# 发布指南

目标：**用户一条命令装上**。

---

## 0. 先确认包名（重要）

**`opencode-feishu` 这个名字在 npm 上已经被占了**（v1.10.10，来自 `NeverMore93/opencode-feishu`）。

实测过：如果你的配置写 `"plugins": ["opencode-feishu"]`，opencode 会去 registry 装**别人的包**，
不是你的。所以本项目用的是 **`opencode-plugin-feishu`**（已确认可用）。

其他当时可用的名字：`feishu-opencode`、`opencode-feishu-connector`、`feishu-bridge-opencode`。
想换就改 `package.json` 的 `name` 和 `src/index.ts` 里的 `id`（两处保持一致）。

发布前再确认一次名字没被抢：

```bash
npm view <包名> version    # 报 404 就是可用
```

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
git remote add origin https://github.com/<你的用户名>/opencode-plugin-feishu.git
git branch -M main
git push -u origin main
```

---

## 3. 用户的安装方式

### 方式 A：git 直装（推荐，不需要发 npm）

```bash
opencode plugin add opencode-plugin-feishu@git+https://github.com/<你的用户名>/opencode-plugin-feishu.git
```

或手写配置 `~/.config/opencode/opencode.json`：

```jsonc
{
  "plugins": ["opencode-plugin-feishu@git+https://github.com/<你的用户名>/opencode-plugin-feishu.git"]
}
```

> **配置键是 `plugins`（复数）**——opencode **V2** 的写法；V1 才是 `plugin`。
> 实测写错了条目会被静默忽略，什么都不发生。

想钉版本就加 `#tag`：

```jsonc
{ "plugins": ["opencode-plugin-feishu@git+https://github.com/<你>/opencode-plugin-feishu.git#v0.1.0"] }
```

### 方式 B：发到 npm

```bash
npm login
npm publish --access public
```

之后用户：

```bash
opencode plugin add opencode-plugin-feishu
```

`package.json` 里已经有 `prepack: npm run build`，发布时会自动重新构建一遍。

### 装完之后

**用户不需要跑任何向导。** 启动 opencode，插件会自己把配置模板写到
`~/.config/opencode/opencode-feishu.json` 并在日志里给出路径；用户填两行存盘即生效
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

**验证过的**

- 包结构正确：`npm install <git-spec>` 能装出完整可用的包
  （`index.js` / `dist/` / 依赖齐全），`import` 出来是 `{ id, setup }`。
- 入口两种约定都满足：包根 `index.js`（opencode 文档里的说法）
  和 `main: dist/index.js`（实测 opencode 对另一个包用的就是这个）。
- 插件本体：opencode 2.0.16 里能加载、权限闸门能挂、`question` 工具能接管。
- 配置自举 + 热加载：有单测（`npm run selftest`）。

**没验证到的（本机环境限制）**

- **真实的 `git+https://github.com/...` 安装**——这台机器访问 GitHub 被重置，拉不下来。
- **npm registry 安装**——需要真的发布，那是公开动作，没做。
- 顺带发现：opencode 内置的安装器（Bun 实现）对 `git+file://` 本地 URL 会报
  `git dep preparation failed`，而同样 spec 用 `npm install` 是成功的。
  所以「本地 git URL 装不上」**不代表** `git+https` 也会失败，但也确实没验证过。

第一次真发出去之后，建议自己先用方式 A 在一台干净机器上装一遍确认。

---

## 6. 开源清单

- [x] `LICENSE`（MIT）
- [x] `.gitignore`（`node_modules/`、`.env`、日志、`.test-build/`；**不忽略 `dist/`**）
- [x] `README.md`（安装 / 能力 / 配置 / FAQ / 开发）
- [x] `docs/`（v2 插件 API 实测、co-team 源码分析、架构、对接方式、本文件）
- [x] CI（`.github/workflows/ci.yml`）
- [ ] 仓库描述与 topics：`opencode` `opencode-plugin` `feishu` `lark` `bot`
- [ ] 可选：`CONTRIBUTING.md`、issue 模板
