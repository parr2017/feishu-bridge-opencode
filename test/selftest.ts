/**
 * 纯逻辑自测（不需要 opencode、不需要飞书凭据）。
 *
 * 覆盖：卡片 2.0 构件、权限载荷归一、表单字段映射与状态机、四类列表卡、面板卡。
 *
 *   npm run selftest
 *
 * 为什么不用 vitest/jest：这些模块零依赖、只做纯函数，用 tsc 编译后直接 node 跑最省事，
 * 也避免为了测试再引一整套运行时。
 */
import { card2, cardResponse, buildResultCard, clip, collapse, form, inputField, note, submitBtn } from '../src/feishu/cards.ts';
import { permViewOf, permSummaryOf, clipText } from '../src/feishu/permView.ts';
import { formFieldsOf, initialFormValues, missingRequiredKeys, buildFormAnswer } from '../src/feishu/formView.ts';
import { buildSessionsCard, buildModelsCard, buildAgentsCard, buildInboxCard } from '../src/feishu/listCards.ts';
import { buildPanelCard } from '../src/feishu/panelCard.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchConfigFile } from '../src/configWatcher.ts';

let failures = 0;

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures++;
  console.error(`  ✗ ${name}${extra === undefined ? '' : ` :: ${JSON.stringify(extra)}`}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- 权限载荷归一

section('permView —— opencode v2 权限载荷归一');
{
  const v2 = permViewOf({
    id: 'per_1',
    sessionID: 'ses_1',
    action: 'external_directory',
    resources: ['C:/Windows/*', 'D:/secrets/*'],
    save: ['C:/Windows/*'],
    source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
  });
  check('动作名归一成中文', v2?.label === '访问项目外目录', v2?.label);
  check('资源列表完整', v2?.resources.length === 2, v2?.resources);
  check('总是批准规则取自 save', v2?.alwaysRule === 'C:/Windows/*', v2?.alwaysRule);
  check('渲染出「总是批准将记住」行', !!v2?.lines.some((l) => l.label === '总是批准将记住'), v2?.lines);
  check('摘要含动作名', (v2?.summary ?? '').includes('访问项目外目录'), v2?.summary);
  check('空载荷回落「权限请求」', permSummaryOf(null) === '权限请求');
  check('未登记动作回落原名', permViewOf({ action: 'weird_action' })?.label === 'weird_action');
  check('资源多时主行折叠计数', (permViewOf({ action: 'read', resources: ['a', 'b', 'c', 'd'] })?.lines[1]?.value ?? '').includes('等 4 项'));
  check('clipText 截断', clipText('a'.repeat(100), 10).length === 11);
}

// ---------------------------------------------------------------- 表单

section('formView —— v2 Form.Field 映射与状态机');
{
  const fields = formFieldsOf([
    { key: 'q0', title: 'Database', type: 'string', options: [{ value: 'SQLite', label: 'SQLite' }], custom: true, required: true },
    { key: 'q1', title: 'Notes', type: 'string' },
    { key: 'q2', title: 'Count', type: 'integer' },
    { key: 'q3', title: 'Enabled', type: 'boolean' },
    { key: 'q4', title: 'Tags', type: 'multiselect', options: [{ value: 'a', label: 'A' }] },
    { key: 'q5', title: 'Hidden', type: 'string', hidden: true },
  ]);
  check('字段数量', fields.length === 6, fields.length);
  check('string + options → select', fields[0]?.type === 'select', fields[0]?.type);
  check('string 无 options → input', fields[1]?.type === 'input', fields[1]?.type);
  check('integer → number', fields[2]?.type === 'number', fields[2]?.type);
  check('boolean → boolean', fields[3]?.type === 'boolean', fields[3]?.type);
  check('multiselect → multiselect 且 multiple', fields[4]?.type === 'multiselect' && fields[4]?.multiple === true);

  const values = initialFormValues(fields);
  check('hidden 字段不占 UI 状态', !('q5' in values), Object.keys(values));
  check('初始必填未答 = q0', missingRequiredKeys(fields, values).join(',') === 'q0', missingRequiredKeys(fields, values));

  values.q0!.selected = ['SQLite'];
  check('作答后必填校验通过', missingRequiredKeys(fields, values).length === 0);
  values.q1!.text = 'hello';
  values.q2!.num = 7;
  values.q3!.bool = true;
  values.q4!.selected = ['a'];

  const answer = buildFormAnswer(fields, values);
  check('select（单选）→ 字符串', answer.q0 === 'SQLite', answer.q0);
  check('input → 字符串', answer.q1 === 'hello', answer.q1);
  check('number → 数字', answer.q2 === 7, answer.q2);
  check('boolean → 布尔', answer.q3 === true, answer.q3);
  check('multiselect → 数组', Array.isArray(answer.q4) && (answer.q4 as string[])[0] === 'a', answer.q4);
  check('hidden 字段不提交', !('q5' in answer), Object.keys(answer));
}

// ---------------------------------------------------------------- 卡片构件

section('cards —— 卡片 2.0 构件');
{
  const c = card2('blue', 'T', [{ tag: 'markdown', content: 'x' }]);
  check('card2 用 schema 2.0', c.schema === '2.0', c.schema);
  check('card2 有 body.elements', Array.isArray((c.body as any)?.elements));
  check('card2 带 header 模板', (c.header as any)?.template === 'blue', c.header);
  check('cardResponse 包成 {card:{type:raw}}', (cardResponse(c) as any)?.card?.type === 'raw');
  check('否定结论 → red', (buildResultCard('已拒绝', ['x']) as any).header.template === 'red');
  check('肯定结论 → green', (buildResultCard('已批准', ['x']) as any).header.template === 'green');
  check('长文本截断带提示', clip('y'.repeat(3000), 100).includes('截断'));

  // ---- 飞书卡片 2.0 的字段红线 ----
  // 这几条是「多一个字段整卡被拒」的坑，来自 co-team f3fcd55（真机发卡验收 + 逐字段探针）。
  // 200621 unknown property / 230099 / 11310 全是整卡被拒，用户侧表现是「什么都没收到」。
  const panel = collapse('全部目标（8 项）', [{ tag: 'markdown', content: '1. a' }]) as Record<string, any>;
  check('collapse：顶层不能有 expand', panel.expand === undefined, panel.expand);
  check('collapse：header 不能有 expand（200621 unknown property）', panel.header?.expand === undefined, panel.header?.expand);
  check('collapse：header 只允许 title/background_color/vertical_align', JSON.stringify(Object.keys(panel.header).sort()) === JSON.stringify(['background_color', 'title', 'vertical_align']), Object.keys(panel.header));
  check('collapse：header 不能有 padding', panel.header?.padding === undefined, panel.header?.padding);
  check('collapse：border 只允许 color/corner_radius', JSON.stringify(Object.keys(panel.border).sort()) === JSON.stringify(['color', 'corner_radius']), Object.keys(panel.border));
  check('collapse：tag 正确', panel.tag === 'collapsible_panel', panel.tag);

  check('note 是 markdown（2.0 不支持 1.0 note 标签）', note('落款').tag === 'markdown');

  check('inputField：max_length 封顶 1000（11310 整卡被拒）', (inputField('a', 'x', 5000) as any).max_length === 1000);

  const f = form('ib_x', [inputField('answer', '输入…'), submitBtn('发送', 'go')]) as Record<string, any>;
  const submit = f.elements[f.elements.length - 1] as any;
  check('form：提交按钮带 form_action_type（否则拿不到 form_value）', submit.form_action_type === 'submit', submit.form_action_type);
  check('form：提交按钮的 name 是路由令牌', submit.name === 'go', submit.name);
}

// ---------------------------------------------------------------- 列表卡

section('listCards —— 列表卡与翻页');
{
  const s = buildSessionsCard([{ id: 'ses_abcdef123456', title: 'A' }, { id: 'ses_bbbbbb123456', title: 'B' }], 0, 'ses_abcdef123456');
  check('会话卡 schema 2.0', s.schema === '2.0', s.schema);
  check('当前会话打标', JSON.stringify(s).includes('当前会话'));
  check('会话卡带新建按钮', JSON.stringify(s).includes('"act":"oc_new"'));

  const m = buildModelsCard(Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, label: `M${i}` })), 1);
  check('9 条模型 → 第 2/2 页', JSON.stringify(m).includes('第 2/2 页'));

  const a = buildAgentsCard([{ id: 'build', label: 'build' }]);
  check('Agent 卡渲染', a.schema === '2.0');
  check('Agent 卡带切换动作', JSON.stringify(a).includes('"act":"oc_pick_agent"'));

  const ib = buildInboxCard([{ kind: 'perm', title: '读取文件 x', ref: 'k1' }]);
  check('收件箱卡携带 ref', JSON.stringify(ib).includes('"ref":"k1"'));
  check('空收件箱给友好文案', JSON.stringify(buildInboxCard([])).includes('没有等你拍板'));
}

// ---------------------------------------------------------------- 面板

section('panelCard —— 功能面板');
{
  const p = buildPanelCard();
  check('面板卡 schema 2.0', p.schema === '2.0', p.schema);
  check('面板按钮合成命令', JSON.stringify(p).includes('"/inbox"'));
  check('面板动作标记为 panel', JSON.stringify(p).includes('"act":"panel"'));
}

// ---------------------------------------------------------------- 配置热加载

section('configWatcher —— 配置文件热加载（插件自动接上）');
{
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const root = mkdtempSync(join(tmpdir(), 'ocfeishu-'));
  const dir = join(root, '.opencode');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'feishu.json');

  // 用 FEISHU_CONFIG_FILE 钉住候选路径，避免读到开发者本机的真实配置导致测试不稳定
  const prevEnv = process.env.FEISHU_CONFIG_FILE;
  process.env.FEISHU_CONFIG_FILE = file;

  try {
    // 初始：无效配置（缺 appId）
    writeFileSync(file, JSON.stringify({ appId: '', appSecret: '' }), 'utf-8');

    let ready: string | null = null;
    const stop = watchConfigFile({
      cwd: root,
      debounceMs: 50,
      onReady: (cfg) => {
        ready = cfg.appId;
      },
    });

    await sleep(300);
    check('无效配置不触发（继续等用户填）', ready === null, ready);

    writeFileSync(file, JSON.stringify({ appId: 'cli_x', appSecret: 's' }), 'utf-8');
    await sleep(700);
    check('填好保存后自动触发', ready === 'cli_x', ready);

    ready = null;
    writeFileSync(file, JSON.stringify({ appId: 'cli_y', appSecret: 's' }), 'utf-8');
    await sleep(400);
    check('触发后自动停止监听（不重复启动）', ready === null, ready);

    stop();
  } finally {
    if (prevEnv === undefined) delete process.env.FEISHU_CONFIG_FILE;
    else process.env.FEISHU_CONFIG_FILE = prevEnv;
    rmSync(root, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------

console.log('');
if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('全部通过');
