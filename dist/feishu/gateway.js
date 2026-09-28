/**
 * 飞书入站网关。两条通道可共存：
 *
 * 1. **长连接**（推荐，无需公网）：WSClient 主动出站连飞书开放平台，
 *    事件与卡片回调经同一条连接推回。开放平台「事件与回调」须切到「使用长连接接收事件」，
 *    且只支持企业自建应用。
 * 2. **HTTP webhook**（可选，需要飞书云可达）：AES 解密 + 签名校验 + 快速 200 + 异步处理。
 *
 * 移植自 co-team `server/src/feishu/{wsGateway,webhook}.ts`，去掉了对 bus 的依赖。
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import { log } from "../log.js";
/** 事件幂等去重（飞书必然重推）。 */
const seen = new Map();
const SEEN_TTL_MS = 300_000;
function isDuplicate(key) {
    if (!key)
        return false;
    const now = Date.now();
    for (const [k, ts] of seen)
        if (now - ts > SEEN_TTL_MS)
            seen.delete(k);
    if (seen.has(key))
        return true;
    seen.set(key, now);
    return false;
}
/** 从 v2（兼容 v1）消息事件里抠出 open_id / chat_id / 文本 / 被引用消息。 */
function extractMessage(source) {
    const msg = source?.message ?? source?.event?.message;
    const sender = source?.sender ?? source?.event?.sender;
    if (!msg)
        return null;
    const openId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? '';
    const chatId = msg.chat_id ?? '';
    let text = '';
    try {
        const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        text = String(content?.text ?? '').trim();
    }
    catch {
        text = '';
    }
    // 去掉 @机器人 占位符："@_user_1 做点事" → "做点事"
    text = text.replace(/^@\S+\s*/, '').trim();
    if (!openId || !chatId || !text)
        return null;
    return { openId, chatId, text, parentId: String(msg.parent_id ?? ''), messageId: String(msg.message_id ?? '') };
}
function verifySignature(opts) {
    const expected = createHash('sha256')
        .update(`${opts.timestamp}${opts.nonce}${opts.encryptKey}${opts.body}`)
        .digest('hex');
    return expected === opts.signature;
}
function decryptPayload(encryptKey, encrypt) {
    const key = createHash('sha256').update(encryptKey).digest();
    const data = Buffer.from(encrypt, 'base64');
    const decipher = createDecipheriv('aes-256-cbc', key, data.subarray(0, 16));
    const plain = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf-8');
    return JSON.parse(plain);
}
export function startInbound(cfg, handlers) {
    let wsState = 'off';
    let webhookState = 'off';
    let ws = null;
    let server = null;
    // ---------- 长连接 ----------
    if (cfg.wsEnabled) {
        const dispatcher = new EventDispatcher({});
        dispatcher.register({
            // SDK 把 v2 事件拍平后分发（header/event 字段平铺顶层）
            'im.message.receive_v1': async (data) => {
                if (isDuplicate(typeof data?.event_id === 'string' ? data.event_id : undefined))
                    return;
                const msg = extractMessage(data);
                if (!msg)
                    return;
                await handlers.onMessage(msg);
            },
            'card.action.trigger': async (data) => {
                const key = `card:${data?.event_id ?? ''}:${data?.operator?.open_id ?? ''}`;
                if (isDuplicate(key))
                    return;
                log.debug('卡片回调', {
                    operator: data?.operator?.open_id,
                    act: data?.action?.value?.act,
                    form_value: data?.action?.form_value,
                    message_id: data?.context?.open_message_id,
                });
                return handlers.onCardAction({
                    operatorOpenId: String(data?.operator?.open_id ?? ''),
                    messageId: data?.context?.open_message_id,
                    chatId: data?.context?.open_chat_id,
                    value: data?.action?.value,
                    formValue: data?.action?.form_value,
                    actionName: typeof data?.action?.name === 'string' ? data.action.name : undefined,
                });
            },
        });
        ws = new WSClient({
            appId: cfg.appId,
            appSecret: cfg.appSecret,
            source: 'opencode-feishu',
            onReady: () => {
                wsState = 'connected';
                log.info('飞书长连接已建立（入站就绪，无需公网）');
            },
            onError: (err) => {
                wsState = 'failed';
                log.error('飞书长连接失败——检查 app_id/app_secret 与开放平台「长连接」订阅模式', {
                    error: String(err?.message ?? err).slice(0, 300),
                });
            },
            onReconnecting: () => {
                wsState = 'reconnecting';
                log.warn('飞书长连接重连中…');
            },
            onReconnected: () => {
                wsState = 'connected';
                log.info('飞书长连接已恢复');
            },
        });
        void ws.start({ eventDispatcher: dispatcher }).catch((e) => {
            wsState = 'failed';
            log.error('飞书长连接启动失败', { error: String(e?.message ?? e).slice(0, 300) });
        });
    }
    // ---------- HTTP webhook ----------
    if (cfg.webhookPort) {
        if (!cfg.encryptKey && !cfg.verificationToken) {
            // 与 co-team 同款 SEC 红线：无鉴权的 webhook 一律不挂
            log.error('拒绝挂载 webhook：encrypt_key 与 verification_token 都没配（无鉴权入站通道禁用）');
        }
        else {
            server = createServer((req, res) => void handleWebhook(cfg, handlers, req, res));
            server.listen(cfg.webhookPort, () => {
                webhookState = `listening:${cfg.webhookPort}`;
                log.info(`飞书 webhook 已监听 :${cfg.webhookPort}`);
            });
            server.on('error', (e) => {
                webhookState = 'failed';
                log.error('飞书 webhook 监听失败', { error: String(e.message).slice(0, 200) });
            });
        }
    }
    return {
        close() {
            try {
                ws?.close();
            }
            catch {
                /* 已关闭 */
            }
            try {
                server?.close();
            }
            catch {
                /* 已关闭 */
            }
        },
        status() {
            return { ws: wsState, webhook: webhookState };
        },
    };
}
async function handleWebhook(cfg, handlers, req, res) {
    const send = (code, body) => {
        const payload = JSON.stringify(body);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(payload);
    };
    if (req.method !== 'POST')
        return send(405, { code: 405, msg: 'method not allowed' });
    const raw = await readBody(req);
    let body;
    try {
        body = JSON.parse(raw || '{}');
    }
    catch {
        return send(400, { code: 400, msg: 'invalid json' });
    }
    if (cfg.encryptKey && typeof body.encrypt === 'string') {
        try {
            body = decryptPayload(cfg.encryptKey, body.encrypt);
        }
        catch (e) {
            log.warn('飞书 payload 解密失败', { error: String(e).slice(0, 200) });
            return send(400, { code: 400, msg: 'decrypt failed' });
        }
    }
    // URL 校验握手
    if (body?.type === 'url_verification' && body?.challenge) {
        return send(200, { challenge: String(body.challenge) });
    }
    const signature = req.headers['x-lark-signature'];
    if (cfg.encryptKey && typeof signature === 'string') {
        const ok = verifySignature({
            timestamp: String(req.headers['x-lark-request-timestamp'] ?? ''),
            nonce: String(req.headers['x-lark-request-nonce'] ?? ''),
            encryptKey: cfg.encryptKey,
            body: raw,
            signature,
        });
        if (!ok)
            return send(403, { code: 403, msg: 'signature mismatch' });
    }
    if (!cfg.encryptKey && cfg.verificationToken && body?.token && body.token !== cfg.verificationToken) {
        return send(403, { code: 403, msg: 'verification token mismatch' });
    }
    const eventId = body?.header?.event_id ?? body?.event_id ?? req.headers['x-lark-request-id'];
    if (isDuplicate(typeof eventId === 'string' ? eventId : undefined))
        return send(200, { code: 0 });
    const eventType = body?.header?.event_type ?? body?.event_type ?? body?.type;
    // 快速 200 + 异步处理：飞书重试很凶，处理逻辑不能占着连接
    if (eventType === 'im.message.receive_v1') {
        const msg = extractMessage(body);
        send(200, { code: 0 });
        if (msg)
            void handlers.onMessage(msg).catch((e) => log.warn('处理飞书消息失败', { error: String(e).slice(0, 200) }));
        return;
    }
    if (eventType === 'card.action.trigger' || body?.action) {
        const action = body?.action ?? {};
        const input = {
            operatorOpenId: String(body?.operator?.open_id ?? ''),
            messageId: body?.context?.open_message_id,
            chatId: body?.context?.open_chat_id,
            value: action?.value,
            formValue: action?.form_value,
            actionName: typeof action?.name === 'string' ? action.name : undefined,
        };
        try {
            const out = await handlers.onCardAction(input);
            return send(200, out ?? {});
        }
        catch (e) {
            log.warn('处理飞书卡片回调失败', { error: String(e).slice(0, 200) });
            return send(200, {});
        }
    }
    return send(200, { code: 0 });
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}
