/**
 * 飞书开放平台客户端：tenant_access_token 生命周期 + 消息收发。
 *
 * 移植自 co-team `server/src/feishu/{tokenManager,messageService}.ts`，
 * 去掉 bus/Redis 缓存（插件里单进程，内存缓存足够）。
 */
import { log } from "../log.js";
const TOKEN_TTL_MS = 7100 * 1000; // 飞书给 2h，提前 ~100s 刷新
let memToken = null;
export function apiBase(cfg) {
    return cfg.apiBase;
}
class FeishuApiError extends Error {
    code;
    retryable;
    constructor(code, message, retryable) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.name = 'FeishuApiError';
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchTenantToken(cfg) {
    const res = await fetch(`${apiBase(cfg)}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
        signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({})));
    if (data.code !== 0 || !data.tenant_access_token) {
        throw new FeishuApiError(data.code ?? res.status, `取 tenant_access_token 失败：${data.msg ?? 'unknown'}`, false);
    }
    return data.tenant_access_token;
}
async function getTenantToken(cfg) {
    if (memToken && memToken.expiresAt > Date.now())
        return memToken.token;
    const token = await fetchTenantToken(cfg);
    memToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
}
/** 带鉴权的飞书 API 调用，429/5xx 指数退避。 */
async function callApi(cfg, path, init, retries = 3) {
    for (let attempt = 0;; attempt++) {
        const token = await getTenantToken(cfg);
        const res = await fetch(`${apiBase(cfg)}${path}`, {
            ...init,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
            signal: AbortSignal.timeout(15_000),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < retries - 1) {
            await sleep(500 * 2 ** attempt);
            continue;
        }
        const data = (await res.json().catch(() => ({})));
        if (!res.ok || (data.code && data.code !== 0)) {
            throw new FeishuApiError(data.code ?? res.status, data.msg || res.statusText, res.status === 429 || res.status >= 500);
        }
        return data;
    }
}
async function sendContent(cfg, receiveId, msgType, content, receiveIdType) {
    try {
        const data = await callApi(cfg, `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
            method: 'POST',
            body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content }),
        });
        return data?.data?.message_id ?? null;
    }
    catch (e) {
        // 失败必须可见：卡片被飞书拒时静默返回 null，曾导致「没推送也没日志」
        log.warn('飞书消息发送失败', {
            receiveIdType,
            receiveId: String(receiveId).slice(0, 24),
            msgType,
            error: String(e?.message ?? e).slice(0, 200),
        });
        return null;
    }
}
export function sendText(cfg, receiveId, text, receiveIdType = 'chat_id') {
    return sendContent(cfg, receiveId, 'text', JSON.stringify({ text }), receiveIdType);
}
export function sendCard(cfg, receiveId, card, receiveIdType = 'chat_id') {
    return sendContent(cfg, receiveId, 'interactive', JSON.stringify(card), receiveIdType);
}
/** 原地更新卡片：一个会话一张卡，状态演进不刷屏。 */
export async function updateCard(cfg, messageId, card) {
    try {
        await callApi(cfg, `/open-apis/im/v1/messages/${messageId}`, {
            method: 'PATCH',
            body: JSON.stringify({ content: JSON.stringify(card) }),
        });
        return true;
    }
    catch (e) {
        log.warn('飞书卡片更新失败', { messageId, error: String(e?.message ?? e).slice(0, 200) });
        return false;
    }
}
