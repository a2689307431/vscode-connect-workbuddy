// update-net.js 的端到端回归测试（手工跑，不进 CI —— 需要真实网络和可用的本机代理）
//
// 用法: node proxy/tests/update-net.cjs
// 覆盖: 格式解析 / HTTP 代理 / SOCKS5 代理 / 直连 / PAC / 302 重定向 / sha256
const { parseProxy, normalizeProxyUrl, systemProxy, httpGet, readStreamAll } = require('../../update-net');

const GH_API = 'https://api.github.com/repos/a2689307431/vscode-connect-workbuddy/releases/latest';
const GH_VSIX =
  'https://github.com/a2689307431/vscode-connect-workbuddy/releases/download/v1.0.0/vscode-connect-workbuddy-1.0.0.vsix';
const EXPECT_SHA = '489927438c1834391a34efac2e94e33dbdf9b1449e9d2df1247d8b1dedbc8522';

let pass = 0;
let fail = 0;
const ok = (name, extra = '') => {
  pass++;
  console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
};
const bad = (name, e) => {
  fail++;
  console.log(`  ✗ ${name}  → ${e?.message || e}`);
};

(async () => {
  // ── 1. 代理格式解析 ──────────────────────────────────────────
  console.log('\n=== 1. 格式解析 ===');
  const cases = [
    ['127.0.0.1:7897', 'http', '127.0.0.1', 7897],
    ['http://127.0.0.1:7897', 'http', '127.0.0.1', 7897],
    ['socks5://127.0.0.1:7891', 'socks5', '127.0.0.1', 7891],
    ['socks5h://127.0.0.1:1080', 'socks5', '127.0.0.1', 1080],
    ['socks://127.0.0.1:1080', 'socks5', '127.0.0.1', 1080],
    ['http=1.2.3.4:8080;https=1.2.3.4:8443', 'http', '1.2.3.4', 8443],
    ['http=1.2.3.4:8080', 'http', '1.2.3.4', 8080],
    ['HTTPS://proxy.local:3128', 'http', 'proxy.local', 3128],
  ];
  for (const [input, type, host, port] of cases) {
    const p = parseProxy(input);
    if (p.type === type && p.host === host && p.port === port) ok(`${input} → ${type} ${host}:${port}`);
    else bad(`解析 ${input}`, `得到 ${JSON.stringify(p)}`);
  }

  for (const s of ['http://proxy.local/proxy.pac', 'file:///C:/proxy.pac', 'https://x.com/a.pac?x=1']) {
    const p = parseProxy(s);
    if (p.type === 'pac') ok(`PAC 识别 ${s}`);
    else bad(`PAC 识别 ${s}`, `得到 ${p.type}`);
  }

  const auth = parseProxy('socks5://user:p%40ss@10.0.0.1:1080');
  if (auth.username === 'user' && auth.password === 'p@ss') ok('SOCKS5 用户名密码解码');
  else bad('SOCKS5 认证解析', JSON.stringify(auth));

  const authHttp = parseProxy('http://u:p@h:8080');
  if (authHttp.username === 'u' && authHttp.password === 'p') ok('HTTP 代理认证解析');
  else bad('HTTP 认证解析', JSON.stringify(authHttp));

  if (normalizeProxyUrl('socks5://127.0.0.1:7891') === 'socks5://127.0.0.1:7891') ok('normalize 保留 socks5');
  else bad('normalize socks5', normalizeProxyUrl('socks5://127.0.0.1:7891'));

  // ── 2. 系统代理探测 ──────────────────────────────────────────
  console.log('\n=== 2. 系统代理探测 ===');
  const sys = systemProxy();
  console.log(`  systemProxy() = ${JSON.stringify(sys)}  (platform=${process.platform})`);
  if (process.platform === 'win32') {
    sys ? ok('Windows 注册表探测') : console.log('  ~ 未探测到系统代理（代理没开？）');
  } else {
    console.log('  ~ 非 Windows 平台，跳过断言（Linux 需 gsettings，macOS 需 scutil）');
  }

  // ── 3. 直连 ────────────────────────────────────────────────
  console.log('\n=== 3. 直连（无代理）===');
  try {
    const t = Date.now();
    const r = await httpGet(GH_API, {
      headers: { 'user-agent': 't', accept: 'application/vnd.github+json' },
      timeout: 10000,
    });
    const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
    ok('直连查 Release', `${r.status} ${Date.now() - t}ms tag=${j.tag_name}`);
  } catch (e) {
    console.log(`  ~ 直连失败（环境决定，不算错）：${e.message}`);
  }

  if (!sys) {
    console.log('\n跳过 4/5：没有可用代理');
  } else {
    const httpProxy = sys.replace(/^socks5:\/\//, 'http://');

    // ── 4. HTTP 代理（CONNECT 隧道）──────────────────────────
    console.log('\n=== 4. HTTP 代理隧道 ===');
    try {
      const t = Date.now();
      const r = await httpGet(GH_API, {
        headers: { 'user-agent': 't', accept: 'application/vnd.github+json' },
        timeout: 20000,
        proxy: httpProxy,
      });
      const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
      ok('HTTP CONNECT', `${r.status} ${Date.now() - t}ms tag=${j.tag_name}`);
    } catch (e) {
      bad('HTTP CONNECT', e);
    }

    try {
      const t = Date.now();
      const r = await httpGet(GH_VSIX, { headers: { 'user-agent': 't' }, timeout: 60000, proxy: httpProxy });
      const buf = await readStreamAll(r.stream, 64 * 1024 * 1024);
      const h = require('node:crypto').createHash('sha256').update(buf).digest('hex');
      if (h === EXPECT_SHA) ok('HTTP 下载 vsix（含 302）', `${buf.length}B ${Date.now() - t}ms sha256✓`);
      else bad('HTTP 下载 vsix', `sha256 不符 ${h}`);
    } catch (e) {
      bad('HTTP 下载 vsix', e);
    }

    // ── 5. SOCKS5 代理 ──────────────────────────────────────
    console.log('\n=== 5. SOCKS5 代理 ===');
    const socksUrl = sys.replace(/^http:\/\//, 'socks5://');
    if (parseProxy(socksUrl).type !== 'socks5') {
      console.log(`  跳过：${sys} 转不成 socks5`);
    } else {
      try {
        const t = Date.now();
        const r = await httpGet(GH_API, {
          headers: { 'user-agent': 't', accept: 'application/vnd.github+json' },
          timeout: 20000,
          proxy: socksUrl,
        });
        const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
        ok('SOCKS5 查 Release', `${r.status} ${Date.now() - t}ms tag=${j.tag_name}`);
      } catch (e) {
        bad('SOCKS5 查 Release', e);
      }

      try {
        const t = Date.now();
        const r = await httpGet(GH_VSIX, { headers: { 'user-agent': 't' }, timeout: 60000, proxy: socksUrl });
        const buf = await readStreamAll(r.stream, 64 * 1024 * 1024);
        const h = require('node:crypto').createHash('sha256').update(buf).digest('hex');
        if (h === EXPECT_SHA) ok('SOCKS5 下载 vsix（含 302）', `${buf.length}B ${Date.now() - t}ms sha256✓`);
        else bad('SOCKS5 下载 vsix', `sha256 不符 ${h}`);
      } catch (e) {
        bad('SOCKS5 下载 vsix', e);
      }
    }
  }

  // ── 6. PAC 应报明确错误 ───────────────────────────────────
  console.log('\n=== 6. PAC 明确报错 ===');
  try {
    await httpGet(GH_API, { proxy: 'http://proxy.local/proxy.pac', timeout: 5000 });
    bad('PAC 报错', '竟然成功了');
  } catch (e) {
    if (/PAC/.test(e.message)) ok('PAC 给出可读提示', e.message.slice(0, 40) + '…');
    else bad('PAC 报错信息', e.message);
  }

  // ── 7. 无效代理应快速失败 ─────────────────────────────────
  console.log('\n=== 7. 无效代理快速失败 ===');
  try {
    await httpGet(GH_API, { proxy: '127.0.0.1:1', timeout: 5000 });
    bad('无效代理', '竟然成功了');
  } catch (e) {
    ok('无效代理报错', e.message.slice(0, 40));
  }

  console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
  process.exit(fail ? 1 : 0);
})();
