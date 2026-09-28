/**
 * 项目内直挂入口（开发用）：opencode 在**本目录**启动时会自动发现 `.opencode/plugin/` 下的文件。
 *
 * 发布出去的那个入口是包根的 `index.js`（编译产物），见 `src/entry.ts`。
 * 这里只做一层转发，保证两种加载方式跑的是同一份实现。
 */
export { default } from '../../src/entry.ts';
