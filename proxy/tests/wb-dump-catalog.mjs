// 照抄插件真实做法：读 /v2/enterprises/personal/models 拿模型目录
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB = 'C:/Users/Lenovo/.dsh/profiles/web/node_modules/dsh-connect-workbuddy/lib';
const hbFile = fs.readdirSync(LIB).find((f) => /^host-heartbeat-.*\.js$/.test(f));
const mod = await import(pathToFileURL(path.join(LIB, hbFile)).href);

const client = new mod.V();
const store = new mod.C({ region: 'cn', refresh: (c) => client.refreshToken(c) });
const cred = await store.resolve();

const base = 'https://copilot.tencent.com';
const UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0';
const origin = `https://${cred.domain || 'www.workbuddy.cn'}`;

const headers = {
  'Authorization': `Bearer ${cred.accessToken}`,
  'Accept': 'application/json',
  'Origin': origin,
  'Referer': `${origin}/`,
  'User-Agent': UA,
};

for (const p of ['/v2/enterprises/personal/models', '/v3/config']) {
  const res = await fetch(`${base}${p}`, { headers });
  const txt = await res.text();
  const name = p.replace(/\W+/g, '_');
  fs.writeFileSync(`C:/Users/Lenovo/.dsh/_desktop/wb-${name}.json`, txt, 'utf8');
  console.log(`\n===== ${p} → HTTP ${res.status}，${txt.length} 字符 =====`);
  console.log(txt.slice(0, 1200));
}
