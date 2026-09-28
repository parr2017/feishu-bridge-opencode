# 发布指南

目标：**用户一条命令装上**。

---

## 0. 包名：`feishu-bridge-opencode`

**为什么不用 `opencode-feishu`**：这个名字在 npm 上已经被占了
（v1.10.10，来自 `NeverMore93/opencode-feishu`）。

实测过：如果你的配置写 `"plugins": ["opencode-feishu"]`，opencode 会去 registry 装**别人的包**，
不是你的——我第一次测试就是这么被坑的（装出来的包里 `main` 是 `dist/index.js`，来自另一个项目）。

所以本项目用 **`feishu-bridge-opencode`**（发版前实测确认 npm 上 404，可用）。

发布前再确认一次没被抢：

```bash
npm view feishu-bridge-opencode version    # 报 404 就是可用
```

要换名字的话，改这几处并保持一致：

| 位置 | 字段 |
| --- | --- |
| `package.json` | `name`、`bin` 的键 |
| `src/index.ts` | 插件 `id` |
| `src/log.ts` | 日志前缀 |
| `src/config.ts` | 配置文件名（`defaultConfigPath()`） |
| `scripts/setup.mjs` | `CONFIG_PATH`、`PLUGIN_LINK`、横幅文案 |
| `README.md` / `docs/` | 安装命令与路径 |

---

## 1. 仓库结构（已就绪）

```
index.js            手写的稳定壳，只做转发 → dist/index.js
dist/               构建产物，**提交进仓库**
src/                TypeScript 源码
.opencode/plugin/   项目内直挂入口（开发用）
scripts/setup.mjs   配置向导（同时是包的 bin）
.github/workflows/  CI：类型检查 + 自测 + 校验 dist 与 src 同步
```

### 为什么把 `dist/` 提交进仓库

opencode 装包时只做 **clone + 装依赖**，不会替你跑构建。把 `dist/` 一起提交，
安装方就**零构建步骤**。CI 里有一道守卫：如果 `dist/` 和 `src/` 不同步，构建会失败。

改了 `src/` 之后记得：

```bash
npm run build && git add -A && git commit
```

---

## 2. 推到 GitHub

```bash
git remote add origin https://github.com/parr2017/feishu-bridge-opencode.git
git branch -M main
git push -u origin main
```

---

## 3. 用户的安装方式

### 方式 A：git 直装（推荐，不需要发 npm）

```bash
opencode plugin add feishu-bridge-opencode@git+https://github.com/parr2017/feishu-bridge-opencode.git
```

或手写配置 `~/.config/opencode/opencode.json`：

```jsonc
{
  "plugins": ["feishu-bridge-opencode@git+https://github.com/parr2017/feishu-bridge-opencode.git"]
}
```

> **配置键是 `plugins`（复数）**——opencode **V2** 的写法；V1 才是 `plugin`。
> 实测写错了条目会被静默忽略，什么都不发生。

想钉版本就加 `#tag`：

```jsonc
{ "plugins": ["feishu-bridge-opencode@git+https://github.com/parr2017/feishu-bridge-opencode.git#v0.1.0"] }
```

### 方式 B：发到 npm

```bash
npm login
npm publish --access public
```

之后用户：

```bash
opencode plugin add feishu-bridge-opencode
```

`package.json` 里已经有 `prepack: npm run build`，发布时会自动重新构建一遍。

### 装完之后

**用户不需要跑任何向导。** 启动 opencode，插件会自己把配置模板写到
`~/.config/opencode/feishu-bridge-opencode.json` 并在日志里给出路径；用户填两行存盘即生效
（插件在监听这个文件）。详见 [opencode-integration.md](./opencode-integration.md) §3.0。

---

## 4. 发版流程

```bash
npm run typecheck && npm run selftest      # 本地先过一遍
npm version patch                          # 或 minor / major
npm run build                              # 重新构建 dist
git add -A && git commit -m "chore: release vX.Y.Z"
git push && git push --tags
# 要发 npm 的话再 npm publish
```

CI 会在 push / PR 时跑：类型检查、45 条自测、以及「`dist/` 是否与 `src/` 同步」。

---

## 5. 已经验证到什么程度（别重复踩）

**已验证**

- **远端仓库内容完整**：用 SSH 克隆 `git@github.com:parr2017/feishu-bridge-opencode.git`，
  `npm install` 后 `import('./index.js')` 得到 `{ id: 'feishu-bridge-opencode' }`。
  这就是用户装包时会拿到的东西——入口、`dist/`、依赖声明都对。
- 包结构正确：`npm install <git-spec>` 能装出完整可用的包。
- 入口两种约定都满足：包根 `index.js`，以及 `main: dist/index.js`。
- 插件本体：opencode 2.0.16 里能加载、权限闸门能挂、`question` 工具能接管。
- 配置自举 + 热加载：有单测（`npm run selftest`，45 条断言）。

**未验证（本机网络限制）**

- **`opencode plugin add <git+https://...>` 这条命令本身没跑通**——
  开发这台机器**访问 github.com 的 443 端口被封**（SSH 22 通，HTTPS 不通）。
  所以走 HTTPS 的 clone 在这里做不到，命令无法端到端验证。
  （远端内容本身已经用 SSH 克隆验证过了，见上。）

- **npm registry 安装**——`registry.npmjs.org` 从这里可达（HTTP 200），
  但需要先 `npm login` + `npm publish`，那是公开动作，没做。

**给你的实操建议**

如果你本机也访问不了 github.com 的 HTTPS，`opencode plugin add <git+https>` 对你也用不了。
两条出路：

1. **发到 npm**（推荐）——npm registry 从这台机器可达，用户装的是
   `opencode plugin add feishu-bridge-opencode`，不依赖 GitHub。
2. 给终端配 HTTPS 代理，再走 git URL。

另外记得确认 GitHub 仓库是 **Public**（Settings → General → 最下面 Change visibility）——
opencode 装包时不带凭据，私有仓库拉不下来。

## 6. 开源清单

- [x] `LICENSE`（MIT）
- [x] `.gitignore`（`node_modules/`、`.env`、日志、`.test-build/`；**不忽略 `dist/`**）
- [x] `README.md`（安装 / 能力 / 配置 / FAQ / 开发）
- [x] `docs/`（v2 插件 API 实测、co-team 源码分析、架构、对接方式、本文件）
- [x] CI（`.github/workflows/ci.yml`）
- [ ] 仓库描述与 topics：`opencode` `opencode-plugin` `feishu` `lark` `bot`
- [ ] 可选：`CONTRIBUTING.md`、issue 模板
