# feishu-bridge-opencode

**把飞书接入 opencode 的插件**——在飞书里发消息，本机 opencode 干活，结果、授权审批、提问作答全部回到飞书闭环。

- 目标运行时：`@opencode/cli` **2.x**（本机实测 2.0.16）
- 入站走飞书**长连接**（出站 WebSocket），**不需要公网、不需要服务器、不需要数据库**
- 唯一的运行时依赖是 `@larksuiteoapi/node-sdk`（仅长连接用），其余全是 Node 内置模块

---

## 飞书里能看到什么

插件向飞书推送的一共 **9 种卡片**和 **2 种纯文本**。下面按「什么时候会收到」分类展示。

### ① ✅ 执行完成卡

opencode 跑完一轮时推送。绿色标题，正文是助手这一轮的完整回复（超长自动截断）。

```
┌─────────────────────────────────────────┐
│ ✅ opencode 已完成                        │
├─────────────────────────────────────────┤
│ 会话  飞书 · ou_a1b2c3                   │
│ 目录  D:\pxx\opencode-mobile             │
│                                         │
│ 已列出当前目录：共 12 个文件，包括        │
│ README.md、package.json、src/ …          │
│                                         │
│ ┌───────────────────────────────────┐   │
│ │ 继续这个话题…                      │   │  ← 输入框
│ └───────────────────────────────────┘   │
│              [ 发送 ]                   │
│                                         │
│ opencode-feishu · 引用回复本卡亦可 · …   │
└─────────────────────────────────────────┘
```

> 被中止时同款卡片换成**橙色**标题「⏹ opencode 已中止」。

**两种追问方式**：卡上的输入框直接发，或者**引用回复这张卡**——效果一样，都会接着同一个会话往下跑。

### ② ⛔ 权限审批卡

opencode 执行过程中要动文件 / 跑命令 / 访问项目外目录时，会停下来等你点按。**动作名被归一成中文**，不是原始英文标识。

```
┌─────────────────────────────────────────┐
│ ⛔ 需要授权 · 访问项目外目录                │
├─────────────────────────────────────────┤
│ 动作  访问项目外目录（external_directory）  │
│ 目标  C:/Windows/*, C:/Users/*           │
│ 会话  飞书 · ou_a1b2c3                   │
│ 目录  D:\pxx\opencode-mobile             │
│                                         │
│ [✅ 批准一次]   [✅ 总是批准（记住 …）]     │
│              [ ✖ 拒绝 ]                  │
│                                         │
│ opencode-feishu · 权限 · …               │
└─────────────────────────────────────────┘
```

三个按钮分别是：**批准一次** / **总是批准** / **拒绝**。资源超过 5 条或单条超过 300 字符时，
多出来的内容收进**折叠面板**（「全部目标（N 项）」），卡片不会被撑爆。
可选「总是批准」时，按钮上会直接写清它记住的是什么规则——避免误以为只放行这一次。

### ③ ❓ 提问卡

opencode 向你提问时推送（对应它内部的 `question` 工具）。**你答完它才会继续执行**，
所以收到这张卡意味着「任务卡在半路」。

```
┌─────────────────────────────────────────┐
│ ❓ opencode 提问                          │
├─────────────────────────────────────────┤
│ ❔ Database Selection                    │
│ Which database would you like to use?    │
│                                         │
│ [ SQLite ]                              │
│ [ PostgreSQL ]                          │
│ [ MySQL / MariaDB ]                     │
│ [ MongoDB ]                             │
│ [ Redis ]                               │
│                                         │
│ ┌───────────────────────────────────┐   │
│ │ 其他（自己输入）                    │   │
│ └───────────────────────────────────┘   │
│              [ ✅ 提交回答 ]              │
└─────────────────────────────────────────┘
```

**作答的几种形态**（取决于 opencode 问的是什么）：

| 形态 | 卡上长什么样 | 怎么答 |
| --- | --- | --- |
| 单选 | 选项按钮竖排 | 点一下，变 ✅ 高亮 |
| 布尔 | 「是 / 否」两个按钮 | 点一下即答 |
| 多选 | 选项按钮，可反复点 | 点亮想要的几个，再提交 |
| 填空 / 数字 | 输入框，带 placeholder | 填好点提交 |
| 自由输入 | 任何选项题都额外带一个输入框 | 不想选就自己打字 |

**交互规则**：

- 点选即标记 `✅`，不必每次都提交。
- **所有题都答完会自动提交**，手动点提交也行。
- 有必填题没答时，卡片底部出现 `⚠ 必填未作答：xxx`。
- 提交后卡片**原地**变成结果卡（`✅ 已回答` + 每题答了什么），agent 接着往下跑。

### ④ 🐢 卡住提醒卡

某个会话持续执行中但 **10 分钟没有任何输出**时推送。给你判断「该不该管它」的上下文，和一键操作。

```
┌─────────────────────────────────────────┐
│ 🐢 opencode 疑似卡住 · 飞书 · ou_a1b2c3   │
├─────────────────────────────────────────┤
│ 会话  飞书 · ou_a1b2c3                   │
│ 最近指令  重构 server/src 下的鉴权逻辑…    │
│ 已 12 分钟无任何输出。                     │
│                                         │
│ [💬 切换到此会话]        [⏹ 中止执行]      │
│        [ 忽略（它可能只是在跑长任务）]        │
└─────────────────────────────────────────┘
```

同一会话 **2 小时内最多提醒一次**。

### ⑤ 📥 待拍板收件箱

`/inbox` 触发。把散落各处的待办聚到一起——权限待批 + 提问待答，点「▶ 处理」跳到对应的卡。

```
┌─────────────────────────────────────────┐
│ 📥 待拍板收件箱                            │
├─────────────────────────────────────────┤
│ [权限] 访问项目外目录 · C:/Windows/*      │
│        会话 飞书 · ou_a1b2c3              │
│        [▶ 处理]                          │
│ [提问] Database Selection                │
│        会话 飞书 · ou_a1b2c3              │
│        [▶ 处理]                          │
│                                         │
│ ◀ 上一页      第 1/2 页      下一页 ▶    │
└─────────────────────────────────────────┘
```

> 没有等你拍板的事时，显示 `✅ 没有等你拍板的事。`

### ⑥ 列表卡：会话 / 模型 / Agent

`/list`、`/model`、`/agent` 触发。统一样式：**当前项打标记 + 点按钮直接切换 + 无状态翻页**。

```
┌─────────────────────────────────────────┐
│ 🖥 opencode 会话                          │
├─────────────────────────────────────────┤
│ [🆕 新建会话]                             │
│ **飞书 · ou_a1b2c3（当前）**  ses_f1a3…  │
│ [📍 当前会话]                             │
│ **重构鉴权逻辑**              ses_7f2c…  │
│ [💬 切换到此会话]                         │
│                                         │
│ ◀ 上一页      第 1/2 页      下一页 ▶    │
└─────────────────────────────────────────┘
```

模型卡和 Agent 卡同款：`🧠 opencode 模型`（标注当前模型）、`🤖 opencode Agent`。

### ⑦ 🎛 功能面板

`/panel` 触发。点按钮等于发对应指令，结果以消息推送。

```
┌─────────────────────────────────────────┐
│ 🎛 opencode 功能面板                       │
├─────────────────────────────────────────┤
│   [📥 收件箱]      [📈 状态]              │
│   [📜 会话列表]   [🆕 新建会话]   [⏹ 中止] │
│   [🧠 模型]        [🤖 Agent]             │
└─────────────────────────────────────────┘
```

### ⑧ 文本回执（纯文本）

指令的普通回执、以及「已发送」类确认，都是纯文本，不弹卡片：

```
✅ 已切换绑定到 ses_7f2c9a01（重构鉴权逻辑）。
已发送到 opencode（会话 ses_7f2c9a01），完成后推送结果。
⏹ 已发送中止请求。
当前没有绑定会话。
```

### ⑨ 操作结果卡

点任何卡片按钮后的**原地回执**（卡片当场替换，不再多发一条消息）：

```
┌─────────────────────────────────────────┐
│ ✅ 已批准                                 │
├─────────────────────────────────────────┤
│ 访问项目外目录 · C:/Windows/*             │
└─────────────────────────────────────────┘
```

按操作性质自动配色：批准 / 切换 / 提交 → 绿；拒绝 / 取消 / 失败 → 红。

---

## 指令

在飞书里对机器人发：

| 指令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/panel` | 按钮面板（上面第 ⑦ 种卡） |
| `/status` | 绑定状态、长连接状态、白名单人数 |
| `/new [标题]` | 新建 opencode 会话并绑定到当前飞书会话 |
| `/list` | 会话列表卡 |
| `/switch <序号>` | 按 `/list` 里的序号切换绑定会话 |
| `/model` | 模型列表卡；`/model <序号或名称>` 直接切换 |
| `/agent` | Agent 列表卡；`/agent <序号或名称>` 直接切换 |
| `/inbox` | 待拍板收件箱 |
| `/stop` | 中止当前会话的执行 |

**除斜杠指令外的任何消息**，都会直接作为 prompt 发给当前绑定的 opencode 会话。

---

## 快速开始

> 假定你已经是 opencode 用户。整个流程只有一件麻烦事：**去飞书开放平台建一个自建应用**（第 2 步），
> 其余都是复制粘贴。

### 第 1 步：装插件

**一条命令**：

```bash
opencode plugin add feishu-bridge-opencode@git+https://github.com/parr2017/feishu-bridge-opencode.git
```

装完**重启 opencode** 让它加载。

⚠️ **如果报 `NpmInstallFailedError: git dep preparation failed`**（opencode 自带的安装器
在部分环境下会这样），用下面这个替代方案，同样两条命令：

```bash
git clone https://github.com/parr2017/feishu-bridge-opencode.git
cd feishu-bridge-opencode && npm install && opencode
```

原理：opencode 启动时会自动发现**当前目录下 `.opencode/plugin/` 里的插件**，
所以在这个目录里启动就行。缺点是只在当前目录生效。
要「任何目录都能用」，把最后一步换成建符号链接：

```bash
mkdir -p ~/.config/opencode/plugin
MSYS=winsymlinks:nativestrict ln -s "$(pwd)/.opencode/plugin/feishu.ts" ~/.config/opencode/plugin/feishu.ts
```

（Windows 建符号链接需要「设置 → 系统 → 开发者选项 → 开发者模式」已打开；
嫌麻烦就用上面「当前目录」那个方案。）

确认装上了：

```bash
opencode plugin list     # 应看到一行 local .../feishu.ts（或包名来源）
```

### 第 2 步：建飞书应用（唯一麻烦的一步）

1. 打开[飞书开放平台](https://open.feishu.cn/app)，创建一个**企业自建应用**。
2. 「凭证与基础信息」里拿到 **App ID** 和 **App Secret**（形如 `cli_` 开头）。
3. 「权限管理」里至少开启：
   - `im:message`（收发消息）
   - `im:message:send_as_bot`（以机器人身份发消息）
   - 想在群里收到消息，再加 `im:message.group_at_msg`
4. 「事件与回调」→ 订阅方式选 **「使用长连接接收事件」**
   （这样不需要公网地址，是免部署的关键）。
5. 订阅事件：
   - `接收消息 im.message.receive_v1`（必选）
   - 想让按钮能点，再加 `卡片回传交互 card.action.trigger`
6. 发布应用版本，然后把机器人**拉进目标群**（或开单聊）。

> 长连接只支持企业自建应用；选长连接后**不需要** `verification_token` / `encrypt_key`。

### 第 3 步：填凭据

启动一次 opencode，插件发现没配置会**自己把模板写到**
`~/.config/opencode/feishu-bridge-opencode.json`，并在日志里告诉你路径。

打开它，填两行，**存盘即生效（不用重启 opencode）**：

```json
{
  "appId": "cli_xxxxxxxx",
  "appSecret": "xxxxxxxx",
  "approvers": []
}
```

| 字段 | 说明 |
| --- | --- |
| `appId` / `appSecret` | 第 2 步拿到的，必填 |
| `approvers` | 能点审批卡 / 权限卡的 open_id 白名单，**留空也能用**——之后拿到 open_id 再补 |

### 第 4 步：常驻 + 验证

插件活在 opencode 进程里，**不开 opencode 飞书就找不到机器人**，所以推荐常驻：

```bash
opencode service restart
```

然后在飞书群里 @机器人 发 **`/status`**：

- 收到一张状态卡 = **成了**。
- 没反应 → 看[常见问题](#常见问题)。

---

## 配置

优先级：**环境变量 > 配置文件 > 默认值**。

配置文件按顺序找第一个存在的：

```
$FEISHU_CONFIG_FILE
<cwd>/.opencode/feishu-bridge-opencode.json           项目级
~/.config/opencode/feishu-bridge-opencode.json        全局（默认写这里）
```

全部可配项：

| 配置字段 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `appId` | `FEISHU_APP_ID` | 空 | 必填 |
| `appSecret` | `FEISHU_APP_SECRET` | 空 | 必填 |
| `approvers` | `FEISHU_APPROVERS` | `[]` | 审批白名单（open_id），逗号分隔或数组。留空则权限 / 提问卡不渲染按钮 |
| `apiBase` | `FEISHU_API_BASE` | `https://open.feishu.cn` | Lark 国际版填 `https://open.larksuite.com` |
| `notifyChatId` | `FEISHU_NOTIFY_CHAT_ID` | 空 | 权限 / 提问等需要落点时的固定目标；未绑定飞书会话时用它兜底，再回落「最后一次说话的会话」 |
| `wsEnabled` | `FEISHU_WS_ENABLED` | `true` | 长连接入站开关 |
| `webhookPort` | `FEISHU_WEBHOOK_PORT` | 空 | HTTP webhook 入站端口；填了才启用 |
| `encryptKey` | `FEISHU_ENCRYPT_KEY` | 空 | 仅 webhook 模式用 |
| `verificationToken` | `FEISHU_VERIFICATION_TOKEN` | 空 | 仅 webhook 模式用 |
| `logLevel` | `FEISHU_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `logFile` | `FEISHU_LOG_FILE` | 空 | 追加写日志文件 |

临时改某一项，直接给环境变量即可，不用动文件：

```bash
FEISHU_LOG_LEVEL=debug opencode service restart
```

> ⚠️ 别把凭据写进 `opencode.json` 的 plugin 选项——那条路实测走不通
> （本地路径的插件条目会被忽略，`ctx.options` 始终是 `{}`）。
> 详见 [docs/opencode-integration.md](docs/opencode-integration.md)。

---

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 飞书发消息没反应 | 长连接没建立 | 看日志有没有「飞书长连接已建立」；没有就是凭据错，或开放平台没切到长连接订阅模式 |
| 日志说「未启用：缺少 app_id / app_secret」 | 没跑过配置，也没配环境变量 | 启动 opencode 让它生成模板，或直接写上面的配置文件 |
| 日志说「入站通道全关」 | `wsEnabled=false` 且没配 webhook 端口 | 至少开一条 |
| 审批卡按钮点不动 | 没配白名单，或你的 open_id 不在里面 | 配 `approvers`；open_id 从日志里的 `operator` 字段拿 |
| 权限请求被自动拒绝 | 没人能应答，opencode 回落到默认策略 | 配白名单 + 确认卡片能送达 |
| `opencode plugin list` 看不到插件 | 不在对应目录启动 | 项目级插件只在该目录生效；要全局就用符号链接（见第 1 步） |
| 多个项目目录同时跑，飞书消息乱 | 插件是进程级单例，只服务第一个 location | 用 `opencode service start` 起单进程 |
| 插件加载报 `Cannot find package '@larksuiteoapi/node-sdk'` | 项目根没装依赖 | 在项目根 `npm install`；或见 [docs/opencode-integration.md](docs/opencode-integration.md) §3.5 |
| 改了配置不生效 | 没保存，或改的是另一个路径 | 存盘即生效，不用重启；确认日志里 `config` 字段指向你改的那个文件 |

排查通用入口：opencode 自己的插件日志在 `~/.local/share/opencode/log/opencode.log`，
grep `loading plugin` / `failed to load plugin`。

---

## 文档

- [docs/opencode-v2-plugin-api.md](docs/opencode-v2-plugin-api.md) —— opencode **v2 插件 API 的实测记录**。这套 API 和网上能搜到的 v1 教程完全不同，含四个坑（hook 靠原地改写入参生效、覆盖工具要包一层 `output`、`setup` 按 location 跑、hook 名不校验）。
- [docs/opencode-integration.md](docs/opencode-integration.md) —— 怎么把插件对接进 opencode：三条可行路径、几条实测走不通的路、凭据怎么传、怎么常驻、验证清单。
- [docs/architecture.md](docs/architecture.md) —— 架构、功能对照表（搬了什么 / 为什么有些没搬）、关键流程、已知限制。
- [docs/coteam-feishu-analysis.md](docs/coteam-feishu-analysis.md) —— 这些能力搬运自 co-team，这里是源码级分析。
- [docs/publishing.md](docs/publishing.md) —— 发布指南：包名、推 GitHub、发版流程、已验证 / 未验证清单。

---

## 开发

```bash
npm install           # 装依赖
npm run build         # 编译 src/ → dist/（dist 提交进仓库，改完 src 必须跑）
npm run setup         # 引导配置：校验凭据 → 写配置 → 装全局链接
npm run typecheck     # 类型检查
npm run selftest      # 纯逻辑自测（45 条断言，不需要 opencode / 不需要飞书凭据）
```

> `dist/` 与 `src/` 必须同步提交，CI 会检查。

```
index.js                     包入口（opencode 约定），转发到 dist/index.js
dist/                        构建产物（提交进仓库，安装方零构建）
src/
  index.ts                   插件定义（{ id, setup }）
  plugin.ts                  ctx 适配 + 单例守卫 + 配置自举
  bridge.ts                  opencode ↔ 飞书 核心（事件流、权限闸门、卡片路由、收件箱）
  ask.ts                     接管 question 工具：提问走飞书作答
  stall.ts                   卡住检测
  commands.ts / state.ts / config.ts / configWatcher.ts
  feishu/                    gateway(入站) · api(发消息) · cards(卡片2.0)
                             permView(权限归一) · formView(表单) · listCards · panelCard
.opencode/plugin/feishu.ts   项目内直挂入口（开发用）
docs/ · test/ · scripts/ · .github/workflows/ci.yml
```
