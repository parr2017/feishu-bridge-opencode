/**
 * 交互列表卡（统一构建 + 无状态翻页）。
 *
 * 搬运自 co-team `server/src/feishu/listCards.ts`，**只保留与 opencode 对应的三类**：
 * 会话 / 模型 / Agent，外加待拍板收件箱。
 * co-team 原文件里的任务卡、协作会话卡、项目选择卡、实例卡在这里没有对应物
 * （opencode 没有任务/项目/实例这些概念），未搬。
 *
 * 翻页机制原样保留：页大小 6；页码放在按钮 value 里，点击时重新拉数据渲染该页，
 * 用 cardResponse 原地替换整卡——不发新消息、服务端无分页状态、可连续翻。
 */
import type { CardElement } from './cards.ts';
import { card2, md, note } from './cards.ts';

const PAGE_SIZE = 6;

function totalPages(n: number): number {
  return Math.max(1, Math.ceil(n / PAGE_SIZE));
}
function clampPage(page: number, n: number): number {
  return Math.min(Math.max(0, page), totalPages(n) - 1);
}
function pageSlice<T>(items: T[], page: number): T[] {
  return items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}

/** 翻页导航行：首页无 ◀、末页无 ▶（仅一页时整行省略）。 */
function navRow(act: string, page: number, pages: number): CardElement {
  const b = (text: string, target: number): CardElement => ({
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: 'default',
    size: 'small',
    behaviors: [{ type: 'callback', value: { act, page: target } }],
  });
  const blank: CardElement = { tag: 'markdown', content: ' ' };
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

function actionBtn(text: string, value: Record<string, unknown>, type: 'primary' | 'default' | 'danger' = 'default'): CardElement {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, size: 'small', behaviors: [{ type: 'callback', value }] };
}

// ---------- 构建器 ----------

export interface SessionEntry {
  id: string;
  title?: string;
  updatedAt?: string;
}

/** 收件箱条目：`ref` 是回跳用的稳定标识（权限 key / 提问 key）。 */
export interface InboxItem {
  kind: string;
  title: string;
  detail?: string;
  ref: string;
}

export function buildSessionsCard(sessions: SessionEntry[], page = 0, currentId?: string): Record<string, unknown> {
  const pages = totalPages(sessions.length);
  const p = clampPage(page, sessions.length);
  const elements: CardElement[] = [actionBtn('🆕 新建会话', { act: 'oc_new' }, 'primary')];
  const shown = pageSlice(sessions, p);
  if (!shown.length) elements.push(md('（还没有会话——点上面新建，或直接发一条消息自动建）'));
  for (const s of shown) {
    const current = s.id === currentId;
    elements.push(md(`${current ? `**${s.title || s.id}（当前）**` : `**${s.title || s.id}**`} \`${s.id.slice(0, 12)}\``));
    elements.push(
      actionBtn(current ? '📍 当前会话' : '💬 切换到此会话', { act: 'oc_pick_session', session_id: s.id }, current ? 'default' : 'primary'),
    );
  }
  if (pages > 1) elements.push(navRow('oc_list_page', p, pages));
  elements.push(note(`opencode-feishu · 会话列表 · 点按钮切换 · ${new Date().toLocaleString()}`));
  return card2('blue', '🖥 opencode 会话', elements);
}

export function buildModelsCard(models: { id: string; label: string; isDefault?: boolean }[], page = 0, currentId?: string): Record<string, unknown> {
  const pages = totalPages(models.length);
  const p = clampPage(page, models.length);
  const elements: CardElement[] = [];
  const shown = pageSlice(models, p);
  if (!shown.length) elements.push(md('（取不到模型列表）'));
  for (const m of shown) {
    const current = currentId === m.id;
    elements.push(md(`**${m.label}**${m.isDefault ? '（默认）' : ''}${current ? ' ←当前' : ''} \`${m.id}\``));
    elements.push(actionBtn(current ? '📍 当前模型' : `🧠 切换到 ${m.label.slice(0, 12)}`, { act: 'oc_pick_model', model_id: m.id }, current ? 'default' : 'primary'));
  }
  if (pages > 1) elements.push(navRow('oc_models_page', p, pages));
  elements.push(note(`opencode-feishu · 模型切换 · ${new Date().toLocaleString()}`));
  return card2('blue', '🧠 opencode 模型', elements);
}

export function buildAgentsCard(agents: { id: string; label: string }[], page = 0, currentId?: string): Record<string, unknown> {
  const pages = totalPages(agents.length);
  const p = clampPage(page, agents.length);
  const elements: CardElement[] = [];
  const shown = pageSlice(agents, p);
  if (!shown.length) elements.push(md('（取不到 agent 列表）'));
  for (const a of shown) {
    const current = currentId === a.id;
    elements.push(md(`**${a.label}**${current ? ' ←当前' : ''} \`${a.id}\``));
    elements.push(actionBtn(current ? '📍 当前 Agent' : `🤖 切换到 ${a.label.slice(0, 12)}`, { act: 'oc_pick_agent', agent: a.id }, current ? 'default' : 'primary'));
  }
  if (pages > 1) elements.push(navRow('oc_agents_page', p, pages));
  elements.push(note(`opencode-feishu · Agent 切换 · ${new Date().toLocaleString()}`));
  return card2('blue', '🤖 opencode Agent', elements);
}

/** 待拍板收件箱：跨来源聚合待办（权限 / 提问），点「处理」跳到具体卡。 */
export function buildInboxCard(items: InboxItem[], page = 0): Record<string, unknown> {
  const pages = totalPages(items.length);
  const p = clampPage(page, items.length);
  const LABELS: Record<string, string> = { perm: '权限', ask: '提问' };
  const elements: CardElement[] = [];
  const shown = pageSlice(items, p);
  if (!shown.length) elements.push(md('✅ 没有等你拍板的事。'));
  for (const it of shown) {
    elements.push(md(`**[${LABELS[it.kind] || it.kind}]** ${it.title}${it.detail ? `\n${it.detail}` : ''}`));
    elements.push(actionBtn('▶ 处理', { act: 'inbox_open', ref: it.ref, kind: it.kind }));
  }
  if (pages > 1) elements.push(navRow('inbox_page', p, pages));
  elements.push(note(`opencode-feishu · 待拍板收件箱 · ${new Date().toLocaleString()}`));
  return card2('orange', '📥 待拍板收件箱', elements);
}
