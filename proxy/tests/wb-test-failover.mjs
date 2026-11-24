// 换号 + 冷却 的端到端验证。
//
// 需要真实账号，所以不进 CI（CI 里没有凭据）。手动跑：
//   1. 起代理时开测试钩子（务必带 WB_TEST_HOOKS=1，否则下面会 404）：
//      $env:WB_TEST_HOOKS='1'; node proxy/workbuddy-proxy.mjs --port 8801
//   2. node proxy/tests/wb-test-failover.mjs [账号A的id] [账号B的id]
//      不传参数就用账号池里前两个。
//
// 覆盖五条路径：
//   ① A 正常 → 不该有换号头
//   ② A 运行时失败（请求前才布钩子）→ 应换到别的账号并带头
//   ③ A 已在冷却 → 应直接换到别的账号并带头
//   ④ /accounts 应能把冷却状态报出来（钱包靠它显示「冷却 N 分钟」）
//   ⑤ 清掉冷却 → A 应恢复成默认账号，不再换号
//
// 环境变量：PROXY_PORT（默认 8799）、TEST_MODEL（默认 deepseek-v4.1-flash）

const PORT = process.env.PROXY_PORT || '8799';
const BASE = `http://127.0.0.1:${PORT}`;

const pass = [];
const fail = [];
function ok(name, cond, extra = '') {
  (cond ? pass : fail).push(name + (extra ? `  ${extra}` : ''));
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
}

async function hook(body) {
  const res = await fetch(`${BASE}/__test/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `POST /__test/hook HTTP ${res.status} —— 代理启动时没设 WB_TEST_HOOKS=1？`
    );
  }
  return res.json();
}

async function accounts() {
  const res = await fetch(`${BASE}/accounts?region=cn`, {
    headers: { authorization: 'Bearer test' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET /accounts HTTP ${res.status}`);
  const j = await res.json();
  return j.accounts || [];
}

/** 用带 @account| 前缀的模型名发一次对话，返回 { status, foFrom, foTo, content }。 */
async function chat(accountId, modelId, { stream = true } = {}) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({
      model: `@${accountId}|${modelId}`,
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
      stream,
      max_tokens: 32,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const foFrom = res.headers.get('x-wb-failover-from');
  const foTo = res.headers.get('x-wb-failover-to');
  let content = '';
  if (res.ok && res.body && stream) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const raw of parts) {
        const s = raw.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        const d = j.choices?.[0]?.delta;
        if (d?.content) content += d.content;
      }
    }
  } else if (res.ok) {
    // 非流式：整包 JSON
    const j = await res.json().catch(() => null);
    content = j?.choices?.[0]?.message?.content || '';
  } else {
    content = (await res.text().catch(() => '')).slice(0, 300);
  }

  return {
    status: res.status,
    foFrom: foFrom ? decodeURIComponent(foFrom) : null,
    foTo: foTo ? decodeURIComponent(foTo) : null,
    content,
  };
}

const main = async () => {
  console.log('\n=== 准备 ===');
  const list = await accounts();
  console.log(`  账号数 ${list.length}：${list.map((a) => a.name || a.id).join('、')}`);
  ok('账号数 ≥ 2', list.length >= 2);
  if (list.length < 2) {
    console.log('\n⚠️ 换号需要至少 2 个账号，先登录第二个再跑这个测试。');
    process.exit(1);
  }

  const argA = process.argv[2];
  const argB = process.argv[3];
  const acctA = argA ? list.find((a) => a.id === argA) : list[0];
  const acctB = argB ? list.find((a) => a.id === argB) : list.find((a) => a.id !== acctA?.id);
  if (!acctA || !acctB) {
    console.log('\n⚠️ 参数里的账号 id 不在账号池里。');
    process.exit(1);
  }
  const nameA = acctA.name || acctA.id;
  const nameB = acctB.name || acctB.id;
  const model = process.env.TEST_MODEL || 'deepseek-v4.1-flash';
  console.log(`  A = ${nameA}（${acctA.id}）`);
  console.log(`  B = ${nameB}（${acctB.id}）`);
  console.log(`  model = ${model}`);

  // 用 A 的模型名发请求 —— 模拟用户在 VS Code 下拉框里选了「A 的 deepseek」
  const doA = () => chat(acctA.id, model);

  // 从干净状态开始，否则上一轮留下的冷却会干扰场景 ①
  await hook({ clear: true });

  console.log('\n=== 场景 ①  A 正常：不该换号 ===');
  {
    const r = await doA();
    ok('HTTP 200', r.status === 200, `HTTP ${r.status}`);
    ok('无换号头', !r.foFrom && !r.foTo, r.foFrom ? `${r.foFrom} → ${r.foTo}` : '');
    ok('有正文', Boolean(r.content.trim()), JSON.stringify(r.content.slice(0, 40)));
  }

  console.log('\n=== 场景 ②  A 运行时失败 → 应自动换号 ===');
  await hook({ fail: `${acctA.id}:1` });
  {
    // 这条是修复前会挂的：以前带前缀时 targets 只有 [A]，
    // A 失败了循环就跑完了，直接把错误返回给客户端 —— 根本走不到换号。
    const r = await doA();
    ok('HTTP 200（换号成功）', r.status === 200, `HTTP ${r.status}`);
    ok('带换号头', Boolean(r.foFrom && r.foTo), r.foFrom ? `${r.foFrom} → ${r.foTo}` : '');
    ok('from 是 A', r.foFrom === nameA, String(r.foFrom));
    ok('to 不是 A', Boolean(r.foTo) && r.foTo !== nameA, String(r.foTo));
    ok('有正文', Boolean(r.content.trim()), JSON.stringify(r.content.slice(0, 40)));
  }

  console.log('\n=== 场景 ③  A 冷却中 → 应直接换号（不白花一次往返）===');
  {
    // 场景 ② 已经把 A 记成 hard_credit 冷却了，这里验证「预冷却」这条路
    const r = await doA();
    ok('HTTP 200', r.status === 200, `HTTP ${r.status}`);
    ok('带换号头', Boolean(r.foFrom && r.foTo), r.foFrom ? `${r.foFrom} → ${r.foTo}` : '');
    ok('有正文', Boolean(r.content.trim()));
  }

  console.log('\n=== 场景 ④  /accounts 应能看到 A 在冷却 ===');
  {
    const fresh = await accounts();
    const a = fresh.find((x) => x.id === acctA.id);
    const b = fresh.find((x) => x.id === acctB.id);
    ok('返回 cooldownSec 字段', a && typeof a.cooldownSec === 'number', String(a?.cooldownSec));
    ok('A 的 cooldownSec > 0', (a?.cooldownSec || 0) > 0, String(a?.cooldownSec));
    ok('B 的 cooldownSec = 0', (b?.cooldownSec || 0) === 0, String(b?.cooldownSec));
  }

  console.log('\n=== 场景 ⑤  清掉冷却后 A 应恢复为默认账号 ===');
  await hook({ clear: true });
  {
    const r = await doA();
    ok('HTTP 200', r.status === 200, `HTTP ${r.status}`);
    ok('无换号头（回到 A）', !r.foFrom && !r.foTo, r.foFrom ? `${r.foFrom} → ${r.foTo}` : '');
    ok('有正文', Boolean(r.content.trim()));
  }

  console.log('\n=== 场景 ⑥  非流式（stream:false）也要带换号头 ===');
  await hook({ fail: `${acctA.id}:1` });
  {
    const r = await chat(acctA.id, model, { stream: false });
    ok('HTTP 200', r.status === 200, `HTTP ${r.status}`);
    ok('带换号头', Boolean(r.foFrom && r.foTo), r.foFrom ? `${r.foFrom} → ${r.foTo}` : '');
    ok('有正文', Boolean(r.content.trim()), JSON.stringify(r.content.slice(0, 40)));
  }

  console.log('\n=== 场景 ⑦  所有账号都冷却 → 仍要能降级工作（不许把路堵死）===');
  await hook({ clear: true });
  for (const a of list) await hook({ cooldown: `${a.id}:hard_credit` });
  {
    const r = await doA();
    ok('HTTP 200（全部冷却仍可用）', r.status === 200, `HTTP ${r.status}`);
    ok('有正文', Boolean(r.content.trim()), JSON.stringify(r.content.slice(0, 40)));
    // 成功的那个账号冷却应被清掉，否则它会一直挂在队尾
    const after = await accounts();
    const stillCooled = after.filter((a) => a.cooldownSec > 0);
    ok('成功的账号冷却已清除', stillCooled.length < list.length, `仍冷却 ${stillCooled.length}/${list.length}`);
  }
  await hook({ clear: true });

  const total = pass.length + fail.length;
  console.log(`\n========== 通过 ${pass.length} / 失败 ${fail.length}（共 ${total}）==========`);
  if (fail.length) {
    console.log('失败项：');
    for (const f of fail) console.log('  · ' + f);
    process.exit(1);
  }
};

main().catch((e) => {
  console.error('\n测试出错：', e?.message || e);
  process.exit(1);
});
