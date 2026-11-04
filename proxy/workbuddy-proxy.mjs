#!/usr/bin/env node
// WorkBuddy → OpenAI 兼容反向代理
// 让 VS Code 里的 Continue / Cline / Roo Code 等工具直接消耗 WorkBuddy 积分。
//
// 启动：node workbuddy-proxy.mjs [--port 8799]
// 客户端配置：baseURL = http://127.0.0.1:8799/v1 ，apiKey 随便填（真 token 由本进程注入）
//
// 依赖：dsh-connect-workbuddy 插件（复用它的凭据解密与 token 刷新）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
// --port 0 = 让系统分配随机端口（扩展自己拉起时用，照抄 DSH shim 的 listen(0)）
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : 8799;

// 扩展拉起时会注入一个进程内随机 token，防止本机其它程序直接调这个端口白嫖积分。
// 手动双击启动时没有这个环境变量 → 跳过校验（方便 curl 调试）。
const AUTH_TOKEN = process.env.WB_PROXY_TOKEN || '';

const CN_CHAT_BASE = 'https://copilot.tencent.com';
const GLOBAL_CHAT_BASE = 'https://www.workbuddy.ai';
const PRODUCT = 'SaaS';

// ── 定位 host-heartbeat 模块所在目录 ──────────────────────────────────────
// 按优先级探测，找到第一个含 host-heartbeat-*.js 的目录。
// 这样既能在这台开发机上直接跑，也能在打包分发后从扩展目录加载。
// 需要同步升级时：把新版 host-heartbeat-*.js 覆盖到 <ext>/lib/ 即可。
function resolveLibDir() {
  // ⚠️ 必须用 fileURLToPath，不能用 URL.pathname ——
  //    后者是 URL 编码的（空格变 %20、中文变 %E4%B8%AD），
  //    路径里带空格或中文时会导致找不到模块。Windows 用户名常含中文。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const localApp = process.env.LOCALAPPDATA || '';
  const roamApp = process.env.APPDATA || '';

  const candidates = [
    process.env.WB_CONNECT_LIB || '',                        // ① 显式指定
    path.join(here, '..', 'lib'),                            // ② 随扩展打包的 <ext>/lib
    path.join(here, 'lib'),                                  // ③ 代理同目录下的 lib
    home ? path.join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-connect-workbuddy', 'lib') : '',
    localApp ? path.join(localApp, 'Programs', '@deepseek-ai', 'dsh', 'node_modules', 'dsh-connect-workbuddy', 'lib') : '',
    roamApp ? path.join(roamApp, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'dsh-connect-workbuddy', 'lib') : '',
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      if (fs.readdirSync(dir).some((n) => /^host-heartbeat-.*\.js$/.test(n))) return dir;
    } catch { /* 无权限等，继续找下一个 */ }
  }

  throw new Error(
    '找不到 dsh-connect-workbuddy 模块（host-heartbeat-*.js）。\n' +
    '已尝试：\n  ' + candidates.join('\n  ') + '\n' +
    '请用环境变量 WB_CONNECT_LIB 指向它的 lib 目录。'
  );
}

const LIB = resolveLibDir();

// ── 加载插件模块 ──────────────────────────────────────────────────────────
function findHeartbeatFile() {
  const f = fs.readdirSync(LIB).find((n) => /^host-heartbeat-.*\.js$/.test(n));
  if (!f) throw new Error(`在 ${LIB} 下找不到 host-heartbeat-*.js`);
  return path.join(LIB, f);
}

const hbPath = findHeartbeatFile();
const mod = await import(pathToFileURL(hbPath).href);
const Store = mod.C;   // WorkBuddyCredentialStore
const Client = mod.V;  // WorkBuddyUpstreamClient
const FALLBACK_MODELS = mod.p || [];        // 国内
const FALLBACK_MODELS_GLOBAL = mod.m || []; // 国际

// ⚠️ 反风控：直接复用插件自己的请求体整形 / 指纹扰动函数。
// 上游两个网关都有一道「通道校验」闸门：system 消息如果以未批准的身份短语开头
// （例如 "You are an AI agent powered by DeepSeek Harness"），直接返回 11128
// （对用户显示成「渠道校验失败」）。插件的 prepareChatBody 就是绕这道闸门的：
//   ① stream 强制 true        ② developer → system
//   ③ 保证首条是 system        ④ 按 CHANNEL_GATE_PHRASES 表做同义改写
//   ⑤ 身份子句插零宽空格打断    ⑥ tool_choice 展平成字符串
//   ⑦ 对拒绝 off 档位的模型剔掉 reasoning_effort
// 直接用它的函数，插件一升级这边自动跟上，比自己抄一份更安全。
const prepareChatBody = mod.rt;              // 请求体整形
const perturbChannelFingerprints = mod.nt;   // 11128 时的零宽扰动重试

if (!Store || !Client) throw new Error('插件导出结构变了，请更新本脚本');
if (typeof prepareChatBody !== 'function') {
  console.warn('⚠ 插件没有导出 prepareChatBody(mod.rt)，将在裸透传模式下运行（风控风险更高）');
}

const upstream = new Client();

// ── 凭据存储目录 ──────────────────────────────────────────────────────────
// 默认落在扩展自己的存储目录（由扩展通过 WB_VAULT_DIR 传入），
// 这样完全不依赖 ~/.dsh，也不再需要 WorkBuddy 桌面客户端。
// 不传时退回插件的默认行为（~/.dsh/workbuddy-vault），兼容手动运行。
const VAULT_ROOT = process.env.WB_VAULT_DIR || '';

function vaultDirFor(region) {
  if (!VAULT_ROOT) return undefined; // 交给 Store 自己决定（兼容旧行为）
  return path.join(VAULT_ROOT, region);
}

// 两个区各一份 store
const stores = {
  cn: new Store({ region: 'cn', refresh: (c) => upstream.refreshToken(c), vaultDir: vaultDirFor('cn') }),
  global: new Store({ region: 'global', refresh: (c) => upstream.refreshToken(c), vaultDir: vaultDirFor('global') }),
};

if (VAULT_ROOT) {
  for (const r of ['cn', 'global']) {
    try { fs.mkdirSync(vaultDirFor(r), { recursive: true }); } catch { /* ignore */ }
  }
}

// ── Token 缓存 ────────────────────────────────────────────────────────────
const cache = { cn: null, global: null };

// ── 区域判定 ──────────────────────────────────────────────────────────────
// ⚠️ 照抄插件 regionOf()（host-heartbeat-*.js @3137）：**只有** workbuddy.ai /
//    codebuddy.ai 算国际，其它一律算国内。
//
// 早先这里的判断写反了（`includes('workbuddy.cn') || includes('tencent')`
// 才算国内），后果很严重：国内账号的 domain 是 `www.codebuddy.cn`，既不含
// workbuddy.cn 也不含 tencent → 被误判成国际区 → 请求发到 www.workbuddy.ai
// → 拿回国际市场模型表（fast-model / balanced-model / gpt-5.6-sol …），
// 这些 id 在国内根本不存在，探测全挂（0/16 可用）。
function isGlobalDomain(domain) {
  const d = String(domain || '').trim().toLowerCase();
  return (
    d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai') ||
    d === 'codebuddy.ai' || d.endsWith('.codebuddy.ai')
  );
}

function chatBaseOf(cred) {
  return isGlobalDomain(cred?.domain) ? GLOBAL_CHAT_BASE : CN_CHAT_BASE;
}

async function getCred(region = 'cn', force = false) {
  if (!force && cache[region]) return cache[region];
  const cred = await stores[region].resolve(); // 内部会按需刷新
  cache[region] = cred;
  return cred;
}

// ── 多账号池 ──────────────────────────────────────────────────────────────
// dsh-connect-workbuddy 的 WorkBuddyCredentialStore 本身就是多账号的：
//   accounts()          列出所有账号（桌面端登录的 + DSH vault 里登录的）
//   credentialFor(id)   取某个账号的完整凭据
//   needsRefresh(cred)  判断是否该刷新
//   refreshNow(cred)    刷新并写回 vault（与插件自身行为一致）
// 这里把「所有账号」串成池子：轮询选账号，失败自动切下一个。
// 单账号时会退化成和以前完全一样的行为。
const POOL_TTL_MS = 30_000;

function emptyPool() {
  return { accounts: [], loadedAt: 0, cursor: 0, tokens: new Map(), lastUsed: null };
}

const pool = { cn: emptyPool(), global: emptyPool() };

async function listAccounts(region = 'cn') {
  const p = pool[region];
  if (p.accounts.length && Date.now() - p.loadedAt < POOL_TTL_MS) return p.accounts;

  const list = await stores[region].accounts();
  p.accounts = list;
  p.loadedAt = Date.now();

  // 账号消失时清掉它的 token 缓存
  const ids = new Set(list.map((a) => a.id));
  for (const id of [...p.tokens.keys()]) if (!ids.has(id)) p.tokens.delete(id);

  // 轮询指针越界保护
  if (p.cursor >= list.length) p.cursor = 0;
  return list;
}

async function credForAccount(accountId, region = 'cn') {
  const p = pool[region];
  const cached = p.tokens.get(accountId);
  if (cached && !stores[region].needsRefresh(cached)) return cached;

  let cred = await stores[region].credentialFor(accountId);
  if (!cred) return null;

  if (stores[region].needsRefresh(cred)) {
    try {
      cred = await stores[region].refreshNow(cred);
    } catch (e) {
      log(`账号 ${accountId} 刷新失败：${e?.message || e}`);
      return null;
    }
  }
  p.tokens.set(accountId, cred);
  return cred;
}

// ── 积分余额 ──────────────────────────────────────────────────────────────
// 上游端点：POST {billingBase}/v2/billing/meter/get-user-resource
// 企业账号走另一条：POST {billingBase}/billing/meter/get-enterprise-user-usage
//
// 这两条的分支、套餐聚合、「已用 vs 剩余」的坑、月付/一次性包的过期时间，
// 插件 WorkBuddyUpstreamClient.fetchCredits() 已经全部处理好了，
// 直接复用 —— 插件升级时这边自动跟上，比自己抄一份安全。
const CREDITS_TTL_MS = 60_000;
const creditsCache = new Map(); // `${region}:${accountId}` → { at, value }

function isoOrNull(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 读某个账号的剩余积分。带 60 秒缓存（上游按账号串行调用，聊天时不该反复打）。
 * @param {string} accountId
 * @param {'cn'|'global'} region
 * @param {boolean} force 跳过缓存
 */
async function creditsFor(accountId, region = 'cn', force = false) {
  const key = `${region}:${accountId}`;
  const hit = creditsCache.get(key);
  if (!force && hit && Date.now() - hit.at < CREDITS_TTL_MS) return hit.value;

  if (typeof upstream.fetchCredits !== 'function') {
    throw new Error('当前 dsh-connect-workbuddy 模块没有 fetchCredits()，请升级 host-heartbeat 到含积分接口的版本');
  }

  const cred = await credForAccount(accountId, region);
  if (!cred) throw new Error(`账号 ${accountId} 的凭据不可用（token 刷新失败？）`);

  const raw = await upstream.fetchCredits(cred);
  const value = {
    total: typeof raw?.total === 'number' ? raw.total : null,
    expiringSoon: typeof raw?.expiringSoon === 'number' ? raw.expiringSoon : 0,
    nearestExpiry: isoOrNull(raw?.nearestExpiryMs),
    packages: (Array.isArray(raw?.packages) ? raw.packages : []).map((p) => ({
      name: typeof p.packageName === 'string' ? p.packageName : '(未命名)',
      remain: typeof p.remain === 'number' ? p.remain : null,
      size: typeof p.size === 'number' ? p.size : null,
      monthly: p.monthly === true,
      refreshAt: isoOrNull(p.refreshAtMs),
      expiresAt: isoOrNull(p.expiresAtMs),
    })),
    fetchedAt: new Date().toISOString(),
  };
  creditsCache.set(key, { at: Date.now(), value });
  return value;
}

function clearCreditsCache(accountId, region) {
  if (!accountId) { creditsCache.clear(); return; }
  creditsCache.delete(`${region}:${accountId}`);
}

// ── 每日签到 ──────────────────────────────────────────────────────────────
// 接口逆向自官方客户端，2026-11-04 实测可用：
//   POST {chat}/v2/billing/meter/checkin-activity-status  今日状态 + 连续天数
//   POST {chat}/v2/billing/meter/daily-checkin           签到（幂等）
// ⚠️ 只放在代理里做：签到和聊天共用同一份 token，刷新必须只有一处，
//    否则两个进程同时写 vault 会互相覆盖。
const CHECKIN_TIMEOUT_MS = 20_000;

function checkinHeaders(cred) {
  const h = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cred.accessToken}`,
    'User-Agent': 'WorkBuddy',
  };
  if (cred.uid) h['X-User-Id'] = cred.uid;
  if (cred.domain) h['X-Domain'] = cred.domain;
  if (cred.enterpriseId) {
    h['X-Enterprise-Id'] = cred.enterpriseId;
    h['X-Tenant-Id'] = cred.enterpriseId;
  }
  return h;
}

/** 响应可能裹一层 data / result，按 key 逐层找。 */
function pickField(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  for (const wrap of ['data', 'result', 'resp', 'response']) {
    const v = obj[wrap];
    if (v && typeof v === 'object') {
      const r = pickField(v, key);
      if (r !== undefined && r !== null) return r;
    }
  }
  return undefined;
}

async function callCheckinEndpoint(cred, path) {
  const res = await fetch(`${chatBaseOf(cred)}${path}`, {
    method: 'POST',
    headers: checkinHeaders(cred),
    body: '{}',
    signal: AbortSignal.timeout(CHECKIN_TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  // 空响应体是「今日已签」的正常形态，不是解析失败
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { http: res.status, body };
}

/** 强制刷新某个账号的 token，并同步账号池缓存。 */
async function refreshCredFor(accountId, region, cred) {
  try {
    const next = await stores[region].refreshNow(cred);
    if (!next) return null;
    pool[region].tokens.set(accountId, next);
    return next;
  } catch (e) {
    log(`账号 ${accountId} 刷新失败：${e?.message || e}`);
    return null;
  }
}

async function checkinStatusFor(accountId, region = 'cn') {
  let cred = await credForAccount(accountId, region);
  if (!cred) return { ok: false, error: 'AUTH', message: '凭据不可用' };

  let { http, body } = await callCheckinEndpoint(cred, '/v2/billing/meter/checkin-activity-status');
  if (http === 401 || http === 403) {
    const next = await refreshCredFor(accountId, region, cred);
    if (next) ({ http, body } = await callCheckinEndpoint(next, '/v2/billing/meter/checkin-activity-status'));
  }
  if (http === 401 || http === 403) return { ok: false, error: 'AUTH', message: '登录已失效，请重新登录账号' };
  if (http < 200 || http >= 300) return { ok: false, error: 'HTTP', message: `查询失败（HTTP ${http}）` };

  return {
    ok: true,
    active: pickField(body, 'active') !== false,
    checkedIn: pickField(body, 'today_checked_in') === true || pickField(body, 'today_checked_in') === 1,
    streakDays: Number(pickField(body, 'streak_days') ?? 0),
    totalCredits: Number(pickField(body, 'total_credits') ?? 0),
    todayCredit: Number(pickField(body, 'today_credit') ?? pickField(body, 'daily_credit') ?? 0),
    isStreakDay: pickField(body, 'is_streak_day') === true,
    activityName: pickField(body, 'activity_name') ?? '',
  };
}

async function checkinFor(accountId, region = 'cn') {
  let cred = await credForAccount(accountId, region);
  if (!cred) return { result: 'AUTH', message: '凭据不可用' };

  let { http, body } = await callCheckinEndpoint(cred, '/v2/billing/meter/daily-checkin');
  if (http === 401 || http === 403) {
    const next = await refreshCredFor(accountId, region, cred);
    if (next) ({ http, body } = await callCheckinEndpoint(next, '/v2/billing/meter/daily-checkin'));
  }
  if (http === 401 || http === 403) return { result: 'AUTH', message: '登录已失效，请重新登录账号' };

  const status = async () => {
    const st = await checkinStatusFor(accountId, region).catch(() => null);
    return st?.ok ? { status: st } : {};
  };

  // 已签：null 响应体，或 code 10001，或 msg 含「已签」
  const already = body === null
    || body?.code === 10001
    || String(pickField(body, 'msg') ?? '').includes('已签');
  if (already && http < 500) {
    return { result: 'ALREADY', message: '今日已签', ...(await status()) };
  }

  const credit = pickField(body, 'credit');
  if (credit !== undefined && credit !== null) {
    return { result: 'CLAIMED', credit: Number(credit), message: `签到成功 +${credit} 积分`, ...(await status()) };
  }
  if (http >= 200 && http < 300) {
    return { result: 'CLAIMED', message: '签到成功', ...(await status()) };
  }

  // 活动没开（新账号 / 活动已结束）时给个能看懂的结论，而不是干巴巴的 HTTP 400
  const st = await checkinStatusFor(accountId, region).catch(() => null);
  if (st?.ok && st.active === false) {
    return { result: 'NO_ACTIVITY', message: '当前账号没有进行中的签到活动', status: st };
  }
  return {
    result: 'ERROR',
    message: String(pickField(body, 'msg') ?? `HTTP ${http}`),
    http,
    ...(st?.ok ? { status: st } : {}),
  };
}

/** 用指定凭据发一次 chat 请求（body 必须是已整形的 JSON 字符串） */
function fetchChat(cred, bodyJson) {
  const base = chatBaseOf(cred);
  return fetch(`${base}/v2/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(cred),
    body: bodyJson,
  });
}

// ── 账号分组（模型 id 里编码账号）──────────────────────────────────────────
// 不轮询。默认用「当前账号」——和插件完全一致，即 WorkBuddyCredentialStore.current()
// （桌面端选中的那个，或 rotatedAccount）。
// 想在客户端里直接指定账号时，用 /v1/models?perAccount=1 拿到的 id：
//     "@<accountId>|<modelId>"
// 客户端原样回传即可，代理会剥掉前缀并锁定那个账号。
const ACCOUNT_MODEL_RE = /^@([0-9A-Za-z_-]{6,64})\|(.+)$/;

function encodeAccountModel(accountId, modelId) {
  return `@${accountId}|${modelId}`;
}

function parseAccountModel(modelId) {
  const m = ACCOUNT_MODEL_RE.exec(String(modelId || ''));
  return m ? { accountId: m[1], model: m[2] } : null;
}

/**
 * 当前该用哪个账号。
 * 优先 `store.current()`（桌面端选中 / rotatedAccount），与插件语义一致；
 * 拿不到就退到 accounts() 里 selected 的那个，再不行取第一个。
 */
async function pickCurrentAccount(region, accounts) {
  if (!accounts.length) return null;
  try {
    const cur = await stores[region].current();
    if (cur && typeof mod.F === 'function') {
      const id = mod.F(cur);
      const hit = accounts.find((a) => a.id === id);
      if (hit) return hit;
    }
  } catch { /* ignore */ }
  return accounts.find((a) => a.selected === true) || accounts[0];
}

// ── OAuth 登录（无需 WorkBuddy 桌面客户端，跨平台）──────────────────────────
// 照抄 dsh-connect-workbuddy 的 src/oauth.ts：
//   ① POST {base}/v2/plugin/auth/state?platform=workbuddy  → state + authUrl
//   ② 用户在浏览器打开 authUrl 完成登录
//   ③ GET  {base}/v2/plugin/auth/token?state=<state>
//        code=11217 "login ing..."  → 还没登录，继续轮询
//        code=0/200 + accessToken   → 成功
//   ④ GET  {base}/v2/plugin/login/account（Bearer）→ uid/nickname/enterpriseId
//
// 这条路完全是 HTTP，不依赖桌面客户端，所以 Linux / macOS / Windows 通用。
const OAUTH_API_PREFIX = '/v2/plugin';
const OAUTH_CN_BASE = 'https://www.codebuddy.cn';
const OAUTH_GLOBAL_BASE = 'https://www.workbuddy.ai';
const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000; // state 有效期 10 分钟

/** loginId -> { region, base, state, expiresAtMs, done, result?, error? } */
const oauthSessions = new Map();

function oauthBase(region, explicitBase) {
  if (region === 'cn') return OAUTH_CN_BASE;
  const t = typeof explicitBase === 'string' ? explicitBase.trim().replace(/\/+$/, '') : '';
  return t || OAUTH_GLOBAL_BASE;
}

function oauthFirstString(src, keys) {
  for (const k of keys) {
    const v = src?.[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function oauthEnvelopeData(doc) {
  const d = doc?.data;
  return typeof d === 'object' && d !== null && !Array.isArray(d) ? d : {};
}

/** 过期时间容忍：绝对时间戳（秒/毫秒）或相对 TTL（秒）。 */
function oauthExpiryMs(src, absoluteKeys, ttlKeys) {
  for (const k of absoluteKeys) {
    const v = src?.[k];
    if (typeof v === 'number' && v > 0) return v > 0xe8d4a51000 ? v : v * 1e3;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      const n = Number(v);
      return n > 0xe8d4a51000 ? n : n * 1e3;
    }
  }
  for (const k of ttlKeys) {
    const v = src?.[k];
    if (typeof v === 'number' && v > 0) return Date.now() + v * 1e3;
  }
  return undefined;
}

/** ① 申请 state，返回要打开的授权页。 */
async function oauthStart(region = 'cn', explicitBase) {
  const base = oauthBase(region, explicitBase);
  const res = await fetch(`${base}${OAUTH_API_PREFIX}/auth/state?platform=workbuddy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  const doc = await res.json().catch(() => null);
  if (!doc) throw new Error(`登录服务返回了非 JSON（HTTP ${res.status}）`);

  const data = oauthEnvelopeData(doc);
  const state = oauthFirstString(data, ['state', 'State']);
  if (!state) throw new Error(`登录服务没有下发 state（HTTP ${res.status}, code=${doc.code ?? '?'}, msg=${doc.msg ?? ''}）`);

  const authUrl =
    oauthFirstString(data, ['authUrl', 'auth_url', 'url', 'Url']) ||
    `${base}/login?state=${encodeURIComponent(state)}`;

  const loginId = `wbo_${crypto.randomUUID().replaceAll('-', '')}`;
  oauthSessions.set(loginId, {
    region,
    base,
    state,
    expiresAtMs: Date.now() + OAUTH_SESSION_TTL_MS,
    done: false,
  });

  return { loginId, verificationUri: authUrl, expiresIn: Math.floor(OAUTH_SESSION_TTL_MS / 1000) };
}

/** ④ 拿账号资料，组装成 Store 能接受的凭据。 */
async function oauthCollectAccount(session, accessToken, tokenData) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const domain = oauthFirstString(tokenData, ['domain', 'Domain']);
  if (domain) headers['X-Domain'] = domain;

  let profile = {};
  try {
    const r = await fetch(`${session.base}${OAUTH_API_PREFIX}/login/account`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const doc = await r.json().catch(() => null);
    if (doc) profile = oauthEnvelopeData(doc);
  } catch { /* 资料拿不到不致命 */ }

  const expiresAtMs =
    oauthExpiryMs(tokenData, ['expiresAt', 'expires_at'], ['expiresIn', 'expires_in']) ?? 0;
  const refreshExpiresAtMs = oauthExpiryMs(
    tokenData,
    ['refreshExpiresAt', 'refresh_expires_at'],
    ['refreshExpiresIn', 'refresh_expires_in'],
  );

  const nick = oauthFirstString(profile, ['nickname', 'NickName', 'ScreenName']);
  const uin = oauthFirstString(profile, ['uin', 'Uin']);
  const ent = oauthFirstString(profile, ['enterpriseId', 'EnterpriseId']);

  return {
    accessToken,
    refreshToken: oauthFirstString(tokenData, ['refreshToken', 'refresh_token', 'RefreshToken']),
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: domain || oauthFirstString(profile, ['domain', 'Domain']),
    uid: oauthFirstString(profile, ['uid', 'Uid', 'userId', 'UserID']),
    ...(nick === '' ? {} : { nickname: nick }),
    ...(uin === '' ? {} : { uin }),
    ...(ent === '' ? {} : { enterpriseId: ent }),
  };
}

/** ③ 轮询一次登录结果。拿到 token 就写入 vault。 */
async function oauthPoll(loginId, region = 'cn') {
  const s = oauthSessions.get(loginId);
  if (!s) return { done: true, error: '登录会话不存在，请重新发起' };
  if (s.region !== region) return { done: true, error: '登录会话属于另一个区域' };
  if (s.done) {
    return s.result ? { done: true, account: s.result } : { done: true, error: s.error || '登录已结束' };
  }
  if (Date.now() > s.expiresAtMs) {
    s.done = true;
    oauthSessions.delete(loginId);
    return { done: true, error: '登录超时，请重新发起' };
  }

  let res;
  try {
    res = await fetch(
      `${s.base}${OAUTH_API_PREFIX}/auth/token?state=${encodeURIComponent(s.state)}`,
      { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) },
    );
  } catch {
    return { done: false }; // 网络抖动，下次再试
  }

  const doc = await res.json().catch(() => null);
  if (!doc) return { done: false };

  const code = typeof doc.code === 'number' ? doc.code : -1;
  if (code !== 0 && code !== 200) {
    // 11217 = "login ing..."，正常的"还没登录"，继续等
    if (code === 11217) return { done: false, pending: true, hint: '等待浏览器完成登录' };
    return { done: false, pending: true, hint: `code=${code} ${doc.msg || ''}`.trim() };
  }

  const data = oauthEnvelopeData(doc);
  const accessToken = oauthFirstString(data, ['accessToken', 'access_token', 'AccessToken']);
  if (!accessToken) return { done: false };

  s.done = true;
  try {
    const credential = await oauthCollectAccount(s, accessToken, data);
    const accountId = await stores[s.region].addOAuthAccount(credential);
    // 让账号池立刻能看到新账号
    pool[s.region].loadedAt = 0;
    pool[s.region].tokens.set(accountId, credential);
    s.result = {
      id: accountId,
      name: credential.nickname || credential.uin || accountId,
      domain: credential.domain,
    };
    log(`✓ OAuth 登录成功：${s.result.name}`);
    oauthSessions.delete(loginId);
    return { done: true, account: s.result };
  } catch (e) {
    s.error = e?.message || String(e);
    oauthSessions.delete(loginId);
    return { done: true, error: s.error };
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...a);
}

// ── 模型别名兜底 ──────────────────────────────────────────────────────────
// 上游对未知模型返回 {"code":11102,"msg":"model [xxx] service info not found"}，
// 而 VS Code 扩展会把它显示成「请求体格式错误」—— 极误导。
// 这里先按别名表纠一次，别名表没有再问上游要真实列表做模糊匹配。
const MODEL_ALIASES = {
  'deepseek-flash': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v4.1-flash': 'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-v4-flash',
  'deepseek-v4-flash-exp': 'deepseek-v4-flash',
};

// 模型清单按区域分开存：两个市场的模型 id 完全不重叠，
// 共用一份会导致「查 CN 的清单去纠 GLOBAL 的模型名」这种错误。
const modelState = {
  cn: { ids: null, catalog: null, verified: null },
  global: { ids: null, catalog: null, verified: null },
};

// 下面两个保留原名（旧代码引用很多），它们始终指向「最近处理的那个区域」的
// 数据。跨区域混用的风险已经由 refreshModelIds / verifyModels 的显式 region
// 参数消除。
let realModelIds = null;   // Set<id>
let catalogModels = null;  // 完整元数据

function useRegion(region = 'cn') {
  const st = modelState[region] ?? modelState.cn;
  realModelIds = st.ids;
  catalogModels = st.catalog;
  return st;
}

function saveRegion(region = 'cn') {
  const st = modelState[region] ?? modelState.cn;
  st.ids = realModelIds;
  st.catalog = catalogModels;
  return st;
}
let verifiedIds = null;    // 实测 200 的 id 集合（可选，用于标注）

// ↓↓↓ 以下筛选规则照抄 dsh-connect-workbuddy（host-heartbeat-*.js）↓↓↓
//   ROUTER_MODEL_IDS   @1011  ["auto", "default-model"]  —— 上游路由器，不是真模型
//   selectCliModels    @4691  —— 用 agents[name=cli].models 当白名单
//   MEDIA_TAGS         @1192  —— 生图/生视频标签
const ROUTER_MODEL_IDS = new Set(['auto', 'default-model']);
const MEDIA_TAGS = ['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video'];

function isRouterModelId(id) {
  return ROUTER_MODEL_IDS.has(id);
}

// 照抄 selectCliModels：白名单 = agents 里 name==='cli' 的 models 数组
function selectCliModels(rawModels, agents) {
  const byId = new Map();
  for (const m of Array.isArray(rawModels) ? rawModels : []) {
    if (m && typeof m === 'object' && typeof m.id === 'string') byId.set(m.id, m);
  }
  let cliIds;
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && typeof a === 'object' && a.name === 'cli' && Array.isArray(a.models)) {
      cliIds = a.models.filter((id) => typeof id === 'string');
      break;
    }
  }
  const ids = cliIds && cliIds.length ? cliIds : [...byId.keys()];
  return ids
    .filter((id) => !isRouterModelId(id))
    .map((id) => byId.get(id))
    .filter(Boolean);
}

/**
 * 兜底模型 id（只在目录拉不到时用）。
 * ⚠️ 必须按区域选，不能把 CN / GLOBAL 两份合并 —— 两个市场的模型 id 完全不
 *    重叠（国内 hy3/glm-5.3/…，国际 fast-model/gpt-5.6-sol/…），合并后会给出
 *    一堆本区域根本不存在的 id，请求全 11102。
 */
function fallbackModelsFor(region = 'cn') {
  return region === 'global' ? (FALLBACK_MODELS_GLOBAL || []) : (FALLBACK_MODELS || []);
}

function knownModelIds(region = 'cn') {
  const st = modelState[region] ?? modelState.cn;
  if (st.ids) return st.ids;
  const raw = fallbackModelsFor(region);
  const ids = raw.map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name ?? ''))).filter(Boolean);
  st.ids = new Set(ids);
  realModelIds = st.ids;
  return st.ids;
}

// 模型目录端点（照抄插件 MODELS_CATALOG_PATH @2257）
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models';

// 拉目录并按插件规则筛选。这是权威清单 —— 和 DSH 里看到的一致。
async function refreshModelIds(region = 'cn') {
  try {
    const cred = await getCred(region);
    const base = chatBaseOf(cred);
    const res = await fetch(`${base}${MODELS_CATALOG_PATH}`, {
      headers: catalogHeaders(cred), // 用 PRODUCT_UA，不是 CLIENT_UA
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      log(`模型目录 HTTP ${res.status}，退回该区域内置常量`);
      return false;
    }
    const j = await res.json();
    if (j.code !== 0) {
      log(`模型目录 code=${j.code} ${j.msg || ''}，退回该区域内置常量`);
      return false;
    }
    const data = j.data ?? {};
    const selected = selectCliModels(data.models, data.agents);
    if (selected.length) {
      const st = modelState[region] ?? modelState.cn;
      st.catalog = selected;
      st.ids = new Set(selected.map((m) => m.id));
      // 同步「最近区域」别名，兼容旧引用
      catalogModels = st.catalog;
      realModelIds = st.ids;
      const media = selected.filter((m) => (m.tags ?? []).some((t) => MEDIA_TAGS.includes(t)));
      const chat = selected.filter((m) => !media.includes(m));
      log(`[${region}] 已同步 ${selected.length} 个模型（chat ${chat.length} / 媒体 ${media.length}）：`);
      log('  ' + chat.map((m) => m.id).join(', '));
      if (media.length) log('  [媒体] ' + media.map((m) => m.id).join(', '));
      return true;
    }
    log('目录解析为空，退回该区域内置常量');
  } catch (e) {
    log(`模型目录异常：${e?.message || e}`);
  }
  return false;
}

// 同一区域同时只跑一次目录请求。调用方可以 await 到「目录已就绪」，
// 避免在目录还没回来时把内置兜底表发出去 —— 那份表少了 deepseek-v4.1-flash
// 等模型，客户端一缓存，下拉框里就会一直缺。
const catalogJobs = { cn: null, global: null };

function ensureCatalog(region = 'cn', { force = false } = {}) {
  if (!force && modelState[region]?.catalog) return Promise.resolve(true);
  if (!catalogJobs[region]) {
    catalogJobs[region] = refreshModelIds(region).finally(() => {
      catalogJobs[region] = null;
    });
  }
  return catalogJobs[region];
}

// 探测哪些模型真的能调通。只探测 chat 模型（跳过生图/生视频）。
async function verifyModels(region = 'cn') {
  const catalog = modelState[region]?.catalog ?? null;
  const chatModels = (catalog ?? []).filter(
    (m) => !(m.tags ?? []).some((t) => MEDIA_TAGS.includes(t)),
  );
  if (!chatModels.length) return;

  log(`探测 ${chatModels.length} 个 chat 模型可用性…`);
  const ok = new Set();
  const bad = [];

  const probe = async (id) => {
    try {
      const cred = await getCred(region);
      const base = chatBaseOf(cred);
      // 和正式请求走同一套整形，保持一致
      const probeSrc = JSON.stringify({
        model: id,
        messages: [{ role: 'user', content: '在' }],
        stream: true,
        max_tokens: 8,
      });
      const probeBody = typeof prepareChatBody === 'function' ? prepareChatBody(probeSrc, {}) : probeSrc;
      const res = await fetch(`${base}/v2/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(cred),
        body: probeBody,
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) { ok.add(id); try { await res.body?.cancel(); } catch { /* ignore */ } }
      else bad.push(id);
    } catch {
      bad.push(id);
    }
  };

  for (let i = 0; i < chatModels.length; i += 5) {
    await Promise.all(chatModels.slice(i, i + 5).map((m) => probe(m.id)));
  }

  const st = modelState[region] ?? modelState.cn;
  st.verified = ok;
  verifiedIds = ok;
  log(`[${region}] 探测完成：${ok.size}/${chatModels.length} 可用`);
  if (bad.length) log(`[${region}] 不可用：${bad.join(', ')}`);
}

function resolveModel(name, region = 'cn') {
  if (!name) return name;
  const known = knownModelIds(region);
  if (known.has(name)) return name;                 // 本来就是真的，放行
  const alias = MODEL_ALIASES[name];
  if (alias && known.has(alias)) return alias;      // 别名表命中
  // 模糊：把 "deepseek-flash" 里的 flash 拿去匹配 "deepseek-v4-flash"
  const lower = String(name).toLowerCase();
  const cands = [...known].filter((id) => {
    const il = id.toLowerCase();
    return lower.split(/[-_.]/).every((seg) => seg && il.includes(seg));
  });
  if (cands.length) {
    // 取最短的（最贴近原名）
    cands.sort((a, b) => a.length - b.length);
    return cands[0];
  }
  return name; // 兜不住，原样发给上游，让它自己报错
}

// ── 上游请求 ──────────────────────────────────────────────────────────────

// ↓↓↓ 以下 header 构造全部照抄 dsh-connect-workbuddy 的 host-heartbeat-*.js ↓↓↓
// 常量来源：host-heartbeat-BtMcdOIa.js
//   CLIENT_UA     @2308  "CLI/2.63.2 CodeBuddy/2.63.2"
//   PRODUCT_UA    @2346  "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0"
//   commonHeaders @3122
//   chatHeaders   @3148
//   conversationHeaders @3086（对话身份三元组，缺失会 11128）
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0';
const APP_VERSION = PRODUCT_UA.match(/WorkBuddy\/([^\s]+)/u)?.[1] ?? '5.8.3';
const CN_BILLING_BASE = 'https://www.codebuddy.cn';

function originReferer(cred) {
  return isGlobalDomain(cred?.domain) ? GLOBAL_CHAT_BASE : CN_BILLING_BASE;
}

/** 每个上游请求共享的 header */
function commonHeaders(cred) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(cred),
    'Referer': `${originReferer(cred)}/`,
    'User-Agent': CLIENT_UA,
  };
}

/**
 * 32 位小写 hex 的 UUIDv7 —— 官方客户端请求 id 的形态（如 `01a169…`）。
 * 照抄插件 `uuidv7()`。
 *
 * 插件注释：上游**不会**因为 v4 拒绝请求（带连字符的 v4 今天照样 200），
 * 所以这是「让使用统计页看起来和官方一致」的保真修正，不是闸门。
 * 但既然目标是「尽可能一致」，就按官方的来。
 */
function uuidv7(nowMs = Date.now()) {
  const bytes = crypto.randomBytes(16);
  for (let index = 0; index < 6; index++) {
    bytes[index] = Math.floor(nowMs / 2 ** (8 * (5 - index))) & 255;
  }
  bytes[6] = (bytes[6] & 15) | 112; // version 7
  bytes[8] = (bytes[8] & 63) | 128; // variant
  return bytes.toString('hex');
}

/**
 * IDE 身份头 —— 官方桌面客户端在 chat 请求里会带。
 * 照抄插件 `ideHeaders()`：`X-IDE-Type` 保持 `CLI`（不冒充桌面端），
 * `X-IDE-Version` 从 PRODUCT_UA 里取，避免两处版本号漂移。
 *
 * 插件注释：缺了这三个头，网关的「使用端」列会是**空的**，
 * 你的请求在 WorkBuddy 使用统计页上显示成「未标识客户端」，
 * 而官方 App 的请求显示 `WorkBuddy`。这是很明显的非官方流量特征。
 */
function ideHeaders() {
  return {
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': APP_VERSION,
  };
}

/**
 * 对话身份三元组（官方桌面端每个请求都带；共享同一 id 会 11128）。
 * 照抄插件 `conversationHeaders('chat', { usageIdentity: true })`：
 * 三个值**互不相同**且**每次请求全新生成**（插件注释明确说不要跨请求复用，
 * 那等于伪造一个自己并不拥有的会话身份）。
 */
function conversationHeaders() {
  const messageId = uuidv7();
  return {
    'X-Conversation-ID': uuidv7(),
    'X-Conversation-Request-ID': uuidv7(),
    'X-Conversation-Message-ID': messageId,
    'X-Request-ID': messageId, // 官方客户端在用 usageIdentity 时会额外带上这个
  };
}

/** chat 请求的完整 header（照抄 chatHeaders） */
function chatHeaders(cred) {
  return {
    ...commonHeaders(cred),
    'Content-Type': 'application/json',
    ...(cred.uid === '' || cred.uid === undefined ? { 'X-No-User-Id': '1' } : { 'X-User-Id': cred.uid }),
    ...(cred.enterpriseId === undefined || cred.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': cred.enterpriseId }),
    ...(cred.domain === '' || cred.domain === undefined ? { 'X-No-Department-Info': '1' } : { 'X-Domain': cred.domain }),
    'X-Product': PRODUCT,
    ...ideHeaders(),
    'Authorization': `Bearer ${cred.accessToken}`,
    ...conversationHeaders(),
  };
}

/** 模型目录请求的 header（照抄 readMedia：Accept/Origin/Referer/User-Agent） */
function catalogHeaders(cred) {
  return {
    'Authorization': `Bearer ${cred.accessToken}`,
    'Accept': 'application/json',
    'Origin': originReferer(cred),
    'Referer': `${originReferer(cred)}/`,
    'User-Agent': PRODUCT_UA, // 注意：目录用 PRODUCT_UA，不是 CLIENT_UA
  };
}

async function callUpstream(bodyObj, region = 'cn', retryOn401 = true) {
  // ① 模型名纠偏（别名 / 模糊匹配），避免上游 11102
  // ① 先剥掉账号前缀（@<accountId>|<model>），再做模型名纠偏
  const mapped = { ...bodyObj };
  let forcedAccountId = null;
  {
    const parsed = parseAccountModel(mapped.model);
    if (parsed) {
      forcedAccountId = parsed.accountId;
      mapped.model = parsed.model;
    }
  }
  if (mapped.model) {
    const fixed = resolveModel(mapped.model, region);
    if (fixed !== mapped.model) log(`模型名纠正：${mapped.model} → ${fixed}`);
    mapped.model = fixed;
  }
  // ② ⚠️ 关键：不传 reasoning_effort 时，上游把「思考过程」直接混进 content，
  //    reasoning_content 字段虽然在但恒为空串。显式传档位才会分离出思考。
  //    实测（deepseek-v4.1-flash，同一道题）：
  //      不传           → reasoning 0 字符 / content 2592
  //      effort=high    → reasoning 1580 / content 457
  //      effort=max     → reasoning 2213 / content 570
  //    照抄 dsh-connect-workbuddy 的 workBuddyThinkingLevelMap()：档位取上游目录里
  //    该模型声明的 reasoning.supportedEfforts，默认用 reasoning.defaultEffort。
  if (mapped.reasoning_effort === undefined) {
    const info = modelState[region]?.catalog?.find?.((m) => m.id === mapped.model);
    const efforts = info?.reasoning?.supportedEfforts;
    const dflt = info?.reasoning?.defaultEffort;
    if (Array.isArray(efforts) && efforts.length && typeof dflt === 'string' && efforts.includes(dflt)) {
      mapped.reasoning_effort = dflt;
    }
  }

  // ③ 照抄插件的 prepareChatBody：反通道指纹 + 强制流式 + tool_choice 展平
  //    （这一步是「不容易被判定为非官方客户端」的核心，别删）
  let prepared;
  try {
    const src = JSON.stringify({ ...mapped, stream: true });
    prepared = typeof prepareChatBody === 'function' ? prepareChatBody(src, {}) : src;
  } catch (e) {
    log('请求体整形失败，退回裸透传：', e?.message || e);
    prepared = JSON.stringify({ ...mapped, stream: true });
  }

  // ④ 账号池：单账号时会退化成与旧版完全一致的行为
  let accounts = [];
  try {
    accounts = await listAccounts(region);
  } catch (e) {
    log('账号列表读取失败，退回单账号模式：', e?.message || e);
  }

  if (accounts.length === 0) {
    const cred = await getCred(region);
    const res = await fetchChat(cred, prepared);
    if (res.status === 401 && retryOn401) {
      log('401 → 强制刷新 token 后重试');
      cache[region] = null;
      await getCred(region, true);
      return callUpstream(bodyObj, region, false);
    }
    return res;
  }

  // ④ 选定账号：带前缀就锁定指定账号，否则用「当前账号」——不轮询
  const p = pool[region];
  let targets;

  if (forcedAccountId) {
    const hit = accounts.find((a) => a.id === forcedAccountId);
    if (hit) {
      targets = [hit];
      log(`指定账号「${hit.accountName}」`);
    } else {
      log(`指定账号 ${forcedAccountId} 已不存在，退回当前账号`);
      targets = accounts;
    }
  } else {
    targets = accounts;
  }

  // 把「当前账号」排到最前面，其余作为失败兜底
  const current = await pickCurrentAccount(region, accounts);
  if (current && !forcedAccountId) {
    targets = [current, ...accounts.filter((a) => a.id !== current.id)];
  }

  const n = targets.length;
  let lastRes = null;
  let lastErr = null;

  for (let i = 0; i < n; i++) {
    const acct = targets[i];

    let cred;
    try {
      cred = await credForAccount(acct.id, region);
    } catch (e) {
      lastErr = e;
      continue;
    }
    if (!cred) {
      if (n > 1) log(`账号「${acct.accountName}」没有可用凭据，跳过`);
      continue;
    }

    // 单账号最多试 3 轮：① 正常 ② 401 刷 token / 4xx 用零宽扰动 ③ 兜底
    let bodyForAttempt = prepared;
    let perturbationTried = false;

    for (let same = 0; same < 3; same++) {
      let res;
      try {
        res = await fetchChat(cred, bodyForAttempt);
      } catch (e) {
        lastErr = e;
        break;
      }

      if (res.ok) {
        p.lastUsed = acct.id;
        if (n > 1 || forcedAccountId) log(`✓ 账号「${acct.accountName}」`);
        return res;
      }

      lastRes = res;

      // 401 → 刷新这个账号的 token 再试一次
      if (res.status === 401 && same === 0) {
        log(`账号「${acct.accountName}」401，刷新 token 后重试`);
        p.tokens.delete(acct.id);
        try {
          cred = await credForAccount(acct.id, region);
        } catch {
          cred = null;
        }
        if (cred) continue;
        break;
      }

      // 4xx 且首轮 → 可能是 11128「通道校验」，用插件的零宽扰动再试一次
      if (
        !perturbationTried &&
        (res.status === 400 || res.status === 403 || res.status === 422) &&
        typeof perturbChannelFingerprints === 'function'
      ) {
        const pert = perturbChannelFingerprints(prepared, false);
        if (pert) {
          perturbationTried = true;
          log(`账号「${acct.accountName}」返回 ${res.status}，疑似通道校验，改用零宽扰动重试`);
          bodyForAttempt = pert;
          continue;
        }
      }
      break;
    }

    if (n > 1) log(`账号「${acct.accountName}」不可用（HTTP ${lastRes?.status}），换下一个`);
  }

  if (lastRes) return lastRes;
  throw lastErr || new Error('所有 WorkBuddy 账号都不可用');
}

// 把 SSE 聚合成一次完整响应（客户端要 stream:false 时用）
async function aggregate(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let id = 'wb-' + Date.now();
  let model = 'unknown';
  let finish = 'stop';
  let usage = null;
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const s = raw.trim();
      if (!s.startsWith('data:')) continue;
      const p = s.slice(5).trim();
      if (p === '[DONE]') continue;
      let j;
      try { j = JSON.parse(p); } catch { continue; }
      if (j.id) id = j.id;
      if (j.model) model = j.model;
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolCalls[i]) toolCalls[i] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const msg = { role: 'assistant', content };
  if (reasoning) msg.reasoning_content = reasoning;
  if (toolCalls.length) msg.tool_calls = toolCalls.filter(Boolean);

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

// ── 模型列表 ──────────────────────────────────────────────────────────────
function modelList(region = 'cn') {
  const catalog = modelState[region]?.catalog ?? null;
  // 有目录元数据就用真实的（已按插件规则筛选）
  if (catalog?.length) {
    const data = catalog.map((m) => {
      // 上游目录里同一个模型有两套上限字段：
      //   contextWindow = { defaultLength: 300000, supportedLengths: [300000, 600000, 1000000] }
      //   maxInputTokens / maxAllowedSize = 真实最大窗口（如 1000000）
      // 客户端下拉框要展示"能力上限"，所以优先取最大值，而不是 defaultLength。
      const cw = m.contextWindow;
      const supported = Array.isArray(cw?.supportedLengths) ? cw.supportedLengths : [];
      const ctx = Math.max(
        0,
        ...[m.maxInputTokens ?? 0, m.maxAllowedSize ?? 0, cw?.defaultLength ?? 0, ...supported],
      ) || 0;
      const isMedia = (m.tags ?? []).some((t) => MEDIA_TAGS.includes(t));
      return {
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'workbuddy',
        name: m.name ?? m.id,
        // 非标准字段：客户端会忽略，方便调试和生成配置
        context_length: ctx,
        context_default: cw?.defaultLength ?? ctx,
        context_supported: supported,
        max_output_tokens: m.maxOutputTokens ?? null,
        supports_images: m.supportsImages ?? false,
        supports_tool_call: m.supportsToolCall ?? true,
        supports_reasoning: m.supportsReasoning ?? false,
        // 思考档位（照抄上游目录的 reasoning 块，供客户端决定传什么 effort）
        reasoning_effort_supported: m.reasoning?.supportedEfforts ?? null,
        reasoning_effort_default: m.reasoning?.defaultEffort ?? null,
        can_disable_thinking: m.reasoning?.canDisableThinking === true,
        credits: m.credits ?? null,
        tags: m.tags ?? [],
        is_media: isMedia,
        verified: modelState[region]?.verified
          ? modelState[region].verified.has(m.id)
          : null,
      };
    });
    return { object: 'list', data };
  }

  const ids = [...knownModelIds(region)];
  const list = ids.length ? ids : ['deepseek-v4-flash'];
  return {
    object: 'list',
    data: list.map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'workbuddy',
    })),
  };
}

// ── HTTP 服务 ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  // 鉴权（仅在 WB_PROXY_TOKEN 存在时启用）。/health 放行，方便探活。
  if (AUTH_TOKEN && p !== '/health' && p !== '/') {
    const presented = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
    const a = Buffer.from(presented?.[1] || '');
    const b = Buffer.from(AUTH_TOKEN);
    const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
    if (!ok) {
      log('✗ 401 鉴权失败', p);
      return send(res, 401, { error: { message: 'unauthorized' } });
    }
  }

  try {
    // 健康检查
    if (p === '/health' || p === '/') {
      const actualPort = server.address()?.port ?? PORT;
      let info = { ok: true, port: actualPort };
      try {
        const cred = await getCred('cn');
        info = { ...info, region: 'cn', domain: cred.domain, signedIn: true };
      } catch (e) {
        info = { ...info, signedIn: false, error: String(e?.message || e) };
      }
      // 账号池概况
      try {
        const accts = await listAccounts('cn');
        info.accounts = accts.length;
        info.accountNames = accts.map((a) => a.accountName);
        const used = pool.cn.lastUsed && accts.find((a) => a.id === pool.cn.lastUsed);
        if (used) info.lastUsedAccount = used.accountName;
      } catch { /* ignore */ }
      return send(res, 200, info);
    }

    // 账号列表
    //   ?credits=1  顺手把每个账号的剩余积分一起带上（并行请求，单个失败不影响其它）
    if (p === '/accounts' && req.method === 'GET') {
      const region = u.searchParams.get('region') === 'global' ? 'global' : 'cn';
      const withCredits = u.searchParams.get('credits') === '1';
      let list = [];
      try {
        list = await listAccounts(region);
      } catch (e) {
        return send(res, 500, { error: { message: String(e?.message || e) } });
      }
      const current = await pickCurrentAccount(region, list).catch(() => null);

      // 积分是「锦上添花」：任何账号读失败都只记 null，绝不让 /accounts 整个 500
      const creditMap = new Map();
      if (withCredits && list.length) {
        const results = await Promise.allSettled(
          list.map((a) => creditsFor(a.id, region))
        );
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') creditMap.set(list[i].id, r.value);
          else log(`积分读取失败（${list[i].accountName}）：${r.reason?.message || r.reason}`);
        });
      }

      return send(res, 200, {
        region,
        count: list.length,
        strategy: '默认用当前账号（与插件一致）；请求里的模型 id 带 @<accountId>| 前缀可锁定账号；失败才顺延到其它账号',
        current: current ? { id: current.id, name: current.accountName } : null,
        lastUsed: pool[region].lastUsed,
        accounts: list.map((a, i) => {
          const c = creditMap.get(a.id);
          return {
            index: i + 1,
            id: a.id,
            name: a.accountName,
            domain: a.domain,
            source: a.source,
            desktopSelected: a.selected === true,
            isCurrent: a.id === current?.id,
            tokenExpiresAt: a.tokenExpiresAtMs ? new Date(a.tokenExpiresAtMs).toISOString() : null,
            isLastUsed: a.id === pool[region].lastUsed,
            ...(withCredits ? { credits: c ? c.total : null, creditError: c ? null : '读取失败' } : {}),
          };
        }),
      });
    }

    // 查某个账号的剩余积分（含套餐明细）
    //   GET /credits?id=<accountId>&region=cn&force=1
    //   不传 id 时用「当前账号」
    if (p === '/credits' && req.method === 'GET') {
      const region = u.searchParams.get('region') === 'global' ? 'global' : 'cn';
      const force = u.searchParams.get('force') === '1';
      let accountId = (u.searchParams.get('id') || '').trim();
      let accountName = null;

      try {
        const list = await listAccounts(region);
        if (!list.length) {
          return send(res, 404, { error: { message: '还没有任何账号，请先登录' } });
        }
        if (accountId) {
          const hit = list.find((a) => a.id === accountId);
          if (!hit) return send(res, 404, { error: { message: `account ${accountId} not found` } });
          accountName = hit.accountName;
        } else {
          const cur = await pickCurrentAccount(region, list);
          if (!cur) return send(res, 404, { error: { message: '没有可用的当前账号' } });
          accountId = cur.id;
          accountName = cur.accountName;
        }

        const credits = await creditsFor(accountId, region, force);
        return send(res, 200, { ok: true, region, accountId, accountName, ...credits });
      } catch (e) {
        log('GET /credits 失败：', e?.message || e);
        return send(res, 502, { error: { message: String(e?.message || e) } });
      }
    }

    // 每日签到：查今日状态
    //   GET /checkin/status?region=cn → 每个账号 { checkedIn, streakDays, todayCredit }
    if (p === '/checkin/status' && req.method === 'GET') {
      const region = u.searchParams.get('region') === 'global' ? 'global' : 'cn';
      let list = [];
      try {
        list = await listAccounts(region);
      } catch (e) {
        return send(res, 500, { error: { message: String(e?.message || e) } });
      }
      const accounts = await Promise.all(list.map(async (a) => {
        const st = await checkinStatusFor(a.id, region)
          .catch((e) => ({ ok: false, error: 'EXCEPTION', message: String(e?.message || e) }));
        return { id: a.id, name: a.accountName, ...st };
      }));
      return send(res, 200, { ok: true, region, accounts });
    }

    // 每日签到：执行（幂等，已签返回 ALREADY）
    //   POST /checkin  { ids?: string[] } → 逐账号 { result, credit, status }
    if (p === '/checkin' && req.method === 'POST') {
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw) body = JSON.parse(raw);
      } catch { /* 允许空 body = 全部账号 */ }
      const region = body.__region === 'global' ? 'global' : 'cn';
      const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : null;

      let list = [];
      try {
        list = await listAccounts(region);
      } catch (e) {
        return send(res, 500, { error: { message: String(e?.message || e) } });
      }
      const targets = ids ? list.filter((a) => ids.includes(a.id)) : list;

      const results = await Promise.all(targets.map(async (a) => {
        try {
          const r = await checkinFor(a.id, region);
          if (r.result === 'CLAIMED' || r.result === 'ALREADY') clearCreditsCache(a.id, region);
          return { id: a.id, name: a.accountName, ...r };
        } catch (e) {
          return { id: a.id, name: a.accountName, result: 'ERROR', message: `异常：${e?.message || e}` };
        }
      }));

      log(`签到：${results.map((r) => `${r.name}:${r.result}`).join('  ') || '(没有账号)'}`);
      return send(res, 200, { ok: true, region, at: new Date().toISOString(), results });
    }

    // 手动切换当前账号（内存态；不落盘，重启代理后回到桌面端选中的那个）
    //   POST { "id": "<accountId>", "region": "cn" }  指定账号
    //   POST { "id": "", "region": "cn" }             清除，回到默认
    if (p === '/accounts/select' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: { message: 'invalid JSON body' } });
      }
      const region = body.region === 'global' ? 'global' : 'cn';
      const id = typeof body.id === 'string' ? body.id.trim() : '';

      if (id === '') {
        stores[region].setRotatedAccount(undefined);
        const list = await listAccounts(region).catch(() => []);
        const cur = await pickCurrentAccount(region, list).catch(() => null);
        log('已恢复默认账号');
        return send(res, 200, {
          ok: true,
          region,
          current: cur ? { id: cur.id, name: cur.accountName } : null,
        });
      }

      const list = await listAccounts(region).catch(() => []);
      const hit = list.find((a) => a.id === id);
      if (!hit) return send(res, 404, { error: { message: `account ${id} not found` } });

      stores[region].setRotatedAccount(id);
      clearCreditsCache(id, region);
      log(`已切换到账号「${hit.accountName}」`);
      return send(res, 200, { ok: true, region, current: { id: hit.id, name: hit.accountName } });
    }

    // ── OAuth 登录（无需 WorkBuddy 桌面客户端）────────────────────────────
    // POST /auth/start  { region?, base? }  → { loginId, verificationUri, expiresIn }
    // POST /auth/poll   { loginId, region? } → { done, account? | error?, pending?, hint? }
    if (p === '/auth/start' && req.method === 'POST') {
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw.trim()) body = JSON.parse(raw);
      } catch { /* 允许空 body */ }
      const region = body.region === 'global' ? 'global' : 'cn';
      try {
        const started = await oauthStart(region, body.base);
        log(`OAuth 已发起（${region}），等待浏览器登录`);
        return send(res, 200, { ok: true, region, ...started });
      } catch (e) {
        log('✗ OAuth 发起失败：', e?.message || e);
        return send(res, 500, { error: { message: String(e?.message || e) } });
      }
    }

    if (p === '/auth/poll' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: { message: 'invalid JSON body' } });
      }
      const region = body.region === 'global' ? 'global' : 'cn';
      const loginId = typeof body.loginId === 'string' ? body.loginId : '';
      if (!loginId) return send(res, 400, { error: { message: 'missing loginId' } });
      try {
        const r = await oauthPoll(loginId, region);
        return send(res, 200, r);
      } catch (e) {
        return send(res, 500, { error: { message: String(e?.message || e) } });
      }
    }

    // 模型列表（客户端启动时会探测）
    //   ?perAccount=1 → 按账号展开：同一模型 × 每个账号各一条，id 形如 @<accountId>|<model>
    if ((p === '/v1/models' || p === '/models') && req.method === 'GET') {
      const region = u.searchParams.get('region') === 'global' ? 'global' : 'cn';
      // 目录是 listen 之后才异步拉的。客户端可能在 READY 后几毫秒就来问，
      // 这时先等目录（最多 6 秒），别把兜底表发出去。
      if (!modelState[region]?.catalog) {
        await Promise.race([
          ensureCatalog(region),
          new Promise((r) => setTimeout(r, 6000)),
        ]);
      }
      const base = modelList(region);

      if (u.searchParams.get('perAccount') !== '1') return send(res, 200, base);

      let accts = [];
      try {
        accts = await listAccounts(region);
      } catch { /* ignore */ }
      const current = await pickCurrentAccount(region, accts).catch(() => null);

      if (accts.length <= 1) {
        const data = base.data.map((m) => ({
          ...m,
          base_name: m.name,
          account_id: accts[0]?.id ?? null,
          account_name: accts[0]?.accountName ?? null,
          account_current: accts.length === 1,
        }));
        return send(res, 200, { ...base, data });
      }

      const data = [];
      for (const a of accts) {
        for (const m of base.data) {
          data.push({
            ...m,
            id: encodeAccountModel(a.id, m.id),
            base_id: m.id,
            // base_name = 不带账号后缀的干净模型名。
            // 客户端按账号分组时必须用它，否则会出现「模型 · 账号 · 账号」双写。
            base_name: m.name,
            name: `${m.name} · ${a.accountName}`,
            account_id: a.id,
            account_name: a.accountName,
            account_current: a.id === current?.id,
          });
        }
      }
      return send(res, 200, {
        ...base,
        data,
        accounts: accts.map((a) => ({
          id: a.id,
          name: a.accountName,
          source: a.source,
          current: a.id === current?.id,
        })),
      });
    }

    // 手动重跑模型可用性探测
    if (p === '/refresh-models' && req.method === 'POST') {
      const region = u.searchParams.get('region') === 'global' ? 'global' : 'cn';
      await ensureCatalog(region, { force: true });
      await verifyModels(region);
      const st = modelState[region] ?? modelState.cn;
      return send(res, 200, {
        ok: true,
        region,
        catalog: st.ids ? st.ids.size : 0,
        verified: st.verified ? st.verified.size : 0,
        usable: st.verified ? [...st.verified] : [],
      });
    }

    // 对话
    if (p === '/v1/chat/completions' || p === '/chat/completions') {
      if (req.method !== 'POST') return send(res, 405, { error: { message: 'method not allowed' } });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return send(res, 400, { error: { message: 'invalid JSON body' } }); }

      const wantStream = body.stream === true;
      const region = body.__region === 'global' ? 'global' : 'cn';
      delete body.__region;

      const t0 = Date.now();
      const up = await callUpstream(body, region);
      if (!up.ok) {
        const txt = await up.text();
        log(`✗ 上游 ${up.status} ${((Date.now() - t0) / 1000).toFixed(1)}s — ${txt.slice(0, 200)}`);
        return send(res, up.status, {
          error: { message: `WorkBuddy upstream ${up.status}`, type: 'upstream_error', detail: txt.slice(0, 2000) },
        });
      }

      if (wantStream) {
        // 透传 SSE（上游格式已是标准 OpenAI chunk）
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'access-control-allow-origin': '*',
        });
        const reader = up.body.getReader();
        let n = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
            n++;
          }
        } catch (e) {
          log('流中断：', e?.message || e);
        }
        res.end();
        log(`✓ 流式 ${body.model} ${n} chunk ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return;
      }

      // 非流式：聚合成一个 JSON
      const agg = await aggregate(up);
      agg.model = agg.model || body.model;
      send(res, 200, agg);
      log(`✓ 非流式 ${body.model} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }

    return send(res, 404, { error: { message: `unknown path ${p}` } });
  } catch (e) {
    log('✗ 异常：', e?.stack || e);
    if (!res.headersSent) return send(res, 500, { error: { message: String(e?.message || e) } });
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  const actualPort = server.address().port;

  // ⚠️ 这一行是扩展解析端口的约定格式，改动需同步 extension.js
  console.log(`WB_PROXY_READY port=${actualPort}`);

  console.log('─'.repeat(60));
  console.log(`WorkBuddy 代理已启动  http://127.0.0.1:${actualPort}`);
  console.log(`  模块   : ${path.basename(hbPath)}`);
  console.log(`  鉴权   : ${AUTH_TOKEN ? '已启用（进程内随机 token）' : '未启用（手动启动模式）'}`);
  console.log(`  端点   : POST /v1/chat/completions`);
  console.log(`  模型   : GET /v1/models`);
  console.log(`  健康   : GET /health`);
  try {
    const cred = await getCred('cn');
    // 区域以凭据里的 domain 为准（国内账号的 domain 是 www.codebuddy.cn）
    const region = isGlobalDomain(cred.domain) ? 'global' : 'cn';
    console.log(`  账号   : ${cred.domain || '?'}（token 长度 ${String(cred.accessToken).length}，区域 ${region}）`);
    const accts = await listAccounts('cn').catch(() => []);
    if (accts.length > 1) {
      const cur = await pickCurrentAccount('cn', accts).catch(() => null);
      console.log(`  账号池 : ${accts.length} 个 → ${accts.map((a) => a.accountName).join(' / ')}`);
      console.log(`  当前   : ${cur?.accountName || '?'}（模型列表按账号分组，选带账号名的模型即锁定该账号）`);
    }
    await ensureCatalog(region);   // 拉目录（权威清单）
    await verifyModels(region);    // 探测哪些真能用
  } catch (e) {
    console.log(`  ⚠ 还没有可用的 WorkBuddy 账号`);
    console.log(`    在 VS Code 命令面板执行「WorkBuddy: 登录账号」即可`);
    console.log(`    （内部原因：${String(e?.message || e).split('\n')[0].slice(0, 160)}）`);
  }
  console.log('─'.repeat(60));
});
