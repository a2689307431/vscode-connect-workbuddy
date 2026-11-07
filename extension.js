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
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

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
/**
 * 把旧的 `local.vscode-connect-workbuddy` 存储目录迁移到当前扩展 ID 下。
 *
 * 为什么需要：`globalStoragePath` = `<userDataDir>/globalStorage/<publisher>.<name>`。
 * 0.7.8 及以前的 publisher 是 `local`，改名后路径会变，老用户的 `vault/`（登录凭据）
 * 和 `dsh-home/`（设备盐）看起来会「凭空消失」，被迫重新登录。
 *
 * 规则：
 *   · 只在新目录**还没有**对应内容时才复制，绝不覆盖已有数据
 *   · 复制而非移动 —— 万一用户又装回旧版本，旧目录仍然可用
 *   · 只复制 vault/ 与 dsh-home/，不碰日志之类
 *   · 全程失败只记日志，不阻塞激活
 */
function migrateLegacyStorage(context) {
  const cur = context.globalStoragePath;
  if (!cur) return;

  const curId = path.basename(cur);
  // 只有「已经是新 ID」时才需要从旧 ID 拉数据
  const LEGACY_IDS = ['local.vscode-connect-workbuddy'];
  if (LEGACY_IDS.includes(curId)) return;

  const parent = path.dirname(cur);
  for (const oldId of LEGACY_IDS) {
    const from = path.join(parent, oldId);
    if (from === cur || !fs.existsSync(from)) continue;

    for (const sub of ['vault', 'dsh-home']) {
      const src = path.join(from, sub);
      const dst = path.join(cur, sub);
      if (!fs.existsSync(src)) continue;
      try {
        if (fs.existsSync(dst) && fs.readdirSync(dst).length) continue; // 已有数据，不覆盖
        fs.mkdirSync(parent, { recursive: true });
        fs.cpSync(src, dst, { recursive: true });
        log(`已从旧目录迁移 ${sub}：${oldId} → ${curId}`);
      } catch (e) {
        log(`迁移 ${sub} 失败：`, e?.message || e);
      }
    }
  }
}

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
  //
  // ⚠️ globalStoragePath 的路径含 "<publisher>.<name>"，所以**改 publisher 会换目录**，
  //    老用户的账号看起来会「消失」。这里做一次性迁移（见 migrateLegacyStorage）。
  const vaultDir = path.join(context.globalStoragePath, 'vault');
  // 内嵌模块是 DSH 插件，会往 $DSH_HOME 写设备盐。这里把它指到扩展自己的目录，
  // 家目录一个文件都不新增；旧的 ~/.dsh 只作为「读取旧账号」的来源。
  const dshHome = path.join(context.globalStoragePath, 'dsh-home');
  const realDshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  try {
    migrateLegacyStorage(context);
  } catch (e) {
    log('迁移旧存储目录失败（不影响新账号登录）：', e?.message || e);
  }
  for (const d of [vaultDir, dshHome]) {
    try {
      // POSIX 上收紧到 0700：里面是凭据和设备盐
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    } catch { /* ignore */ }
  }

  const child = spawn(node.cmd, [...node.args, script, '--port', '0'], {
    env: {
      ...process.env,
      WB_PROXY_TOKEN: token,
      WB_VAULT_DIR: vaultDir,
      WB_DSH_HOME: dshHome,
      WB_LEGACY_DSH_HOME: realDshHome,
      ...node.env,
    },
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

/** 查剩余积分。不传 accountId 时用代理侧的「当前账号」。 */
async function fetchCredits(accountId, force = false) {
  const q = new URLSearchParams();
  if (accountId) q.set('id', accountId);
  if (force) q.set('force', '1');
  const res = await fetch(baseUrl() + '/credits?' + q.toString(), {
    headers: { authorization: 'Bearer ' + getApiKey() },
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return j;
}

/** 账号列表 + 每个账号的剩余积分（代理侧并行查询）。 */
async function fetchAccountsWithCredits() {
  const res = await fetch(baseUrl() + '/accounts?credits=1', {
    headers: { authorization: 'Bearer ' + getApiKey() },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `GET /accounts 返回 HTTP ${res.status}`);
  return j;
}

// ── 每日签到 ──────────────────────────────────────────────────────
// 逻辑放在代理里（和聊天共用同一份 token），这里只负责调用和展示。
async function fetchCheckinStatus() {
  const res = await fetch(baseUrl() + '/checkin/status', {
    headers: { authorization: 'Bearer ' + getApiKey() },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `GET /checkin/status 返回 HTTP ${res.status}`);
  return j;
}

async function postCheckin(ids) {
  const res = await fetch(baseUrl() + '/checkin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getApiKey() },
    body: JSON.stringify(Array.isArray(ids) && ids.length ? { ids } : {}),
    signal: AbortSignal.timeout(90_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        '当前代理不支持签到（可能是旧版或外部代理）。请清空 connect-workbuddy.proxyUrl 让扩展自己拉起代理，或升级外部代理。'
      );
    }
    throw new Error(j?.error?.message || `POST /checkin 返回 HTTP ${res.status}`);
  }
  return j;
}

let checkinRunning = false;

function localDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 跑一轮签到并汇报。silent = 不弹窗（自动签到用）。 */
async function performCheckin({ silent = false, ids = null } = {}) {
  if (checkinRunning) {
    if (!silent) vscode.window.showInformationMessage('WorkBuddy：正在签到中，请稍候');
    return null;
  }
  checkinRunning = true;
  try {
    return await doCheckin({ silent, ids });
  } finally {
    checkinRunning = false;
  }
}

async function doCheckin({ silent = false, ids = null } = {}) {
  const j = await postCheckin(ids);
  const results = Array.isArray(j.results) ? j.results : [];
  const claimed = results.filter((r) => r.result === 'CLAIMED');
  const already = results.filter((r) => r.result === 'ALREADY');
  const failed = results.filter((r) => r.result !== 'CLAIMED' && r.result !== 'ALREADY');

  output.appendLine(
    `签到：成功 ${claimed.length}，已签 ${already.length}` + (failed.length ? `，失败 ${failed.length}` : '')
  );
  for (const r of results) {
    output.appendLine(`  ${r.name || r.id}: ${r.result}${r.credit ? ' +' + r.credit : ''} ${r.message || ''}`);
  }

  if (claimed.length) await refreshCreditsStatus({ quiet: true, force: true });

  if (!silent) {
    const detail = results.length
      ? results.map((r) => {
        const streak = r.status?.streakDays ? `（连续 ${r.status.streakDays} 天）` : '';
        return `${r.name || r.id}：${r.message || r.result}${streak}`;
      }).join('\n')
      : '还没有登录任何账号。';

    if (!results.length) {
      await vscode.window.showInformationMessage(
        'WorkBuddy：还没有登录账号，先执行「WorkBuddy: 登录账号」',
        { modal: true, detail }
      );
    } else if (failed.length && !claimed.length && !already.length) {
      await vscode.window.showErrorMessage('WorkBuddy：签到失败', { modal: true, detail });
    } else {
      const headline = claimed.length
        ? `WorkBuddy：签到成功 ${claimed.length} 个账号` +
          (claimed[0]?.credit ? `，+${claimed[0].credit} 积分` : '')
        : failed.length
          ? `WorkBuddy：${failed.length} 个账号签到失败`
          : 'WorkBuddy：今天已经签过了';
      await vscode.window.showInformationMessage(headline, { modal: true, detail });
    }
  }
  return { claimed, already, failed, results };
}

const AUTO_CHECKIN_KEY = 'autoCheckinDay';

/**
 * 自动签到：每天最多一次，只在用户显式开启 `autoCheckin` 时执行。
 * 全部失败时不记日期，下次开窗口还会再试。
 */
async function maybeAutoCheckin(context) {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  if (cfg.get('autoCheckin') !== true) return null;
  if ((await checkAccountCount()) <= 0) return null;

  const day = localDayKey();
  if (context.globalState.get(AUTO_CHECKIN_KEY) === day) {
    log('自动签到：今天已经跑过');
    return null;
  }

  // 服务端「今天」的分界在 0 点附近。太早跑可能把昨天当成今天，
  // 所以 02:00 前先不签，改成 02:05 再补一次（窗口一直开着也能补上）。
  const now = new Date();
  if (now.getHours() < 2) {
    const target = new Date(now);
    target.setHours(2, 5, 0, 0);
    const waitMs = Math.max(1000, target - now);
    const timer = setTimeout(() => {
      maybeAutoCheckin(context).catch((e) => output.appendLine('自动签到异常：' + (e?.message || e)));
    }, waitMs);
    if (typeof timer.unref === 'function') timer.unref();
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    output.appendLine(`自动签到：等到 02:05 再签（约 ${Math.round(waitMs / 60000)} 分钟后）`);
    return null;
  }

  // 等启动时的模型拉取/积分刷新忙完再发
  await new Promise((r) => setTimeout(r, 10_000));

  try {
    const out = await performCheckin({ silent: true });
    if (!out || !out.results.length) {
      output.appendLine('自动签到：没有可签到的账号');
      return out;
    }
    // 只有所有账号都确认过（成功或今日已签）才记日期；有失败就下次启动重试
    if (out.failed.length) {
      output.appendLine(`自动签到：${out.failed.length} 个账号失败，今天稍后启动会重试`);
      return out;
    }
    await context.globalState.update(AUTO_CHECKIN_KEY, day);
    if (out.claimed.length) {
      const names = out.claimed.map((r) => r.name || r.id).join('、');
      vscode.window.showInformationMessage(`WorkBuddy：已自动签到（${names}）`);
    }
    return out;
  } catch (e) {
    output.appendLine('自动签到失败：' + (e?.message || e));
    return null;
  }
}

// ── 状态栏积分 ────────────────────────────────────────────────────
// 状态栏跟随「你实际在用哪个账号」：
//   · 模型 id 形如 `@<accountId>|<model>`（代理 /v1/models?perAccount=1 生成），
//     每次发请求时解析出账号 → 状态栏立刻切到那个账号的余额
//   · 还没发过请求时，退回代理侧的「当前账号」
// 上游按账号串行查询，所以别太勤：定时刷新 5 分钟一次，
// 切账号 / 换模型 / 登录成功 / 手动刷新时立刻更新。
let statusBar = null;
let creditsTimer = null;
let creditsInFlight = null;
let creditsInFlightFor; // 上面那个请求是给哪个账号发的（null = 代理当前账号）

// 状态栏正在跟踪的账号。null = 用代理侧的「当前账号」
let trackedAccountId = null;
let trackedAccountName = null;

/** 解析 `@<accountId>|<modelId>`；不是这个格式返回 null（裸模型名）。 */
const ACCOUNT_MODEL_RE = /^@([0-9A-Za-z_-]{6,64})\|(.+)$/;
function parseAccountModelId(id) {
  const m = ACCOUNT_MODEL_RE.exec(String(id || ''));
  return m ? { accountId: m[1], model: m[2] } : null;
}

/** 刷新间隔（秒 → 毫秒），从设置读，最小 60 秒 */
function creditsRefreshMs() {
  const s = Number(vscode.workspace.getConfiguration(SECTION).get('creditsRefreshSeconds'));
  return (Number.isFinite(s) && s >= 60 ? s : 300) * 1000;
}

/** 1234.56 → "1,235"；1.2 → "1.2"。整数就省略小数。 */
function formatCredits(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString('en-US', {
    maximumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
  });
}

/**
 * 状态栏里的账号名要短。
 * 手机号上游本来就会脱敏（如 `138****0000`，自身就短），昵称则截到 8 个字。
 */
function shortenAccountName(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return s.length > 10 ? s.slice(0, 9) + '…' : s;
}

function setStatusBar(state, text, tooltip, command = 'connect-workbuddy.showCredits') {
  if (!statusBar) return;
  // 用户可以在设置里关掉状态栏
  if (vscode.workspace.getConfiguration(SECTION).get('showCreditsInStatusBar') === false) {
    statusBar.hide();
    return;
  }
  statusBar.text = text;
  statusBar.tooltip = tooltip;
  statusBar.command = command;
  statusBar.show();
  switch (state) {
    case 'ok': statusBar.backgroundColor = undefined; break;
    case 'warn': statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); break;
    case 'error': statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground'); break;
    default: statusBar.backgroundColor = undefined;
  }
}

/** 刷新状态栏上的积分。失败也不弹窗，只把状态栏变红。 */
function refreshCreditsStatus({ quiet = false, force = false } = {}) {
  // 同一个账号正在查就直接复用；换账号时必须重新发起
  if (creditsInFlight && creditsInFlightFor === (trackedAccountId || null)) {
    return creditsInFlight;
  }
  const wantAccount = trackedAccountId || null;
  creditsInFlightFor = wantAccount;
  const task = (async () => {
    try {
      // 跟随正在使用的账号；没跟踪就交给代理用「当前账号」
      const c = await fetchCredits(wantAccount || undefined, force);
      // 请求期间用户又切了账号 → 这次结果已过时，丢掉
      if ((trackedAccountId || null) !== wantAccount) return null;
      const num = formatCredits(c.total);
      if (num === null) {
        setStatusBar('error', '$(warning) WorkBuddy 积分 ?', '没读到余额（点这里看详情）');
        return null;
      }
      // 服务端认出的账号名以它为准（切账号后名字也会更新）
      if (c.accountId) {
        trackedAccountId = c.accountId;
        trackedAccountName = c.accountName || null;
      }
      const low = c.total <= 0;
      const soon = typeof c.expiringSoon === 'number' && c.expiringSoon > 0;
      const label = c.accountName || c.accountId || '当前账号';
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown(`**WorkBuddy 剩余积分**：${num}\n\n`);
      tip.appendMarkdown(`账号：\`${label}\`\n\n`);
      if (c.nearestExpiry) {
        tip.appendMarkdown(`最近到期：${new Date(c.nearestExpiry).toLocaleString()}\n\n`);
      }
      if (soon) tip.appendMarkdown(`⚠️ 其中 ${formatCredits(c.expiringSoon)} 将在 30 天内过期\n\n`);
      if (wantAccount) {
        tip.appendMarkdown('_这是你在模型下拉框里所选账号的余额 · 点击查看明细_');
      } else {
        tip.appendMarkdown('_点击查看积分明细_');
      }
      // 带账号名，否则两个账号余额相近时根本分不清现在显示的是谁
      const shortName = shortenAccountName(label);
      const text = wantAccount && shortName
        ? `$(credit-card) ${num} · ${shortName}`
        : `$(credit-card) ${num}`;
      setStatusBar(low ? 'warn' : 'ok', text, tip);
      if (!quiet) log(`积分刷新：${num}（${label}）`);
      return c;
    } catch (e) {
      const msg = String(e?.message || e);
      // 没登录 / 代理没起来：状态栏直接藏起来，比挂个红叉友好
      if (/还没有任何账号|没有可用的当前账号|unauthorized|ECONNREFUSED|fetch failed/i.test(msg)) {
        if (statusBar) statusBar.hide();
        if (!quiet) log('积分不可用（正常，通常是还没登录）：' + msg);
        return null;
      }
      setStatusBar('error', '$(warning) WorkBuddy 积分 ?', '读不到积分：' + msg);
      if (!quiet) log('积分刷新失败：' + msg);
      return null;
    } finally {
      if (creditsInFlightFor === wantAccount) {
        creditsInFlight = null;
        creditsInFlightFor = undefined;
      }
    }
  })();
  creditsInFlight = task;
  return task;
}

/**
 * 状态栏切到某个账号（用户选了一个带账号前缀的模型时调用）。
 * 已经是这个账号就不重复请求；换账号时强制跳过代理侧缓存，保证数字是新的。
 */
function trackAccount(accountId, { force = false } = {}) {
  const changed = accountId !== trackedAccountId;
  if (!force && !changed) return Promise.resolve(null);
  trackedAccountId = accountId || null;
  trackedAccountName = null;
  // 换账号 = 必须绕过缓存，否则会显示上一个账号的余额
  return refreshCreditsStatus({ force: changed || force });
}

// ── 账号分组（模型下拉框里每个账号一个分组）──────────────────────────
// VS Code 的模型下拉框只能按 `chatLanguageModels.json` 里的
// { name, vendor } 条目分组（源码里 _resolveAllLanguageModels 会为每个条目
// 单独调一次 provider，并把条目的其它字段放进 options.configuration）。
// 所以「每个账号一组」只能靠往那个文件里写条目，扩展没法凭空创建分组。
//
// 文件位置（VS Code 内部叫 currentProfile.languageModelsResource）：
//   Windows  %APPDATA%\<变体>\User\chatLanguageModels.json
//   macOS    ~/Library/Application Support/<变体>/User/chatLanguageModels.json
//   Linux    ~/.config/<变体>/User/chatLanguageModels.json
// 变体：Code（稳定版）/ Code - Insiders / VSCodium / Cursor …
// 也支持 --user-data-dir 指定的目录，所以优先用 context 给的 URI 反推。
const GROUP_PREFIX = 'WorkBuddy';

/**
 * 用户数据目录名（<userDataDir> 的最后一段）。
 * 只有在拿不到任何 context URI 时才用得到 —— 写死 "Code" 会让
 * Insiders / VSCodium / Cursor 写到错误目录。
 */
function userDataDirName() {
  const app = String(vscode.env?.appName || '');
  if (/insider/i.test(app)) return 'Code - Insiders';
  if (/vscodium/i.test(app)) return 'VSCodium';
  if (/cursor/i.test(app)) return 'Cursor';
  if (/windsurf/i.test(app)) return 'Windsurf';
  if (/codium/i.test(app)) return 'VSCodium';
  return 'Code';
}

function modelsConfigPath(context) {
  // ① 首选：globalStorageUri = <userDataDir>/globalStorage/<extId>
  try {
    const gs = context.globalStorageUri?.fsPath;
    if (gs) {
      const userDir = path.dirname(path.dirname(gs));
      return path.join(userDir, 'chatLanguageModels.json');
    }
  } catch { /* 继续下一个来源 */ }

  // ② 次选：从 logUri 往上找到名为 logs 的那层，它的父目录就是 userDataDir
  //    logUri 形如 <userDataDir>/logs/<会话>/window1/exthost/<扩展名>，
  //    层数可能随版本变，所以按名字找而不是数层数。
  try {
    let cur = context.logUri?.fsPath;
    for (let depth = 0; cur && depth < 6; depth++) {
      const parent = path.dirname(cur);
      if (path.basename(cur) === 'logs') {
        // ⚠️ 不能返回 <userDataDir>/chatLanguageModels.json ——
        //    真实位置是 <userDataDir>/User/chatLanguageModels.json
        return path.join(parent, 'User', 'chatLanguageModels.json');
      }
      if (parent === cur) break;
      cur = parent;
    }
  } catch { /* 继续 */ }

  // ③ 兜底：按平台约定 + 变体名拼
  const appData = process.env.APPDATA
    || (process.env.HOME ? path.join(process.env.HOME, '.config') : '');
  const base = process.platform === 'darwin'
    ? (process.env.HOME ? path.join(process.env.HOME, 'Library', 'Application Support') : '')
    : appData;
  return base
    ? path.join(base, userDataDirName(), 'User', 'chatLanguageModels.json')
    : '';
}

/** 读 chatLanguageModels.json；文件不存在/坏了都返回空数组。 */
function readModelsConfig(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    if (e?.code !== 'ENOENT') log('读 chatLanguageModels.json 失败：' + (e?.message || e));
    return [];
  }
}

/** 写回（首次改动前备份一次，原子写）。 */
function writeModelsConfig(file, list) {
  try {
    // 只保留「扩展第一次改动之前」的原件；后续重写不覆盖，避免备份跟着一起坏掉
    const bak = file + '.workbuddy-bak';
    if (fs.existsSync(file) && !fs.existsSync(bak)) {
      fs.copyFileSync(file, bak);
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log('写 chatLanguageModels.json 失败：' + (e?.message || e));
    throw e;
  }
}

// 组名里不能有奇怪字符，且要能稳定地反查回账号 id
function groupNameFor(account) {
  return `${GROUP_PREFIX} · ${account.name}`;
}

function isOurGroup(g) {
  return g && g.vendor === VENDOR && typeof g.name === 'string' && g.name.startsWith(GROUP_PREFIX);
}

// 「配置文件里是否已经有我们的账号分组」被 provider 每次调用时查询，
// 但 VS Code 一次解析会对每个组各调一次，所以加个短缓存（文件改动靠 mtime 感知）。
let groupsProbe = { file: '', mtimeMs: 0, has: false, at: 0 };

/** 配置文件里是否存在 vendor=workbuddy 且名字以 "WorkBuddy" 开头的条目。 */
function hasAccountGroups(context) {
  const file = modelsConfigPath(context);
  if (!file) return false;

  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return false; }

  // mtime 没变就直接用上次结论
  if (groupsProbe.file === file && groupsProbe.mtimeMs === mtimeMs) return groupsProbe.has;

  const has = readModelsConfig(file).some(isOurGroup);
  groupsProbe = { file, mtimeMs, has, at: Date.now() };
  return has;
}

/**
 * 按当前账号列表同步分组条目。
 * @returns {{added:string[], removed:string[], kept:string[]}}
 */
function syncAccountGroups(context, accounts) {
  const file = modelsConfigPath(context);
  if (!file) throw new Error('找不到 chatLanguageModels.json 的位置');

  const list = readModelsConfig(file);
  const others = list.filter((g) => !isOurGroup(g));

  // 保留用户自己建的同名组（非本扩展格式的），按 (vendor:name) 去重
  const want = [];
  const seenName = new Set(others.map((g) => `${g.vendor}:${g.name}`));
  for (const a of accounts) {
    const name = groupNameFor(a);
    if (seenName.has(`${VENDOR}:${name}`)) continue;
    seenName.add(`${VENDOR}:${name}`);
    want.push({
      name,
      vendor: VENDOR,
      workbuddyAccount: a.id,
    });
  }

  const before = new Set(list.filter(isOurGroup).map((g) => g.name));
  const after = new Set(want.map((g) => g.name));
  const added = [...after].filter((n) => !before.has(n));
  const removed = [...before].filter((n) => !after.has(n));
  const kept = [...after].filter((n) => before.has(n));

  // 顺序保持：别人的组在前，我们的组在后。
  // 内容没变就不写 —— 否则每次激活都 touch 一次用户配置，还会触发文件监听。
  const next = [...others, ...want];
  const changed = JSON.stringify(next) !== JSON.stringify(list);
  if (changed) writeModelsConfig(file, next);
  return { added, removed, kept, changed, file };
}

/**
 * 按当前账号同步分组，不弹窗（登录成功 / 激活时调用）。
 * @returns {Promise<{added:string[], removed:string[], kept:string[], file:string}|null>}
 */
async function autoSyncGroups(context, { silent = true } = {}) {
  let accounts = [];
  try {
    accounts = (await fetchAccounts()).accounts || [];
  } catch (e) {
    if (!silent) throw e;
    log('分组同步跳过（读不到账号）：' + (e?.message || e));
    return null;
  }
  if (!accounts.length) return null;

  let result;
  try {
    result = syncAccountGroups(context, accounts);
  } catch (e) {
    log('分组同步失败：' + (e?.message || e));
    return null;
  }

  if (result.added.length || result.removed.length) {
    output.appendLine(
      `分组已同步：+${result.added.length} -${result.removed.length}（共 ${accounts.length} 组）`
    );
    for (const n of result.added) output.appendLine('  + ' + n);
    for (const n of result.removed) output.appendLine('  - ' + n);
  }
  return result;
}

/**
 * 把一次积分响应整理成弹窗文本。
 * 返回用户点了哪个按钮（'刷新' / '查看其它账号' / undefined）。
 */
async function showCreditsModal(c, allowSwitch, checkin = null) {
  const total = formatCredits(c.total) ?? '—';
  const lines = [`账号：${c.accountName || c.accountId || '当前账号'}`, `剩余合计：${total} 积分`];

  if (checkin?.ok && checkin.checkedIn) {
    lines.push(
      `今日已签到 · 连续 ${checkin.streakDays} 天` +
      (checkin.todayCredit ? ` · 今日 +${checkin.todayCredit}` : '')
    );
  } else if (checkin?.ok) {
    lines.push('今日尚未签到（命令面板 → WorkBuddy: 每日签到）');
  }
  if (c.nearestExpiry) lines.push(`最近到期：${new Date(c.nearestExpiry).toLocaleString()}`);
  if (c.expiringSoon > 0) {
    lines.push(`注意：其中 ${formatCredits(c.expiringSoon)} 将在 30 天内过期`);
  }

  const pkgs = Array.isArray(c.packages) ? c.packages : [];
  if (pkgs.length) {
    lines.push('', '积分包明细：');
    for (const p of pkgs) {
      const remain = formatCredits(p.remain) ?? '?';
      const size = formatCredits(p.size);
      const when = p.monthly
        ? (p.refreshAt ? `每月 ${new Date(p.refreshAt).toLocaleDateString()} 重置` : '每月重置')
        : (p.expiresAt ? `${new Date(p.expiresAt).toLocaleDateString()} 到期` : '');
      lines.push(`  · ${p.name}：${remain}${size ? ` / ${size}` : ''}${when ? `，${when}` : ''}`);
    }
  } else {
    lines.push('', '没有查到积分包（企业账号，或余额已用尽）。');
  }

  const buttons = ['刷新'];
  if (allowSwitch) buttons.push('查看其它账号');

  return vscode.window.showInformationMessage(
    `WorkBuddy 剩余积分 ${total}`,
    { modal: true, detail: lines.join('\n') },
    ...buttons
  );
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
    'WorkBuddy 还没有登录账号。登录后即可在 Copilot Chat 里直接使用 WorkBuddy 的模型。',
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

    // 上游不保证最后一行以换行结尾，EOF 时把残留的 data 行也处理掉
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
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

// ── 上下文用量上报 ────────────────────────────────────────────────
// Copilot Chat 的「上下文窗口 0/1M」进度条靠 provider 上报的 usage 数据驱动。
// 格式由 Copilot 自己约定（mime = "usage"），参照
// vizards.deepseek-v4-for-copilot 的 stream.js → reportCopilotContextUsage()：
//
//   progress.report(new LanguageModelDataPart(
//     new TextEncoder().encode(JSON.stringify({
//       prompt_tokens, completion_tokens, total_tokens,
//       prompt_tokens_details: { cached_tokens },
//     })),
//     'usage',
//   ));
//
// 不报的话界面永远显示 0/1M（实测 WorkBuddy 上游是**会**返回 usage 的，
// 只是本扩展一直没解析，属于漏做，不是上游限制）。
const USAGE_MIME = 'usage';

function reportUsage(progress, usage) {
  if (!usage || typeof usage !== 'object') return;
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return;

  const data = {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(Number(usage.total_tokens))
      ? Number(usage.total_tokens)
      : (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0),
    prompt_tokens_details: {
      cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens
        ?? usage.prompt_cache_hit_tokens ?? 0) || 0,
    },
  };

  try {
    const Ctor = vscode.LanguageModelDataPart;
    if (typeof Ctor !== 'function') return; // 旧版 VS Code 没有这个 API
    progress.report(new Ctor(new TextEncoder().encode(JSON.stringify(data)), USAGE_MIME));
    log(`上下文用量：prompt=${data.prompt_tokens} completion=${data.completion_tokens}`);
  } catch (e) {
    log('上报上下文用量失败：', e?.message || e);
  }
}

// ── 思考内容（LanguageModelThinkingPart） ─────────────────────────
// 用途：把上游 delta.reasoning_content 显示成 Copilot Chat 里可折叠的「思考」块。
// 参考实现：vizards.deepseek-v4-for-copilot 的 provider/stream.js → handleThinking()。
//
// 两条硬要求（2026-11-05 与官方 API 对照实测，缺任一条界面上就是一串
// 「Thought for 1s」碎片而不是一整块）：
//   1. 同一轮连续思考的所有 part 必须带**同一个 id**（正文 / 工具调用打断后清空，
//      下一段思考才另起一块）。参照做法：
//        state.reasoningRunId ??= randomUUID();
//        progress.report(new LanguageModelThinkingPart(text, state.reasoningRunId));
//   2. 上游把 reasoning_content 拆成 1~4 字符的碎片，攒到几十字符再上报，
//      否则一次回答会生成几十个 part。
let thinkingSupported = null;

function reportThinking(progress, text, runId) {
  // 兜底：只有空白的「思考」是上游噪音，别在界面上留空块
  if (!text || !text.trim()) return;
  if (thinkingSupported === null) {
    thinkingSupported = typeof vscode.LanguageModelThinkingPart === 'function';
    log('LanguageModelThinkingPart 运行时可用：', thinkingSupported);
  }
  if (!thinkingSupported) return;
  try {
    progress.report(new vscode.LanguageModelThinkingPart(text, runId));
  } catch (e) {
    thinkingSupported = false;
    log('ThinkingPart 上报失败，本次起禁用：', e?.message || e);
  }
}

// ── Provider ──────────────────────────────────────────────────────
class WorkBuddyProvider {
  constructor(context) {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
    this._context = context;
  }

  async provideLanguageModelChatInformation(options, token) {
    // 分组：`chatLanguageModels.json` 里每个 vendor=workbuddy 的条目会被
    // VS Code 单独调用一次，`options.group` 是组名，`options.configuration`
    // 是该条目里除 vendor/name/settings 之外的字段（我们用 workbuddyAccount）。
    //
    // ⚠️ 另有一次**不带 group** 的默认调用（源码 _resolveAllLanguageModels 里
    //    `provideLanguageModelChatInfo({silent})`），结果会渲染成一个以 vendor
    //    displayName（"WorkBuddy"）为标题的组。我们已经按账号分了组，如果那次
    //    也把全部模型返回，下拉框里就会多出一个「所有账号混在一起」的重复组。
    //    所以：只要配置文件里已有我们的分组，默认调用就返回空数组。
    const groupName = typeof options?.group === 'string' ? options.group : '';
    const wantAccount = String(options?.configuration?.workbuddyAccount ?? '').trim();

    if (!groupName && !wantAccount && hasAccountGroups(this._context)) {
      log('已配置账号分组 → 跳过无组的默认模型列表（避免出现混合组）');
      return [];
    }

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

    let chat = models.filter((m) => m.is_media !== true);

    // 带账号的分组：只保留该账号的模型（workbuddyAccount 可以填 id 或昵称）
    if (wantAccount) {
      const hit = chat.filter(
        (m) => m.account_id === wantAccount || m.account_name === wantAccount
      );
      if (hit.length) {
        chat = hit;
      } else {
        // 账号没了（退登/改名）→ 不要把整组清空，退回全部，避免下拉框里凭空少东西
        log(`分组「${groupName || '?'}」指定的账号 ${wantAccount} 不存在，本组退回全部模型`);
      }
    }

    return chat.map((m) => {
      const ctx = Number(m.context_length) || 128000;
      const maxOut = Number(m.max_output_tokens) || 32000;
      // base_name 是代理给的「不带账号后缀」的干净模型名；老版本代理没有这个
      // 字段，用 base_id / id 兜底。分组里组名已标明账号，名字里不再重复。
      const clean = m.base_name || m.base_id || m.id;
      const name = wantAccount ? clean : `${clean} · ${m.account_name || ''}`.replace(/ · $/, '');
      return {
        id: m.id,
        name,
        family: 'workbuddy',
        version: '1.0.0',
        detail: `${Math.round(ctx / 1000)}k 上下文 · WorkBuddy`,
        tooltip:
          `${clean}\n${ctx} 上下文 / ${maxOut} 输出\nWorkBuddy 积分计费` +
          (m.account_name ? `\n账号：${m.account_name}${m.account_current ? '（桌面端当前选中）' : ''}` : '') +
          (groupName ? `\n分组：${groupName}` : ''),
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

    // 模型 id 可能带账号前缀 `@<accountId>|<model>`：
    // 用户在下拉框里选了哪个账号的模型，状态栏就显示那个账号的余额。
    const parsed = parseAccountModelId(model.id);

    const body = {
      model: model.id,
      messages: toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools) body.tools = tools;
    if (model.maxOutputTokens) body.max_tokens = Math.min(model.maxOutputTokens, 32000);

    log('POST', url, 'model=' + model.id, 'tools=' + (tools?.length ?? 0));

    // 跟上用户实际选的账号（不阻塞请求，失败也不影响对话）
    if (parsed) {
      trackAccount(parsed.accountId).catch(() => {});
    }

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
          // 代理给的是「能看懂的一句话」+ 原始失败体，两个都要
          const friendly = j?.error?.message;
          const detail = j?.error?.detail;
          if (friendly) {
            let extra = typeof detail === 'string' ? detail : '';
            // detail 可能是嵌套的 JSON 信封，取里面的 msg
            if (extra) {
              try {
                const nested = JSON.parse(extra);
                extra = nested?.msg || nested?.displayMsg || extra;
              } catch { /* 保持原样 */ }
            }
            msg = extra && !String(extra).includes(String(friendly))
              ? `${friendly}：${String(extra).slice(0, 300)}`
              : String(friendly);
          } else if (detail) {
            msg = String(detail);
          }
        } catch { /* 保持原样 */ }
        // 401/403 才和登录有关；其它状态码别让用户白重登一次
        const hint = res.status === 401 || res.status === 403
          ? '\n登录可能已失效：命令面板 → 「WorkBuddy: 登录账号」重新登录。'
          : '';
        throw new Error(`WorkBuddy 返回 HTTP ${res.status}: ${String(msg).slice(0, 500)}${hint}`);
      }

      const pendingToolCalls = new Map();
      let reasoningChars = 0;
      let contentChars = 0;
      // 上游在最后一个 chunk 里给 usage（请求已带 include_usage: true），
      // 记下来在收尾时上报给 Copilot Chat 用于绘制上下文占用。
      let usageReported = null;

      // ── 思考批处理 ──────────────────────────────────────────────
      // 上游把 reasoning_content 拆成 1~4 字符的碎片（实测一次回答 121 个 delta），
      // 逐条上报会让 Copilot Chat 渲染成一长串「Thought for 1s」。
      // 这里先攒够 THINK_FLUSH_CHARS 再上报，一轮连续思考共用一个 runId。
      //
      // 权衡：攒批会让思考显示略微滞后（80 字符 ≈ 20~40 个字）。调小 → 更实时但
      // part 更多；调大 → part 更少但更迟钝。80 是实测下来既连续又够及时的值。
      //
      // ⚠️ 必须过滤纯空白（2026-11-06 从 chatSessions/*.jsonl 取证）：
      //    WorkBuddy 大多数模型的 reasoning_content 只返回空格和换行，真正的
      //    思考（如果有）混在 content 里。不过滤的话每个工具调用前都会多出一个
      //    「内容只有一个空格」的思考块，界面上全是噪音。
      const THINK_FLUSH_CHARS = 80;
      let reasoningRunId;
      let reasoningBuf = '';

      const flushThinking = () => {
        // 整段都是空白就丢弃（上游常有这种），否则原样上报 ——
        // 不能逐块 trim，否则英文单词会被粘在一起（"the " + "cat" → "thecat"）。
        if (!reasoningBuf.trim()) {
          reasoningBuf = '';
          return;
        }
        reasoningRunId ??= crypto.randomUUID();
        reportThinking(progress, reasoningBuf, reasoningRunId);
        reasoningBuf = '';
      };
      // 思考结束：先把尾巴发完，再清掉 runId，下一段思考才会另起一块
      const endThinkingRun = () => {
        flushThinking();
        reasoningRunId = undefined;
      };

      for await (const chunk of readSSE(res.body)) {
        if (token.isCancellationRequested) break;

        // usage 出现在最后一个 chunk（此时 choices 里通常只有一个空 delta）
        if (chunk.usage) usageReported = chunk.usage;

        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta || {};

          // 思考内容：攒批上报，runId 在一轮内保持不变
          if (delta.reasoning_content) {
            reasoningChars += delta.reasoning_content.length;
            reasoningBuf += delta.reasoning_content;
            if (reasoningBuf.length >= THINK_FLUSH_CHARS) flushThinking();
          }

          if (delta.content) {
            endThinkingRun();
            contentChars += delta.content.length;
            progress.report(new vscode.LanguageModelTextPart(delta.content));
          }

          // ⚠️ 必须判 length：上游每个 chunk 都带 `tool_calls: []`，
          //    只判 isArray 会在每个 delta 触发 endThinkingRun()，
          //    把思考流切成 1~10 字符的碎片（2026-11-05 取证日志确认）。
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
            endThinkingRun();
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
            endThinkingRun();
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

      endThinkingRun();

      // 收尾上报上下文用量（必须在所有 part 之后，Copilot 按顺序消费）
      reportUsage(progress, usageReported);

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
    // 不要写死 .bat —— Linux / macOS 上没有这个文件
    output.appendLine('  排查：确认 node 可用（设置 connect-workbuddy.nodePath），或查看 README 的故障排查。');
    proxyState.url = DEFAULT_PROXY_URL;
    proxyState.child = null;
  }

  const provider = new WorkBuddyProvider(context);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
  );

  // ── 状态栏：当前账号剩余积分 ──────────────────────────────────────
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);
  setStatusBar('idle', '$(credit-card) WorkBuddy …', '正在读取 WorkBuddy 积分…');

  // 手动刷新命令
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.refresh', async () => {
      cachedModels = null;
      provider._onDidChange.fire();
      try {
        const list = await fetchModels(true);
        vscode.window.showInformationMessage(`WorkBuddy：已刷新 ${list.length} 个模型`);
        // 顺手把积分也刷一下（用户主动刷新的语义）
        await refreshCreditsStatus();
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：刷新失败 — ' + (e?.message || e));
      }
    })
  );

  // ── 每日签到 ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.checkin', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'WorkBuddy 签到中…' },
          () => performCheckin({ silent: false })
        );
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：签到失败 — ' + (e?.message || e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.showLogs', () => output.show())
  );

  // ── 查看积分明细 ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.showCredits', async () => {
      let c;
      try {
        c = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'WorkBuddy 读取积分…' },
          () => fetchCredits()
        );
      } catch (e) {
        const pick = await vscode.window.showErrorMessage(
          'WorkBuddy：读取积分失败 — ' + (e?.message || e),
          '显示日志'
        );
        if (pick === '显示日志') output.show();
        return;
      }

      // 有其它账号时给个按钮，直接切过去看
      let accounts = [];
      try {
        accounts = (await fetchAccountsWithCredits()).accounts || [];
      } catch { /* 拿不到就只显示当前账号 */ }
      const others = accounts.filter((a) => a.id !== c.accountId);

      // 签到状态是加分项：拿不到就只展示积分
      let checkin = null;
      try {
        const st = await fetchCheckinStatus();
        checkin = (st.accounts || []).find((a) => a.id === c.accountId) || null;
      } catch { /* ignore */ }

      const action = await showCreditsModal(c, others.length > 0, checkin);

      if (action === '刷新') {
        await refreshCreditsStatus();
        vscode.commands.executeCommand('connect-workbuddy.showCredits');
        return;
      }
      if (action === '查看其它账号' && others.length) {
        const sel = await vscode.window.showQuickPick(
          others.map((a) => ({
            label: '$(account) ' + a.name,
            description: `${formatCredits(a.credits) ?? '—'} 积分`,
            id: a.id,
          })),
          { placeHolder: '选择要查看积分的账号' }
        );
        if (!sel) return;
        try {
          const other = await fetchCredits(sel.id);
          await showCreditsModal(other, false, null);
        } catch (e) {
          vscode.window.showErrorMessage('WorkBuddy：读取积分失败 — ' + (e?.message || e));
        }
      }
    })
  );

  // ── 每个账号一个模型分组 ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.syncGroups', async () => {
      let accounts = [];
      try {
        accounts = (await fetchAccounts()).accounts || [];
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：读取账号失败 — ' + (e?.message || e));
        return;
      }
      if (!accounts.length) {
        vscode.window.showWarningMessage('WorkBuddy：还没有账号，先登录再分组。');
        return;
      }

      let result;
      try {
        result = syncAccountGroups(context, accounts);
      } catch (e) {
        const pick = await vscode.window.showErrorMessage(
          'WorkBuddy：写分组配置失败 — ' + (e?.message || e),
          '显示日志'
        );
        if (pick === '显示日志') output.show();
        return;
      }

      output.appendLine(
        `分组已同步：+${result.added.length} -${result.removed.length}（共 ${accounts.length} 组）`
      );
      for (const n of result.added) output.appendLine('  + ' + n);
      for (const n of result.removed) output.appendLine('  - ' + n);

      // provider 缓存要清掉，否则新组的模型列表还是旧的
      cachedModels = null;
      provider._onDidChange.fire();

      const msg =
        `已为 ${accounts.length} 个账号准备好模型分组` +
        (result.added.length ? `（新增 ${result.added.length} 组）` : '') +
        (result.removed.length ? `（移除 ${result.removed.length} 组）` : '');

      const pick = await vscode.window.showInformationMessage(
        msg,
        '重载窗口生效',
        '打开配置文件'
      );
      if (pick === '重载窗口生效') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      } else if (pick === '打开配置文件') {
        vscode.window.showTextDocument(vscode.Uri.file(result.file));
      }
    })
  );

  // ── 登录（OAuth，不需要 WorkBuddy 桌面客户端）─────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.login', async () => {
      // ① 选区域
      const regionPick = await vscode.window.showQuickPick(
        [
          { label: '国内版（CodeBuddy 账号）', description: 'www.codebuddy.cn', region: 'cn', recommended: true },
          { label: '国际版（WorkBuddy 账号）', description: 'www.workbuddy.ai', region: 'global' },
        ],
        { placeHolder: '选择要登录的区域' }
      );
      if (!regionPick) return;
      const region = regionPick.region;

      // 记下登录前已有账号：登录完如果还是其中某个，说明浏览器用的是旧会话，
      // 用户以为换了账号其实没换。
      let beforeIds = new Set();
      try {
        beforeIds = new Set(((await fetchAccounts()).accounts || []).map((a) => a.id));
      } catch { /* 拿不到就不做这个判断 */ }

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
        const wasExisting = beforeIds.has(account.account.id);
        output.appendLine(
          `登录成功 → ${account.account.name}（${account.account.id}）` +
          (wasExisting ? '  ← 这个账号之前已经登录过' : '')
        );
        if (wasExisting) {
          // 浏览器里还留着上一个账号的登录状态时，点授权页会自动沿用旧账号
          const pick = await vscode.window.showWarningMessage(
            `WorkBuddy：这个账号「${account.account.name}」之前已经登录过了，账号数没有增加。`,
            {
              modal: true,
              detail:
                '要添加另一个账号，请先在浏览器里退出 WorkBuddy / CodeBuddy 登录，' +
                '或者用无痕窗口打开授权页，然后再执行一次「WorkBuddy: 登录账号」。',
            },
            '重新登录'
          );
          if (pick === '重新登录') {
            vscode.commands.executeCommand('connect-workbuddy.login');
            return;
          }
        } else {
          vscode.window.showInformationMessage(
            `WorkBuddy：已登录「${account.account.name}」，模型列表已刷新`
          );
        }
        await refreshCreditsStatus();
        // 新账号 → 顺手把模型分组补齐（失败不打扰用户，日志里有）
        await autoSyncGroups(context, { silent: true });
      }
    })
  );

  // 切换当前账号（只影响「不带 @accountId| 前缀」的模型，比如外部客户端用的裸模型名）
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.switchAccount', async () => {
      let info;
      try {
        // credits=1：顺手把每个账号的剩余积分也带回来，方便直接对比
        info = await fetchAccountsWithCredits();
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

      const items = info.accounts.map((a) => {
        const credit = formatCredits(a.credits);
        return {
          label: (a.isCurrent ? '$(check) ' : '$(account) ') + a.name,
          description: [
            credit === null ? '积分 —' : `${credit} 积分`,
            a.source,
            a.desktopSelected ? '桌面端选中' : '',
            a.isLastUsed ? '最近使用' : '',
          ]
            .filter(Boolean)
            .join(' · '),
          detail: `token 到期 ${a.tokenExpiresAt || '未知'}`,
          id: a.id,
          isCurrent: a.isCurrent === true,
        };
      });

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
        // 账号变了：状态栏跟踪的账号一起切过去，并绕过缓存拿新数字
        await trackAccount(pick.id, { force: true });
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
      // 每个账号一个模型分组（写了新组才提示重载，平时静默）
      const groupResult = await autoSyncGroups(context, { silent: true });
      if (groupResult && groupResult.added.length) {
        const pick = await vscode.window.showInformationMessage(
          `WorkBuddy：已为 ${n} 个账号生成模型分组，重载窗口后生效`,
          '立即重载',
          '稍后'
        );
        if (pick === '立即重载') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        }
      }
      // 有账号才开始读积分（零账号时白读一次）
      await refreshCreditsStatus();
      // 自动签到默认关闭；开启后每天最多一次，不阻塞激活流程
      maybeAutoCheckin(context).catch((e) => output.appendLine('自动签到异常：' + (e?.message || e)));
      const startTimer = () => {
        if (creditsTimer) clearInterval(creditsTimer);
        creditsTimer = setInterval(() => refreshCreditsStatus({ quiet: true }), creditsRefreshMs());
      };
      startTimer();
      context.subscriptions.push({ dispose: () => { if (creditsTimer) clearInterval(creditsTimer); } });
      // 设置改了（间隔或开关）→ 重设定时器
      context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration(SECTION + '.creditsRefreshSeconds')) startTimer();
          if (e.affectsConfiguration(SECTION + '.showCreditsInStatusBar')) refreshCreditsStatus({ quiet: true });
        })
      );
    } else {
      output.appendLine('⚠ 无法读取账号列表（代理可能没起来）');
    }
  }, 6000);
}

function deactivate() {
  // 只杀自己拉起的那个；复用外部代理时 child 为 null，不动它
  if (proxyState.child) {
    const child = proxyState.child;
    proxyState.child = null;
    try {
      if (process.platform === 'win32' && child.pid) {
        // Windows 上 child.kill() 不保证结束整棵进程树，会留下僵尸代理
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore', timeout: 3000,
        });
      } else {
        child.kill();
      }
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
  }
  proxyState.url = '';
  proxyState.token = '';
}

module.exports = { activate, deactivate };
