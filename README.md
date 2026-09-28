# feishu-bridge-opencode

把**飞书**接入 **opencode** 的插件。在飞书里发消息，本机 opencode 干活，结果、授权审批、提问作答都在飞书闭环。

- 目标运行时：`@opencode/cli` **2.x**（本机实测 2.0.16）
- 入站：飞书**长连接**（出站 WebSocket，**不需要公网**），可选 HTTP webhook
- 依赖：`@larksuiteoapi/node-sdk`（仅长连接用）+ Node 内置模块，无 Redis / 无数据库 / 无独立服务进程

---

## 它能做什么

在飞书里发消息 → 本机 opencode 干活 → 结果、授权审批、提问作答都回到飞书。
**不需要公网、不需要服务器、不需要数据库。**

| 飞书里 | 效果 |
| --- | --- |
| 直接发一句话 | 作为 prompt 发给当前绑定的 opencode 会话 |
| opencode 跑完 | 推「✅ 已完成」卡，正文是助手回复，卡上带输入框可继续追问 |
| opencode 要授权 | 推「⛔ 需要授权」卡，动作名归一成中文（读取文件/执行命令/访问项目外目录…），点 **批准一次 / 总是批准 / 拒绝** |
| opencode 向你提问 | 推「❓ 提问」卡，选项可点、也可自己输入，答完自动提交，agent 接着往下跑 |
| `/list` | 会话列表卡，点按钮切换绑定 |
| `/model` `/agent` | 列表卡，点按钮切换 |
| `/new` `/switch` `/stop` | 新建并绑定 / 按序号切换 / 中止执行 |
| `/inbox` | 待拍板收件箱：聚合待裁决的权限与待作答的提问 |
| `/panel` | 按钮面板 |
| 长时间没输出 | 推「🐢 疑似卡住」提醒卡（切换会话 / 中止 / 忽略） |
| `/status` | 绑定状态、长连接状态、白名单人数 |

---

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
| `approvers` | 能点审批卡/权限卡的 open_id 白名单，**留空也能用**——之后拿到 open_id 再补 |

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

**优先级：环境变量 > 配置文件 > 默认值。**

推荐用 `npm run setup` 生成配置文件（见上文「快速开始」）。想手工改就直接编辑
`~/.config/opencode/feishu-bridge-opencode.json`：

```json
{
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "approvers": ["ou_a", "ou_b"],
  "notifyChatId": "",
  "apiBase": "https://open.feishu.cn",
  "wsEnabled": true,
  "logLevel": "info"
}
```

临时覆盖某一项，用环境变量（不用改文件）：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_APPROVERS=ou_a,ou_b        # 逗号分隔，能点审批卡的账号
FEISHU_NOTIFY_CHAT_ID=            # 可选：固定推送落点，默认回落到最后说话的会话
FEISHU_API_BASE=https://open.feishu.cn   # Lark 国际版填 https://open.larksuite.com
FEISHU_WS_ENABLED=true
FEISHU_LOG_LEVEL=info             # debug 排查用
FEISHU_LOG_FILE=D:/pxx/opencode-mobile/feishu.log
```

> ⚠️ **别写进 `opencode.json` 的 plugin 选项**——那条路实测走不通：本地路径的插件条目会被忽略
> （`ctx.options` 始终是 `{}`），V2 的配置键还是 `plugins`（复数）且只吃 npm/git 包规格。
> 详见 [docs/opencode-integration.md](docs/opencode-integration.md)。

> 完整可配项见 [.env.example](.env.example)——每项都能写进配置文件的同名驼峰字段。

---

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 飞书发消息没反应 | 长连接没建立 | 看日志有没有「飞书长连接已建立」；没有就是凭据错或开放平台没切到长连接订阅模式 |
| 日志说「飞书插件未启用：缺少 app_id / app_secret」 | 没跑过 `npm run setup`，也没有环境变量 | 跑 `npm run setup`；或确认环境变量在**启动 opencode 的那个进程**里 |
| 日志说「入站通道全关」 | `wsEnabled=false` 且没配 webhookPort | 至少开一条 |
| 审批卡按钮点不动 | 没配 `FEISHU_APPROVERS`，或你的 open_id 不在里面 | 配白名单；open_id 从日志里的 `operator` 字段拿 |
| 权限请求被自动拒绝 | 没人能应答，opencode 回落到默认策略 | 配白名单 + 保证卡片能送达 |
| `opencode plugin list` 看不到 | 不在本项目目录下跑的 opencode | 项目级插件只在对应目录生效；要全局就把插件放进 `~/.config/opencode/plugin/` |
| 多个项目目录同时跑，飞书消息乱 | 插件是进程级单例，只服务第一个 location | 用 `opencode service start` 起单进程 |
| 插件加载报 `Cannot find package '@larksuiteoapi/node-sdk'` | 项目根没 `npm install` | 在项目根跑 `npm install` |
| 用了全局符号链接后仍报上面这个错 | 符号链接的 bare import 从**链接所在目录**找依赖，全局配置目录里没有 | `cd ~/.config/opencode && npm install @larksuiteoapi/node-sdk`（`npm run setup` 会自动做） |

排查不到时看 opencode 自己的插件日志：`~/.local/share/opencode/log/opencode.log`，
grep `loading plugin` / `failed to load plugin`。

---

## 文档

- [docs/opencode-v2-plugin-api.md](docs/opencode-v2-plugin-api.md)
  —— **v2 插件 API 实测记录**。这套 API 与网上能搜到的 v1 教程完全不同，包含四个坑：
  hook 靠**原地改写入参**生效（返回值被忽略）、覆盖工具时 execute 要包一层 `output`、
  `setup` 按 location 跑、hook 名不校验。
- [docs/coteam-feishu-analysis.md](docs/coteam-feishu-analysis.md)
  —— co-team 里 opencode × 飞书 的源码分析：哪些能搬、哪些在插件形态下多余。
- [docs/publishing.md](docs/publishing.md)
  —— **发布指南**：包名确认、推 GitHub、用户的一条命令安装、发版流程、
  以及「已经验证到什么程度 / 哪些没验证」。
- [docs/architecture.md](docs/architecture.md)
  —— 架构、功能对照表（搬了什么 / 为什么有些没搬）、关键流程、已知限制。
- [docs/opencode-integration.md](docs/opencode-integration.md)
  —— **怎么把插件对接进 opencode**：三条可行路径、几条实测走不通的路径、
  凭据怎么传、怎么常驻、验证清单，以及 superpowers 的接法对照。

---

## 开发

```bash
npm install           # 装依赖
npm run build         # 编译 src/ → dist/（dist 是提交进仓库的，改完 src 记得跑）
npm run setup         # 引导配置（校验凭据 → 写配置 → 装全局链接）
npm run typecheck     # 类型检查
npm run selftest      # 纯逻辑自测（45 条断言，不需要 opencode / 不需要飞书凭据）
npm run check         # 飞书凭据自检（独立于插件，直接打飞书 API）
```

> `dist/` 与 `src/` 必须同步提交（CI 会检查）。

`selftest` 覆盖卡片 2.0 构件、权限载荷归一、表单字段映射与状态机、四类列表卡与翻页、面板卡。
它把 `src/` 用 tsc 编译到 `.test-build/` 再交给 node 跑，所以不引 vitest/jest 这类测试运行时。

目录结构：

```
index.js                     包入口（opencode 约定），转发到 dist/index.js
dist/                        构建产物（提交进仓库，让安装方零构建步骤）
.github/workflows/ci.yml     类型检查 + 自测 + 校验 dist 与 src 同步
.opencode/plugin/feishu.ts   项目内直挂入口（开发用）
src/plugin.ts                ctx 适配 + 单例守卫
src/bridge.ts                opencode ↔ 飞书 核心（事件流、权限闸门、卡片路由、收件箱）
src/ask.ts                   接管 question 工具：提问走飞书作答
src/stall.ts                 卡住检测
src/commands.ts              指令路由
src/state.ts                 绑定关系（走 ctx.storage）
src/feishu/gateway.ts        长连接 + 可选 HTTP webhook 入站
src/feishu/api.ts            token / 发消息 / 发卡 / 更新卡
src/feishu/cards.ts          卡片 2.0 构件库
src/feishu/permView.ts       权限载荷归一（v2 真字段优先）
src/feishu/formView.ts       表单字段视图与状态机
src/feishu/listCards.ts      会话/模型/Agent/收件箱 列表卡
src/feishu/panelCard.ts      功能面板卡
test/selftest.ts             纯逻辑自测
docs/                        实测记录、源码分析、架构
scripts/setup.mjs            引导配置向导
scripts/check-feishu.mjs     凭据自检
```
