# 架构设计

## 1. 定位

一个 **opencode v2 插件**：装进 opencode 后，飞书里的消息直接驱动本机 opencode 干活，
执行结果、授权请求、提问都在飞书里闭环。不需要公网、不需要单独的服务进程、不需要 Redis。

```
┌──────────────┐   长连接(出站)   ┌─────────────────────────────────────┐
│   飞书       │ ◄──────────────► │         opencode 进程               │
│  用户/群     │                  │                                     │
└──────────────┘                  │  ┌───────────────────────────────┐  │
        ▲                         │  │ 本插件 (opencode-feishu)      │  │
        │ 卡片/文本               │  │                               │  │
        └─────────────────────────┤  │  gateway ──► commands ──►     │  │
                                  │  │     ▲            │            │  │
                                  │  │     │            ▼            │  │
                                  │  │  cards/api      bridge        │  │
                                  │  │  permView/formView/listCards  │  │
                                  │  │     ▲            │            │  │
                                  │  │     │            ▼            │  │
                                  │  │  state       ctx.session.*    │  │
                                  │  │  (storage)   ctx.event.*      │  │
                                  │  │              ctx.permission.* │  │
                                  │  │              ctx.tool.transform│ │
                                  │  └───────────────────────────────┘  │
                                  └─────────────────────────────────────┘
```

## 2. 为什么插件形态能删掉 co-team 一半的代码

co-team 站在 opencode 外面，所以它得自己解决一堆问题。插件跑在 opencode 进程**里面**，
这些问题直接消失：

| co-team 要做的事 | 为什么必须做 | 插件里 |
| --- | --- | --- |
| 发现桌面版 opencode / spawn `opencode serve` | 它在进程外，得先找到对端 | 不需要，`ctx` 就是本实例 |
| 多实例注册表 + 按目录匹配「家」 | 一个 co-team 管多个 opencode | 不需要，单实例 |
| 事件重放缓冲（2048 条 / 8MiB） | SSE 断线会丢事件，得能补 | 不需要，`ctx.event.subscribe()` 是权威流 |
| 30s 轮询 `pendingAll()` 找待批权限 | 权限没有事件推送 | 不需要，`permission.hook('evaluate')` 直接拦 |
| 30s 轮询 `pendingAll()` 找待答提问 | 提问没有回复入口 | 不需要，接管 `question` 工具，直接拿 execute 的返回值 |
| busy→idle 对账扫描补推完成通知 | `session.idle` 事件可能丢 | 不需要，`session.execution.succeeded` 就是信号 |
| 完成推送按 `sid+updated` 去重 | 双通道（事件+扫描）会重复推 | 只需简单去重 |
| Redis/bus 存绑定关系 | 跨进程共享 | `ctx.storage`（插件自带持久 KV） |
| `oc_watch: all\|managed\|bound` 噪音阀门 | 要控制多实例的推送噪音 | 不需要，只有自己的会话 |

## 3. 功能对照：co-team 有什么，搬了什么

### 已搬（与 opencode 有对应物）

| co-team 源文件 | 本项目 | 说明 |
| --- | --- | --- |
| `feishu/tokenManager.ts` | `src/feishu/api.ts` | token 生命周期；去掉 bus 缓存（单进程内存即可） |
| `feishu/messageService.ts` | `src/feishu/api.ts` | 发文本/卡片、429 退避、PATCH 原地更新 |
| `feishu/cards.ts` | `src/feishu/cards.ts` | 卡片 2.0 构件库，红线注释一并保留 |
| `feishu/wsGateway.ts` | `src/feishu/gateway.ts` | 长连接入站（免公网） |
| `feishu/webhook.ts` | `src/feishu/gateway.ts` | HTTP webhook 入站（AES 解密 + 签名 + 幂等） |
| `feishu/session.ts` | `src/state.ts` | 绑定关系；存储从 bus 换成 `ctx.storage` |
| `feishu/commands.ts` | `src/commands.ts` | 单域简化版；保留「裸命令看选项、带参才执行」 |
| `feishu/panelCard.ts` | `src/feishu/panelCard.ts` | `/help` `/panel` 按钮面板 |
| `feishu/listCards.ts` | `src/feishu/listCards.ts` | 会话/模型/Agent 三类列表卡 + 收件箱卡（翻页机制原样） |
| `feishu/ocBridge.ts` 完成推送 | `src/bridge.ts` | 完成卡 + 快速回复 + 路由反查 |
| `feishu/ocBridge.ts` 权限卡 | `src/bridge.ts` + `permView.ts` | 三按钮 + 资源折叠 + `permViewOf` 归一 |
| `feishu/ocBridge.ts` 提问表单 | `src/ask.ts` + `formView.ts` | 选项按钮/输入框/全答自动提交 |
| `feishu/ocBridge.ts` 卡住检测 | `src/stall.ts` | 合并了 `stallWatch.ts` 的任务侧思路 |
| `feishu/inboxBridge.ts` | `src/bridge.ts` `collectInbox()` | 聚合待裁决权限 + 待作答提问 |
| `packages/opencode-sync/src/perm.ts` | `src/feishu/permView.ts` | 几乎逐行搬运 |
| `packages/opencode-sync/src/form.ts` | `src/feishu/formView.ts` | 状态机逐行搬运，补 v2 字段映射 |

### 没搬（co-team 自有领域，opencode 没有对应物）

| co-team 源文件 | 为什么不搬 |
| --- | --- |
| `feishu/approvalCards.ts` | 桥接的是 co-team 的**任务节点审批 / 命令审批 / 人工门**。opencode 没有「任务节点」这个概念，权限就是权限（已由权限闸门覆盖）。 |
| `feishu/decisionCards.ts` | **ask_user / 监督者提案 / 每日报告 / 需求澄清**——全是 co-team orchestrator 的概念。opencode 的对应物是 `question` 工具，已由提问桥覆盖。 |
| `feishu/convoBridge.ts` | co-team 的**协作会话**（多 agent 讨论室）是它自己的产品功能，opencode 里没有。 |
| `feishu/notifyBridge.ts` | 推送的是 co-team 任务生命周期事件（task_success/failed/auto_restart…），opencode 无此状态机。 |
| `listCards.ts` 的任务卡 / 项目选择卡 / 实例卡 | 依赖任务图、项目工作区、多实例——opencode 都没有。 |
| `server/src/opencode/manager.ts`（73KB） | 实例发现、spawn `opencode serve`、事件重放、`waitSessionIdle`、`pendingAll`——插件里全部失去对象。 |
| `server/src/opencode/{client,eventHub,modelInjection,ocTools}.ts` | 同上：都是「站在外面接管 opencode」才需要的机器。 |
| `server/src/taskQueue` / `orchestrator` / `store` | co-team 自己的任务引擎，与 opencode 无关。 |

> 一句话：co-team 的飞书层里，**与 opencode 有关的那部分全搬了**；
> 没搬的是它自己的任务/会话/决策领域——那些不是「opencode 的功能」，搬过来没有落点。

## 4. 关键流程

### 4.1 飞书发消息 → opencode 执行

```
飞书消息 → gateway（长连接/回调，按 event_id 去重）
  → bridge.onMessage
      → state.setNotifyChat（记住落点）
      → 引用回复？→ 按 route:{messageId} 找到 session，直接发 prompt
      → 以 "/" 开头？→ commands.handleCommand → 文本回执 或 交互卡
      → 自由文本 → state.getChat(chatId) ?? api.createSession()
                → ctx.session.prompt({ sessionID, text })
```

### 4.2 opencode 执行完 → 飞书收到卡片

```
ctx.event.subscribe() 异步迭代
  session.execution.started      → busy.add + stall.markBusy
  session.inbox.enqueued         → stall.touch(text)   （记下最近指令）
  session.text.ended             → replyBuffer[sessionID:messageID] = text
  session.execution.succeeded    → drainBuffer → 完成卡（带快速回复输入框）
  session.execution.interrupted  → 同上，标题改「已中止」
```

> v2 这个 fork **没有 `session.idle`**，回合完成的信号是 `session.execution.succeeded`。

### 4.3 授权：飞书审批卡拦住请求

```
opencode 判定权限
  → permission.hook('evaluate')  ← 插件在这里挂住
      → chatForSession → 推权限卡（permViewOf 归一：中文动作名/资源/记住规则）
      → await 一个 Promise（10 分钟超时；卡片发不出去就立刻放弃）
  飞书用户点按钮 → card.action.trigger → bridge.onCardAction → resolve
  → evaluate 回调写回：input.effect = 'allow' | 'deny'
```

**机制要点**：hook 的返回值被忽略，只能原地改写入参（见 `opencode-v2-plugin-api.md` §4.4）。
另外一次请求会触发**两次** evaluate（先 `external_directory` 再 `read`），
所以待裁决状态用 `sessionID|action|resources` 作稳定 key，避免推两张卡。

### 4.4 提问：接管 `question` 工具

```
agent 调 question 工具
  → 我们的 execute（args.questions = [{question, header, options}]）
      → 有落点？没有 → 回落原 execute，TUI 表单照常弹（非破坏性）
      → 有落点 → 推提问卡（选项按钮 + 自由输入框 + 全答自动提交）
  用户作答 → ask_pick / ask_submit → 收口成 string[][]
  → return { output: { answers: [['SQLite']] } } → agent 继续执行
```

返回信封是实测出来的：`{ output: {...} }` 才对，直接返回业务值会被判
「Tool did not return its declared output」（见 §4.7）。

### 4.5 卡住检测

```
任何会话事件 → stall.touch(sessionID)
execution.succeeded/interrupted → stall.settle(sessionID)
每分钟扫描：busy 且 10 分钟无事件 → 推提醒卡（切换会话 / 中止 / 忽略），同会话 2h 只提醒一次
```

## 5. 已知限制

1. **没有历史消息读取**。v2 的 `ctx.session` 没有 `list` / `messages`（实测 runtime keys 里没有）。
   所以 `/list` 列的是**本插件创建过的会话**，opencode 里手工开的会话看不到。
   需要完整历史得走 HTTP API（`GET /api/session/{id}/message`），本版本没做。

2. **`switchModel` / `switchAgent` 的入参形状未逐个实测**。按 OpenAPI 推断为
   `{ sessionID, model }` / `{ sessionID, agent }`，代码里 try/catch 会把失败原因回显到飞书。

3. **单实例**。进程级单例：多个项目目录同时跑 opencode 时，只有第一个 location 会建飞书连接。
   要跨项目用，得靠 `opencode service start` 起单进程后台服务。

4. **`permission.reply` 兜底路径未实测**。正常路径走 evaluate hook 用不到它；
   只有插件重启后点旧卡才会走到。

5. **新建会话不能指定目录**。co-team 有「项目选择卡」（在指定工作区建会话），
   opencode 侧对应的是 `session.create({ directory })`，形状未验证，本版本没做。

## 6. 下一步建议

1. **接 HTTP 客户端** —— 补齐历史读取、`session.list`、跨目录建会话。
   `opencode serve` 的 `/openapi.json` 有全部 113 条路径，Basic Auth 用启动日志里的 `server password`。
2. **打包成 npm 包** —— `opencode plugin add <pkg>` 分发，用户不用手动放文件。
3. **多 location 支持** —— 飞书侧 `/location` 切换当前项目目录。
4. **流式推送** —— 现在只在回合结束推一次；可考虑长回合期间推增量（`session.text.delta`），
   但要先做节流，否则飞书会被刷屏。
