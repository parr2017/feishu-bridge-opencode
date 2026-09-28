import { btnRow, card2, note } from "./cards.js";
const PANEL_ACT = 'panel';
const ROWS = [
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
export function buildPanelCard() {
    const elements = [];
    for (const row of ROWS) {
        const btns = row.map(([text, cmd, type]) => ({ text, cmd, type: type ?? 'default' }));
        if (btns.length === 1)
            elements.push(singleBtn(btns[0]));
        else if (btns.length === 2)
            elements.push(btnRow(singleBtn(btns[0]), singleBtn(btns[1])));
        else
            elements.push(threeCols(btns));
    }
    elements.push(note('opencode-feishu · 功能面板 · 点击即执行，结果以消息推送'));
    return card2('blue', '🎛 opencode 功能面板', elements);
}
function singleBtn(b) {
    return {
        tag: 'button',
        text: { tag: 'plain_text', content: b.text },
        type: b.type,
        size: 'medium',
        behaviors: [{ type: 'callback', value: { act: PANEL_ACT, cmd: b.cmd } }],
    };
}
function threeCols(btns) {
    return {
        tag: 'column_set',
        flex_mode: 'trisect',
        columns: btns.map((b) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [singleBtn(b)] })),
    };
}
