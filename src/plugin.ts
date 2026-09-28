/**
 * 插件入口：把 opencode 的 `ctx` 适配成本项目用的 `OpencodeApi`，然后拉起 Bridge。
 *
 * 两个关键约束决定了这里的写法：
 *
 * 1. **`setup` 是按 location（项目目录）跑的**，不是进程级一次。多个项目目录会让它跑多次；
 *    如果每次都建一条飞书长连接，同一条飞书消息会被随机投递到其中一条，行为不可预期。
 *    所以有进程级单例守卫。
 *
 * 2. **插件拿不到用户的终端**（它跑在 opencode 服务进程里），所以做不了交互式配置向导。
 *    替代方案：没配置时把模板落到磁盘，并**监听配置文件变化**——用户填好保存就自动接上，
 *    连重启 opencode 都不用。有仓库的人仍可用 `npm run setup` 走完整向导。
 */
import { log, configureLog } from './log.ts';
import { Bridge, type OpencodeApi } from './bridge.ts';
import { defaultConfigPath, loadConfig, validateConfig, writeConfigTemplateIfMissing } from './config.ts';
import { watchConfigFile } from './configWatcher.ts';
import type { KvStore } from './state.ts';

let active: Bridge | null = null;
let activeDirectory: string | null = null;
let stopWatching: (() => void) | null = null;
let shuttingDown = false;

/** 把 opencode 的插件 ctx 适配成我们声明的窄接口。 */
export function adaptCtx(ctx: any): OpencodeApi {
  const session = ctx?.session ?? {};
  const permission = ctx?.permission ?? {};

  return {
    directory: String(ctx?.location?.directory ?? process.cwd()),
    createSession: (input) => session.create(input ?? {}),
    getSession: (input) => session.get(input),
    prompt: (input) => session.prompt(input),
    interrupt: (input) => session.interrupt(input),
    switchModel: (input) => session.switchModel(input),
    switchAgent: (input) => session.switchAgent(input),
    listModels: async () => normalizeChoices(await ctx?.model?.list?.({})),
    listAgents: async () => normalizeChoices(await ctx?.agent?.list?.({})),
    permissionReply: (input) => permission.reply(input),
    subscribe: (handler) => ctx.event.subscribe(handler),
    hook: (ns, event, cb) => ctx[ns].hook(event, cb),
    // 接管 question 工具（提问走飞书作答）——见 src/ask.ts
    toolTransform: (cb) => ctx.tool.transform(cb),
    storage: adaptStorage(ctx?.storage),
  };
}

/**
 * `model.list()` / `agent.list()` 的返回形状没有公开文档，这里做宽容归一。
 * 实测 `ctx.model.list({})` 返回的是对象数组，字段名可能是 id / modelID / name。
 */
function normalizeChoices(raw: unknown): { id: string; label: string; isDefault?: boolean }[] {
  const arr: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.data)
      ? (raw as any).data
      : Array.isArray((raw as any)?.items)
        ? (raw as any).items
        : [];
  return arr
    .map((item): { id: string; label: string; isDefault?: boolean } | null => {
      if (typeof item === 'string') return { id: item, label: item };
      const id = String(item?.id ?? item?.modelID ?? item?.name ?? '');
      if (!id) return null;
      const provider = item?.providerID ? `${item.providerID}/` : '';
      const label = String(item?.name ?? item?.label ?? id);
      const isDefault = item?.default === true || item?.is_default === true || item?.isDefault === true;
      return {
        id: provider && !id.includes('/') ? `${provider}${id}` : id,
        label,
        ...(isDefault ? { isDefault: true } : {}),
      };
    })
    .filter((x): x is { id: string; label: string; isDefault?: boolean } => x !== null);
}

function adaptStorage(storage: any): KvStore {
  if (storage && typeof storage.get === 'function' && typeof storage.set === 'function') {
    return {
      get: async <T>(key: string) => ((await storage.get(key)) as T | undefined) ?? null,
      set: async (key: string, value: unknown) => {
        await storage.set(key, value);
      },
      remove: async (key: string) => {
        if (typeof storage.remove === 'function') await storage.remove(key);
      },
    };
  }
  // ctx.storage 不可用时降级为内存实现：功能可用但重启即失忆
  log.warn('ctx.storage 不可用，绑定关系降级为内存存储（重启后丢失）');
  const m = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => (m.get(key) as T | undefined) ?? null,
    set: async (key: string, value: unknown) => void m.set(key, value),
    remove: async (key: string) => void m.delete(key),
  };
}

// ---------------------------------------------------------------- 生命周期

function installSignalHandlers(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const shutdown = () => {
    stopWatching?.();
    stopWatching = null;
    void active?.dispose();
    active = null;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('beforeExit', shutdown);
}

async function launch(api: OpencodeApi, options: Record<string, unknown>): Promise<void> {
  if (active) return;
  try {
    const bridge = new Bridge(api, options);
    active = bridge;
    activeDirectory = api.directory;
    await bridge.start();
  } catch (e) {
    active = null;
    // 插件初始化失败不能把 opencode 拖死
    log.error('飞书插件启动失败', { error: String((e as Error)?.stack ?? e).slice(0, 600) });
  }
}

// ---------------------------------------------------------------- 配置热加载

/**
 * 未配置时盯住配置文件：用户填好保存 → 自动接上。
 *
 * 逻辑在 `configWatcher.ts`（独立出来是为了能单测——这段依赖 fs 事件与时序，
 * 靠驱动 opencode 验证不可靠，它的插件 setup 是惰性触发的）。
 */
function watchConfig(api: OpencodeApi, options: Record<string, unknown>): void {
  if (stopWatching) return;
  stopWatching = watchConfigFile({
    cwd: api.directory,
    options,
    log: (msg, extra) => log.info(msg, extra),
    onReady: () => {
      stopWatching = null;
      void launch(api, options);
    },
  });
  log.info(`正在监听配置文件变化（保存即生效）：${defaultConfigPath()}`);
}

// ---------------------------------------------------------------- 入口

/**
 * 插件主体。opencode 调用 `setup(ctx)` 时，opencode.json 里 plugin 元组的第二项
 * 会作为 `ctx.options` 传进来（实测确认，不是第二个参数）。
 */
export async function startPlugin(ctx: any, optionsOverride?: Record<string, unknown>): Promise<void> {
  const options: Record<string, unknown> = optionsOverride ?? (ctx?.options as Record<string, unknown>) ?? {};
  configureLog((options.logLevel as any) ?? 'info', (options.logFile as string) ?? process.env.FEISHU_LOG_FILE);

  const api = adaptCtx(ctx);

  if (active) {
    log.info('飞书桥已在运行，跳过本 location 的重复初始化', { already: activeDirectory, skipped: api.directory });
    return;
  }

  const cfg = loadConfig(options, api.directory);
  const problem = validateConfig(cfg);

  if (problem) {
    log.warn(`飞书插件未启用：${problem}`);
    const written = writeConfigTemplateIfMissing();
    if (written) {
      log.warn(
        `已生成配置模板 → ${written}\n` +
          '  填好 appId / appSecret 保存即可，插件会自动接上（不用重启 opencode）。\n' +
          '  appSecret 到飞书开放平台「凭证与基础信息」拿；approvers 可以先留空。',
      );
    } else {
      log.warn(`请编辑配置：${cfg.configPath ?? defaultConfigPath()}`);
    }
    installSignalHandlers();
    watchConfig(api, options);
    return;
  }

  installSignalHandlers();
  await launch(api, options);
}
