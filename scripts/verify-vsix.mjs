#!/usr/bin/env node
// 校验 vsix 内容（跨平台，零依赖）
//
// ⚠️ 为什么不用 `unzip -l`：
//   GitHub 的 **windows-latest** 跑 `shell: bash` 用的是 Git-bash，
//   里面**没有 unzip.exe**。于是 `unzip -l x.vsix | grep -q foo` 永远失败，
//   检查步骤会误报「vsix 里缺少 extension.js」——文件其实好好的。
//   （CI #6 就是这么挂的：ubuntu/macos 绿，windows 红）
//
//   也不用 `grep 二进制` 代替：文件名是明文没错，但 README.md 正文里提到
//   `HANDOFF.md` 就会误判成「混进了不该进包的文件」。
//
//   这里直接解析 ZIP 的 **central directory**，拿到精确条目名。
//   纯 Buffer 操作，Node 18+ 即可，三平台结果一致。
//
// 用法：
//   node scripts/verify-vsix.mjs dist/vscode-connect-workbuddy-1.0.0.vsix
//   node scripts/verify-vsix.mjs dist          ← 自动选里面最新的一个 .vsix

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIN_BYTES = 150 * 1024;
const MAX_BYTES = 800 * 1024;

// 必须存在的条目（比较时已剥掉 vsix 的 `extension/` 前缀）
const MUST_HAVE = [
  'extension.js',
  'update-net.js',
  'package.json',
  'proxy/workbuddy-proxy.mjs',
  'lib/package.json',
  /^lib\/host-heartbeat-[\w.-]+\.js$/,
];

// 绝不能出现的条目
const MUST_NOT_HAVE = [
  /^HANDOFF\.md$/,
  /^proxy\/PROXY\.md$/,
  /^node_modules\//,
  /(^|\/)_[^/]*$/,   // _newver 之类的临时目录/文件
  /\.tgz$/,
  /\.vsix$/,
  /^scripts\//,
  /(^|\/)\.git\//,
];

/** 读 ZIP central directory，返回条目名列表 */
function listZipEntries(file) {
  const buf = readFileSync(file);
  // EOCD 在文件尾部，长度为 22 + 注释（注释最长 65535）
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/vsix：找不到 EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length) throw new Error(`central directory 越界 @${p}`);
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory 损坏 @${p}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

let file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/verify-vsix.mjs <path/to/x.vsix | 包含 vsix 的目录>');
  process.exit(2);
}

// 传目录时自动选最新的 vsix
// （必须支持：Windows 的 cmd 不会展开 `*.vsix` 通配符，npm scripts 里拿不到文件名）
if (statSync(file).isDirectory()) {
  const latest = readdirSync(file)
    .filter((n) => n.toLowerCase().endsWith('.vsix'))
    .map((n) => ({ n, t: statSync(join(file, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (!latest) {
    console.error(`::error::${file} 里没有 .vsix 再产物`);
    process.exit(1);
  }
  file = join(file, latest.n);
}

const bytes = statSync(file).size;
const kb = (bytes / 1024).toFixed(2);
console.log(`vsix: ${file}`);
console.log(`大小: ${bytes} 字节（约 ${kb} KB）`);

const errors = [];

if (bytes > MAX_BYTES) {
  errors.push(`超过 ${MAX_BYTES / 1024}KB，检查 .vscodeignore 是否漏了什么（曾因上游 .tgz 涨到 3.3MB）`);
}
if (bytes < MIN_BYTES) {
  errors.push(`小于 ${MIN_BYTES / 1024}KB，可能缺了 lib/ 或 proxy/`);
}

let entries = [];
try {
  entries = listZipEntries(file);
} catch (e) {
  errors.push(`解析失败：${e.message}`);
}

if (entries.length) {
  console.log(`条目（${entries.length}）:`);
  for (const n of entries) console.log('  ' + n);

  // vsix 是 OPC 包，真正的内容都在 `extension/` 下面。
  // 比较前先剥掉这层前缀，规则就可以按扩展目录的样子写。
  const PREFIX = 'extension/';
  const rel = entries.map((n) => (n.startsWith(PREFIX) ? n.slice(PREFIX.length) : n));

  for (const rule of MUST_HAVE) {
    const hit = typeof rule === 'string'
      ? rel.some((n) => n === rule)
      : rel.some((n) => rule.test(n));
    if (!hit) errors.push(`缺少 ${rule instanceof RegExp ? rule.source : rule}`);
  }
  for (const rule of MUST_NOT_HAVE) {
    const hit = entries.find((n) => rule.test(n.startsWith(PREFIX) ? n.slice(PREFIX.length) : n));
    if (hit) errors.push(`混进了不该进包的文件：${hit}`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log('✓ 包内容检查通过');
