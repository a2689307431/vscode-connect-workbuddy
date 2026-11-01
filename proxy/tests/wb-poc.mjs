// PoC：验证能否用 dsh-connect-workbuddy 的凭据直连 WorkBuddy 的 OpenAI 兼容端点。
// 只发一次最小请求（约 0.x 积分）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB = 'C:/Users/Lenovo/.dsh/profiles/web/node_modules/dsh-connect-workbuddy/lib';

// 文件名带 hash，升级会变 → 动态找
const hbFile = fs.readdirSync(LIB).find((f) => /^host-heartbeat-.*\.js$/.test(f));
if (!hbFile) { console.error('✗ 找不到 host-heartbeat-*.js'); process.exit(1); }
console.log('模块：', hbFile);

const mod = await import(pathToFileURL(path.join(LIB, hbFile)).href);
const Store = mod.C;   // WorkBuddyCredentialStore
const Client = mod.V;  // WorkBuddyUpstreamClient

const client = new Client();
const store = new Store({ region: 'cn', refresh: (c) => client.refreshToken(c) });
const cred = await store.resolve();

console.log('✓ 拿到凭据');
console.log('  domain      :', cred.domain);
console.log('  accessToken :', String(cred.accessToken).slice(0, 24) + `…（共 ${String(cred.accessToken).length} 字符）`);
console.log('  refreshToken:', cred.refreshToken ? '有' : '无');

// 国内区 chat 基址（源码里 CN_CHAT_BASE）
const chatBase = 'https://copilot.tencent.com';
const url = `${chatBase}/v2/chat/completions`;
const body = {
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: '只回两个字：收到' }],
  stream: true,
};

console.log('\n→ POST', url);
const t0 = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${cred.accessToken}`,
    'X-Product': 'SaaS',
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60_000),
});
const text = await res.text();
console.log(`← HTTP ${res.status}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (!res.ok) { console.log(text.slice(0, 800)); process.exit(1); }

// 解析 SSE
let content = '';
let chunks = 0;
for (const line of text.split('\n')) {
  const s = line.trim();
  if (!s.startsWith('data:')) continue;
  const payload = s.slice(5).trim();
  if (payload === '[DONE]') break;
  try {
    const j = JSON.parse(payload);
    chunks++;
    const d = j.choices?.[0]?.delta?.content;
    if (d) content += d;
    if (chunks === 1) console.log('首个 chunk 结构:', JSON.stringify(j).slice(0, 300));
  } catch { /* 忽略非 JSON 行 */ }
}
console.log(`\n✓ 收到 ${chunks} 个 chunk，正文："${content}"`);
