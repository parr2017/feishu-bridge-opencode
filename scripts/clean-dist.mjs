#!/usr/bin/env node
/**
 * 构建前清空 dist/。
 *
 * 为什么需要：tsc 不会删除「源文件已改名/删除」留下的旧产物。
 * 之前把 src/entry.ts 改名成 src/index.ts，dist/entry.js 就一直留在仓库里，
 * 被 npm pack 一起打进包里（实测发现）。
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });
