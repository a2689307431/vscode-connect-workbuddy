'use strict';

/**
 * WorkBuddy for Copilot Chat
 *
 * 通过 VS Code 的 languageModelChatProviders API，把本地 WorkBuddy 代理
 * (http://127.0.0.1:8799/v1) 暴露的模型注入到 Copilot Chat 的模型下拉框里。
 *
 * 模型清单从代理的 GET /v1/models 动态读取 —— 不硬编码。
 */

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SECTION = 'connect-workbuddy';
const VENDOR = 'workbuddy';

const DEFAULT_PROXY_URL = 'http://127.0.0.1:8799/v1';

let output;
function log(...args) {
  if (!output) return;
  const cfg = vscode.workspace.getConfiguration(SECTION);
  if (cfg.get('debug') !== true) return;
  output.appendLine('[' + new Date().toTimeString().slice(0, 8) + '] ' + args.map(String).join(' '));
}

// ── 代理进程管理（跟着 VS Code 生死）───────────────────────────────
// 抄 dsh-connect-workbuddy 的 loopback shim 三个要点：
//   1. 随机端口（listen(0)），不用固定的 8799
//   2. 仅绑 127.0.0.1
//   3. 进程内随机 Bearer token，防本机其它程序白嫖积分
// 区别只在于：shim 活在 DSH 进程里，这里是一个独立子进程，
// 由 VS Code 扩展负责拉起和关闭。
const proxyState = {
  url: '',      // 运行时确定，如 http://127.0.0.1:54321/v1
  token: '',    // spawn 时随机生成；复用外部代理时为空
  child: null,  // 只有自己拉起的才非空 → deactivate 时只杀自己的
};

function getProxyUrl() {
  if (proxyState.url) return proxyState.url;
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return String(cfg.get('proxyUrl') || '').trim().replace(/\/+$/, '') || DEFAULT_PROXY_URL;
}

function getApiKey() {
  if (proxyState.token) return proxyState.token;
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return String(cfg.get('apiKey') || 'workbuddy-local-proxy');
}

function findProxyScript(extensionPath) {
  const candidates = [
    process.env.WB_PROXY_SCRIPT || '',
    // 随扩展打包的那份（正式分发路径）
    path.join(extensionPath, 'proxy', 'workbuddy-proxy.mjs'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return '';
}

function resolveNodeBinary() {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const custom = String(cfg.get('nodePath') || '').trim();
  if (custom && fs.existsSync(custom)) return { cmd: custom, args: [], env: {} };

  // 常见安装位置
  const probe = [
    'C:/Program Files/nodejs/node.exe',
    'C:/Program Files (x86)/nodejs/node.exe',
  ];
  for (const p of probe) {
    if (fs.existsSync(p)) return { cmd: p, args: [], env: {} };
  }
  // 从 PATH 里找
  try {
    const { execFileSync } = require('node:child_process');
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['node'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return { cmd: first, args: [], env: {} };
  } catch { /* ignore */ }

  // 兜底：让 VS Code 自带的 Electron 以 node 模式运行
  return { cmd: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

async function probeHealth(url, timeoutMs = 1500) {
  try {
    const r = await fetch(url + '/health', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 保证有一个可用的代理。
 *   ① 配置里显式写了 proxyUrl  → 完全交给用户，不插手
 *   ② 8799 上已有手动启动的代理 → 复用（不杀）
 *   ③ 都没有 → 自己 spawn 一个随机端口的，记下 PID
 */
async function ensureProxy(context) {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const manual = String(cfg.get('proxyUrl') || '').trim().replace(/\/+$/, '');

  if (manual) {
    proxyState.url = manual;
    log('使用配置指定的代理：' + manual);
    return;
  }

  if (await probeHealth(DEFAULT_PROXY_URL)) {
    proxyState.url = DEFAULT_PROXY_URL;
    log('复用已在运行的手动代理（8799）');
    output.appendLine('复用已在运行的手动代理 ' + DEFAULT_PROXY_URL);
    return;
  }

  const script = findProxyScript(context.extensionPath);
  if (!script) {
    proxyState.url = DEFAULT_PROXY_URL;
    output.appendLine('⚠ 找不到 workbuddy-proxy.mjs，请手动启动代理');
    return;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const node = resolveNodeBinary();
  log('拉起代理：', node.cmd, script);

  // 凭据存储目录交给扩展管理 —— 这样不依赖 ~/.dsh，也不依赖 WorkBuddy 桌面端。
  // OAuth 登录拿到的账号会写到 globalStoragePath 下。
  const vaultDir = path.join(context.globalStoragePath, 'vault');
  try {
    fs.mkdirSync(vaultDir, { recursive: true });
  } catch { /* ignore */ }

  const child = spawn(node.cmd, [...node.args, script, '--port', '0'], {
    env: { ...process.env, WB_PROXY_TOKEN: token, WB_VAULT_DIR: vaultDir, ...node.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proxyState.child = child;
  proxyState.token = token;

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('代理启动超时（15 秒）')), 15_000);
    let buf = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      buf += s;
      for (const line of s.split('\n')) {
        if (line.trim()) output.appendLine('[proxy] ' + line.trimEnd());
      }
      const m = /WB_PROXY_READY port=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) output.appendLine('[proxy:err] ' + line.trimEnd());
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('无法启动代理进程：' + (e?.message || e)));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('代理进程提前退出，code=' + code));
    });
  });

  proxyState.url = `http://127.0.0.1:${port}/v1`;
  output.appendLine('代理已就绪 ' + proxyState.url);
  log('代理端口 ' + port);
}

// ── 账号 ──────────────────────────────────────────────────────────
function baseUrl() {
  const u = getProxyUrl();
  return u.endsWith('/v1') ? u.slice(0, -3) : u;
}

async function fetchAccounts() {
  const res = await fetch(baseUrl() + '/accounts', {
    headers: { authorization: 'Bearer ' + getApiKey() },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET /accounts 返回 HTTP ${res.status}`);
  return res.json();
}

async function selectAccount(id) {
  const res = await fetch(baseUrl() + '/accounts/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getApiKey() },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return j;
}

// ── 首次使用引导 ──────────────────────────────────────────────────
// 没登录过账号时，模型下拉框里应该是空的（而不是给一堆点了就报错的模型），
// 同时弹一次「立即登录」的提示。
const PROMPT_KEY = 'loginPromptShown';
let accountCountCache = { value: -1, at: 0 };
const ACCOUNT_COUNT_TTL = 30_000;

/** 查账号数。-1 表示查不到（代理没起）。 */
async function checkAccountCount(force = false) {
  if (!force && Date.now() - accountCountCache.at < ACCOUNT_COUNT_TTL) {
    return accountCountCache.value;
  }
  try {
    const info = await fetchAccounts();
    const n = typeof info.count === 'number' ? info.count : (info.accounts?.length ?? 0);
    accountCountCache = { value: n, at: Date.now() };
    return n;
  } catch {
    accountCountCache = { value: -1, at: Date.now() };
    return -1;
  }
}

/** 弹一次登录引导（用 globalState 记住，避免每次启动都打扰）。 */
async function promptLoginOnce(context, force = false) {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  if (cfg.get('hideLoginPrompt') === true) {
    log('用户在设置里关闭了登录提示');
    return;
  }
  if (!force && context.globalState.get(PROMPT_KEY) === true) return;
  await context.globalState.update(PROMPT_KEY, true);

  const pick = await vscode.window.showInformationMessage(
    'WorkBuddy 还没有登录账号。登录后即可在 Copilot Chat 里直接使用 WorkBuddy 的模型（消耗你自己的积分）。',
    '立即登录',
    '不再提示'
  );
  if (pick === '立即登录') {
    vscode.commands.executeCommand('connect-workbuddy.login');
  } else if (pick === '不再提示') {
    await cfg.update('hideLoginPrompt', true, vscode.ConfigurationTarget.Global);
  }
}

// ── OAuth 登录 ────────────────────────────────────────────────────
async function oauthStart(region) {
  const res = await fetch(baseUrl() + '/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getApiKey() },
    body: JSON.stringify({ region }),
    signal: AbortSignal.timeout(35_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return j;
}

async function oauthPoll(loginId, region) {
  const res = await fetch(baseUrl() + '/auth/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getApiKey() },
    body: JSON.stringify({ loginId, region }),
    signal: AbortSignal.timeout(35_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return j;
}

// ── 拉模型清单 ────────────────────────────────────────────────────
let cachedModels = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

async function fetchModels(force = false) {
  if (!force && cachedModels && Date.now() - cachedAt < CACHE_MS) return cachedModels;

  const url = getProxyUrl() + '/models?perAccount=1';
  log('GET', url);
  const res = await fetch(url, {
    headers: { authorization: 'Bearer ' + getApiKey(), accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`代理 /models 返回 HTTP ${res.status}（代理没跑？）`);
  const j = await res.json();
  const list = Array.isArray(j.data) ? j.data : [];
  cachedModels = list;
  cachedAt = Date.now();
  log(`拿到 ${list.length} 个模型`);
  return list;
}

// ── 消息转换：VS Code → OpenAI ────────────────────────────────────
// VS Code 只公开了 User / Assistant；System（内部值 3）未导出，
// 所以按扩展惯例用数字兜底。
const ROLE_SYSTEM = 3;

function mapRole(role) {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  if (role === vscode.LanguageModelChatMessageRole.User) return 'user';
  if (role === ROLE_SYSTEM) return 'system';
  return 'user';
}

// LanguageModelDataPart 承载图片等二进制内容。它是较新的 API，
// 旧版 VS Code 上可能不存在 —— 所以用 typeof 守卫而不是直接 instanceof。
function isDataPart(part) {
  const Ctor = vscode.LanguageModelDataPart;
  if (typeof Ctor !== 'function') return false;
  try {
    return part instanceof Ctor;
  } catch {
    return false;
  }
}

// 把「文本 + 若干图片」组装成 OpenAI 兼容的 content。
// 没有图片时保持纯字符串（兼容性最好），有图片才升级成多模态数组。
function buildContent(text, images) {
  if (!images.length) return text;
  const arr = [];
  if (text) arr.push({ type: 'text', text });
  for (const img of images) {
    arr.push({
      type: 'image_url',
      image_url: { url: `data:${img.mime};base64,${img.b64}` },
    });
  }
  return arr;
}

function toOpenAIMessages(messages) {
  const out = [];

  for (const msg of messages) {
    const role = mapRole(msg.role);

    let text = '';
    const images = [];
    const toolCalls = [];
    const toolResults = [];

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (isDataPart(part)) {
        // 图片 → OpenAI image_url（data URL 内联）
        const mime = String(part.mimeType || '');
        if (mime.startsWith('image/')) {
          try {
            images.push({ mime, b64: Buffer.from(part.data).toString('base64') });
          } catch { /* 读不出字节就跳过 */ }
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        let content = '';
        for (const p of part.content) {
          if (p instanceof vscode.LanguageModelTextPart) content += p.value;
        }
        toolResults.push({ callId: part.callId, content });
      }
    }

    if (role === 'assistant') {
      if (text || toolCalls.length) {
        const m = { role: 'assistant', content: text || '' };
        if (toolCalls.length) m.tool_calls = toolCalls;
        out.push(m);
      }
    } else if (text || images.length) {
      out.push({ role, content: buildContent(text, images) });
      if (images.length) log(`消息含 ${images.length} 张图片（${images.map((i) => i.mime).join(', ')}）`);
    }

    for (const tr of toolResults) {
      out.push({ role: 'tool', tool_call_id: tr.callId, content: tr.content });
    }
  }

  return out;
}

function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

// ── SSE 解析 ──────────────────────────────────────────────────────
async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch { /* 跳过坏行 */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// ── Token 估算（粗略，1 token ≈ 3.5 字符，中英文混合） ─────────────
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80) cjk++;
  }
  const other = text.length - cjk;
  return Math.ceil(cjk / 1.5 + other / 4);
}

// ── 思考内容（LanguageModelThinkingPart） ─────────────────────────
// 用途：把上游 delta.reasoning_content 显示成 Copilot Chat 里可折叠的「思考」块。
// 参考实现：vizards.deepseek-v4-for-copilot 的 provider/stream.js → handleThinking()。
//
// ⚠️ 现状（2026-11-01 实测）：WorkBuddy 的 deepseek-v4.1-flash 虽然声明
//    `supportsReasoning: true` / `onlyReasoning: true`，但上游 SSE 里
//    `reasoning_content` 字段**恒为空字符串**，推理过程全部混在 `content` 里。
//    所以这里的代码对当前模型不会产生可见变化，但：
//      - 换成别的模型（glm / kimi 等，若上游改为返回）时自动生效
//      - 无副作用：拿不到内容就什么都不报
let thinkingSupported = null;

function reportThinking(progress, text) {
  if (!text) return;
  if (thinkingSupported === null) {
    thinkingSupported = typeof vscode.LanguageModelThinkingPart === 'function';
    log('LanguageModelThinkingPart 运行时可用：', thinkingSupported);
  }
  if (!thinkingSupported) return;
  try {
    progress.report(new vscode.LanguageModelThinkingPart(text));
  } catch (e) {
    thinkingSupported = false;
    log('ThinkingPart 上报失败，本次起禁用：', e?.message || e);
  }
}

// ── Provider ──────────────────────────────────────────────────────
class WorkBuddyProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  }

  async provideLanguageModelChatInformation(options, token) {
    let models;
    try {
      models = await fetchModels();
    } catch (e) {
      log('拉模型失败：', e?.message || e);
      // 抛错会让 VS Code 显示警告，而不是静默空列表
      throw new Error(
        '无法连接 WorkBuddy 代理：' + (e?.message || String(e)) +
        '\n可在命令面板执行「WorkBuddy: 显示日志」查看详情。'
      );
    }

    // 没登录账号 → 返回空列表，别给用户一堆点下去就报错的模型。
    // 引导提示由 activate() 负责弹（只弹一次）。
    const accountCount = await checkAccountCount();
    if (accountCount === 0) {
      log('当前没有已登录账号，返回空模型列表');
      output.appendLine('尚未登录任何 WorkBuddy 账号（命令面板 → WorkBuddy: 登录账号）');
      return [];
    }

    const chat = models.filter((m) => m.is_media !== true);

    return chat.map((m) => {
      const ctx = Number(m.context_length) || 128000;
      const maxOut = Number(m.max_output_tokens) || 32000;
      const acct = m.account_name ? ` · ${m.account_name}` : '';
      return {
        id: m.id,
        name: m.name || m.id,
        family: 'workbuddy',
        version: '1.0.0',
        detail: `${Math.round(ctx / 1000)}k 上下文 · WorkBuddy${acct}`,
        tooltip:
          `${m.name || m.id}\n${ctx} 上下文 / ${maxOut} 输出\nWorkBuddy 积分计费` +
          (m.account_name ? `\n账号：${m.account_name}${m.account_current ? '（桌面端当前选中）' : ''}` : ''),
        maxInputTokens: ctx,
        maxOutputTokens: maxOut,
        isUserSelectable: true,
        capabilities: {
          toolCalling: m.supports_tool_call !== false,
          imageInput: m.supports_images === true,
        },
      };
    });
  }

  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const url = getProxyUrl() + '/chat/completions';
    const tools = toOpenAITools(options?.tools);

    const body = {
      model: model.id,
      messages: toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools) body.tools = tools;
    if (model.maxOutputTokens) body.max_tokens = Math.min(model.maxOutputTokens, 32000);

    log('POST', url, 'model=' + model.id, 'tools=' + (tools?.length ?? 0));

    const ac = new AbortController();
    const sub = token.onCancellationRequested(() => ac.abort());

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + getApiKey(),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        let msg = txt;
        try {
          const j = JSON.parse(txt);
          msg = j?.error?.detail ?? j?.error?.message ?? txt;
          // detail 可能是嵌套 JSON
          try { msg = JSON.parse(msg).msg ?? msg; } catch { /* 保持原样 */ }
        } catch { /* 保持原样 */ }
        throw new Error(`WorkBuddy 返回 HTTP ${res.status}: ${String(msg).slice(0, 500)}`);
      }

      const pendingToolCalls = new Map();
      let reasoningChars = 0;
      let contentChars = 0;

      for await (const chunk of readSSE(res.body)) {
        if (token.isCancellationRequested) break;

        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta || {};

          // 思考内容（上游若返回才显示；当前 WorkBuddy 多数模型返回空串）
          if (delta.reasoning_content) {
            reasoningChars += delta.reasoning_content.length;
            reportThinking(progress, delta.reasoning_content);
          }

          if (delta.content) {
            contentChars += delta.content.length;
            progress.report(new vscode.LanguageModelTextPart(delta.content));
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let cur = pendingToolCalls.get(idx);
              if (!cur) {
                cur = { id: tc.id || '', name: '', args: '' };
                pendingToolCalls.set(idx, cur);
              }
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name += tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
            }
          }

          if (choice.finish_reason) {
            // 收尾时把累积的工具调用一次性发出
            for (const [idx, tc] of pendingToolCalls) {
              let input = {};
              try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = { _raw: tc.args }; }
              progress.report(new vscode.LanguageModelToolCallPart(
                tc.id || `call_${idx}_${Date.now()}`,
                tc.name,
                input,
              ));
            }
            pendingToolCalls.clear();
          }
        }
      }

      if (token.isCancellationRequested) log('已取消');
      else log(`完成：正文 ${contentChars} 字符，思考 ${reasoningChars} 字符`);
    } finally {
      sub.dispose();
    }
  }

  async provideTokenCount(model, text, token) {
    if (typeof text === 'string') return estimateTokens(text);
    let total = 0;
    try {
      for (const part of text.content ?? []) {
        if (part instanceof vscode.LanguageModelTextPart) total += estimateTokens(part.value);
      }
    } catch { /* ignore */ }
    return Math.max(1, total);
  }
}

// ── 激活 / 停用 ───────────────────────────────────────────────────
async function activate(context) {
  output = vscode.window.createOutputChannel('WorkBuddy for Copilot');
  context.subscriptions.push(output);

  // 先把代理准备好（要么复用，要么自己拉起），失败不阻塞激活
  try {
    await ensureProxy(context);
  } catch (e) {
    output.appendLine('⚠ 自动拉起代理失败：' + (e?.message || e));
    output.appendLine('  可手动启动：proxy\\启动 WorkBuddy 代理.bat');
    proxyState.url = DEFAULT_PROXY_URL;
    proxyState.child = null;
  }

  const provider = new WorkBuddyProvider();
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
  );

  // 手动刷新命令
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.refresh', async () => {
      cachedModels = null;
      provider._onDidChange.fire();
      try {
        const list = await fetchModels(true);
        vscode.window.showInformationMessage(`WorkBuddy：已刷新 ${list.length} 个模型`);
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：刷新失败 — ' + (e?.message || e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.showLogs', () => output.show())
  );

  // ── 登录（OAuth，不需要 WorkBuddy 桌面客户端）─────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.login', async () => {
      // ① 选区域
      const regionPick = await vscode.window.showQuickPick(
        [
          { label: '国内版', description: 'www.codebuddy.cn', region: 'cn', recommended: true },
          { label: '国际版', description: 'www.workbuddy.ai', region: 'global' },
        ],
        { placeHolder: '选择 WorkBuddy 区域' }
      );
      if (!regionPick) return;
      const region = regionPick.region;

      // ② 发起登录
      let started;
      try {
        started = await oauthStart(region);
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：发起登录失败 — ' + (e?.message || e));
        return;
      }
      output.appendLine(`OAuth 发起：${started.verificationUri}`);

      // ③ 打开浏览器
      const opened = await vscode.env.openExternal(vscode.Uri.parse(started.verificationUri));
      if (!opened) {
        const copy = await vscode.window.showWarningMessage(
          '无法自动打开浏览器，请手动复制这个链接登录：',
          { modal: true, detail: started.verificationUri },
          '复制链接'
        );
        if (copy === '复制链接') await vscode.env.clipboard.writeText(started.verificationUri);
      }

      // ④ 轮询（在状态栏显示进度，用户可随时取消）
      const account = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'WorkBuddy 登录中',
          cancellable: true,
        },
        async (progress, cancelToken) => {
          const deadline = Date.now() + (started.expiresIn || 600) * 1000;
          let tick = 0;
          while (Date.now() < deadline) {
            if (cancelToken.isCancellationRequested) return { cancelled: true };

            await new Promise((r) => setTimeout(r, 2000));
            tick++;
            if (tick % 5 === 0) {
              progress.report({ message: `等待浏览器完成登录…（还剩 ${Math.round((deadline - Date.now()) / 1000)} 秒）` });
            }

            let r;
            try {
              r = await oauthPoll(started.loginId, region);
            } catch {
              continue; // 网络抖动，继续轮询
            }
            if (r.done) {
              if (r.account) return { account: r.account };
              return { error: r.error || '登录失败' };
            }
          }
          return { error: '登录超时，请重新发起' };
        }
      );

      // ⑤ 结果处理
      if (account?.cancelled) {
        vscode.window.showInformationMessage('WorkBuddy：已取消登录');
        return;
      }
      if (account?.error) {
        vscode.window.showErrorMessage('WorkBuddy：登录失败 — ' + account.error);
        output.appendLine('登录失败：' + account.error);
        return;
      }
      if (account?.account) {
        cachedModels = null;
        accountCountCache = { value: -1, at: 0 }; // 强制重新查
        await context.globalState.update(PROMPT_KEY, false);
        provider._onDidChange.fire();
        output.appendLine(`登录成功 → ${account.account.name}（${account.account.id}）`);
        vscode.window.showInformationMessage(
          `WorkBuddy：已登录「${account.account.name}」，模型列表已刷新`
        );
      }
    })
  );

  // 切换当前账号（只影响「不带 @accountId| 前缀」的模型，比如外部客户端用的裸模型名）
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.switchAccount', async () => {
      let info;
      try {
        info = await fetchAccounts();
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：读取账号失败 — ' + (e?.message || e));
        return;
      }
      if (!info.accounts || info.accounts.length === 0) {
        vscode.window.showWarningMessage(
          'WorkBuddy：没找到账号。请先安装并登录 WorkBuddy 桌面客户端。'
        );
        return;
      }

      const items = info.accounts.map((a) => ({
        label: (a.isCurrent ? '$(check) ' : '$(account) ') + a.name,
        description: [a.source, a.desktopSelected ? '桌面端选中' : '', a.isLastUsed ? '最近使用' : '']
          .filter(Boolean)
          .join(' · '),
        detail: `token 到期 ${a.tokenExpiresAt || '未知'}`,
        id: a.id,
        isCurrent: a.isCurrent === true,
      }));

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: '选择当前 WorkBuddy 账号（影响不带账号前缀的模型调用）',
        matchOnDescription: true,
      });
      if (!pick) return;
      if (pick.isCurrent) {
        vscode.window.showInformationMessage(`已经在用「${pick.label.replace(/^\$\([^)]+\)\s*/, '')}」`);
        return;
      }

      try {
        const r = await selectAccount(pick.id);
        cachedModels = null;
        provider._onDidChange.fire();
        output.appendLine(`已切换当前账号 → ${r?.current?.name || pick.id}`);
        vscode.window.showInformationMessage(`WorkBuddy：已切换到「${r?.current?.name || pick.id}」`);
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：切换失败 — ' + (e?.message || e));
      }
    })
  );

  log('已激活，vendor=' + VENDOR + '，代理=' + getProxyUrl());
  output.appendLine('WorkBuddy provider 已注册（vendor=' + VENDOR + '，代理=' + getProxyUrl() + '）');

  // 首次使用引导：等代理把凭据扫完再判断，避免刚启动时误判
  setTimeout(async () => {
    const n = await checkAccountCount(true);
    if (n === 0) {
      output.appendLine('检测到 0 个账号 → 触发登录引导');
      await promptLoginOnce(context);
    } else if (n > 0) {
      output.appendLine(`已发现 ${n} 个 WorkBuddy 账号`);
      // 有账号了，重置标记，以便账号被删光后还能再弹一次
      await context.globalState.update(PROMPT_KEY, false);
    } else {
      output.appendLine('⚠ 无法读取账号列表（代理可能没起来）');
    }
  }, 6000);
}

function deactivate() {
  // 只杀自己拉起的那个；复用外部代理时 child 为 null，不动它
  if (proxyState.child) {
    try {
      proxyState.child.kill();
    } catch { /* ignore */ }
    proxyState.child = null;
  }
  proxyState.url = '';
  proxyState.token = '';
}

module.exports = { activate, deactivate };
