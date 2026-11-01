// 验证代理的模型别名兜底：故意发扩展默认的 "deepseek-flash"
const url = 'http://127.0.0.1:8799/v1/chat/completions';
const payload = {
  model: 'deepseek-flash',                  // ← 扩展默认名，代理应自动纠正
  messages: [{ role: 'user', content: '只回两个字：好了' }],
  stream: false,
};
const t0 = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(90_000),
});
const txt = await res.text();
const out = [`HTTP ${res.status}  ${((Date.now() - t0) / 1000).toFixed(1)}s`];
try {
  const j = JSON.parse(txt);
  if (j.error) out.push('error: ' + JSON.stringify(j.error).slice(0, 400));
  else {
    out.push('model 回显: ' + j.model);
    out.push('finish    : ' + j.choices?.[0]?.finish_reason);
    out.push('content   : ' + j.choices?.[0]?.message?.content);
  }
} catch { out.push(txt.slice(0, 500)); }
console.log(out.join('\n'));
