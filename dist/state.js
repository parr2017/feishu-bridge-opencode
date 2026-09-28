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
export class State {
    kv;
    constructor(kv) {
        this.kv = kv;
    }
    async getChat(chatId) {
        return this.kv.get(`chat:${chatId}`);
    }
    async putChat(binding) {
        await this.kv.set(`chat:${binding.chatId}`, { ...binding, updatedAt: new Date().toISOString() });
    }
    /** 所有已绑定的飞书会话（用于 /status、完成推送时找落点）。 */
    async allChats() {
        const out = [];
        // storage.scan 的入参语义在 v2 里没定论，所以额外维护一份索引，别依赖 scan
        const index = (await this.kv.get('chat_index')) ?? [];
        for (const chatId of index) {
            const b = await this.getChat(chatId);
            if (b)
                out.push(b);
        }
        return out;
    }
    async indexChat(chatId) {
        const index = (await this.kv.get('chat_index')) ?? [];
        if (!index.includes(chatId)) {
            index.push(chatId);
            await this.kv.set('chat_index', index.slice(-200));
        }
    }
    /** 按 opencode session 反查绑定的飞书会话（事件推送时用）。 */
    async findBySession(sessionId) {
        for (const b of await this.allChats())
            if (b.sessionId === sessionId)
                return b;
        return null;
    }
    async putRoute(messageId, value) {
        await this.kv.set(`route:${messageId}`, value);
    }
    async getRoute(messageId) {
        return this.kv.get(`route:${messageId}`);
    }
    /** 提问卡：messageId → 路由参数（ask_key）。 */
    async putAsk(messageId, value) {
        await this.kv.set(`ask:${messageId}`, value);
    }
    async getAsk(messageId) {
        return this.kv.get(`ask:${messageId}`);
    }
    async dropAsk(messageId) {
        await this.kv.remove(`ask:${messageId}`);
    }
    async setNotifyChat(chatId) {
        await this.kv.set('notify_chat', chatId);
    }
    async getNotifyChat() {
        return this.kv.get('notify_chat');
    }
}
