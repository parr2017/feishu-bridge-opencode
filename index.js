/**
 * 插件包入口 —— opencode 的包插件约定：包根要有 `index.js`，default export 即插件定义。
 *
 * 本文件是**手写的稳定壳**，只做转发；实现全部在 `dist/`（`npm run build` 从 `src/` 编译）。
 * `dist/` 一并提交进仓库，是为了让安装方**零构建步骤**就能用——
 * opencode 用 `name@git+https://...` 装包时只做 clone + 装依赖，不会替你跑构建。
 */
export { default } from './dist/index.js';
