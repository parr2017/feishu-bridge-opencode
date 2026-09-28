/**
 * 飞书卡片 2.0 构件库 —— 移植自 co-team `server/src/feishu/cards.ts`。
 *
 * 注释里那几条是实测踩出来的红线，别改：
 * 1. 2.0 不支持 1.0 的 `note` 标签（报 230099）——落款一律用 markdown。
 * 2. 按钮回调必须 `behaviors:[{type:'callback',value}]`，旧版写法长连接下收不到回调。
 * 3. 回调结果卡必须包成 `{card:{type:'raw',data}}` 随响应帧返回，裸卡片会被飞书回滚。
 * 4. `input` 的 `max_length` 上限 1000，超了整卡被拒（230099 / 11310）。
 * 5. `collapsible_panel` 老租户不支持会被整卡拒——只在正文真放不下时用。
 */

export type CardElement = Record<string, unknown>;

export function card2(template: string, title: string, elements: CardElement[]): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  };
}

export function md(content: string): CardElement {
  return { tag: 'markdown', content };
}

/** 落款/提示行（2.0 无 note 标签，用 markdown 替代）。 */
export function note(content: string): CardElement {
  return md(content);
}

export function collapse(title: string, elements: CardElement[]): CardElement {
  return {
    tag: 'collapsible_panel',
    header: { title: { tag: 'plain_text', content: title }, background_color: 'grey', expand: true },
    border: { color: 'grey', corner_radius: '6px' },
    elements,
  };
}

export function btn(text: string, type: 'primary' | 'default' | 'danger', value: Record<string, unknown>): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    size: 'medium',
    behaviors: [{ type: 'callback', value }],
  };
}

export function btnRow(left: CardElement, right: CardElement): CardElement {
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [left] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [right] },
    ],
  };
}

/** 表单输入框：submit 后回调 `action.form_value` 携带 `{name: 值}`。 */
export function inputField(name: string, placeholder: string, maxLength = 1000): CardElement {
  return {
    tag: 'input',
    name,
    max_length: Math.min(maxLength, 1000),
    placeholder: { tag: 'plain_text', content: placeholder },
  };
}

export function form(name: string, elements: CardElement[]): CardElement {
  return { tag: 'form', name, elements };
}

export function submitBtn(text: string, routeName: string): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: 'primary',
    size: 'medium',
    form_action_type: 'submit',
    name: routeName,
  };
}

/** 操作结果卡（随回调响应帧返回，原地替换被点的卡）。 */
export function buildResultCard(title: string, lines: string[]): Record<string, unknown> {
  const negative = /拒绝|取消|失败|超时|已处理|无权/.test(title);
  return card2(negative ? 'red' : 'green', title, [
    ...lines.map((l) => md(l)),
    note(`opencode-feishu · ${new Date().toLocaleString()}`),
  ]);
}

/** 响应帧包装：裸卡片 JSON 会被飞书当空响应回滚。 */
export function cardResponse(card: Record<string, unknown>): Record<string, unknown> {
  return { card: { type: 'raw', data: card } };
}

/** 兜底文本长度：飞书 markdown 卡有大小上限，长回复要截断。 */
export function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+$/g, '');
  return t.length > max ? `${t.slice(0, max)}\n\n…（截断，完整内容请在 opencode 查看）` : t;
}
