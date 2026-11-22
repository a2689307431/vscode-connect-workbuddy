// 用真实 GitHub 端点验证兜底链路（需联网，不进 CI）
// 用法: node proxy/tests/release-fallback.live.cjs
const { httpGet, readStreamAll } = require('../../update-net');
const { parseReleaseAtom, parseExpandedAssets } = require('../../release-parse');

const REPO = 'a2689307431/vscode-connect-workbuddy';
const PROXY = process.argv[2] || '';

async function get(url) {
  const r = await httpGet(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; vscode-connect-workbuddy-updater)' },
    timeout: 25000,
    proxy: PROXY,
  });
  if (r.status !== 200) { r.stream.resume(); throw new Error('HTTP ' + r.status); }
  return (await readStreamAll(r.stream, 8 * 1024 * 1024)).toString('utf8');
}

(async () => {
  console.log('proxy:', PROXY || '直连');

  console.log('\n=== 1. releases.atom ===');
  let parsed;
  try {
    const xml = await get(`https://github.com/${REPO}/releases.atom`);
    parsed = parseReleaseAtom(xml);
    console.log('  解析结果:', JSON.stringify(parsed, null, 2).split('\n').slice(0, 6).join(' '));
    if (!parsed) { console.log('  ✗ 解析失败'); process.exit(1); }
    console.log('  ✓ tag =', parsed.tag, '| version =', parsed.version);
  } catch (e) {
    console.log('  ✗', e.message); process.exit(1);
  }

  console.log('\n=== 2. expanded_assets ===');
  let vsixName;
  try {
    const html = await get(`https://github.com/${REPO}/releases/expanded_assets/${parsed.tag}`);
    vsixName = parseExpandedAssets(html, parsed.version);
    console.log('  解析结果:', JSON.stringify(vsixName));
    if (!vsixName) { console.log('  ✗ 没找到 vsix'); process.exit(1); }
    console.log('  ✓ vsixName =', vsixName);
  } catch (e) {
    console.log('  ✗', e.message); process.exit(1);
  }

  console.log('\n=== 3. 用 /releases/latest/download/<name> 下载 ===');
  const url = `https://github.com/${REPO}/releases/latest/download/${vsixName}`;
  console.log('  URL:', url);
  try {
    const r = await httpGet(url, { headers: { 'user-agent': 'x' }, timeout: 90000, proxy: PROXY });
    console.log('  HTTP', r.status, '| content-length:', r.headers['content-length']);
    if (r.status !== 200) { r.stream.resume(); process.exit(1); }
    const buf = await readStreamAll(r.stream, 32 * 1024 * 1024);
    const h = require('node:crypto').createHash('sha256').update(buf).digest('hex');
    console.log('  ✓ 收到', buf.length, '字节 | sha256 =', h);
    console.log('     （兜底路径没有 digest 可校，只能记录实际值）');
  } catch (e) {
    console.log('  ✗', e.message); process.exit(1);
  }

  console.log('\n全部通过');
})();
