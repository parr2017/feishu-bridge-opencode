/**
 * opencode 2.x 权限申请的归一化视图。
 *
 * 搬运自 co-team `packages/opencode-sync/src/perm.ts`（原文说明：飞书卡 / web / mobile 三端共用）。
 *
 * 为什么必须归一：opencode v2 的真实载荷是
 *   { id, sessionID, action, resources, save?, metadata?, source?, message? }
 * 早期代码按 v1 的 { title, pattern, command, type } 取值——这四个字段在 2.x 一律不存在，
 * 于是所有端都落到兜底串「权限请求」，审批人根本看不出申请的是什么。
 * 这里是唯一的格式化源：v2 真字段优先，v1/更早字段兜底。
 */
/** 动作名 → 中文说法。键为归一化后的小写动作名（去 - _ 空格）。 */
const ACTION_LABELS = {
    read: '读取文件',
    readfile: '读取文件',
    file_read: '读取文件',
    write: '写入文件',
    writefile: '写入文件',
    create: '新建文件',
    edit: '修改文件',
    editfile: '修改文件',
    patch: '修改文件',
    applypatch: '修改文件',
    multiedit: '修改文件',
    delete: '删除文件',
    remove: '删除文件',
    glob: '匹配文件',
    list: '浏览目录',
    ls: '浏览目录',
    grep: '搜索文件',
    search: '搜索代码',
    bash: '执行命令',
    shell: '执行命令',
    command: '执行命令',
    exec: '执行命令',
    run: '执行命令',
    webfetch: '访问网络',
    fetch: '访问网络',
    http: '访问网络',
    websearch: '联网搜索',
    web_search: '联网搜索',
    externaldirectory: '访问项目外目录',
    outsidedirectory: '访问项目外目录',
    external_directory: '访问项目外目录',
    mcp: '调用 MCP 工具',
    task: '调用子 agent',
    agent: '调用子 agent',
    todo: '更新任务清单',
    todowrite: '更新任务清单',
    snapshot: '创建快照',
    revert: '回退改动',
};
/** 归一化动作名：小写 + 去分隔符（兼容 external_directory / external-directory） */
export function normalizePermAction(action) {
    return String(action || '')
        .trim()
        .toLowerCase()
        .replace(/[\s._-]+/g, '');
}
/** 动作名 → 中文说法；未登记的动作回落原名（宁可 ugly 也不空手） */
export function permActionLabel(action) {
    const raw = String(action || '').trim();
    if (!raw)
        return '权限请求';
    return ACTION_LABELS[normalizePermAction(raw)] || raw;
}
function stringsOf(value) {
    if (Array.isArray(value))
        return value.map((v) => String(v ?? '').trim()).filter(Boolean);
    const s = String(value ?? '').trim();
    return s ? [s] : [];
}
function dedupe(list) {
    return [...new Set(list.filter(Boolean))];
}
export function clipText(text, max) {
    const s = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}
/**
 * 归一化一个权限申请。null/undefined 返回 null——调用方自己决定兜底文案。
 * 资源取值优先级：v2 resources → v1 patterns → 旧 pattern/command → metadata.command/pattern。
 */
export function permViewOf(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const md = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
    const action = String(raw.action || raw.permission || raw.type || '').trim();
    const label = permActionLabel(action);
    const resources = dedupe([
        ...stringsOf(raw.resources),
        ...stringsOf(raw.patterns),
        ...stringsOf(raw.pattern),
        ...stringsOf(raw.command),
        ...stringsOf(md.command),
        ...stringsOf(md.pattern),
        ...stringsOf(md.filePath),
        ...stringsOf(md.filepath),
    ]);
    const save = dedupe(stringsOf(raw.save));
    const alwaysRule = save.join(' , ');
    const message = String(raw.message || raw.title || '').trim();
    // metadata 剩余项：已消费 command/pattern/filePath/filepath，其余才值得给审批人看
    const consumed = new Set(['command', 'pattern', 'filePath', 'filepath']);
    const rest = {};
    for (const [k, v] of Object.entries(md)) {
        if (!consumed.has(k) && v !== undefined && v !== null && v !== '')
            rest[k] = v;
    }
    let extra = '';
    if (Object.keys(rest).length) {
        try {
            extra = clipText(JSON.stringify(rest), 400);
        }
        catch {
            extra = '';
        }
    }
    const first = resources[0] || '';
    const summary = first
        ? resources.length > 1
            ? clipText(`${label} ${first} 等 ${resources.length} 项`, 80)
            : clipText(`${label} ${first}`, 80)
        : clipText(message || label, 80);
    const lines = [{ label: '动作', value: label === action ? label : action ? `${label}（${action}）` : label }];
    if (resources.length) {
        // 资源多时主行只给前几条 + 计数（全量交给折叠区，避免同一屏看两遍）
        const head = resources.length > 3 ? [...resources.slice(0, 3), `等 ${resources.length} 项`] : resources;
        lines.push({ label: '目标', value: clipText(head.join(' , '), 300) });
    }
    // 说明行只在真的多出信息时给：与摘要相同、或就是某条资源都不重复渲染
    if (message && message !== summary && !resources.includes(message)) {
        lines.push({ label: '说明', value: clipText(message, 200) });
    }
    if (alwaysRule) {
        // save 为通配时点明含义——「记住 *」单看容易以为只放行这一次
        lines.push({ label: '总是批准将记住', value: clipText(alwaysRule === '*' ? '*（该动作不限具体对象）' : alwaysRule, 200) });
    }
    return { id: String(raw.id || ''), action, label, resources, summary, lines, alwaysRule, extra };
}
/** 只要一行摘要的快捷方式；拿不到视图时回落「权限请求」（绝不返回空串）。 */
export function permSummaryOf(raw) {
    return permViewOf(raw)?.summary || '权限请求';
}
