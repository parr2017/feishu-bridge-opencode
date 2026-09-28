/**
 * 卡住检测。
 *
 * 搬运自 co-team 的两处同类逻辑：
 *  - `server/src/feishu/stallWatch.ts`（任务侧，30 分钟无 journal）
 *  - `ocBridge.ts` 里的 `alive` Map + `scanStalled`（opencode 侧，事件驱动刷新活动时间）
 *
 * 这里合并成一份：任何 opencode 事件到达就刷新该会话的「最后活动时间」，
 * 回合收场（succeeded/interrupted/failed）就清除；某会话持续 busy 且 N 分钟无任何事件
 * → 推提醒卡（带「切换到此会话」「中止执行」「忽略」三个按钮，同一会话 2 小时只提醒一次）。
 */
import { log } from './log.ts';
import type { FeishuConfig } from './config.ts';
import type { State } from './state.ts';
import { sendCard } from './feishu/api.ts';
import { btnRow, card2, md, note } from './feishu/cards.ts';

const STALL_MS = 10 * 60 * 1000;
const SCAN_INTERVAL_MS = 60 * 1000;
const DEDUP_TTL_MS = 2 * 3600 * 1000;

interface Activity {
  sessionId: string;
  lastAt: number;
  lastPrompt: string;
}

export class StallWatch {
  private readonly alive = new Map<string, Activity>();
  private readonly busy = new Set<string>();
  private readonly alerted = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cfg: FeishuConfig,
    private state: State,
    private chatForSession: (sessionId: string) => Promise<string | null>,
  ) {}

  /** 事件驱动：刷新活动时间。 */
  touch(sessionId: string, prompt?: string): void {
    if (!sessionId) return;
    const prev = this.alive.get(sessionId);
    this.alive.set(sessionId, { sessionId, lastAt: Date.now(), lastPrompt: prompt ?? prev?.lastPrompt ?? '' });
  }

  markBusy(sessionId: string): void {
    if (sessionId) this.busy.add(sessionId);
  }

  /** 回合收场：清除跟踪（它已经不在跑了）。 */
  settle(sessionId: string): void {
    this.busy.delete(sessionId);
    this.alive.delete(sessionId);
  }

  start(): () => void {
    this.timer = setInterval(() => void this.scan().catch((e) => log.warn('卡住检测失败', { error: String(e).slice(0, 200) })), SCAN_INTERVAL_MS);
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scan(minAgeMs = STALL_MS): Promise<void> {
    const now = Date.now();
    for (const [sessionId, act] of [...this.alive]) {
      if (!this.busy.has(sessionId)) continue;
      if (now - act.lastAt < minAgeMs) continue;

      const lastAlert = this.alerted.get(sessionId) ?? 0;
      if (now - lastAlert < DEDUP_TTL_MS) continue;

      const chatId = await this.chatForSession(sessionId).catch(() => null);
      if (!chatId) continue;

      this.alerted.set(sessionId, now);
      const minutes = Math.max(1, Math.round((now - act.lastAt) / 60000));
      const binding = await this.state.findBySession(sessionId).catch(() => null);
      const messageId = await sendCard(this.cfg, chatId, card2('orange', `🐢 opencode 疑似卡住 · ${binding?.title ?? sessionId.slice(0, 12)}`, [
        md(
          `**会话** ${binding?.title ?? sessionId.slice(0, 12)}\n` +
            `**最近指令** ${act.lastPrompt.slice(0, 120) || '（无记录）'}\n` +
            `已 **${minutes} 分钟**无任何输出。`,
        ),
        btnRow(
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '💬 切换到此会话' },
            type: 'primary',
            size: 'small',
            behaviors: [{ type: 'callback', value: { act: 'oc_pick_session', session_id: sessionId } }],
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⏹ 中止执行' },
            type: 'danger',
            size: 'small',
            behaviors: [{ type: 'callback', value: { act: 'oc_abort', session_id: sessionId } }],
          },
        ),
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '忽略（它可能只是在跑长任务）' },
          type: 'default',
          size: 'small',
          behaviors: [{ type: 'callback', value: { act: 'noop' } }],
        },
        note(`opencode-feishu · 卡住检测 · ${new Date().toLocaleString()}`),
      ]));
      if (messageId) {
        // 提醒卡上的按钮也要能路由
        await this.state.putRoute(messageId, { act: 'oc_pick_session', session_id: sessionId });
      }
      log.warn('已推送卡住提醒', { sessionId, minutes });
    }
  }
}
