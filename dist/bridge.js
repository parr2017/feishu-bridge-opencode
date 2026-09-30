/**
 * 核心桥：opencode ↔ 飞书。
 *
 * 功能面搬运自 co-team 的 `feishu/ocBridge.ts` + `listCards.ts` + `panelCard.ts`
 * + `stallWatch.ts`，并接上插件侧才有的两条能力：
 *   - `ctx.tool.transform` 接管 `question` 工具（→ `src/ask.ts`，等价于 co-team 的 answerQuestion）
 *   - `ctx.storage` 存绑定关系（等价于 co-team 的 bus/Redis）
 *
 * 与 co-team 的差别只在「不需要的机器」：不发现/拉起实例、不轮询 pending 权限、
 * 不做 busy→idle 对账、不维护事件重放缓冲——插件在 opencode 进程里，这些都没有对象。
 */
import { log } from "./log.js";
import { loadConfig, validateConfig } from "./config.js";
import { State } from "./state.js";
import { handleCommand, HELP } from "./commands.js";
import { recentSessions, shortDir } from "./sessions.js";
import { AskBridge } from "./ask.js";
import { StallWatch } from "./stall.js";
import { sendCard, sendText } from "./feishu/api.js";
import { startInbound } from "./feishu/gateway.js";
import { btn, btnRow, buildResultCard, card2, cardResponse, clip, collapse, form, inputField, md, note, submitBtn } from "./feishu/cards.js";
import { clipText, permViewOf } from "./feishu/permView.js";
import { buildAgentsCard, buildInboxCard, buildModelsCard, buildSessionsCard } from "./feishu/listCards.js";
import { buildPanelCard } from "./feishu/panelCard.js";
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const PERM_FOLD_MAX = 5;
const PERM_FOLD_LEN = 300;
/** 回合内累计的助手文本，key = `${sessionID}:${assistantMessageID}` */
const replyBuffer = new Map();
function drainBuffer(sessionId) {
    const prefix = `${sessionId}:`;
    const parts = [];
    for (const [key, text] of replyBuffer) {
        if (key.startsWith(prefix)) {
            parts.push(text);
            replyBuffer.delete(key);
        }
    }
    return parts.join('\n\n').trim();
}
export class Bridge {
    api;
    cfg;
    state;
    inbound = null;
    ask;
    stall;
    pending = new Map();
    busy = new Set();
    lastActiveSession = null;
    disposers = [];
    constructor(api, options = {}) {
        this.api = api;
        this.cfg = loadConfig(options, api.directory);
        this.state = new State(api.storage);
        this.ask = new AskBridge({
            cfg: this.cfg,
            state: this.state,
            chatForSession: (sid) => this.chatForSession(sid),
            lastActiveSession: () => this.lastActiveSession,
        });
        this.stall = new StallWatch(this.cfg, this.state, (sid) => this.chatForSession(sid));
    }
    // ---------------------------------------------------------------- 生命周期
    async start() {
        const problem = validateConfig(this.cfg);
        if (problem) {
            log.warn(`飞书插件未启用：${problem}`);
            return;
        }
        this.inbound = startInbound(this.cfg, {
            onMessage: (m) => this.onMessage(m),
            onCardAction: (i) => this.onCardAction(i),
        });
        await this.installEventStream();
        await this.installPermissionGate();
        await this.ask.install({ toolTransform: (cb) => this.api.toolTransform(cb) });
        this.disposers.push(this.stall.start());
        log.info('飞书插件已就绪', {
            directory: this.api.directory,
            config: this.cfg.configPath ?? '（无配置文件，用的是环境变量/默认值）',
            ws: this.cfg.wsEnabled,
            webhook: this.cfg.webhookPort ?? null,
            approvers: this.cfg.approvers.length,
        });
    }
    async dispose() {
        this.inbound?.close();
        this.stall.stop();
        await this.ask.dispose();
        for (const d of this.disposers.splice(0)) {
            try {
                d();
            }
            catch {
                /* ignore */
            }
        }
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.resolve('ask');
        }
        this.pending.clear();
    }
    /**
     * 会话 → 飞书落点。三级回落：
     *   1. 该 opencode 会话绑定的飞书会话（正常情况）
     *   2. 配置文件里的固定落点 notifyChatId
     *   3. 「最后一次和机器人说话的那个会话」（动态记忆）
     */
    async chatForSession(sessionId) {
        if (!sessionId)
            return null;
        const binding = await this.state.findBySession(sessionId);
        return binding?.chatId ?? this.cfg.notifyChatId ?? (await this.state.getNotifyChat());
    }
    // ---------------------------------------------------------------- opencode 事件
    async installEventStream() {
        const stream = this.api.subscribe(() => { });
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
            log.warn('event.subscribe 未返回可迭代对象——完成推送/权限卡/提问桥将不可用');
            return;
        }
        void (async () => {
            try {
                for await (const event of stream) {
                    try {
                        await this.onOpencodeEvent(event);
                    }
                    catch (e) {
                        log.warn('处理 opencode 事件失败', { type: event?.type, error: String(e).slice(0, 200) });
                    }
                }
            }
            catch (e) {
                log.error('opencode 事件流中断', { error: String(e).slice(0, 300) });
            }
        })();
    }
    async onOpencodeEvent(event) {
        const type = String(event?.type ?? '');
        const data = event?.data ?? {};
        const sid = String(data.sessionID ?? '');
        // 卡住检测的数据源：任何会话事件都刷新活动时间
        if (sid && !type.startsWith('session.execution.'))
            this.stall.touch(sid);
        switch (type) {
            case 'session.execution.started': {
                if (sid) {
                    this.busy.add(sid);
                    this.lastActiveSession = sid;
                    this.stall.markBusy(sid);
                }
                return;
            }
            case 'session.inbox.enqueued': {
                const text = String(data?.item?.payload?.text ?? '');
                if (sid && text)
                    this.stall.touch(sid, text);
                return;
            }
            case 'session.text.ended': {
                const mid = String(data.assistantMessageID ?? '');
                if (sid && mid && typeof data.text === 'string')
                    replyBuffer.set(`${sid}:${mid}`, data.text);
                return;
            }
            case 'session.execution.succeeded': {
                if (sid) {
                    this.busy.delete(sid);
                    this.stall.settle(sid);
                }
                await this.pushTurnResult(sid, false);
                return;
            }
            case 'session.execution.interrupted':
            case 'session.execution.failed': {
                if (sid) {
                    this.busy.delete(sid);
                    this.stall.settle(sid);
                }
                await this.pushTurnResult(sid, true);
                return;
            }
            case 'session.retry.scheduled': {
                log.warn('opencode 请求重试', { sessionID: sid, attempt: data.attempt, error: data?.error?.message });
                return;
            }
            // 提问：正常路径由 question 工具接管（src/ask.ts）处理；这里只记日志
            case 'form.created': {
                log.debug('opencode 创建表单', { id: data?.form?.id, sessionID: data?.form?.sessionID, title: data?.form?.title });
                return;
            }
            case 'permission.asked': {
                log.debug('opencode 请求权限', { id: data.id, sessionID: sid, action: data.action, resources: data.resources });
                return;
            }
            default:
                return;
        }
    }
    /** 回合结束：把攒到的助手文本渲染成卡片推到绑定会话。 */
    async pushTurnResult(sessionId, interrupted) {
        if (!sessionId)
            return;
        const binding = await this.state.findBySession(sessionId);
        const chatId = binding?.chatId ?? (this.cfg.pushAll ? await this.chatForSession(sessionId) : null);
        if (!chatId)
            return; // 既没绑定、也没开 pushAll、也没有历史落点——不打扰
        // 会话自身的元数据：/switch 可跨项目接管，目录可能不是插件所在的目录
        const info = await this.api.getSession({ sessionID: sessionId }).catch(() => null);
        const title = binding?.title || info?.title || '';
        const dir = info?.directory || this.api.directory;
        const text = drainBuffer(sessionId);
        const body = text || (interrupted ? '（执行被中止，无文本输出）' : '（执行完成，无文本输出）');
        const card = card2(interrupted ? 'orange' : 'green', interrupted ? '⏹ opencode 已中止' : '✅ opencode 已完成', [
            md(`**会话** ${title || sessionId.slice(0, 12)}\n**目录** ${dir}\n\n${clip(body, 2400)}`),
            form(`reply_${sessionId}_${Date.now()}`, [inputField('reply', '继续这个话题…'), submitBtn('发送', 'go')]),
            note(`opencode-feishu · 引用回复本卡亦可 · ${new Date().toLocaleString()}`),
        ]);
        const messageId = await sendCard(this.cfg, chatId, card);
        if (messageId)
            await this.state.putRoute(messageId, { act: 'quick_reply', session_id: sessionId });
    }
    // ---------------------------------------------------------------- 权限闸门
    /**
     * 权限闸门。**关键机制（实测）**：hook 的返回值会被忽略，
     * 必须**原地改写入参对象**（`input.effect = 'allow' | 'deny'`）才生效。
     * 这跟 v1 的 `permission.ask`（改 `output.status`）以及「返回一个裁决对象」的直觉都不一样。
     */
    async installPermissionGate() {
        try {
            await this.api.hook('permission', 'evaluate', async (input) => {
                if (String(input?.effect ?? 'ask') !== 'ask')
                    return; // 已经放行/拒绝的不用我们管
                const sessionId = String(input?.sessionID ?? '');
                const action = String(input?.action ?? 'permission');
                const resources = Array.isArray(input?.resources) ? input.resources.map(String) : [];
                const decision = await this.awaitDecision({ sessionId, action, resources, raw: input });
                if (decision === 'allow')
                    input.effect = 'allow';
                else if (decision === 'deny')
                    input.effect = 'deny';
                // 'ask' → 不动它，交回 opencode 默认策略（无人应答时它自己会拒，比误放行安全）
            });
            log.info("已挂载权限闸门 permission.hook('evaluate')（靠原地改写入参生效）");
        }
        catch (e) {
            log.warn('权限闸门挂载失败——将退化为「仅记日志」模式', { error: String(e).slice(0, 200) });
        }
    }
    async awaitDecision(req) {
        const chatId = await this.chatForSession(req.sessionId);
        if (!chatId || !this.cfg.approvers.length)
            return 'ask';
        const key = `${req.sessionId}|${req.action}|${req.resources.join(',')}`;
        const existing = this.pending.get(key);
        if (existing)
            return existing.promise; // 同一请求的第二阶段复用同一张卡
        let resolveFn;
        const promise = new Promise((resolve) => {
            resolveFn = resolve;
        });
        const timer = setTimeout(() => {
            this.pending.delete(key);
            log.warn('权限卡等待超时，交回 opencode 默认策略', { key });
            resolveFn('ask');
        }, PERMISSION_TIMEOUT_MS);
        this.pending.set(key, {
            key,
            sessionId: req.sessionId,
            chatId,
            summary: `${req.action} · ${req.resources.join(', ')}`,
            promise,
            resolve: resolveFn,
            timer,
        });
        await this.pushPermissionCard(key, chatId, req.sessionId, req.raw);
        return promise;
    }
    /** 权限卡：内容经 permViewOf 归一（v2 真载荷 {action,resources,save,message}）。 */
    async pushPermissionCard(key, chatId, sessionId, raw) {
        const view = permViewOf(raw);
        const binding = await this.state.findBySession(sessionId);
        const meta = await this.api.getSession({ sessionID: sessionId }).catch(() => null);
        const lines = view ? view.lines.map((l) => `**${l.label}** ${l.value}`) : ['**动作** 权限请求'];
        lines.push(`**会话** ${binding?.title || meta?.title || sessionId.slice(0, 12)}`);
        lines.push(`**目录** ${meta?.directory || this.api.directory}`);
        const elems = [md(lines.join('\n'))];
        // 放不下的部分进折叠面板（老租户可能不支持 collapsible_panel，所以只在真放不下时用）
        const rest = [];
        const heavy = view ? view.resources.length > PERM_FOLD_MAX || view.resources.some((r) => r.length > PERM_FOLD_LEN) : false;
        if (heavy && view)
            rest.push(md(view.resources.slice(0, 40).map((r, i) => `${i + 1}. ${r.slice(0, 800)}`).join('\n')));
        if (view?.extra)
            rest.push(md(`更多细节：${view.extra}`));
        if (rest.length)
            elems.push(collapse(heavy ? `全部目标（${view?.resources.length} 项）` : '更多细节', rest));
        const value = { act: 'perm', perm_key: key, session_id: sessionId };
        const brief = view ? clipText(view.summary, 60) : '';
        elems.push(btnRow(btn('✅ 批准一次', 'primary', { ...value, decision: 'allow', brief }), btn(view?.alwaysRule ? `总是批准（记住 ${clipText(view.alwaysRule, 24)}）` : '总是批准', 'default', { ...value, decision: 'always', brief })));
        elems.push(btn('✖ 拒绝', 'danger', { ...value, decision: 'deny', brief }));
        elems.push(note(`opencode-feishu · 权限 · ${view?.label || '权限请求'} · ${new Date().toLocaleString()}`));
        const messageId = await sendCard(this.cfg, chatId, card2('orange', `⛔ 需要授权 · ${view?.label || '权限请求'}`, elems));
        if (!messageId) {
            // 卡片没送出去 = 没人能点，立刻交回 opencode，别干等 10 分钟
            const p = this.pending.get(key);
            if (p) {
                clearTimeout(p.timer);
                this.pending.delete(key);
                p.resolve('ask');
            }
            return false;
        }
        await this.state.putRoute(messageId, value);
        return true;
    }
    // ---------------------------------------------------------------- 入站消息
    async onMessage(msg) {
        await this.state.setNotifyChat(msg.chatId);
        log.debug('收到飞书消息', { openId: msg.openId, chatId: msg.chatId, text: msg.text.slice(0, 80) });
        // 引用回复某条卡片 → 按路由处理（继续对话）
        if (msg.parentId) {
            const route = await this.state.getRoute(msg.parentId);
            if (route?.act === 'quick_reply' && route.session_id) {
                await this.sendPrompt(msg.chatId, String(route.session_id), msg.text);
                return;
            }
        }
        await this.runCommand(msg, msg.text);
    }
    /** 执行一条指令（文本或面板按钮合成的），把结果发回飞书。 */
    async runCommand(msg, text) {
        const result = await handleCommand(text, this.host(msg));
        if (result.passthrough) {
            const binding = await this.ensureBinding(msg);
            if (binding)
                await this.sendPrompt(msg.chatId, binding.sessionId, text);
            return;
        }
        if (result.card) {
            const messageId = await sendCard(this.cfg, msg.chatId, result.card);
            if (messageId)
                await this.state.putRoute(messageId, { act: 'noop' });
            if (result.reply)
                await sendText(this.cfg, msg.chatId, result.reply);
            return;
        }
        if (result.reply)
            await sendText(this.cfg, msg.chatId, result.reply);
    }
    async sendPrompt(chatId, sessionId, text) {
        try {
            this.busy.add(sessionId);
            this.lastActiveSession = sessionId;
            this.stall.markBusy(sessionId);
            this.stall.touch(sessionId, text);
            await this.api.prompt({ sessionID: sessionId, text });
            await sendText(this.cfg, chatId, `已发送到 opencode（会话 ${sessionId.slice(0, 12)}），完成后推送结果。`);
        }
        catch (e) {
            this.busy.delete(sessionId);
            const message = String(e?.message ?? e).slice(0, 200);
            log.warn('发送 prompt 失败', { sessionId, error: message });
            await sendText(this.cfg, chatId, `发送失败：${message}`);
        }
    }
    async ensureBinding(msg) {
        const existing = await this.state.getChat(msg.chatId);
        if (existing)
            return existing;
        try {
            const created = await this.api.createSession({ title: `飞书 · ${msg.openId.slice(0, 8)}` });
            const binding = {
                chatId: msg.chatId,
                sessionId: created.id,
                openId: msg.openId,
                title: created.title || `飞书会话 ${created.id.slice(0, 12)}`,
                updatedAt: new Date().toISOString(),
            };
            await this.state.putChat(binding);
            await this.state.indexChat(msg.chatId);
            log.info('已自动绑定新 opencode 会话', { chatId: msg.chatId, sessionId: created.id });
            return binding;
        }
        catch (e) {
            log.error('创建 opencode 会话失败', { error: String(e).slice(0, 200) });
            await sendText(this.cfg, msg.chatId, `无法创建 opencode 会话：${String(e?.message ?? e).slice(0, 160)}`);
            return null;
        }
    }
    // ---------------------------------------------------------------- 指令实现
    host(msg) {
        const chatId = msg.chatId;
        const bindingOf = () => this.state.getChat(chatId);
        const bindNew = async (title) => {
            const created = await this.api.createSession(title ? { title } : {});
            const binding = {
                chatId,
                sessionId: created.id,
                openId: msg.openId,
                title: created.title || title || `飞书会话 ${created.id.slice(0, 12)}`,
                updatedAt: new Date().toISOString(),
            };
            await this.state.putChat(binding);
            await this.state.indexChat(chatId);
            return binding;
        };
        return {
            help: () => HELP_TEXT(),
            panel: async () => buildPanelCard(),
            status: async () => {
                const binding = await bindingOf();
                const gw = this.inbound?.status() ?? { ws: 'off', webhook: 'off' };
                const chats = await this.state.allChats();
                return [
                    '**状态**',
                    `目录：${this.api.directory}`,
                    `长连接：${gw.ws} · webhook：${gw.webhook}`,
                    `审批白名单：${this.cfg.approvers.length ? `${this.cfg.approvers.length} 人` : '未配置（审批按钮不可点）'}`,
                    `你的 open_id：\`${msg.openId}\`${this.cfg.approvers.includes(msg.openId) ? '' : ' ← 把它加进配置的 approvers 才能点审批按钮'}`,
                    `绑定会话：${binding ? `${binding.title}（${binding.sessionId.slice(0, 12)}）` : '未绑定'}`,
                    binding?.model ? `模型：${binding.model}` : '',
                    binding?.agent ? `Agent：${binding.agent}` : '',
                    `本插件管理的会话数：${chats.length}`,
                ]
                    .filter(Boolean)
                    .join('\n');
            },
            newSession: async (title) => {
                const b = await bindNew(title);
                return { reply: `✅ 已新建并绑定 opencode 会话 \`${b.sessionId.slice(0, 12)}\`。直接发消息即开始。` };
            },
            listSessions: async () => ({ reply: '', card: await this.sessionsCard(0, chatId) }),
            switchSession: async (ref) => {
                if (!ref)
                    return '用法：`/switch <序号>` 或 `/switch <会话ID>`（先用 /list 看列表）';
                const chats = await this.state.allChats();
                // ① 按序号 / 已绑定会话的前缀匹配
                const n = Number(ref);
                const hit = Number.isInteger(n)
                    ? chats[n - 1]
                    : chats.find((c) => c.sessionId.startsWith(ref));
                if (hit) {
                    await this.state.putChat({ ...hit, chatId, openId: msg.openId });
                    await this.state.indexChat(chatId);
                    return `✅ 已切换绑定到 \`${hit.sessionId.slice(0, 12)}\`（${hit.title}）。`;
                }
                // ② 直接给了一个 opencode 会话 ID（ses_…）——接管一个非插件创建的会话。
                //    典型场景：在 TUI 里聊了一半，想切到飞书继续。
                if (/^ses[_a-z0-9]*$/i.test(ref)) {
                    try {
                        const found = await this.api.getSession({ sessionID: ref });
                        if (!found?.id)
                            return `会话 \`${ref}\` 不存在（或不在当前项目目录下）。`;
                        const binding = {
                            chatId,
                            sessionId: found.id,
                            openId: msg.openId,
                            title: found.title || `会话 ${found.id.slice(0, 12)}`,
                            updatedAt: new Date().toISOString(),
                        };
                        await this.state.putChat(binding);
                        await this.state.indexChat(chatId);
                        this.lastActiveSession = found.id;
                        return `✅ 已接管会话 \`${found.id.slice(0, 12)}\`（${binding.title}）。之后飞书里的消息都会发往这个会话。`;
                    }
                    catch (e) {
                        return `接管失败：${String(e?.message ?? e).slice(0, 160)}\n（注意：只能接管**当前项目目录**下的会话；别的项目的会话要在那个目录里装插件。）`;
                    }
                }
                return `没找到「${ref}」，用 /list 看可选会话，或直接给一个会话 ID（ses_ 开头）。`;
            },
            models: async (ref) => {
                const models = await this.api.listModels().catch(() => []);
                const binding = await bindingOf();
                if (!ref) {
                    if (!models.length)
                        return { reply: '取不到模型列表。' };
                    return { reply: '', card: buildModelsCard(models, 0, binding?.model) };
                }
                if (!binding)
                    return { reply: '先发一条消息或用 /new 绑定会话，再切模型。' };
                const n = Number(ref);
                const target = (Number.isInteger(n) ? models[n - 1]?.id : undefined) || ref;
                try {
                    await this.api.switchModel({ sessionID: binding.sessionId, model: target });
                    await this.state.putChat({ ...binding, model: target });
                    return { reply: `✅ 已切换模型为 \`${target}\`。` };
                }
                catch (e) {
                    return { reply: `切换失败：${String(e?.message ?? e).slice(0, 160)}` };
                }
            },
            agents: async (ref) => {
                const agents = await this.api.listAgents().catch(() => []);
                const binding = await bindingOf();
                if (!ref) {
                    if (!agents.length)
                        return { reply: '取不到 agent 列表。' };
                    return { reply: '', card: buildAgentsCard(agents, 0, binding?.agent) };
                }
                if (!binding)
                    return { reply: '先发一条消息或用 /new 绑定会话，再切 agent。' };
                const n = Number(ref);
                const target = (Number.isInteger(n) ? agents[n - 1]?.id : undefined) || ref;
                try {
                    await this.api.switchAgent({ sessionID: binding.sessionId, agent: target });
                    await this.state.putChat({ ...binding, agent: target });
                    return { reply: `✅ 已切换 Agent 为 \`${target}\`。` };
                }
                catch (e) {
                    return { reply: `切换失败：${String(e?.message ?? e).slice(0, 160)}` };
                }
            },
            inbox: async () => {
                const items = await this.collectInbox();
                return buildInboxCard(items);
            },
            stop: async () => {
                const binding = await bindingOf();
                if (!binding)
                    return '当前没有绑定会话。';
                try {
                    await this.api.interrupt({ sessionID: binding.sessionId });
                    this.busy.delete(binding.sessionId);
                    this.stall.settle(binding.sessionId);
                    return '⏹ 已发送中止请求。';
                }
                catch (e) {
                    return `中止失败（可能已经结束）：${String(e?.message ?? e).slice(0, 160)}`;
                }
            },
        };
    }
    /** 会话列表卡：/list 与翻页按钮共用的唯一数据源（读 opencode 的库，跨项目）。 */
    async sessionsCard(page, chatId) {
        const recent = await recentSessions(30);
        const current = await this.state.getChat(chatId);
        const entries = recent.map((r) => ({
            id: r.id,
            title: `${r.title || '(未命名)'} · ${shortDir(r.directory)}`,
        }));
        return buildSessionsCard(entries, page, current?.sessionId);
    }
    /** 收件箱：聚合待裁决的权限与待作答的提问。 */
    async collectInbox() {
        const items = [];
        for (const p of this.pending.values()) {
            const binding = await this.state.findBySession(p.sessionId).catch(() => null);
            items.push({ kind: 'perm', title: p.summary, detail: `会话 ${binding?.title ?? p.sessionId.slice(0, 12)}`, ref: p.key });
        }
        for (const a of this.ask.pendingList()) {
            items.push({ kind: 'ask', title: a.title, detail: `会话 ${a.sessionId.slice(0, 12)}`, ref: a.key });
        }
        return items;
    }
    // ---------------------------------------------------------------- 卡片回调
    async onCardAction(input) {
        const who = input.operatorOpenId || 'unknown';
        const params = input.value && Object.keys(input.value).length ? input.value : input.messageId ? await this.state.getRoute(input.messageId) : null;
        if (!params)
            return;
        const act = String(params.act ?? '');
        const reply = (title, lines) => cardResponse(buildResultCard(title, lines));
        try {
            if (act === 'noop')
                return;
            // 面板按钮：合成一条命令，走同一条管道（面板响应帧返回 undefined = 面板保留，可连点）
            if (act === 'panel') {
                const cmd = String(params.cmd ?? '');
                const chatId = input.chatId ?? (await this.state.getNotifyChat()) ?? '';
                if (!cmd || !chatId)
                    return;
                void this.runCommand({ openId: who, chatId, text: cmd, parentId: '', messageId: '' }, cmd);
                return;
            }
            // 提问卡：交给 AskBridge（它自己校验白名单）
            if (act.startsWith('ask_'))
                return await this.ask.handleAction(input);
            // 只读浏览类动作：翻页 / 看列表，不改任何状态，**不需要白名单**。
            // （之前这类也被拦，导致空白名单时连列表翻页都点不动——实测踩过。）
            if (act === 'oc_list_page') {
                // ⚠️ 必须和 /list 用同一个数据源——之前这里还在读旧的绑定列表，
                //    翻页翻出来的是另一份数据，表现为「翻页失效」。
                return cardResponse(await this.sessionsCard(Number(params.page ?? 0) || 0, input.chatId ?? ''));
            }
            if (act === 'oc_models_page') {
                return cardResponse(buildModelsCard(await this.api.listModels().catch(() => []), Number(params.page ?? 0) || 0));
            }
            if (act === 'oc_agents_page') {
                return cardResponse(buildAgentsCard(await this.api.listAgents().catch(() => []), Number(params.page ?? 0) || 0));
            }
            if (act === 'inbox_page') {
                return cardResponse(buildInboxCard(await this.collectInbox(), Number(params.page ?? 0) || 0));
            }
            // ↓↓ 从这里开始是会改变 opencode 状态 / 替人做决定的动作，必须过白名单 ↓↓
            if (!this.cfg.approvers.length || !this.cfg.approvers.includes(who)) {
                // 拒绝的同时把「怎么解决」说清楚——open_id 就在眼前，别让用户再去翻日志
                return reply('⛔ 无权操作', [
                    `操作人 \`${who}\` 不在审批白名单内。`,
                    '',
                    '**加入白名单**：',
                    '1. 发 `/status` 可看到配置文件路径和你的 open_id',
                    '2. 把你的 open_id 加进配置的 `approvers` 数组',
                    '3. `opencode service restart`',
                ]);
            }
            switch (act) {
                case 'perm': {
                    const permKey = String(params.perm_key ?? '');
                    const decision = String(params.decision ?? 'deny');
                    const pending = this.pending.get(permKey);
                    if (pending) {
                        clearTimeout(pending.timer);
                        this.pending.delete(permKey);
                        pending.resolve(decision === 'deny' ? 'deny' : 'allow');
                        return reply(decision === 'deny' ? '✖ 已拒绝' : '✅ 已批准', [pending.summary]);
                    }
                    // 没有挂起的 evaluate（插件重启过 / 卡是上一轮留下的）：退回 permission.reply
                    const sessionId = String(params.session_id ?? '');
                    const permissionId = String(params.permission_id ?? '');
                    if (!sessionId || !permissionId)
                        return reply('⏱ 权限已失效', ['没有对应的等待中请求。']);
                    try {
                        await this.api.permissionReply({
                            sessionID: sessionId,
                            requestID: permissionId,
                            reply: decision === 'deny' ? 'reject' : decision === 'always' ? 'always' : 'once',
                        });
                        return reply(decision === 'deny' ? '✖ 已拒绝' : '✅ 已批准', [`${sessionId.slice(0, 12)} · ${permissionId}`]);
                    }
                    catch (e) {
                        return reply('⏱ 权限已失效', [String(e?.message ?? e).slice(0, 160)]);
                    }
                }
                case 'oc_pick_session': {
                    const sid = String(params.session_id ?? '');
                    const chatId = input.chatId ?? (await this.state.getNotifyChat()) ?? '';
                    if (!sid || !chatId)
                        return;
                    const existing = (await this.state.allChats()).find((c) => c.sessionId === sid);
                    const binding = existing
                        ? { ...existing, chatId, openId: who }
                        : { chatId, sessionId: sid, openId: who, title: `会话 ${sid.slice(0, 12)}`, updatedAt: new Date().toISOString() };
                    await this.state.putChat(binding);
                    await this.state.indexChat(chatId);
                    this.lastActiveSession = sid;
                    await sendText(this.cfg, chatId, `✅ 已切换到会话 \`${sid.slice(0, 12)}\`（${binding.title}）。直接发消息即发往此会话。`);
                    return;
                }
                case 'oc_pick_model': {
                    const modelId = String(params.model_id ?? '');
                    const binding = await this.state.getChat(input.chatId ?? '');
                    if (!binding || !modelId)
                        return reply('⚠ 未绑定会话', ['先发一条消息或用 /list 绑定会话。']);
                    try {
                        await this.api.switchModel({ sessionID: binding.sessionId, model: modelId });
                        await this.state.putChat({ ...binding, model: modelId });
                        return reply('✅ 已切换模型', [modelId]);
                    }
                    catch (e) {
                        return reply('⚠ 切换失败', [String(e?.message ?? e).slice(0, 160)]);
                    }
                }
                case 'oc_pick_agent': {
                    const agentId = String(params.agent ?? '');
                    const binding = await this.state.getChat(input.chatId ?? '');
                    if (!binding || !agentId)
                        return reply('⚠ 未绑定会话', ['先发一条消息或用 /list 绑定会话。']);
                    try {
                        await this.api.switchAgent({ sessionID: binding.sessionId, agent: agentId });
                        await this.state.putChat({ ...binding, agent: agentId });
                        return reply('✅ 已切换 Agent', [agentId]);
                    }
                    catch (e) {
                        return reply('⚠ 切换失败', [String(e?.message ?? e).slice(0, 160)]);
                    }
                }
                case 'oc_new': {
                    const chatId = input.chatId ?? (await this.state.getNotifyChat()) ?? '';
                    if (!chatId)
                        return;
                    const created = await this.api.createSession({});
                    const binding = {
                        chatId,
                        sessionId: created.id,
                        openId: who,
                        title: created.title || `飞书会话 ${created.id.slice(0, 12)}`,
                        updatedAt: new Date().toISOString(),
                    };
                    await this.state.putChat(binding);
                    await this.state.indexChat(chatId);
                    await sendText(this.cfg, chatId, `✅ 已新建并绑定会话 \`${created.id.slice(0, 12)}\`。直接发消息即开始。`);
                    return;
                }
                case 'oc_abort': {
                    const sid = String(params.session_id ?? '');
                    if (!sid)
                        return;
                    try {
                        await this.api.interrupt({ sessionID: sid });
                        this.busy.delete(sid);
                        this.stall.settle(sid);
                        return reply('⏹ 已中止', [sid.slice(0, 12)]);
                    }
                    catch {
                        return reply('⏱ 会话已结束', [sid.slice(0, 12)]);
                    }
                }
                case 'inbox_open': {
                    const ref = String(params.ref ?? '');
                    const kind = String(params.kind ?? '');
                    const chatId = input.chatId ?? (await this.state.getNotifyChat()) ?? '';
                    if (!ref || !chatId)
                        return;
                    if (kind === 'perm') {
                        const p = this.pending.get(ref);
                        if (!p)
                            return reply('条目已过期', ['权限请求已经结束。']);
                        await this.pushPermissionCard(p.key, chatId, p.sessionId, { action: p.summary, resources: [] });
                        return;
                    }
                    const ok = await this.ask.repush(ref, chatId);
                    if (!ok)
                        return reply('条目已过期', ['提问已经结束。']);
                    return;
                }
                case 'quick_reply': {
                    const text = String(input.formValue?.reply ?? '').trim();
                    const sid = String(params.session_id ?? '');
                    if (!text)
                        return reply('内容为空', ['请输入内容后再提交。']);
                    if (!sid)
                        return reply('会话已失效', ['请直接发消息。']);
                    const chatId = input.chatId ?? (await this.state.getNotifyChat()) ?? '';
                    if (chatId)
                        await this.sendPrompt(chatId, sid, text);
                    return;
                }
                default:
                    return;
            }
        }
        catch (e) {
            log.warn('处理卡片回调失败', { act, error: String(e).slice(0, 200) });
            return reply('⚠ 处理失败', [String(e?.message ?? e).slice(0, 200)]);
        }
    }
}
function HELP_TEXT() {
    return HELP;
}
