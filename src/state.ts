/**
 * 绑定状态。用 opencode 插件自带的 `ctx.storage` 持久化（实测 get/set 往返正常），
 * 不需要外部 Redis——co-team 那套 bus 在这里省掉了。
 *
 * key 规划（对应 co-team 的 feishu:* 总线 key）：
 *   chat:{chatId}        飞书会话 → opencode session 绑定
 *   chat_index           已绑定会话的 chatId 索引（storage.scan 语义未定，不依赖它）
 *   route:{messageId}    卡片按钮/表单的回调路由参数
 *   ask:{messageId}      提问卡 → ask_key（提问状态在 AskBridge 内存里）
 *   notify_chat          默认结果推送落点
 */

/** 抽象一层，方便脱离 opencode 单测。 */
export interface KvStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ChatBinding {
  chatId: string;
  /** opencode session id（ses_…） */
  sessionId: string;
  /** 绑定者 open_id，用于权限校验 */
  openId: string;
  title: string;
  model?: string;
  agent?: string;
  updatedAt: string;
}

export class State {
  constructor(private kv: KvStore) {}

  async getChat(chatId: string): Promise<ChatBinding | null> {
    return this.kv.get<ChatBinding>(`chat:${chatId}`);
  }

  async putChat(binding: ChatBinding): Promise<void> {
    await this.kv.set(`chat:${binding.chatId}`, { ...binding, updatedAt: new Date().toISOString() });
  }

  /** 所有已绑定的飞书会话（用于 /status、完成推送时找落点）。 */
  async allChats(): Promise<ChatBinding[]> {
    const out: ChatBinding[] = [];
    // storage.scan 的入参语义在 v2 里没定论，所以额外维护一份索引，别依赖 scan
    const index = (await this.kv.get<string[]>('chat_index')) ?? [];
    for (const chatId of index) {
      const b = await this.getChat(chatId);
      if (b) out.push(b);
    }
    return out;
  }

  async indexChat(chatId: string): Promise<void> {
    const index = (await this.kv.get<string[]>('chat_index')) ?? [];
    if (!index.includes(chatId)) {
      index.push(chatId);
      await this.kv.set('chat_index', index.slice(-200));
    }
  }

  /** 按 opencode session 反查绑定的飞书会话（事件推送时用）。 */
  async findBySession(sessionId: string): Promise<ChatBinding | null> {
    for (const b of await this.allChats()) if (b.sessionId === sessionId) return b;
    return null;
  }

  async putRoute(messageId: string, value: Record<string, unknown>): Promise<void> {
    await this.kv.set(`route:${messageId}`, value);
  }

  async getRoute(messageId: string): Promise<Record<string, unknown> | null> {
    return this.kv.get<Record<string, unknown>>(`route:${messageId}`);
  }

  /** 提问卡：messageId → 路由参数（ask_key）。 */
  async putAsk(messageId: string, value: Record<string, unknown>): Promise<void> {
    await this.kv.set(`ask:${messageId}`, value);
  }

  async getAsk(messageId: string): Promise<Record<string, unknown> | null> {
    return this.kv.get<Record<string, unknown>>(`ask:${messageId}`);
  }

  async dropAsk(messageId: string): Promise<void> {
    await this.kv.remove(`ask:${messageId}`);
  }

  async setNotifyChat(chatId: string): Promise<void> {
    await this.kv.set('notify_chat', chatId);
  }

  async getNotifyChat(): Promise<string | null> {
    return this.kv.get<string>('notify_chat');
  }
}
