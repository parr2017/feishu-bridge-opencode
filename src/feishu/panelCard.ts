/**
 * 功能面板卡（/help 与 /panel 的渲染载体）。
 *
 * 搬运自 co-team `server/src/feishu/panelCard.ts`：点击按钮 = 向既有命令管道
 * 合成一条消息（cmd 文本），命令解析/去重/回执全部复用；面板响应帧返回 undefined
 * （回滚 = 面板保留，可连点）。
 *
 * co-team 原版有 task/convo/oc 三套模式按钮，这里只有 opencode 一套。
 */
import type { CardElement } from './cards.ts';
import { btnRow, card2, note } from './cards.ts';

const PANEL_ACT = 'panel';

type Btn = [text: string, cmd: string, type?: 'primary' | 'default' | 'danger'];

const ROWS: Btn[][] = [
  [
    ['📥 收件箱', '/inbox', 'primary'],
    ['📈 状态', '/status'],
  ],
  [
    ['📜 会话列表', '/list', 'primary'],
    ['🆕 新建会话', '/new'],
    ['⏹ 中止', '/stop', 'danger'],
  ],
  [
    ['🧠 模型', '/model'],
    ['🤖 Agent', '/agent'],
  ],
];

export function buildPanelCard(): Record<string, unknown> {
  const elements: CardElement[] = [];
  for (const row of ROWS) {
    const btns = row.map(([text, cmd, type]) => ({ text, cmd, type: type ?? ('default' as const) }));
    if (btns.length === 1) elements.push(singleBtn(btns[0]!));
    else if (btns.length === 2) elements.push(btnRow(singleBtn(btns[0]!), singleBtn(btns[1]!)));
    else elements.push(threeCols(btns));
  }
  elements.push(note('opencode-feishu · 功能面板 · 点击即执行，结果以消息推送'));
  return card2('blue', '🎛 opencode 功能面板', elements);
}

interface BtnSpec {
  text: string;
  cmd: string;
  type: 'primary' | 'default' | 'danger';
}

function singleBtn(b: BtnSpec): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: b.text },
    type: b.type,
    size: 'medium',
    behaviors: [{ type: 'callback', value: { act: PANEL_ACT, cmd: b.cmd } }],
  };
}

function threeCols(btns: BtnSpec[]): CardElement {
  return {
    tag: 'column_set',
    flex_mode: 'trisect',
    columns: btns.map((b) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [singleBtn(b)] })),
  };
}

