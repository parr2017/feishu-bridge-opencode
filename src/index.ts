/**
 * 插件包入口（编译成 `dist/entry.js`，由包根的 `index.js` 再导出）。
 *
 * opencode 的包插件约定：包根必须有 `index.js`，它的 default export 是插件定义。
 *
 * v2 与 v1 的差别（实测，别照抄网上的 v1 教程）：
 *   - **只认 default export**，且必须是 `{ id, setup }` / `{ id, effect }`；
 *     v1 那种「一个模块导出多个具名插件函数」在这里完全不生效。
 *   - 没有 `ctx.client`；要用 opencode 能力走 `ctx.session.*` / `ctx.event.*` / `ctx.storage.*`。
 *   - opencode.json 里 plugin 元组的第二项会作为 `ctx.options` 传进来。
 *
 * 详细 API 见 docs/opencode-v2-plugin-api.md（实测记录）。
 */
import { startPlugin } from './plugin.ts';

export default {
  id: 'feishu-bridge-opencode',
  async setup(ctx: unknown): Promise<void> {
    await startPlugin(ctx);
  },
};
