# 如何把这个插件对接进 opencode

> 本文件里的每一条都是**在本机实测**出来的，环境是 `@opencode/cli` **2.0.16**。
> 踩过的坑写在每条后面，避免你重复试。

---

## 0. 一句话

**跑 `npm run setup` 就完事了。** 向导会校验凭据、写配置文件、装全局符号链接，
之后在任何目录启动 opencode 都能用。

（插件本体在 `.opencode/plugin/feishu.ts`，opencode 在该目录启动时会**自动发现并加载**它——
这是底层机制，向导只是帮你把「全局可见 + 凭据就位」这两件事自动化了。）

剩下的问题是「怎么分发给别人用」，那需要打包成插件包——见 §4。

---

## 1. 三条挂载路径（实测）

### 1.1 自动发现（本项目用的就是这条，推荐）

opencode 会扫描这几个目录，里面的 `.ts` / `.js` 文件（以及子目录）都会被当作插件加载：

| 位置 | 作用范围 |
| --- | --- |
| `<项目>/.opencode/plugin/` | 项目级 |
| `<项目>/.opencode/plugins/` | 同上（两个目录名都认） |
| `~/.config/opencode/plugin/` | 全局 |
| `~/.config/opencode/plugins/` | 同上 |

实测确认：

```
$ opencode plugin list
ID  VERSION  SOURCE
-   local    D:\pxx\opencode-mobile\.opencode\plugin\feishu.ts
```

**要点**：

- 插件文件里可以 `import` 相对路径的 TS（`../../src/plugin.ts`），Bun 直接吃。
- bare import（`@larksuiteoapi/node-sdk`）会从插件目录**逐级向上找 `node_modules`**，
  所以项目根 `npm install` 之后就能解析到。
- **不需要**改任何配置文件。

### 1.2 配置里写包规格（分发用）

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["你的包名@git+https://github.com/you/your-repo.git"]
}
```

**注意配置键**：V2 是 `plugins`（复数），V1 才是 `plugin`（单数）。
这是 superpowers 的安装文档明确区分的：

```jsonc
// V1
{ "plugin":  ["superpowers@git+https://github.com/obra/superpowers.git"] }
// V2 (2.0.4+)
{ "plugins": ["superpowers@git+https://github.com/obra/superpowers.git"] }
```

包会被 opencode 的插件管理器（npm / git）装到它自己的目录里，所以
**依赖必须在包自己的 `package.json` 里声明**——不能指望宿主项目的 `node_modules`。

插件包的入口是包根目录下的 **`index.js`**。

### 1.3 符号链接（本地开发推荐）

superpowers 文档里提到：「Discovered plugin symlinks remain supported」。
即把本地 checkout 软链进 `.opencode/plugin/`，就能一边开发一边被自动发现。

---

## 2. ❌ 走不通的路（都实测过，别再试）

| 尝试 | 结果 |
| --- | --- |
| `"plugin": [["./.opencode/plugin/feishu.ts", {opts}]]` | 条目被忽略，`plugin list` 里只剩自动发现的文件；`ctx.options` 仍是 `{}` |
| `"plugins": ["D:\\...\\some-dir"]`（本地绝对路径） | 没有报错，但插件**不加载**（日志里连记录都没有） |
| `"plugins": ["/tmp/x"]` | 日志报 `ENOENT: stat '/tmp/x'`——opencode 把 `/tmp` 当**盘符相对路径**解析成 `C:\tmp` / `D:\tmp`，不认 Git Bash 的 `/tmp` |
| `opencode plugin add <本地目录>` | 直接拒绝：`Plugin target must be an npm registry package or Git package specifier` |
| 配 `.js` **文件**路径（非目录） | superpowers 文档明确说 2.0.4 / 2.0.7 会拒绝；目录才行 |

**结论**：想用配置挂载，就得是 **npm / git 包规格**；本地开发一律走**自动发现**或**符号链接**。

---

## 3. 凭据怎么传

优先级：**`ctx.options`（仅包插件） > 环境变量 > 配置文件 > 默认值**。

### 3.0 装插件的人怎么配置？（没有仓库、跑不了 `npm run setup`）

先说清楚一个硬约束：**插件跑在 opencode 服务进程里，拿不到用户的终端**，
所以它**做不了交互式向导**——没有 stdin 可以问问题。

所以对「只装了插件的人」，走的是**自举**：

1. 插件启动时发现没配置 → **自动把配置模板写到磁盘**（有效 JSON，未知字段被忽略）：

   ```json
   {
     "_help": "填好 appId / appSecret 保存即可（插件会自动重连，不用重启 opencode）。…",
     "appId": "",
     "appSecret": "",
     "approvers": [],
     "apiBase": "https://open.feishu.cn",
     "wsEnabled": true,
     "logLevel": "info"
   }
   ```

2. 同时在日志里给出路径和说明：

   ```
   WARN 飞书插件未启用：缺少 app_id / app_secret
   WARN 已生成配置模板 → C:\Users\nw02\.config\opencode\feishu-bridge-opencode.json
        填好 appId / appSecret 保存即可，插件会自动接上（不用重启 opencode）。
   INFO 正在监听配置文件变化（保存即生效）
   ```

3. 用户填两行、存盘 → **插件自动接上**，不用重启 opencode。

「改完存盘即生效」这条是实打实的：`src/configWatcher.ts` 监听配置文件所在目录，
配置变有效就自动启动桥。这段逻辑有单测（`npm run selftest` 里的
`configWatcher —— 配置文件热加载` 三条断言），因为它依赖 fs 事件和时序，
靠驱动 opencode 验证不可靠（opencode 的插件 `setup` 是惰性触发的）。

> 写这个监听的时候踩了个平台坑：`fs.watch` 回调里的 `filename`，**Windows 给的是文件名**
> （`feishu.json`），有的平台给完整路径。只比完整路径的话事件会被全部忽略——
> 是靠单测发现的。

### 3.1 有源码的人：`npm run setup` 走完整向导

```bash
npm run setup
```

会问 App ID / App Secret / 白名单 / 测试 chat_id，**当场校验凭据**，然后写配置 + 装全局链接。
装了全局链接的话，还会顺手把依赖装进 `~/.config/opencode/`（原因见 §4.1）。

### 3.2 配置文件位置

按顺序找第一个存在的：

```
$FEISHU_CONFIG_FILE
<cwd>/.opencode/feishu.json                  项目级
~/.config/opencode/feishu-bridge-opencode.json      全局（向导/自举都写这里）
```

实测确认：从 `C:\Users\nw02` 启动 opencode，插件日志里能看到

```
飞书插件已就绪 {"directory":"C:\\Users\\nw02",
              "config":"C:\\Users\\nw02\\.config\\opencode\\feishu-bridge-opencode.json",
              "approvers":2}
```

——即**不需要任何环境变量**，任何目录都能读到。

### 3.3 环境变量（临时覆盖用）

```bash
FEISHU_LOG_LEVEL=debug opencode service restart
```

要点：必须在**启动 opencode 的那个进程环境里**。Windows 上建议设系统环境变量，
比在某个终端里 `export` 稳。环境变量优先于配置文件，适合临时改一项而不动文件。

### 3.4 ❌ 插件选项 `ctx.options`

`ctx.options` 是存在的（实测 key 列表里有），但**自动发现的插件拿到的是 `{}`**——
配置里传的选项没进来（见 §2 第一行）。所以别指望用 `opencode.json` 传凭据。

（包插件按类型定义是支持 `[name, options]` 元组的，但本机这个 build 上没验证成功——
没有可用的包可装。要用这条路得先把自己的插件发成包再试。）

---

## 3.5 全局符号链接的一个已知坑（遇到再修）

**症状**：插件明明在 `opencode plugin list` 里，但加载失败：

```
WARN failed to load plugin target="...\.config\opencode\plugineishu.ts"
     cause="Cannot find package '@larksuiteoapi/node-sdk'
            imported from <项目路径>\srceishu\gateway.ts"
```

**修法**：把依赖装进 `~/.config/opencode/`（它本身就是个正常 npm 项目，
`opencode plugin add` 装的包也是装在那里）：

```bash
cd ~/.config/opencode && npm install @larksuiteoapi/node-sdk
```

**但这可能不是必须的**。后来复核时删掉 `~/.config/opencode/node_modules/@larksuiteoapi`，
再用符号链接从别的目录启动（`opencode run --standalone`），插件**照样加载正常**——
说明 Bun 在这条路径上会按符号链接的**真实路径**解析，用的是项目里的 `node_modules`。

结论：**遇到上面那个报错就按这个修，但别当成前置必做步骤**。
两种行为的差异可能和 opencode 版本、或后台服务 vs standalone 有关，没有完全定位。
`npm run setup` 里保留了「缺依赖就顺手装一个」的保险动作。

---


## 4. 要分发给别人用，需要打包

现在的形态只适合「在这个项目目录里用」。要让别人也能装：

1. 包根加 `index.js`（opencode 的入口约定），内容大致是：

   ```js
   // index.js —— 插件包入口
   export default {
     id: 'opencode-feishu',
     async setup(ctx) { /* 转发到编译后的实现 */ },
   };
   ```

2. `package.json` 里声明依赖（`@larksuiteoapi/node-sdk`）和 `main`/`exports`。
   包已经声明了 `bin`，所以装完之后 `npx opencode-feishu` 能直接跑向导
   （向导会识别「以插件包形式安装」并跳过符号链接那步）。
3. 推到 git 仓库，然后：

   ```bash
   opencode plugin add <你的包名>@git+https://github.com/you/repo.git
   # 或直接写进 ~/.config/opencode/opencode.json 的 "plugins"
   ```

> 现在项目是 TS 源码 + `.opencode/plugin/feishu.ts` 入口，属于「源码直挂」形态。
> 打包成 npm 包需要加一步构建（把 `src/` 编译成 `index.js` 能 import 的产物）。

---

## 5. 让插件常驻（重要）

插件活在 **opencode 进程**里。你不开 opencode，飞书就找不到它。

```bash
opencode service start     # 后台常驻服务
opencode service status    # 看状态（本机实测已在跑：http://127.0.0.1:49374）
opencode service stop
```

想随时在飞书里发消息就能驱动 opencode，就用后台服务；
只是偶尔用 TUI 的话，直接 `opencode` 也行。

---

## 6. 验证清单

```bash
# 1. 插件被发现了没
opencode plugin list
#    期望看到：local  .../.opencode/plugin/feishu.ts

# 2. 凭据对不对（不经过插件，直接打飞书 API）
FEISHU_APP_ID=... FEISHU_APP_SECRET=... node scripts/check-feishu.mjs

# 3. 插件真的起来了没
FEISHU_LOG_FILE=D:/pxx/opencode-mobile/feishu.log FEISHU_LOG_LEVEL=debug opencode
#    期望日志：
#      已挂载权限闸门 permission.hook('evaluate')
#      飞书插件已就绪 {"directory":"...","ws":true,...}
#      已接管 question 工具

# 4. 端到端：飞书里对机器人发 /status
```

排查不到时，opencode 自己的插件日志在：

```
~/.local/share/opencode/log/opencode.log
```

grep `loading plugin` / `failed to load plugin` 就能看到它到底加载了什么、为什么失败。

---

## 7. 参考：superpowers 是怎么接的

`obra/superpowers`（opencode 上最常被引用的插件之一）的做法：

- **不**手工往 `.opencode/plugin/` 放文件，而是走 **opencode 自己的插件管理器**：
  在 `opencode.json` 里写包规格 `"plugins": ["superpowers@git+https://github.com/obra/superpowers.git"]`，
  由 opencode 去 clone / 安装。
- 明确区分 V1 `plugin` 与 V2 `plugins` 两个配置键。
- 插件包入口是包根的 `index.js`。
- 本地开发用**符号链接**进发现目录（文档原话：discovered plugin symlinks remain supported）。
- 它对每个 harness（Claude Code / Codex / opencode …）都**单独装一遍**，
  因为各家的插件机制不通用。

对照下来，我们的项目：
- 挂载方式用**自动发现**，比 superpowers 的包规格更省事（适合自己用），
  但**要给别人用就得补 §4 的打包**。
- 不需要 superpowers 那套「skills 注册」，因为我们的能力是飞书通道，不是给模型加技能。
