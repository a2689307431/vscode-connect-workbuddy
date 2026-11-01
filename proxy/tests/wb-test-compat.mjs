// 模拟 deepseek-v4-for-copilot 扩展的真实请求体，验证代理兼容性
const url = 'http://127.0.0.1:8799/v1/chat/completions';
const t0 = Date.now();

const payload = {
  model: 'deepseek-v4.1-flash',            // 扩展默认模型名（原样透传，看上游认不认）
  messages: [
    { role: 'system', content: '你是编码助手。' },
    { role: 'user', content: '用一行 Python 读出 a.txt 的行数' },
  ],
  stream: true,
  stream_options: { include_usage: true },  // ← 扩展强制加的
  temperature: 0.3,
  max_tokens: 512,
};

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer dummy-key-ignored' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(90_000),
});

const out = [`HTTP ${res.status}`];
if (!res.ok) {
  out.push((await res.text()).slice(0, 600));
  console.log(out.join('\n'));
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '', content = '', reasoning = '', n = 0, usage = null, finish = null, model = null, ttfb = null;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (ttfb === null) ttfb = Date.now() - t0;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split('\n');
  buf = parts.pop() ?? '';
  for (const raw of parts) {
    const s = raw.trim();
    if (!s.startsWith('data:')) continue;
    const p = s.slice(5).trim();
    if (p === '[DONE]') continue;
    let j; try { j = JSON.parse(p); } catch { continue; }
    n++;
    model = model || j.model;
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    if (ch.delta?.content) content += ch.delta.content;
    if (ch.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
  }
}

out.push(`model 回显   : ${model}`);
out.push(`finish       : ${finish}`);
out.push(`chunk        : ${n}`);
out.push(`首字延迟     : ${ttfb}ms   总计 ${Date.now() - t0}ms`);
out.push(`usage        : ${usage ? '✅ 有（' + JSON.stringify({ p: usage.prompt_tokens, c: usage.completion_tokens, credit: usage.credit }) + '）' : '❌ 无'}`);
out.push(`reasoning    : ${reasoning ? reasoning.length + ' 字符' : '(空)'}`);
out.push(`content      :\n${content}`);
console.log(out.join('\n'));
