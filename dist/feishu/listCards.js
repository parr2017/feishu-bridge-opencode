import { card2, md, note } from "./cards.js";
const PAGE_SIZE = 6;
function totalPages(n) {
    return Math.max(1, Math.ceil(n / PAGE_SIZE));
}
function clampPage(page, n) {
    return Math.min(Math.max(0, page), totalPages(n) - 1);
}
function pageSlice(items, page) {
    return items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}
/** 翻页导航行：首页无 ◀、末页无 ▶（仅一页时整行省略）。 */
function navRow(act, page, pages) {
    const b = (text, target) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: text },
        type: 'default',
        size: 'small',
        behaviors: [{ type: 'callback', value: { act, page: target } }],
    });
    const blank = { tag: 'markdown', content: ' ' };
    return {
        tag: 'column_set',
        flex_mode: 'trisect',
        columns: [
            { tag: 'column', width: 'weighted', weight: 1, elements: [page > 0 ? b('◀ 上一页', page - 1) : blank] },
            { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**第 ${page + 1}/${pages} 页**` }] },
            { tag: 'column', width: 'weighted', weight: 1, elements: [page < pages - 1 ? b('下一页 ▶', page + 1) : blank] },
        ],
    };
}
function actionBtn(text, value, type = 'default') {
    return { tag: 'button', text: { tag: 'plain_text', content: text }, type, size: 'small', behaviors: [{ type: 'callback', value }] };
}
export function buildSessionsCard(sessions, page = 0, currentId) {
    const pages = totalPages(sessions.length);
    const p = clampPage(page, sessions.length);
    const elements = [actionBtn('🆕 新建会话', { act: 'oc_new' }, 'primary')];
    const shown = pageSlice(sessions, p);
    if (!shown.length)
        elements.push(md('（还没有会话——点上面新建，或直接发一条消息自动建）'));
    for (const s of shown) {
        const current = s.id === currentId;
        elements.push(md(`${current ? `**${s.title || s.id}（当前）**` : `**${s.title || s.id}**`} \`${s.id.slice(0, 12)}\``));
        elements.push(actionBtn(current ? '📍 当前会话' : '💬 切换到此会话', { act: 'oc_pick_session', session_id: s.id }, current ? 'default' : 'primary'));
    }
    if (pages > 1)
        elements.push(navRow('oc_list_page', p, pages));
    elements.push(note(`opencode-feishu · 会话列表 · 点按钮切换 · ${new Date().toLocaleString()}`));
    return card2('blue', '🖥 opencode 会话', elements);
}
export function buildModelsCard(models, page = 0, currentId) {
    const pages = totalPages(models.length);
    const p = clampPage(page, models.length);
    const elements = [];
    const shown = pageSlice(models, p);
    if (!shown.length)
        elements.push(md('（取不到模型列表）'));
    for (const m of shown) {
        const current = currentId === m.id;
        elements.push(md(`**${m.label}**${m.isDefault ? '（默认）' : ''}${current ? ' ←当前' : ''} \`${m.id}\``));
        elements.push(actionBtn(current ? '📍 当前模型' : `🧠 切换到 ${m.label.slice(0, 12)}`, { act: 'oc_pick_model', model_id: m.id }, current ? 'default' : 'primary'));
    }
    if (pages > 1)
        elements.push(navRow('oc_models_page', p, pages));
    elements.push(note(`opencode-feishu · 模型切换 · ${new Date().toLocaleString()}`));
    return card2('blue', '🧠 opencode 模型', elements);
}
export function buildAgentsCard(agents, page = 0, currentId) {
    const pages = totalPages(agents.length);
    const p = clampPage(page, agents.length);
    const elements = [];
    const shown = pageSlice(agents, p);
    if (!shown.length)
        elements.push(md('（取不到 agent 列表）'));
    for (const a of shown) {
        const current = currentId === a.id;
        elements.push(md(`**${a.label}**${current ? ' ←当前' : ''} \`${a.id}\``));
        elements.push(actionBtn(current ? '📍 当前 Agent' : `🤖 切换到 ${a.label.slice(0, 12)}`, { act: 'oc_pick_agent', agent: a.id }, current ? 'default' : 'primary'));
    }
    if (pages > 1)
        elements.push(navRow('oc_agents_page', p, pages));
    elements.push(note(`opencode-feishu · Agent 切换 · ${new Date().toLocaleString()}`));
    return card2('blue', '🤖 opencode Agent', elements);
}
/** 待拍板收件箱：跨来源聚合待办（权限 / 提问），点「处理」跳到具体卡。 */
export function buildInboxCard(items, page = 0) {
    const pages = totalPages(items.length);
    const p = clampPage(page, items.length);
    const LABELS = { perm: '权限', ask: '提问' };
    const elements = [];
    const shown = pageSlice(items, p);
    if (!shown.length)
        elements.push(md('✅ 没有等你拍板的事。'));
    for (const it of shown) {
        elements.push(md(`**[${LABELS[it.kind] || it.kind}]** ${it.title}${it.detail ? `\n${it.detail}` : ''}`));
        elements.push(actionBtn('▶ 处理', { act: 'inbox_open', ref: it.ref, kind: it.kind }));
    }
    if (pages > 1)
        elements.push(navRow('inbox_page', p, pages));
    elements.push(note(`opencode-feishu · 待拍板收件箱 · ${new Date().toLocaleString()}`));
    return card2('orange', '📥 待拍板收件箱', elements);
}
