/**
 * 配置文件热加载。
 *
 * 为什么需要它：**插件跑在 opencode 服务进程里，拿不到用户的终端**，
 * 所以「装插件的人」跑不了交互式向导。退而求其次的做法是——
 * 没配置时把模板落到磁盘，然后盯住这个文件；用户填好保存，插件自动接上，
 * 连重启 opencode 都不用。
 *
 * 单独成文件是为了能单测：这段逻辑依赖 fs 事件和时序，靠驱动 opencode 验证不可靠
 * （opencode 的插件 setup 是惰性触发的）。
 */
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { configFileCandidates, loadConfig, validateConfig } from "./config.js";
/**
 * 监听配置文件所在目录，直到配置变有效为止。返回停止函数。
 *
 * 注意：目录不存在时（用户还没建）会静默跳过——opencode 重启后会重新走到这里。
 */
export function watchConfigFile(opts) {
    const { cwd, options = {}, onReady, log, debounceMs = 500 } = opts;
    const targets = configFileCandidates(cwd);
    // ⚠️ 平台差异：fs.watch 回调里的 filename，Windows 给的是**文件名**（feishu.json），
    // 有的平台给完整路径。两边都比一遍，否则事件会被全部忽略（实测踩过）。
    const wantedNames = new Set();
    for (const p of targets) {
        wantedNames.add(p.toLowerCase());
        wantedNames.add(basename(p).toLowerCase());
    }
    const dirs = [...new Set(targets.map((p) => dirname(p)))];
    let stopped = false;
    let timer = null;
    const watchers = [];
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        if (timer)
            clearTimeout(timer);
        for (const w of watchers) {
            try {
                w.close();
            }
            catch {
                /* ignore */
            }
        }
        watchers.length = 0;
    };
    const check = () => {
        if (stopped)
            return;
        const cfg = loadConfig(options, cwd);
        const problem = validateConfig(cfg);
        if (problem)
            return; // 还没填好，继续等
        stop();
        log?.('检测到配置已就绪，正在启动飞书桥…', { config: cfg.configPath });
        void onReady(cfg);
    };
    const schedule = (filename) => {
        if (stopped)
            return;
        // 有些平台不给 filename，那就只能一律重查
        if (filename && !wantedNames.has(filename.toLowerCase()))
            return;
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(check, debounceMs);
    };
    for (const dir of dirs) {
        try {
            const w = watch(dir, { persistent: false }, (_event, filename) => schedule(typeof filename === 'string' ? filename : null));
            w.on('error', () => {
                /* 目录被删了就放弃这条监听 */
            });
            watchers.push(w);
        }
        catch {
            // 目录还不存在
        }
    }
    return stop;
}
