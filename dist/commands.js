/**
 * 指令集。骨架来自 co-team `server/src/feishu/commands.ts`（按模式域解析、
 * 裸命令看选项带参数才执行、交互列表卡优先于文本）。
 *
 * co-team 有 task / convo / oc 三个模式域；opencode 插件只有「会话」一个域，
 * 所以这里是一份单域简化版，但保留了那两条交互约定：
 *   1. 裸命令（`/model`）→ 出交互卡；带参数（`/model 2`）→ 直接执行；
 *   2. 卡片动作全部经 `CommandResult.card` 回传，由 bridge 决定发送还是原地替换。
 */
import { log } from "./log.js";
export const HELP = [
    '**opencode × 飞书**',
    '直接发消息 = 作为 prompt 发给当前绑定的 opencode 会话，执行完推送结果。',
    '',
    '**会话**',
    '`/new [标题]` 新建并绑定 · `/list` 会话列表（可点按钮切换）',
    '`/switch 序号` 切换绑定 · `/stop` 中止执行',
    '',
    '**模型 / Agent**',
    '`/model` 看列表并点选切换 · `/agent` 同上',
    '',
    '**其它**',
    '`/inbox` 待拍板收件箱（权限 / 提问） · `/panel` 按钮面板',
    '`/status` 状态 · `/help` 本帮助',
    '',
    '**审批与提问**',
    'opencode 需要授权时推权限卡，点「批准一次 / 总是批准 / 拒绝」。',
    'opencode 向你提问时推提问卡，点选项或填答案后提交，agent 会接着往下跑。',
    '白名单外的账号点不动按钮（需要 `FEISHU_APPROVERS` 配置）。',
].join('\n');
export async function handleCommand(text, host) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/'))
        return { reply: '', passthrough: true };
    const [rawCmd = '', ...rest] = trimmed.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = rest.join(' ').trim();
    try {
        switch (cmd) {
            case '/help':
            case '/?':
                return { reply: HELP };
            case '/panel':
                return { reply: '', card: await host.panel() };
            case '/status':
                return { reply: await host.status() };
            case '/new':
                return await host.newSession(arg);
            case '/list':
            case '/sessions':
                return { reply: '', card: await host.listSessions() };
            case '/switch':
                return { reply: await host.switchSession(arg) };
            case '/model':
                return await host.models(arg);
            case '/agent':
                return await host.agents(arg);
            case '/inbox':
                return { reply: '', card: await host.inbox() };
            case '/stop':
                return { reply: await host.stop() };
            default:
                return { reply: `未知指令 \`${cmd}\`。\n\n${HELP}` };
        }
    }
    catch (e) {
        log.warn('指令执行失败', { cmd, error: String(e).slice(0, 200) });
        return { reply: `指令执行失败：${String(e?.message ?? e).slice(0, 200)}` };
    }
}
