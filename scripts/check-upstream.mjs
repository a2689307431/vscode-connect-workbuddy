/**
 * 检查内嵌的 host-heartbeat 模块是否落后于上游。
 *
 *   node scripts/check-upstream.mjs
 *
 * 内嵌模块是**快照**：上游适配了新的风控规则（例如 11128 闸门的指纹表）之后，
 * 我们不会自动跟上，必须手动替换 lib/host-heartbeat-*.js。
 * 这个脚本只负责提醒"该升级了"，不做替换。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const META = path.join(ROOT, 'lib', 'package.json');

async function latestVersion(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  const j = await res.json();
  return j.version;
}

function semverGt(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const info = meta.upstream || {};
const file = info.file ? path.join(ROOT, 'lib', info.file) : '';
const exists = Boolean(file) && fs.existsSync(file);
const actual = exists ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

console.log(`内嵌版本 : ${info.version || '(未记录)'}  ${info.file || ''}`);
if (!exists) console.log('⚠ lib/package.json 里记录的模块文件不存在');
if (actual && info.sha256 && actual !== info.sha256) {
  console.log(`⚠ 校验和不匹配（文件可能被改过）：期望 ${info.sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);
}

try {
  const version = await latestVersion(info.package || 'dsh-connect-workbuddy');
  console.log(`上游最新 : ${version}`);
  if (semverGt(version, info.version)) {
    console.log('\n→ 有新版，升级步骤：');
    console.log(`   1. npm pack ${info.package || 'dsh-connect-workbuddy'}@${version}`);
    console.log('   2. 解包，取 package/lib/host-heartbeat-*.js');
    console.log('   3. 保留旧文件头部的 THIRD-PARTY 注释块，拼到新文件前面');
    console.log('   4. 删掉旧的 host-heartbeat-*.js，更新 lib/package.json 的 upstream 字段');
    console.log('   5. 跑一遍冒烟测试确认模型列表 / 对话 / 积分 / 签到都正常');
  } else {
    console.log('→ 已是最新。');
  }
} catch (e) {
  console.log(`上游版本检查失败（不影响使用）：${e?.message || e}`);
}
