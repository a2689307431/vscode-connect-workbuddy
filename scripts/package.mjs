#!/usr/bin/env node
// 打包 vsix 到 dist/
//
// ⚠️ 为什么需要这个脚本（别退回成直接写 npx vsce）：
//   `vsce package --out <path>` 的 --out 是"输出路径"，**不是**"输出目录"。
//   如果该路径不存在，vsce 会把整串当**文件名**，直接生成一个叫 `dist`
//   的普通文件（无扩展名），后续 `ls dist/*.vsix` 全部落空。
//   CI 上 dist/ 是 gitignored 的 → 每次都是干净环境 → 必然踩到（曾导致
//   CI 在「包体积与内容检查」步骤 exit 2）。本地能通过只是因为 dist/ 已存在。
//   所以这里必须先 mkdir，且 CI 与本地共用同一份逻辑。
//
// 用法：
//   npm run package

import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'dist');

mkdirSync(outDir, { recursive: true });

const r = spawnSync(
  'npx',
  ['--yes', '@vscode/vsce', 'package', '--allow-missing-repository', '--out', outDir],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);

if (r.error) {
  console.error('打包失败:', r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
