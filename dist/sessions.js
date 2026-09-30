var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
/**
 * 读取 opencode 的真实会话列表。
 *
 * 为什么绕这一层：opencode v2 的插件 `ctx.session` **没有 list 方法**（实测 runtime keys
 * 只有 hook/create/get/prompt/interrupt/…），插件想列出用户已有的会话，只能直接读
 * opencode 自己的 SQLite 库（只读）。
 *
 * opencode 跑在 Bun 上，Bun 自带 `bun:sqlite`，所以这条路在插件里是通的（实测）；
 * 在 Node 下（自测）import 会失败，返回空数组即可。
 *
 * 只读打开 + 立即关闭，不碰 WAL、不写任何东西。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const DB_RELATIVE = join('.local', 'share', 'opencode', 'opencode.db');
function dbCandidates() {
    const out = [];
    const dataDir = process.env.OPENCODE_DATA_DIR;
    if (dataDir)
        out.push(join(dataDir, 'opencode.db'));
    out.push(join(homedir(), DB_RELATIVE));
    // Windows 上 opencode 也可能落在 LOCALAPPDATA
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData)
        out.push(join(localAppData, 'opencode', 'opencode.db'));
    return [...new Set(out)];
}
/** 最近活跃的 opencode 会话（跨项目，全目录）。拿不到就返回空数组——调用方自行降级。 */
export async function recentSessions(limit = 30) {
    const dbPath = dbCandidates().find((p) => existsSync(p));
    if (!dbPath)
        return [];
    let mod;
    try {
        // 用变量而不是字面量：TS 解析不到 bun:sqlite 的类型（它只在 Bun 运行时存在）
        const spec = 'bun:' + 'sqlite';
        mod = await import(__rewriteRelativeImportExtension(/* @vite-ignore */ spec));
    }
    catch {
        return []; // 不是 Bun 运行时（单测环境）
    }
    try {
        const db = new mod.Database(dbPath, { readonly: true });
        const rows = db
            .query('SELECT id, directory, title, time_updated FROM session_v2 ORDER BY time_updated DESC LIMIT ?')
            .all(limit);
        db.close();
        return rows
            .filter((r) => typeof r?.id === 'string' && r.id.startsWith('ses'))
            .map((r) => ({
            id: String(r.id),
            title: String(r.title ?? '').trim(),
            directory: String(r.directory ?? ''),
            updatedAt: Number(r.time_updated ?? 0),
        }));
    }
    catch (e) {
        // 库被锁 / schema 变了：降级为空，不影响主流程
        return [];
    }
}
/** 目录路径 → 短标签（最后一段），用于卡片上区分「这是哪个项目的事」。 */
export function shortDir(dir) {
    const norm = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    return norm.split('/').filter(Boolean).at(-1) || norm || '（未知目录）';
}
