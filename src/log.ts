/**
 * 极简分级日志。插件跑在 opencode 进程内，stdout 会被 TUI 吃掉，
 * 所以默认写 stderr；配了 FEISHU_LOG_FILE 再追加一份到文件（排查「为什么没反应」全靠它）。
 */
import { appendFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;
let file: string | undefined;

export function configureLog(level: LogLevel, filePath?: string): void {
  threshold = ORDER[level] ?? ORDER.info;
  file = filePath || undefined;
}

function emit(level: LogLevel, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const tail = extra === undefined ? '' : ` ${safe(extra)}`;
  const line = `${new Date().toISOString()} [opencode-feishu] ${level.toUpperCase()} ${msg}${tail}`;
  process.stderr.write(`${line}\n`);
  if (file) {
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      /* 日志写不进去不能影响主流程 */
    }
  }
}

function safe(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 800 ? `${s.slice(0, 800)}…` : s;
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
