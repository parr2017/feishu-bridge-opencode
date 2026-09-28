# co-team 里 opencode × 飞书 的部分（源码分析）

分析对象：`D:\pxx\co-team`（只读，未改动任何文件）。

## 1. 一句话结论

co-team 里的飞书集成是一个**站在 opencode 外面的适配层**：它要么把 `opencode serve` 当子进程拉起来，
要么去发现桌面上已经在跑的 opencode，然后用 HTTP + SSE 当客户端使唤它。
飞书那一侧的代码（鉴权、发消息、卡片、长连接）**是完整且经过实战打磨的**，可以直接搬；
opencode 那一侧的代码（实例发现、托管、事件补偿、轮询）**大部分在插件形态下会消失**。

## 2. 飞书侧代码清单（可复用）

目录：`server/src/feishu/`（16 个文件，约 3.5k 行）

| 文件 | 行数 | 作用 | 复用判断 |
| --- | --- | --- | --- |
| `tokenManager.ts` | 68 | `tenant_access_token` 获取 + 7100s 缓存；`X-Lark-Signature` 校验 | **直接搬**（去掉 bus 缓存即可） |
| `messageService.ts` | 87 | `im/v1/messages` 发文本/卡片，429/5xx 指数退避；`PATCH` 原地更新卡片 | **直接搬** |
| `cards.ts` | 104 | 卡片 2.0 构件库（`card2`/`md`/`btn`/`form`/`collapse`…） | **直接搬**，含实测红线注释 |
| `wsGateway.ts` | 95 | 长连接入站（`WSClient` + `EventDispatcher`），无公网部署方案 | **直接搬**，本项目入站主通道 |
| `session.ts` | 60 | 每飞书用户一个上下文（mode/项目/绑定会话），24h 滑动过期 | **搬结构，换存储**（`ctx.storage`） |
| `commands.ts` | 280 | 指令集，按窗口主题分域解析 | **搬骨架，砍掉 task/convo 域** |
| `webhook.ts` | 298 | HTTP webhook 入站 + 事件去重 + 路由中枢 | 部分搬（本插件可选 HTTP 通道） |
| `panelCard.ts` | 52 | `/help` `/panel` 按钮面板卡 | 可搬 |
| `listCards.ts` | 328 | 8 类交互列表卡 + 分页 | 可搬（oc 会话/模型/agent 三张卡有用） |
| `ocBridge.ts` | 768 | **opencode ↔ 飞书 桥**：绑定会话、发 prompt、完成推送、权限/提问审批卡 | **核心参考**，但一半机制在插件里不再需要 |
| `approvalCards.ts` | 264 | 任务/命令审批卡（co-team 自有任务体系） | 不需要（无对应概念） |
| `decisionCards.ts` | 505 | 决策卡（ask_user/监督提案/每日报告…） | 不需要 |
| `convoBridge.ts` | 314 | co-team 协作会话桥 | 不需要 |
| `inboxBridge.ts` | 204 | 跨引擎待办收件箱 | 可借鉴「聚合待拍板」思路 |
| `notifyBridge.ts` | 52 | 白名单通知统一推送 | 不需要 |
| `stallWatch.ts` | 45 | 卡住检测（30min 无 journal） | 可搬（改成 N 分钟无事件） |

配套文档：`docs/feishu_architecture.md`（架构总览，含两条入站通道）、
`docs/飞书长连接接入-计划-2026-09-26.md`、`docs/飞书功能树与交互设计-2026-09-26.md`。

### 卡片 2.0 的实测红线（`cards.ts` 注释里记着的血泪）

1. 2.0 不支持 1.0 的 `note` 标签 → 落款用 `markdown`。
2. 按钮回调必须 `behaviors:[{type:'callback',value}]`，旧版写法在长连接下收不到回调。
3. 回调结果卡必须包成 `{card:{type:'raw',data}}` 随响应帧返回，裸卡片会被回滚。
4. `input` 的 `max_length` 上限 1000，超了整卡被拒（`230099` / `11310`）。
5. `collapsible_panel` 在老租户会被拒 → 只在正文真放不下时用。

## 3. opencode 侧代码清单（插件形态下大部分可删）

目录：`server/src/opencode/`

| 文件 | 作用 | 插件形态下 |
| --- | --- | --- |
| `client.ts` (36KB) | `@opencode/client` 2.0.15 封装（`OpenCode.make`），session/event/pty/permission 全套 | **删**，插件直接用 `ctx.session.*` |
| `manager.ts` (73KB) | 实例注册表：`startManaged`（spawn `opencode serve`）、`bootstrapAttached`（发现桌面实例）、事件 replay、`waitSessionIdle`、`pendingAll` | **删**，只有单实例 |
| `eventHub.ts` | 2048 条 / 8MiB 事件重放缓冲 | **删**，`ctx.event.subscribe()` 是权威流 |
| `events.ts` | 事件过滤（丢 heartbeat/lsp/vcs 噪音）+ 50ms 微批 | **可借鉴**，噪音过滤逻辑仍有用 |
| `ocTools.ts` | `oc_*` 十个工具（给 co-team 自己的 agent 调用） | 不需要 |
| `modelInjection.ts` | 把 co-team 模型池注入托管实例 | 不需要 |
| `officialClientLoader.cjs` | 一行 `import('@opencode/client')` | 不需要 |

**为什么能删这么多**：co-team 必须自己发现/拉起 opencode、自己维护多实例注册表、自己做事件重放和
busy→idle 对账（因为它的 SSE 连接可能断、可能错过事件）。插件**跑在 opencode 进程里面**，
这些补偿机制全部失去存在意义。

## 4. ocBridge 里哪些逻辑是真正有价值的

`ocBridge.ts` 768 行里，与「opencode ↔ 飞书」本质相关的其实不多：

**保留**
- 完成推送卡：读末条助手回复 → 渲染卡片 → 带快速回复输入框 → 记录 `feishu:reply:{messageId}` 反查路由。
- 权限卡：`permViewOf()` 归一化（v2 真载荷是 `{action, resources, save, message}`，
  早期按 v1 的 `{title,pattern,command}` 取值导致卡片永远只显示「权限请求」）→ 批准一次/总是批准/拒绝三按钮。
- 提问表单卡：选择题渲染按钮（点选即答、✓ 标记），输入题渲染输入框，全部作答后自动提交。
- 卡住检测：会话有活动但 N 分钟无输出 → 推提醒卡 + 中止按钮。
- 切会话时的「最近对话」预览。

**删掉**
- `notifyChat()` 的 approvers 私聊回落（插件场景直接记群 id）。
- `scanPendingOnce` 30s 轮询 `pendingAll()` → 换成 `permission.asked` 事件驱动。
- `scanReconcile` busy→idle 对账 → 换成 `session.execution.succeeded` 事件。
- `pushCompletionOnce` 的 `sid+updated` 去重 → 事件本身唯一，只需简单 dedupe。
- 多实例噪音阀门 `feishu.oc_watch: all|managed|bound` → 无多实例。
- 实例归属解析（按 `project_root` 匹配目录判断「家」）→ 插件天然知道自己的 location。

## 5. 反向集成（opencode 调 co-team）

`integrations/opencode/`：
- `README.md`：把 co-team 暴露成 remote MCP（`/mcp/coteam`），5 个 `coteam_*` 工具。
- `coteam-bridge.ts`：**一个 v1 形态的 opencode 插件样例**——`export const CoteamBridge = async (ctx) => {...}`，
  轮询 `/api/tasks` 用 `client.tui.showToast` 弹提示。

> ⚠️ 这个样例是 **v1 插件写法**（具名导出 + `ctx.client.tui.showToast`）。
> 在本机这个 v2 上**不会生效**：v2 只认 default export，且没有 `ctx.client`。
> 本项目没有沿用它的形状。

## 6. 关键总线 key（co-team 的跨模块契约）

搬过来时对应关系：

| co-team（bus KV） | 本项目（`ctx.storage`） |
| --- | --- |
| `feishu:session:{userId}` | `session:{openId}` |
| `feishu:card:{taskId}` | 无对应（改成 `bound:{openId}`） |
| `feishu:cardmsg:{messageId}` → taskId | `route:{messageId}` |
| `feishu:reply:{messageId}` | `route:{messageId}`（合并） |
| `feishu:route:{messageId}` | `route:{messageId}` |
| `feishu:oc:notify_chat` | `notify_chat` |
| `feishu:oc:permseen:{pid}` | `permseen:{permissionId}` |
| `feishu:event:{eventId}`（幂等） | `seen:{eventId}` |
