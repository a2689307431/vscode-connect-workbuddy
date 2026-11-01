// 测流式 + 工具调用（Cline / Roo Code 的真实用法）
const url = 'http://127.0.0.1:8799/v1/chat/completions';
const payload = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: '看看北京天气' }],
  stream: true,
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询城市天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }],
};

const t0 = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(90_000),
});

const lines = [];
let n = 0, content = '', tcArgs = '';
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let ttfb = null;

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
    let j;
    try { j = JSON.parse(p); } catch { continue; }
    n++;
    if (n === 1) lines.push('首 chunk: ' + JSON.stringify(j.choices?.[0]?.delta ?? {}).slice(0, 220));
    const d = j.choices?.[0]?.delta ?? {};
    if (d.content) content += d.content;
    if (d.tool_calls) for (const tc of d.tool_calls) if (tc.function?.arguments) tcArgs += tc.function.arguments;
    const fr = j.choices?.[0]?.finish_reason;
    if (fr) lines.push('finish_reason: ' + fr);
  }
}

lines.push(`chunk 数: ${n}`);
lines.push(`首字延迟: ${ttfb}ms  总耗时: ${Date.now() - t0}ms`);
lines.push(`content: ${content}`);
lines.push(`tool 参数流式拼装: ${tcArgs || '(无)'}`);
console.log(lines.join('\n'));
