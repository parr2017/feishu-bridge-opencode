/**
 * 配置加载。
 *
 * 优先级（高 → 低）：
 *   1. `ctx.options` —— 仅包插件能拿到（自动发现的插件是空的，实测）
 *   2. 环境变量     —— `FEISHU_*`，适合 CI / 临时覆盖
 *   3. 配置文件     —— 引导向导写的就是它，见下
 *   4. 默认值
 *
 * 配置文件按顺序找第一个存在的：
 *   $FEISHU_CONFIG_FILE
 *   <cwd>/.opencode/feishu.json          项目级
 *   ~/.config/opencode/opencode-feishu.json   全局（推荐，任何目录都能用）
 *
 * 用 `npm run setup` 生成配置文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LogLevel } from './log.ts';

export type SessionMode = 'new-per-chat' | 'shared';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  apiBase: string;
  /** 能点审批卡/权限卡的 open_id 白名单；为空时卡片不渲染按钮 */
  approvers: string[];
  /** 结果推送落点；为空时回落到「最后一次说话的会话」 */
  notifyChatId?: string;
  wsEnabled: boolean;
  webhookPort?: number;
  encryptKey?: string;
  verificationToken?: string;
  sessionMode: SessionMode;
  logLevel: LogLevel;
  logFile?: string;
  /** 实际生效的配置文件路径（没读到就是 undefined）——启动日志里会打出来 */
  configPath?: string;
}

type Raw = Record<string, unknown>;

/** 全局配置文件默认位置（向导写这里）。 */
export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode-feishu.json');
}

export function configFileCandidates(cwd: string): string[] {
  const out: string[] = [];
  const explicit = process.env.FEISHU_CONFIG_FILE;
  if (explicit && explicit.trim()) out.push(explicit.trim());
  out.push(join(cwd, '.opencode', 'feishu.json'));
  out.push(defaultConfigPath());
  return out;
}

/** 读第一个能解析的配置文件；坏文件跳过而不是让插件起不来。 */
export function readConfigFile(cwd: string): { path: string; data: Raw } | null {
  for (const path of configFileCandidates(cwd)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      continue; // 不存在
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) return { path, data: data as Raw };
    } catch {
      // 文件存在但坏了：明确告警，别静默当成「没配置」
      process.stderr.write(`[opencode-feishu] WARN 配置文件解析失败，已跳过：${path}\n`);
    }
  }
  return null;
}

/** 三级取值：options → env → file。 */
function pick(options: Raw, file: Raw, envKey: string, key: string): string | undefined {
  const candidates = [options[key], process.env[envKey], file[key]];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickBool(options: Raw, file: Raw, envKey: string, key: string, fallback: boolean): boolean {
  const candidates = [options[key], process.env[envKey], file[key]];
  for (const v of candidates) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string' && v.trim()) return !/^(0|false|no|off)$/i.test(v.trim());
  }
  return fallback;
}

function pickList(options: Raw, file: Raw, envKey: string, key: string): string[] {
  for (const raw of [options[key], process.env[envKey], file[key]]) {
    if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
    if (typeof raw === 'string' && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function loadConfig(options: Raw = {}, cwd: string = process.cwd()): FeishuConfig {
  const found = readConfigFile(cwd);
  const file: Raw = found?.data ?? {};

  const apiBase = (pick(options, file, 'FEISHU_API_BASE', 'apiBase') ?? 'https://open.feishu.cn').replace(/\/+$/, '');
  const portRaw = pick(options, file, 'FEISHU_WEBHOOK_PORT', 'webhookPort');
  const port = portRaw ? Number(portRaw) : undefined;
  const sessionModeRaw = pick(options, file, 'FEISHU_SESSION_MODE', 'sessionMode');

  return {
    appId: pick(options, file, 'FEISHU_APP_ID', 'appId') ?? '',
    appSecret: pick(options, file, 'FEISHU_APP_SECRET', 'appSecret') ?? '',
    apiBase,
    approvers: pickList(options, file, 'FEISHU_APPROVERS', 'approvers'),
    notifyChatId: pick(options, file, 'FEISHU_NOTIFY_CHAT_ID', 'notifyChatId'),
    wsEnabled: pickBool(options, file, 'FEISHU_WS_ENABLED', 'wsEnabled', true),
    webhookPort: Number.isInteger(port) && port! > 0 ? port : undefined,
    encryptKey: pick(options, file, 'FEISHU_ENCRYPT_KEY', 'encryptKey'),
    verificationToken: pick(options, file, 'FEISHU_VERIFICATION_TOKEN', 'verificationToken'),
    sessionMode: sessionModeRaw === 'shared' ? 'shared' : 'new-per-chat',
    logLevel: (pick(options, file, 'FEISHU_LOG_LEVEL', 'logLevel') as LogLevel) ?? 'info',
    logFile: pick(options, file, 'FEISHU_LOG_FILE', 'logFile'),
    ...(found ? { configPath: found.path } : {}),
  };
}

/** 启动前校验：返回 null 表示可以启动，否则是给用户看的说明。 */
export function validateConfig(cfg: FeishuConfig): string | null {
  if (!cfg.appId || !cfg.appSecret) {
    return '缺少 app_id / app_secret —— 跑 `npm run setup` 生成配置，或设环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET';
  }
  if (!cfg.wsEnabled && !cfg.webhookPort) {
    return '入站通道全关：wsEnabled=false 且未配 webhookPort，飞书消息进不来';
  }
  return null;
}

/**
 * 配置模板（有效 JSON，未知字段会被忽略）。
 *
 * 为什么需要它：**插件跑在 opencode 服务进程里，拿不到用户的终端**，
 * 所以「装插件的人」跑不了交互式向导。这里的做法是——
 * 没配置时把模板落到磁盘，用户填两行保存即可，插件**监听文件变化自动重连**，
 * 连重启 opencode 都不用。
 */
export function configTemplate(): Record<string, unknown> {
  return {
    _help: '填好 appId / appSecret 保存即可（插件会自动重连，不用重启 opencode）。approvers 是能点审批卡的 open_id 白名单，可以先留空后补。',
    appId: '',
    appSecret: '',
    approvers: [],
    apiBase: 'https://open.feishu.cn',
    wsEnabled: true,
    logLevel: 'info',
  };
}

/** 没配置时写一份模板；已存在则不动。返回写出的路径，或 null（已存在/写失败）。 */
export function writeConfigTemplateIfMissing(path = defaultConfigPath()): string | null {
  if (existsSync(path)) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(configTemplate(), null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}
