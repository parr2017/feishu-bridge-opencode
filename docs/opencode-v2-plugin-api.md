# opencode v2 插件 API（实测）

> 本文件不是抄文档，而是**在这台机器上跑探针实测**出来的结果。
> 环境：`@opencode/cli` **2.0.16**（anomalyco/opencode 分支），`opencode --version` → `opencode v2.0.16`。
>
> ⚠️ 注意：这套 API 与 sst/opencode 的 `@opencode-ai/plugin`（1.x，`chat.message` / `tool.execute.before` 那套）
> **完全不同**。v2 是 Effect 风格的命名空间 API。网上搜到的 v1 插件教程在这里基本不适用。

---

## 1. 插件放在哪

三条发现路径（实测均生效）：

| 位置 | 说明 |
| --- | --- |
| `.opencode/plugin/*.ts` \| `*.js` | 项目级。也支持 `.opencode/plugins/`（两个目录名都会被扫） |
| `~/.config/opencode/plugin/` | 全局级 |
| `opencode.json` 的 `plugin: [...]` | 包插件（npm / git），用 `opencode plugin add <package>` 安装 |

管理命令：

```bash
opencode plugin list      # 列出已发现的插件（含 local 与 package）
opencode plugin add <pkg> # 安装包插件并写入全局配置
opencode plugin remove <pkg>
opencode plugin check / update
```

`plugin list` 只枚举、**不加载**。插件是**惰性加载**的：只有在实例真正跑起来（一次 `run` / 一个 session 被驱动）时才 `import` 并调用 `setup`。

---

## 2. 插件模块形状

**默认导出**，形如 `{ id, setup }`（或 `{ id, effect }`）：

```ts
export default {
  id: 'my-plugin',
  async setup(ctx) {
    // 在这里注册 hook / 订阅事件 / 做初始化
  },
}
```

实测要点：

- **只认 default export**。我同时导出了具名 `probeSetup` / `probeEffect`，它们**都没有被调用**，只有 default 生效。
- 具名导出与 v1 的「一个模块导出多个插件函数」不同，v2 是**一个模块一个插件**。
- `setup` 里可以 `await`，可以做长生命周期的事（启动 WS 连接、注册 hook）。
- `setup` 的调用时机：**每个 location（项目目录）一次**。多项目 = 多实例，见 §6 的坑。

---

## 3. `ctx` 命名空间全景（实测 `Object.keys`）

```
app         { name, version, channel }
location    { directory, workspaceID, project: { id, directory, canonical } }
options     {}                       ← opencode.json 里 plugin 元组的第二项

agent       { get, list, transform, reload }
aisdk       { hook }
command     { list, transform, reload }
event       { subscribe }
experimental{ terminal }
generate    { text }
model       { list, default, transform, reload }
provider    { list, get, transform, reload }
integration { list, get, connect, oauth, command, transform, reload, connection }
mcp         { list, transform, reload }
permission  { hook, list, get, reply }
plugin      { list }
reference   { list, transform, reload }
rpc         function
skill       { list, transform, reload }
storage     { get, set, remove, scan }
tool        { reload, list, transform, hook }
vcs         { get, base, branch, status, diff, reload, transform }
websearch   { providers, query, reload, transform }
worktree    { list, create, remove, refresh, reload, transform }
session     { hook, create, get, switchAgent, switchModel, prompt, generate,
              command, synthetic, interrupt, update, move, wait, context }
shell       { hook }
```

> 注意 `session.form` 在运行时是 **undefined**（二进制里有，但这个 build 没挂到 ctx 上）。
> 表单/提问能力走 HTTP：`/api/form`、`/api/session/{id}/form/{formID}/reply`。

---

## 4. 实测确认的调用

### 4.1 `storage` —— 插件自带的持久 KV（替代外部 Redis）

```ts
await ctx.storage.set('k', { hello: 'world', n: 1 });
await ctx.storage.get('k');      // → { hello: 'world', n: 1 }   ✅ 实测往返成功
await ctx.storage.remove('k');
await ctx.storage.scan('');      // → { entries: [] }  （scan 的入参语义待定，先别依赖）
```

co-team 用 bus/Redis 存的那堆绑定关系（`feishu:card:*`、`feishu:session:*`），在插件里直接用 `ctx.storage` 就够。

### 4.2 `session.create` / `session.prompt`

```ts
const s = await ctx.session.create({});
// → { id:'ses_…', projectID:'…', cost:0, tokens:{…}, time:{…}, location:{ directory:'D:\\…' } }

await ctx.session.prompt({ sessionID: s.id, text: '你好' });
// 坏 sessionID → 抛 Session.NotFoundError，说明 { sessionID, text } 形状正确
```

### 4.3 `session.hook('prompt', cb)` —— 入站 prompt 拦截

实测在提交 prompt 时触发：

```ts
await ctx.session.hook('prompt', async (input) => {
  // input = {
  //   sessionID: 'ses_…',
  //   messageID: 'msg_…',
  //   prompt: { text: '…', files: [] },
  //   delivery: 'steer',
  // }
});
```

> 注册时**不校验名字**：`session.hook('随便什么字符串', cb)` 也会「成功」返回。
> 所以别指望靠报错来发现合法 hook 名，只能靠触发观察。目前确认有效的是 `prompt`。

### 4.4 `permission.hook('evaluate', cb)` —— 权限闸门（关键）

实测在权限判定时触发，**在 `permission.asked` 事件之前**：

```ts
await ctx.permission.hook('evaluate', async (input) => {
  // input = {
  //   sessionID: 'ses_…',
  //   agent: 'build',
  //   action: 'external_directory',      // 也有 'read' / 'shell' 等
  //   resources: ['C:/Windows/*'],
  //   metadata: {},
  //   source: { type:'tool', messageID:'msg_…', id:'call_…' },
  //   effect: 'ask',                     // allow | deny | ask
  // }
});
```

#### ⚠️ 返回值会被忽略，必须原地改写入参

这是本项目踩得最深的一个坑。**`return { effect: 'allow' }` 完全无效** ——
opencode 仍然 auto-reject。真正生效的是**改写入参对象**：

```ts
// ✅ 生效
input.effect = 'allow';   // → 工具放行
input.effect = 'deny';    // → "Permission denied: external_directory"

// ❌ 无效（实测两次）
return { effect: 'allow' };
return 'allow';
```

根因在实现里：`PluginHooks.trigger` 是

```js
s = function*(ns, name, payload) {
  for (const h of handlers) yield* h.callback(payload);
  return payload;          // ← 返回的是 payload 本身，不是回调的返回值
}
```

所以 **v2 的 hook 全部是「改写入参」语义**，不是「返回结果」语义。
（v1 的 `permission.ask` 是改第二个参数 `output.status`，也不一样，别混。）

#### 一次请求会触发多次 evaluate

实测一次「读外部目录」触发两轮：

```
EVALUATE action=external_directory effect=ask resources=["C:/Windows/*"]
EVALUATE action=read             effect=allow
```

所以待裁决状态要用 `sessionID|action|resources` 这种**稳定 key** 去重，
否则一次授权会推两张卡。

这是**飞书审批卡能否拦住请求**的支点：在 `evaluate` 里推卡并等待飞书用户点按，
拿到结果后写回 `input.effect`。

### 4.5 `permission.list` / `permission.reply`

```ts
await ctx.permission.list({ sessionID });           // 必须带 sessionID，否则 SchemaError(Missing key at ["sessionID"])
await ctx.permission.reply({ sessionID, requestID, reply });  // reply ∈ 'once' | 'always' | 'reject'
```

`reply` 的入参形状由 OpenAPI `/api/session/{sessionID}/permission/{requestID}/reply` 推断，未逐个实测。

### 4.7 `tool.transform` —— 覆盖内置工具（提问链路的关键）

`ctx.tool` 运行时只有 `[reload, list, transform, hook]`（没有 `add`/`update`/`remove`），
但 `transform` 的回调里给的是一个**完整的工具注册表**：

```ts
await ctx.tool.transform((tools) => {
  // tools = { list, get, namespace, add, update, remove }
  tools.update('question', (tool) => {
    tool.execute = async (args, execCtx) => { ... };
  });
});
```

实测 `tool` 对象的形状：`{ name, id, options, description, input, output, execute }`，
其中 `input` / `output` 是 **Effect Schema**（`_tag:"Objects"` + `propertySignatures`），
`execute(args, execCtx)` 的第二个参数带 `{ sessionID, agent, messageID, id, progress, signal }`
——**有 sessionID，所以能精确路由到对应的飞书会话**。

#### 返回值信封（踩了两轮才试出来）

`question` 工具的 `output` schema 是 `{ answers: Array<Array<string>> }`（每题一个字符串数组）。
但 execute **不能直接返回这个值**，必须包一层 `output`：

```ts
// ✅ 生效 → session.tool.success
return { output: { answers: [['SQLite'], ['React']] } };

// ❌ "Tool did not return its declared output"
return { answers: [['SQLite']] };

// ❌ "Tool returned an invalid value for its output schema: Expected object"
return { output: 'SQLite', metadata: {...} };
```

#### 完整提问链路（本项目的做法）

```
agent 调 question 工具
  → 我们的 execute（args.questions = [{question, header, options:[{label,description}]}]）
  → 推飞书卡（选项按钮 + 自由输入框）
  → 用户点选/填答 → 收口成 string[][]
  → return { output: { answers } } → agent 继续执行
```

拿不到落点（会话没绑飞书 / 没配白名单）时**回落到原 execute**，TUI 表单照常弹——
这是非破坏性接管的关键，不然会把手动用 TUI 的人也一起坑了。

#### ⚠️ `tool.transform` 会重复执行

实测：接入 MCP 工具后注册表变化，transform 回调**会再跑一次**。所以覆盖工具必须防重复包装：

```ts
tools.update('question', (tool) => {
  if (tool.__feishuWrapped === true) return;   // 同一个对象，已经包过 → 跳过
  this.original ??= tool.execute.bind(tool);   // 原实现只记第一次
  tool.__feishuWrapped = true;
  tool.execute = (args, ctx) => this.onQuestion(args, ctx);
});
```

不这么做的话，第二次包装会把 `original` 指向**我们自己的包装函数**，
回落时调用自己 → 无限递归。（这个是靠日志里「已接管」打印两次才发现的。）

#### 另一个发现：`form.created` 事件

`question` 工具内部会创建表单，事件流里能看到：

```json
{ "type": "form.created", "data": { "form": {
  "id": "frm_…", "sessionID": "ses_…", "title": "Questions",
  "metadata": { "kind": "question", "tool": {…} },
  "fields": [{ "key":"q0", "title":"…", "description":"…", "type":"string",
               "options":[{"value","label","description"}], "custom": true }]
}}}
```

但 **`ctx.session.form` 是 undefined**，插件侧没有回复入口（回复只在 HTTP 层：
`POST /api/session/{sid}/form/{fid}/reply`）。所以如果只想「知道有人在问什么」，
订阅 `form.created` 就够；要**作答**，就得走上面覆盖 `question` 工具的路线。

### 4.8 `ctx.rpc` 是什么（容易误解）

`ctx.rpc` 不是「调用 opencode 内部 API」的通道。它是**反向的**：插件用它**暴露**自己的
RPC 方法给别的客户端调（对应 HTTP 的 `/api/rpc/{rpcID}/{method}`）。

```ts
ctx.rpc = (spec) => {
  // spec.methods 里的每个方法会被暴露成可远程调用的端点
  // 返回 { <method>: fn, events: { subscribe, on } }
}
```

所以想拿表单/历史的回复能力，别指望 `ctx.rpc`。

### 4.9 `event.subscribe` —— 全量事件流（主战场）

```ts
const stream = ctx.event.subscribe(() => {});   // 立即返回，无 keys，带 Symbol.asyncIterator
for await (const e of stream) { /* e = { id, created, type, data, location?, durable? } */ }
```

实测事件样本（`data` 只列关键字段）：

| `type` | `data` 关键字段 |
| --- | --- |
| `session.inbox.enqueued` | `sessionID`, `inboxID`, `item:{type:'user', payload:{text,files}, delivery}` |
| `session.inbox.delivered` | `sessionID`, `inboxID` |
| `session.execution.started` | `sessionID` |
| `session.execution.succeeded` | `sessionID` ← **回合完成信号** |
| `session.execution.interrupted` | `sessionID` |
| `session.step.started` / `session.step.ended` | `assistantMessageID`, `finish`, `cost`, `tokens` |
| `session.text.started` / `session.text.delta` / `session.text.ended` | `sessionID`, `assistantMessageID`, `ordinal`, `text`（ended 带全文） |
| `session.reasoning.*` | 同 text，`delta` / `text` |
| `session.tool.input.started/ended` | `id`, `name`, `text` |
| `session.tool.called` | `id`, `input`, `executed` |
| `session.tool.progress` / `session.tool.success` | `id`, `content`, `metadata` |
| `session.usage.updated` | `sessionID`, `cost`, `tokens` |
| `session.retry.scheduled` | `error:{type,message,status}`, `attempt` |
| `session.instructions.updated` | `delta`, `text` |
| `permission.asked` | `id`, `sessionID`, `action`, `resources`, `save`, `source` |
| `permission.replied` | `sessionID`, `requestID`, `reply` |
| `shell.created` / `shell.exited` | `info` / `id`, `exit`, `status` |
| `mcp.status.changed` / `mcp.resources.changed` | `server` |
| `{integration,model,provider,agent,command,skill,websearch,reference,plugin}.updated` | `{}` |

**注意**：这个 fork **没有** `session.idle`。回合完成看 `session.execution.succeeded` / `.interrupted`。

---

## 5. 依赖与模块解析（重要）

本地插件 `.opencode/plugin/x.ts` 里 **bare import 会失败**，除非包能从插件目录向上解析到：

```
IMPORT OK   node:fs, node:crypto
IMPORT FAIL effect                    ← Cannot find package 'effect'
IMPORT FAIL @larksuiteoapi/node-sdk
IMPORT FAIL zod
```

结论：

- 想用 `@larksuiteoapi/node-sdk`，就得让 `node_modules` 出现在解析链上——
  项目根 `npm i @larksuiteoapi/node-sdk` 即可（`.opencode/plugin/` → 项目根，Node 解析会逐级向上）。
- 或者走包插件：`opencode plugin add <npm|git>`，opencode 会把它装进 `~/.config/opencode` 并带上依赖。
- 只用 `node:*` 内置模块 + 全局 `fetch` / `WebSocket` 可以做到零依赖（HTTP webhook 入站就是这样）。

---

## 6. 四个必须知道的坑

1. **hook 是「改写入参」语义，不是「返回结果」语义。**
   `return { effect: 'allow' }` 无效，必须 `input.effect = 'allow'`。
   所有 `*.hook(name, cb)` 都一样（见 §4.4 的根因）。

2. **覆盖工具时，execute 的返回值要包一层 `output`。**
   `return { output: { answers: [...] } }` 才对，直接返回业务值会被判「没有返回声明的输出」（见 §4.7）。

3. **`setup` 是按 location 跑的**，不是进程级一次。
   多个项目目录 → 多个实例 → 如果每个都建一条飞书长连接，同一条飞书消息会被随机投递到其中一条，行为不可预期。
   对策：模块级单例守卫（本项目已这么做），或用 `opencode service start` 起单进程后台服务。

4. **`hook` 注册不校验名字**，写错了不会报错，只是永远不触发。
   排查「为什么我的 hook 没反应」时，先确认名字，别怀疑代码逻辑。

---

## 7. 顺带拿到的 HTTP API 全貌

`opencode serve` 起来后 `GET /openapi.json` 可以拿到完整 113 条路径（`opencode HttpApi 0.0.1`）。
鉴权是 `server password <pw>` 打印出来的口令做 Basic Auth。
本插件用不到（插件内直接用 `ctx` 更省事），但对写外部 bridge 很有用。
