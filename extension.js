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
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { spawn, execFileSync } = require('node:child_process');

const SECTION = 'connect-workbuddy';
const VENDOR = 'workbuddy';

const DEFAULT_PROXY_URL = 'http://127.0.0.1:8799/v1';

// ── 自动更新 ──────────────────────────────────────────────────────
// 这个扩展不上 Marketplace（会被下架，见 README），只发 GitHub Release。
// 所以没有商店的自动更新，只能自己做：查 Release → 下载 vsix → 装。
//
// 边界（做不到的事，别指望）：
//   · 不能静默安装 —— 调 installExtension 会走 VS Code 的安装流程
//   · 装完必须重载窗口才生效（扩展代码已在内存里，替换文件不影响运行中的实例）
//   · 只有「我自己拉起的仓库」可信；不接受任意 URL（见下 releaseRepo）
const RELEASE_REPO = 'a2689307431/vscode-connect-workbuddy';
const UPDATE_LAST_CHECK_KEY = 'updateLastCheck';
const UPDATE_SKIP_KEY = 'updateSkippedVersion';
// 每天最多查一次，避免打开窗口就发请求
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// activate() 里赋值的扩展上下文（checkForUpdates 需要读写 globalState）
let extensionContext = null;
// 最近一次查更新失败的原因（用于给用户更准的提示，而不是一句「网络问题」）
let lastUpdateError = '';
// 已知的新版本号；非空时状态栏会加个提示
let pendingUpdateVersion = null;

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

// 代理和上游模块都用到了这两个特性，低于这个版本会在 import 阶段就崩：
//   · 内置 fetch            → Node 18.0
//   · AbortSignal.timeout() → Node 17.3
// Ubuntu 22.04 自带的 node 是 12、Debian 11 是 12、macOS 上 nvm 可能装着很老的版本，
// 所以**必须逐版本校验**，不能「找到 node 就用」。
const MIN_NODE_MAJOR = 18;

/** 取一个 node 可执行文件的主版本号；拿不到就返回 0。 */
function nodeMajorVersion(cmd, env) {
  try {
    const out = execFileSync(cmd, ['-v'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      env: env ? { ...process.env, ...env } : process.env,
    });
    const m = /v(\d+)\./.exec(String(out));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function resolveNodeBinary() {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const custom = String(cfg.get('nodePath') || '').trim();
  const tried = [];

  // ① 用户显式指定的路径 —— 版本不够也照用，但要在日志里讲清楚
  if (custom && fs.existsSync(custom)) {
    const major = nodeMajorVersion(custom);
    if (major && major < MIN_NODE_MAJOR) {
      log(`⚠ 设置的 nodePath（${custom}）是 v${major}，低于要求的 v${MIN_NODE_MAJOR}，可能启动失败`);
      output?.appendLine(
        `⚠ connect-workbuddy.nodePath 指向 Node v${major}，本扩展需要 v${MIN_NODE_MAJOR}+。` +
        `请升级 Node，或清空该设置改用 VS Code 自带的 Electron。`
      );
    }
    return { cmd: custom, args: [], env: {} };
  }

  // ② 常见安装位置（Windows）
  const probe = [
    'C:/Program Files/nodejs/node.exe',
    'C:/Program Files (x86)/nodejs/node.exe',
  ];
  for (const p of probe) {
    if (!fs.existsSync(p)) continue;
    tried.push(p + ' → v' + (nodeMajorVersion(p) || '?'));
    if (nodeMajorVersion(p) >= MIN_NODE_MAJOR) return { cmd: p, args: [], env: {} };
  }

  // ③ 从 PATH 里找（Linux / macOS 主要靠这条）
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['node'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const cands = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const first of cands) {
      if (!fs.existsSync(first)) continue;
      const major = nodeMajorVersion(first);
      tried.push(first + ' → v' + (major || '?'));
      if (major >= MIN_NODE_MAJOR) return { cmd: first, args: [], env: {} };
    }
  } catch { /* PATH 里没有 node，正常 */ }

  // ④ 兜底：VS Code 自带的 Electron 以 node 模式运行。
  //    它的 Node 版本跟着 VS Code 走，1.116 已经是很新的 Node，够用。
  if (tried.length) {
    log(`系统中找到的 node 版本都低于 v${MIN_NODE_MAJOR}：${tried.join('、')}，改用 VS Code 内置运行时`);
    output?.appendLine(
      `提示：系统中的 Node 版本偏低（${tried.join('、')}），已改用 VS Code 内置的运行时。`
    );
  }
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

  // ⚠️ stdin 必须是 'pipe' 而不是 'ignore'：
  //    代理在 Windows 上靠 stdin EOF 判断「父进程已退出」，'ignore' 时拿不到这个信号，
  //    代理会在 VS Code 崩溃后变成孤儿进程。POSIX 上另用 ppid 轮询，两种方式都留着。
  const child = spawn(node.cmd, [...node.args, script, '--port', '0'], {
    env: {
      ...process.env,
      WB_PROXY_TOKEN: token,
      WB_VAULT_DIR: vaultDir,
      WB_DSH_HOME: dshHome,
      WB_LEGACY_DSH_HOME: realDshHome,
      ...node.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // 不往 stdin 写任何东西，只是保持管道打开
  try { child.stdin?.on('error', () => { /* EPIPE，进程已退出，忽略 */ }); } catch { /* ignore */ }
  proxyState.child = child;
  proxyState.token = token;

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('代理启动超时（15 秒）')), 15_000);
    let buf = '';
    // 记下 stderr 尾部：代理崩了（比如 node 版本太低）时要把原因带给用户，
    // 只报 "code=1" 完全没法排查。
    const errTail = [];
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
        if (!line.trim()) continue;
        output.appendLine('[proxy:err] ' + line.trimEnd());
        errTail.push(line.trim());
        if (errTail.length > 8) errTail.shift();
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('无法启动代理进程：' + (e?.message || e)));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const detail = errTail.length ? '\n' + errTail.join('\n') : '';
      reject(new Error('代理进程提前退出，code=' + code + detail));
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

// ⚠️ 代理的账号池按区域分开（vault/cn、vault/global），`/accounts` 等接口的
// region 参数默认是 cn。早先这里所有调用都不传 region，结果**国际站账号
// 在钱包里完全不存在**。所以统一走 REGIONS 把两边并起来。
const REGIONS = ['cn', 'global'];
const REGION_LABEL = { cn: '国内站', global: '国际站' };

function normRegion(r) {
  return r === 'global' ? 'global' : 'cn';
}

async function fetchAccounts(region = 'cn') {
  const res = await fetch(baseUrl() + '/accounts?region=' + normRegion(region), {
    headers: { authorization: 'Bearer ' + getApiKey() },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET /accounts 返回 HTTP ${res.status}`);
  return res.json();
}

/** 查剩余积分。不传 accountId 时用代理侧该区域的「当前账号」。 */
async function fetchCredits(accountId, force = false, region = 'cn') {
  const q = new URLSearchParams();
  if (accountId) q.set('id', accountId);
  if (force) q.set('force', '1');
  q.set('region', normRegion(region));
  const res = await fetch(baseUrl() + '/credits?' + q.toString(), {
    headers: { authorization: 'Bearer ' + getApiKey() },
    signal: AbortSignal.timeout(20_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
  return { ...j, region: j?.region || normRegion(region) };
}

/** 账号列表 + 每个账号的剩余积分（代理侧并行查询）。 */
async function fetchAccountsWithCredits(region = 'cn') {
  const res = await fetch(baseUrl() + '/accounts?credits=1&region=' + normRegion(region), {
    headers: { authorization: 'Bearer ' + getApiKey() },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `GET /accounts 返回 HTTP ${res.status}`);
  return j;
}

/**
 * 账号池：把两个区域的账号并成一张表，每条带上自己的 `region`。
 * 单个区域失败不影响另一个；两边都拿不到才抛错。
 */
async function fetchPool({ withCredits = false } = {}) {
  const settled = await Promise.allSettled(
    REGIONS.map((r) => (withCredits ? fetchAccountsWithCredits(r) : fetchAccounts(r)))
  );
  const accounts = [];
  let firstError = null;
  settled.forEach((res, i) => {
    if (res.status === 'rejected') {
      if (!firstError) firstError = res.reason;
      return;
    }
    for (const a of res.value.accounts || []) accounts.push({ ...a, region: REGIONS[i] });
  });
  if (!accounts.length && firstError) throw firstError;
  return accounts;
}

// ── 每日签到 ──────────────────────────────────────────────────────
// 逻辑放在代理里（和聊天共用同一份 token），这里只负责调用和展示。
async function fetchCheckinStatus(region = 'cn') {
  const res = await fetch(baseUrl() + '/checkin/status?region=' + normRegion(region), {
    headers: { authorization: 'Bearer ' + getApiKey() },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `GET /checkin/status 返回 HTTP ${res.status}`);
  return j;
}

/** 两个区域的签到状态并成 Map(id → 状态)；拿不到就是空 Map。 */
async function fetchCheckinMap() {
  const map = new Map();
  const settled = await Promise.allSettled(REGIONS.map((r) => fetchCheckinStatus(r)));
  for (const res of settled) {
    if (res.status !== 'fulfilled') continue;
    for (const a of res.value.accounts || []) map.set(a.id, a);
  }
  return map;
}

async function postCheckin(ids, region = 'cn') {
  const payload = Array.isArray(ids) && ids.length ? { ids } : {};
  if (region === 'global') payload.__region = 'global';
  const res = await fetch(baseUrl() + '/checkin', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getApiKey() },
    body: JSON.stringify(payload),
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
async function performCheckin({ silent = false, ids = null, region = null } = {}) {
  if (checkinRunning) {
    if (!silent) vscode.window.showInformationMessage('WorkBuddy：正在签到中，请稍候');
    return null;
  }
  checkinRunning = true;
  try {
    return await doCheckin({ silent, ids, region });
  } finally {
    checkinRunning = false;
  }
}

async function doCheckin({ silent = false, ids = null, region = null } = {}) {
  // 不指定区域就两个区域都跑一遍（国际站账号以前根本签不到）
  const targets = region ? [normRegion(region)] : REGIONS;
  const settled = await Promise.allSettled(
    targets.map((r) => postCheckin(ids, r).then((j) => ({ region: r, j })))
  );

  const results = [];
  const errors = [];
  for (const s of settled) {
    if (s.status === 'rejected') { errors.push(s.reason); continue; }
    for (const x of Array.isArray(s.value.j.results) ? s.value.j.results : []) {
      results.push({ ...x, region: s.value.region });
    }
  }
  // 一个区域都没签成 → 把错误抛给上层
  if (!results.length && errors.length === targets.length) throw errors[0];

  const claimed = results.filter((r) => r.result === 'CLAIMED');
  const already = results.filter((r) => r.result === 'ALREADY');
  const failed = results.filter((r) => r.result !== 'CLAIMED' && r.result !== 'ALREADY');

  output.appendLine(
    `签到：成功 ${claimed.length}，已签 ${already.length}` + (failed.length ? `，失败 ${failed.length}` : '')
  );
  for (const r of results) {
    output.appendLine(`  ${r.name || r.id}: ${r.result}${r.credit ? ' +' + r.credit : ''} ${r.message || ''}`);
  }

  if (claimed.length) {
    await refreshCreditsStatus({ quiet: true, force: true });
    await refreshPoolSnapshot({ force: true });
  }

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
//   · 模型 id 形如 `@<accountId>|<model>`（代理 /v1/models?perAccount=1 生成）
//   · 换模型的下拉选择没有 API 事件，所以用 provideTokenCount 当探针
//     （见 provideTokenCount 注释），发请求时再确认一次
//   · 还没选过 / 没发过请求时，退回代理侧的「当前账号」
// 上游按账号串行查询，所以别太勤：定时刷新 5 分钟一次，
// 切账号 / 换模型 / 登录成功 / 手动刷新时立刻更新。
let statusBar = null;
let creditsTimer = null;
let creditsInFlight = null;
let creditsInFlightKey; // 上面那个请求是给 `区域:账号` 发的

// 状态栏正在跟踪的账号。null = 用代理侧该区域的「当前账号」
let trackedAccountId = null;
let trackedRegion = 'cn';

// 账号池快照：状态栏 tooltip 和钱包都用它，省得每次点开都重新问上游
let poolSnapshot = { at: 0, accounts: [], total: null, partial: false, error: null };
const POOL_TTL_MS = 60_000;

/** 解析 `@<accountId>|<modelId>`；不是这个格式返回 null（裸模型名）。 */
const ACCOUNT_MODEL_RE = /^@([0-9A-Za-z_-]{6,64})\|(.+)$/;
function parseAccountModelId(id) {
  const m = ACCOUNT_MODEL_RE.exec(String(id || ''));
  return m ? { accountId: m[1], model: m[2] } : null;
}

/** 账号所在区域（从账号池快照里查；查不到就用当前跟踪的区域）。 */
function regionOfAccount(accountId) {
  const hit = poolSnapshot.accounts.find((a) => a.id === accountId);
  return hit ? hit.region : trackedRegion;
}

/**
 * 拉一遍账号池并缓存。失败保留旧快照（宁可显示略旧的总数，也不要忽然空白）。
 * `partial` = 有账号的积分没读到，此时 total 是下限。
 */
async function refreshPoolSnapshot({ force = false } = {}) {
  if (!force && poolSnapshot.accounts.length && Date.now() - poolSnapshot.at < POOL_TTL_MS) {
    return poolSnapshot;
  }
  try {
    const accounts = await fetchPool({ withCredits: true });
    const known = accounts.filter((a) => typeof a.credits === 'number' && Number.isFinite(a.credits));
    poolSnapshot = {
      at: Date.now(),
      accounts,
      total: known.length ? known.reduce((s, a) => s + a.credits, 0) : null,
      partial: known.length !== accounts.length,
      error: null,
    };
    // 只有国际站账号时，默认区域得跟着走，否则 /credits 永远 404
    if (!trackedAccountId && trackedRegion === 'cn') {
      const cn = accounts.filter((a) => a.region === 'cn').length;
      const gl = accounts.filter((a) => a.region === 'global').length;
      if (!cn && gl) trackedRegion = 'global';
    }
    log(`账号池：${accounts.length} 个账号，合计 ${poolSnapshot.total ?? '?'}`);
  } catch (e) {
    poolSnapshot = { ...poolSnapshot, error: String(e?.message || e) };
    log('账号池读取失败：' + (e?.message || e));
  }
  return poolSnapshot;
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

/**
 * 有新版本时重绘状态栏。
 *
 * 幂等：先把上一次加的角标和提示剥掉，再重新加。
 * 否则每次积分刷新都会多叠一条分隔线。
 *
 * ⚠️ tooltip 可能是 MarkdownString，也可能是**纯字符串**
 *    （setStatusBar('error', …, '读不到积分：' + msg) 就是字符串）。
 *    早期只处理了 MarkdownString，结果「有新版本 + 积分读取失败」同时出现时，
 *    错误信息会被整条吞掉。
 */
const UPDATE_TIP_MARK = '$(arrow-up) **有新版本';

/** 把 tooltip 统一读成文本（MarkdownString 或 string 都行）。 */
function tooltipText(tip) {
  if (typeof tip === 'string') return tip;
  if (tip && typeof tip.value === 'string') return tip.value;
  return '';
}

function renderStatusBarForUpdate() {
  if (!statusBar) return;
  // ① 剥掉上一次的角标
  statusBar.text = String(statusBar.text || '').replace(/\s*\$\(arrow-up\)$/, '');
  // ② 剥掉上一次的提示（含前面的分隔线），保留原有内容
  let base = tooltipText(statusBar.tooltip);
  const at = base.indexOf(UPDATE_TIP_MARK);
  if (at >= 0) {
    const cut = base.lastIndexOf('---', at);
    base = (cut >= 0 ? base.slice(0, cut) : base.slice(0, at)).trimEnd();
  }
  if (!pendingUpdateVersion) {
    statusBar.tooltip = base ? new vscode.MarkdownString(base) : '';
    statusBar.show();
    return;
  }
  // ③ 重新加
  statusBar.text = `${statusBar.text} $(arrow-up)`;
  const tip = new vscode.MarkdownString(base);
  tip.appendMarkdown(`\n\n---\n\n${UPDATE_TIP_MARK} ${pendingUpdateVersion}** · 点钱包 → 检查更新`);
  statusBar.tooltip = tip;
  statusBar.show();
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
  // 有新版本时统一由它加角标 + tooltip 提示（幂等，不会叠加）
  if (pendingUpdateVersion) renderStatusBarForUpdate();
  switch (state) {
    case 'ok': statusBar.backgroundColor = undefined; break;
    case 'warn': statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground'); break;
    case 'error': statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground'); break;
    default: statusBar.backgroundColor = undefined;
  }
}

/** 状态栏 tooltip 里的账号池概览。只读快照，不额外打上游。 */
function appendPoolTooltip(tip) {
  const { accounts, total, partial } = poolSnapshot;
  if (!accounts.length) return;
  const head = total === null
    ? '合计 —'
    : `合计 **${formatCredits(total)}**${partial ? '+' : ''}`;
  tip.appendMarkdown(`---\n\n**账号池** ${accounts.length} 个账号 · ${head}\n\n`);
  for (const a of accounts) {
    const n = formatCredits(a.credits);
    const mark = a.id === trackedAccountId ? ' ←' : '';
    tip.appendMarkdown(`· ${a.name || a.id}：${n === null ? '—' : n}${mark}\n\n`);
  }
}

/** 刷新状态栏上的积分。失败也不弹窗，只把状态栏变红。 */
function refreshCreditsStatus({ quiet = false, force = false } = {}) {
  const wantAccount = trackedAccountId || null;
  const wantRegion = normRegion(trackedRegion);
  const key = `${wantRegion}:${wantAccount || ''}`;
  // 同一个 `区域:账号` 正在查就直接复用；换了账号必须重新发起
  if (creditsInFlight && creditsInFlightKey === key) {
    return creditsInFlight;
  }
  creditsInFlightKey = key;
  const task = (async () => {
    try {
      // 跟随正在使用的账号；没跟踪就交给代理用该区域的「当前账号」
      const c = await fetchCredits(wantAccount || undefined, force, wantRegion);
      // 请求期间用户又切了账号 → 这次结果已过时，丢掉
      if (`${normRegion(trackedRegion)}:${trackedAccountId || ''}` !== key) return null;
      const num = formatCredits(c.total);
      if (num === null) {
        setStatusBar('error', '$(warning) WorkBuddy 积分 ?', '没读到余额（点这里看详情）');
        return null;
      }
      // 服务端认出的账号名以它为准（切账号后名字也会更新）
      if (c.accountId) {
        trackedAccountId = c.accountId;
      }
      const low = c.total <= 0;
      const soon = typeof c.expiringSoon === 'number' && c.expiringSoon > 0;
      const label = c.accountName || c.accountId || '当前账号';
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown(`**WorkBuddy 剩余积分**：${num}\n\n`);
      tip.appendMarkdown(`账号：\`${label}\` · ${REGION_LABEL[normRegion(c.region)] || '国内站'}\n\n`);
      if (c.nearestExpiry) {
        tip.appendMarkdown(`最近到期：${new Date(c.nearestExpiry).toLocaleString()}\n\n`);
      }
      if (soon) tip.appendMarkdown(`⚠️ 其中 ${formatCredits(c.expiringSoon)} 将在 30 天内过期\n\n`);
      appendPoolTooltip(tip);
      tip.appendMarkdown('---\n\n_点击打开钱包（账号池总览 → 单个账号明细）_');
      // 带账号名，否则两个账号余额相近时根本分不清现在显示的是谁
      const shortName = shortenAccountName(label);
      const text = shortName
        ? `$(credit-card) ${num} · ${shortName}`
        : `$(credit-card) ${num}`;
      setStatusBar(low ? 'warn' : 'ok', text, tip);
      if (!quiet) log(`积分刷新：${num}（${label}）`);
      // tooltip 里的账号池过期了就在后台补一次（不阻塞状态栏更新）
      if (!poolSnapshot.accounts.length || Date.now() - poolSnapshot.at >= POOL_TTL_MS) {
        refreshPoolSnapshot().catch(() => {});
      }
      return c;
    } catch (e) {
      const msg = String(e?.message || e);
      // 账号属于另一个区域（快照滞后）→ 自动纠正后重试一次，避免误报错
      if (wantAccount && /not found|不存在/i.test(msg)) {
        const other = poolSnapshot.accounts.find((a) => a.id === wantAccount);
        if (other && normRegion(other.region) !== wantRegion) {
          trackedRegion = normRegion(other.region);
          if (creditsInFlightKey === key) { creditsInFlight = null; creditsInFlightKey = undefined; }
          return refreshCreditsStatus({ quiet, force });
        }
      }
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
      if (creditsInFlightKey === key) {
        creditsInFlight = null;
        creditsInFlightKey = undefined;
      }
    }
  })();
  creditsInFlight = task;
  return task;
}

/**
 * 状态栏切到某个账号。三处调用：
 *   · provideTokenCount —— 模型下拉框换了模型（探针，传 force:false 走缓存）
 *   · provideLanguageModelChatResponse —— 真正发请求时（确认一次）
 *   · 钱包/切换账号命令 —— 用户显式操作（force:true）
 *
 * `force` 三态：不传 = 换账号才强制刷缓存；true = 一定强制；false = 一定不强制。
 */
function trackAccount(accountId, { force, region = null } = {}) {
  const nextRegion = region ? normRegion(region) : (accountId ? regionOfAccount(accountId) : trackedRegion);
  const changed = (accountId || null) !== trackedAccountId || nextRegion !== trackedRegion;
  if (!changed && force !== true) return Promise.resolve(null);
  trackedAccountId = accountId || null;
  trackedRegion = nextRegion;
  const doForce = force === undefined ? changed : force === true;
  return refreshCreditsStatus({ force: doForce });
}

// ── 感知「用户在模型下拉框里选了哪个模型」───────────────────────────
// 这是本项目最难的一个点，前两次尝试都失败了，记录清楚：
//
//   ① provideLanguageModelChatResponse —— 只有真正发请求时才触发，
//      用户切完模型不发消息就看不到变化（最早的行为，用户投诉的就是这个）。
//   ② provideTokenCount —— 看起来是唯一能在「切模型时」被调到的回调，
//      但实测两个问题：一是它收到的第一个参数是**模型 id 字符串**而不是
//      模型对象（workbench 里 `computeTokenLength(o,e,t)` 直接把 id 传下来），
//      写 `model?.id` 永远 undefined；二是更根本的，模型下拉框的
//      `_applyModelSelection` 只做 `{...ctx, selectedModelId}` + `onSelect`，
//      **完全不触发 token 重算**，所以它根本不会被调用。
//
//   ③ 最终方案：Copilot Chat 每次切换模型都会把选择写进全局 SQLite 的
//      `chat.currentLanguageModel.panel`，值形如
//        workbuddy/WorkBuddy · <账号名>/@<accountId>|<modelId>
//      我们监听那个文件（fs.watch + 轮询兜底），读到 accountId 就切状态栏。
//      实测 4 次连续切换全部在 0~1 秒内跟上，账号名/id 都正确。
//
// 为什么用 node:sqlite 而不是自己扫字节：SQLite 会复用页面，
// 旧值会残留在文件里，纯字节正则极容易读到过期数据（踩过，读到了上一轮的账号）。
// 扩展宿主的 Node 是 v24（ELECTRON_RUN_AS_NODE），node:sqlite 可稳定使用；
// 老版本 VS Code 没有它时自动降级为「只在发请求时更新」，不报错。

// 两个互不相干的聊天入口各存各的，都要监听（见 readSelectedModels 注释）。
// 顺序有意义：同时变化时后者覆盖前者，内联聊天排后面（用户刚在编辑器里按 Ctrl+I 时优先它）。
const SELECTED_MODEL_KEYS = [
  'chat.currentLanguageModel.panel',
  'chat.currentLanguageModel.editor',
];
const SELECTED_MODEL_POLL_MS = 1000;

let selectedModelWatcher = null;
let selectedModelTimer = null;
let selectedModelSig = '';
let selectedModelStamp = ''; // `mtimeMs:size`，没变就不必开库（省掉每秒拷 600KB）
let sqliteState = null; // null = 未探测，false = 不可用，否则是 module
// 上一个状态：`key → "accountId|model|label"`。两份值都留着，
// 这样能判断出「哪个 key 刚变过」，而不是盲猜。
let selectedModelPrev = new Map();

/**
 * 全局 state.vscdb 的位置。
 * globalStorageUri = <userDataDir>/globalStorage/<extId>，所以往上退两级就是 userDataDir。
 */
function globalStateDbPath(context) {
  const candidates = [];
  try {
    const gs = context.globalStorageUri?.fsPath;
    if (gs) candidates.push(path.join(path.dirname(path.dirname(gs)), 'globalStorage', 'state.vscdb'));
  } catch { /* 继续 */ }
  try {
    const cml = modelsConfigPath(context); // <userDataDir>/User/chatLanguageModels.json
    if (cml) candidates.push(path.join(path.dirname(path.dirname(cml)), 'globalStorage', 'state.vscdb'));
  } catch { /* 继续 */ }
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 继续 */ }
  }
  return candidates[0] || '';
}

function loadSqlite() {
  if (sqliteState !== null) return sqliteState;
  try {
    sqliteState = require('node:sqlite');
  } catch (e) {
    sqliteState = false;
    log('node:sqlite 不可用（选中的模型无法实时跟随）：' + (e?.message || e));
  }
  return sqliteState;
}

/**
 * 读「当前选中的模型」，返回 { accountId, model, label } 或 null。
 * 每次读一份拷贝再打开 —— 直接打开正在被 VS Code 写的库会拿到 SQLITE_BUSY。
 */
/**
 * 读所有「聊天入口」的当前选中模型，返回 `Map<key, {accountId, model, label}>`。
 *
 * VS Code 有两个互不相干的聊天入口，各记各的：
 *   chat.currentLanguageModel.panel    侧边栏聊天面板（Ctrl+Alt+I）
 *   chat.currentLanguageModel.editor   编辑器内联聊天（Ctrl+I）
 * 只监听 panel 的话，在内联聊天里切到 WorkBuddy 的模型，状态栏不会跟随。
 * 所以两个都读，谁变了就跟谁。
 *
 * 每次读一份拷贝再打开 —— 直接打开正在被 VS Code 写的库会拿到 SQLITE_BUSY。
 */
function readSelectedModels(context) {
  const out = new Map();
  const sqlite = loadSqlite();
  if (!sqlite) return out;
  const db = globalStateDbPath(context);
  if (!db) return out;

  const tmp = path.join(os.tmpdir(), `wb-selmodel-${process.pid}.vscdb`);
  try {
    fs.copyFileSync(db, tmp);
    const conn = new sqlite.DatabaseSync(tmp, { readOnly: true });
    try {
      for (const key of SELECTED_MODEL_KEYS) {
        let row;
        try {
          row = conn.prepare(`SELECT value FROM ItemTable WHERE key = ?`).get(key);
        } catch { continue; }
        if (!row?.value) continue;
        const raw = String(row.value).trim();
        // 形如 workbuddy/WorkBuddy · 账号名/@<accountId>|<modelId>
        const m = /@([0-9A-Za-z_-]{6,64})\|(.+)$/.exec(raw);
        if (!m) continue;
        const head = raw.slice(0, m.index);
        // 前缀必须是我们的 vendor，别的提供方（copilot/xxx 之类）直接跳过
        if (!/^workbuddy\//.test(head)) continue;
        const label = head.replace(/^[^/]*\/\s*WorkBuddy\s*·?\s*/, '').replace(/\/\s*$/, '').trim();
        out.set(key, { accountId: m[1], model: m[2].trim(), label });
      }
    } finally {
      conn.close();
    }
  } catch (e) {
    log('读选中的模型失败：' + (e?.message || e));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  return out;
}

/**
 * 检查一次；只对「刚变过的那个入口」做跟随。
 *
 * 为什么需要 `prev` 而不是简单取某个 key：两个入口各存各的值，用户可能
 * 面板里用 A 账号、内联里用 B 账号。只有**刚被改动**的那个才代表用户此刻的意图，
 * 否则轮询会拿另一个入口的旧值把状态栏反复改回去。
 */
function pollSelectedModel(context) {
  const db = globalStateDbPath(context);
  if (!db) return;

  // ⚠️ 先比 mtime+size，没变就直接返回。
  //    state.vscdb 有 600 KB，每秒拷一次再开库纯属浪费（笔记本上看得出来）。
  let stamp = '';
  try {
    const st = fs.statSync(db);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return;
  }
  if (stamp === selectedModelStamp) return;
  selectedModelStamp = stamp;

  const now = readSelectedModels(context);
  const sigOf = (v) => (v ? `${v.accountId}|${v.model}` : '');

  // 找出这次真正变化的入口（可能有多个 key 同时被写，取第一个有内容的）
  let changed = null;
  for (const key of SELECTED_MODEL_KEYS) {
    const prev = selectedModelPrev.get(key);
    const cur = now.get(key);
    if (sigOf(prev) !== sigOf(cur) && cur) changed = cur;
  }
  // 先把快照更新掉，避免下一轮重复判定
  selectedModelPrev = new Map();
  for (const key of SELECTED_MODEL_KEYS) selectedModelPrev.set(key, now.get(key));

  const sig = changed ? sigOf(changed) : '';
  if (sig === selectedModelSig) return;
  selectedModelSig = sig;
  if (!changed) return;

  // 已经是这个账号在跟踪了，不用重复请求
  if (changed.accountId === trackedAccountId) return;
  log(`下拉框切到账号 ${changed.accountId}（${changed.label || '?'}）`);
  trackAccount(changed.accountId, { force: false }).catch(() => {});
}

function startSelectedModelWatch(context) {
  const db = globalStateDbPath(context);
  if (!db) {
    log('找不到 state.vscdb，跳过错过的模型监听');
    return;
  }
  if (!loadSqlite()) return;

  const stop = () => {
    if (selectedModelWatcher) { try { selectedModelWatcher.close(); } catch { /* ignore */ } selectedModelWatcher = null; }
    if (selectedModelTimer) { clearInterval(selectedModelTimer); selectedModelTimer = null; }
  };

  stop();
  // fs.watch 反应快但可能漏事件（尤其是 SQLite 的 WAL 写入），
  // 所以配一个 1 秒的轮询兜底；轮询本身很便宜（读一次 key 就退出）。
  try {
    selectedModelWatcher = fs.watch(db, { persistent: false }, () => {
      clearTimeout(global.__wbSelDeb);
      global.__wbSelDeb = setTimeout(() => pollSelectedModel(context), 120);
    });
    selectedModelWatcher.on('error', (e) => {
      log('state.vscdb 监听出错，改为纯轮询：' + (e?.message || e));
      try { selectedModelWatcher.close(); } catch { /* ignore */ }
      selectedModelWatcher = null;
    });
  } catch (e) {
    log('无法监听 state.vscdb，改为纯轮询：' + (e?.message || e));
  }

  selectedModelTimer = setInterval(() => pollSelectedModel(context), SELECTED_MODEL_POLL_MS);
  if (typeof selectedModelTimer.unref === 'function') selectedModelTimer.unref();

  context.subscriptions.push({ dispose: stop });
  pollSelectedModel(context); // 先把启动时已有的选择读进来
  log('已开始监听模型下拉框的选择');
}

// ── 「分组是否已同步」的一次性信号 ────────────────────────────────
// 背景：VS Code 的 _resolveAllLanguageModels 先调一次「无组」的
// provideLanguageModelChatInformation，再按配置里的每个组各调一次。
// 我们靠 hasAccountGroups() 让无组调用返回空数组，从而不出现混合组。
//
// 但如果 provider 在**分组写进配置文件之前**就被调用（冷启动竞态），
// 那次无组调用会返回全部模型 → VS Code 渲染成混合组并写进
// chat.cachedLanguageModels.v2 缓存，之后要等下次重解析才恢复。
//
// 所以：首轮解析时，如果发现「还没有分组但账号数 > 0」，就等分组同步
// 完成（最多 GROUPS_READY_TIMEOUT_MS）再看一眼，而不是立刻吐全部模型。
let groupsReadyPromise = null;
let groupsReadyResolve = null;
let groupsReady = false;

function markGroupsReady() {
  groupsReady = true;
  if (groupsReadyResolve) {
    groupsReadyResolve();
    groupsReadyResolve = null;
  }
}

/** 等分组就绪（已就绪则立刻返回）。超时返回 false，调用方按兜底处理。 */
function waitGroupsReady(timeoutMs = 8000) {
  if (groupsReady) return Promise.resolve(true);
  if (!groupsReadyPromise) {
    groupsReadyPromise = new Promise((resolve) => { groupsReadyResolve = resolve; });
  }
  return Promise.race([
    groupsReadyPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
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
    // ⚠️ 写完必须让 hasAccountGroups 的缓存失效。
    //    写入和随后的读取可能落在同一毫秒，mtimeMs 相同 → 会拿到写之前的结论。
    invalidateGroupsProbe();
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
// 但 VS Code 一次解析会对每个组各调一次，所以加个短缓存。
//
// ⚠️ 缓存条件必须包含「真读过一次」，不能只比 mtime：
//    早期写法是 `{ file:'', mtimeMs:0, has:false }`，然后
//    `if (probe.file===file && probe.mtimeMs===mtimeMs) return probe.has;`
//    —— 如果 statSync 给出的 mtimeMs 正好是 0（虚拟文件系统、某些网络盘、
//    时钟异常时都会），首次调用就会命中这个「初始值」，返回 false，
//    并且**永远缓存 false**。表现就是：配置文件里明明有 4 个分组，
//    provider 却一直以为没有 → 无组调用返回全部模型 → 所有账号的模型
//    混成一个组（2026-11-22 用户报的现象）。
//    现在用 `at > 0` 保证「至少真读过一次」才允许命中缓存。
let groupsProbe = { file: '', mtimeMs: -1, has: false, at: 0 };

/** 让分组探测缓存失效（写完配置文件后必须调）。 */
function invalidateGroupsProbe() {
  groupsProbe = { file: '', mtimeMs: -1, has: false, at: 0 };
}

/** 配置文件里是否存在 vendor=workbuddy 且名字以 "WorkBuddy" 开头的条目。 */
function hasAccountGroups(context) {
  const file = modelsConfigPath(context);
  if (!file) return false;

  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return false; // 文件不存在 → 没有分组
  }

  // 只有「真读过一次」且文件没变过，才复用上次结论
  if (groupsProbe.at > 0 && groupsProbe.file === file && groupsProbe.mtimeMs === mtimeMs) {
    return groupsProbe.has;
  }

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
    accounts = await fetchPool();
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

// ── 钱包：账号池总览 → 单账号明细 ─────────────────────────────────
// 以前点状态栏是一个 modal：先看「当前账号」，再看别的账号得点「查看其它账号」
// 跳进另一个列表，来回退很别扭。现在改成两级 QuickPick：
//
//   总览  所有账号一行一个（区域 / 余额 / 签到 / 到期），外加刷新、签到、切号、登录
//   明细  单个账号的积分包和到期时间，外加针对这个账号的操作
//
// 两级之间可以来回跳，Esc 退出。所有数据都带区域，国内站和国际站的账号
// 都出现在同一张表里。

const SEP = vscode.QuickPickItemKind.Separator;

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN');
}

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN');
}

/** 积分包 → 每个包一行（QuickPickItem）。 */
function packageItems(packages) {
  return packages.map((p) => {
    const remain = formatCredits(p.remain);
    const size = formatCredits(p.size);
    const when = p.monthly
      ? (p.refreshAt ? `每月 ${fmtDay(p.refreshAt)} 重置` : '每月重置')
      : (p.expiresAt ? `${fmtDay(p.expiresAt)} 到期` : '');
    return {
      label: '$(package) ' + p.name,
      description: `${remain === null ? '?' : remain}${size ? ' / ' + size : ''}`,
      detail: when || undefined,
      got: 'info',
    };
  });
}

/** 明细 → 可粘贴的纯文本（「复制明细」用）。 */
function formatWalletDetail(account, detail, checkin) {
  const lines = [
    `WorkBuddy · ${account.name || account.id}（${REGION_LABEL[account.region] || account.region}）`,
    `剩余合计：${formatCredits(detail?.total ?? account.credits) ?? '—'} 积分`,
  ];
  if (checkin?.checkedIn) {
    lines.push(`签到：今日已签 · 连续 ${checkin.streakDays || 1} 天` +
      (checkin.todayCredit ? ` · 今日 +${checkin.todayCredit}` : ''));
  } else if (checkin) {
    lines.push('签到：今日未签');
  }
  if (detail?.nearestExpiry) lines.push(`最近到期：${fmtTime(detail.nearestExpiry)}`);
  const expiring = Number(detail?.expiringSoon) || 0;
  if (expiring > 0) lines.push(`注意：其中 ${formatCredits(expiring)} 将在 30 天内过期`);
  const pkgs = Array.isArray(detail?.packages) ? detail.packages : [];
  if (pkgs.length) {
    lines.push('', '积分包：');
    for (const p of packageItems(pkgs)) {
      lines.push(`  · ${p.label.replace(/^\$\([^)]+\)\s*/, '')}：${p.description}` +
        (p.detail ? `（${p.detail}）` : ''));
    }
  }
  if (account.tokenExpiresAt) lines.push('', `token 到期：${fmtTime(account.tokenExpiresAt)}`);
  return lines.join('\n');
}

/** 总览列表。 */
async function walletOverview(accounts, checkinMap) {
  const items = [];
  for (const a of accounts) {
    const credit = formatCredits(a.credits);
    const marks = [];
    if (a.id === trackedAccountId) marks.push('状态栏跟踪');
    else if (a.isCurrent) marks.push('代理当前账号');
    const ck = checkinMap.get(a.id);
    if (ck?.checkedIn) marks.push(`已签 ${ck.streakDays || 1} 天`);
    items.push({
      id: `acc|${a.region}|${a.id}`,
      acc: a,
      label: (a.id === trackedAccountId ? '$(check) ' : '$(account) ') + (a.name || a.id),
      description:
        (credit === null ? '积分 —' : `积分 ${credit}`) +
        (marks.length ? '  ·  ' + marks.join(' · ') : ''),
      detail: [
        REGION_LABEL[a.region] || a.region,
        a.domain,
        a.tokenExpiresAt ? `token 到期 ${fmtDay(a.tokenExpiresAt)}` : '',
        a.credits == null && a.creditError ? '积分读取失败' : '',
      ].filter(Boolean).join(' · '),
    });
  }

  items.push({ label: '操作', kind: SEP });
  items.push({ label: '$(refresh) 刷新全部余额', got: 'refresh' });
  items.push({ label: '$(check-all) 一键签到（全部账号）', got: 'checkin' });
  items.push({ label: '$(sync) 同步模型分组', got: 'groups' });
  items.push({ label: '$(add) 登录新账号', got: 'login' });
  items.push({
    label: '$(cloud-download) 检查更新' + (pendingUpdateVersion ? `（有新版本 ${pendingUpdateVersion}）` : ''),
    got: 'update',
  });
  items.push({ label: '$(output) 显示日志', got: 'logs' });

  const total = poolSnapshot.total;
  return vscode.window.showQuickPick(items, {
    title: `WorkBuddy 钱包 · ${accounts.length} 个账号` +
      (total === null ? '' : ` · 合计 ${formatCredits(total)}${poolSnapshot.partial ? '+' : ''} 积分`),
    placeHolder: '选一个账号看明细，或选下面的操作',
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
}

/**
 * 单个账号的明细页。返回 { action, detail }：
 * action: 'stay'（原地重绘）/ 'refresh' / 'checkin-one' / 'select' / 'copy' / 'back'
 */
async function walletAccountDetail(account, { force = true, checkin = null } = {}) {
  let detail = null;
  let err = null;
  try {
    detail = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `WorkBuddy 读取「${account.name}」…` },
      () => fetchCredits(account.id, force, account.region)
    );
  } catch (e) {
    err = e;
  }

  const credit = formatCredits(detail?.total ?? account.credits);
  const expiring = Number(detail?.expiringSoon) || 0;
  const items = [];

  items.push({ label: '$(arrow-left) 返回账号池', got: 'back' });

  items.push({ label: '概况', kind: SEP });
  items.push({
    label: '$(credit-card) 剩余合计',
    description: credit === null ? '—' : `${credit} 积分`,
    detail: [
      detail?.nearestExpiry ? `最近到期 ${fmtTime(detail.nearestExpiry)}` : '',
      expiring > 0 ? `⚠️ ${formatCredits(expiring)} 将在 30 天内过期` : '',
      REGION_LABEL[account.region] || account.region,
      account.domain,
    ].filter(Boolean).join(' · ') || undefined,
    got: 'info',
  });
  items.push({
    label: '$(sign-in) 签到',
    description: checkin === null || checkin === undefined
      ? '状态未知'
      : checkin.checkedIn
        ? `今日已签 · 连续 ${checkin.streakDays || 1} 天` + (checkin.todayCredit ? ` · +${checkin.todayCredit}` : '')
        : '今日未签',
    got: 'info',
  });

  items.push({ label: '积分包', kind: SEP });
  const pkgs = Array.isArray(detail?.packages) ? detail.packages : [];
  if (pkgs.length) {
    items.push(...packageItems(pkgs));
  } else {
    items.push({
      label: err
        ? '$(warning) 读取失败：' + String(err?.message || err)
        : '没有查到积分包（企业账号，或余额已用尽）',
      got: 'info',
    });
  }

  items.push({ label: '操作', kind: SEP });
  items.push({ label: '$(refresh) 刷新这个账号', got: 'refresh' });
  if (account.id !== trackedAccountId) {
    items.push({ label: '$(arrow-swap) 设为代理当前账号', got: 'select' });
  }
  items.push({ label: '$(check-all) 只签到这个账号', got: 'checkin-one' });
  items.push({ label: '$(copy) 复制明细', got: 'copy' });

  const pick = await vscode.window.showQuickPick(items, {
    title: `${account.name || account.id} · ${REGION_LABEL[account.region] || account.region}`,
    placeHolder: credit === null ? '积分 —' : `剩余 ${credit} 积分`,
    ignoreFocusOut: true,
  });
  if (!pick) return { action: 'back', detail };
  return { action: pick.got || 'stay', detail };
}

/**
 * 钱包主流程。
 * @returns {Promise<void>} 用户按 Esc 或选了会离开的动作就返回
 */
async function showWallet(context) {
  let accounts = [];
  let checkinMap = new Map();
  let needCheckin = true;

  for (;;) {
    const snap = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'WorkBuddy 读取账号池…' },
      () => refreshPoolSnapshot({ force: true })
    );
    accounts = snap.accounts;

    if (needCheckin && accounts.length) {
      checkinMap = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'WorkBuddy 读取签到状态…' },
        () => fetchCheckinMap()
      ).catch(() => new Map());
      needCheckin = false;
    }

    if (!accounts.length) {
      const pick = await vscode.window.showWarningMessage(
        'WorkBuddy：没读到账号' + (snap.error ? '（' + snap.error + '）' : ''),
        '登录账号',
        '显示日志'
      );
      if (pick === '登录账号') await vscode.commands.executeCommand('connect-workbuddy.login');
      else if (pick === '显示日志') output.show();
      return;
    }

    const pick = await walletOverview(accounts, checkinMap);
    if (!pick) return;

    // ── 选了某个账号 → 进入明细，直到用户返回 ──────────────────
    if (pick.acc) {
      const account = pick.acc;
      let force = true;
      let checkin = checkinMap.get(account.id) ?? null;
      let detail = null;
      for (;;) {
        const r = await walletAccountDetail(account, { force, checkin });
        force = false;
        const action = r.action;
        if (r.detail) detail = r.detail;
        if (action === 'back') break;
        if (action === 'stay' || action === 'info') continue;
        if (action === 'refresh') { force = true; continue; }
        if (action === 'copy') {
          await vscode.env.clipboard.writeText(formatWalletDetail(account, detail, checkin));
          vscode.window.setStatusBarMessage('WorkBuddy：明细已复制到剪贴板', 2500);
          continue;
        }
        if (action === 'select') {
          try {
            await selectAccount(account.id, account.region);
            account.isCurrent = true;
            await trackAccount(account.id, { force: true, region: account.region });
            vscode.window.setStatusBarMessage(`WorkBuddy：已切换到「${account.name}」`, 3000);
          } catch (e) {
            vscode.window.showErrorMessage('WorkBuddy：切换失败 — ' + (e?.message || e));
          }
          force = true;
          continue;
        }
        if (action === 'checkin-one') {
          try {
            const out = await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `WorkBuddy 签到「${account.name}」…` },
              () => performCheckin({ silent: true, ids: [account.id], region: account.region })
            );
            const one = out?.results?.[0];
            vscode.window.showInformationMessage(
              `WorkBuddy：${one?.name || account.name} ${one?.message || one?.result || '已签到'}`
            );
            needCheckin = true;
            // 重新读这个账号的签到状态（performCheckin 用的是 silent，不会带回来展示信息）
            checkin = await fetchCheckinStatus(account.region)
              .then((st) => (st.accounts || []).find((x) => x.id === account.id) || null)
              .catch(() => null);
          } catch (e) {
            vscode.window.showErrorMessage('WorkBuddy：签到失败 — ' + (e?.message || e));
          }
          force = true;
          continue;
        }
      }
      continue;
    }

    // ── 选了底部操作 ────────────────────────────────────────────
    switch (pick.got) {
      case 'refresh':
        break; // 下一轮会 force 重拉
      case 'checkin':
        await vscode.commands.executeCommand('connect-workbuddy.checkin');
        needCheckin = true;
        break;
      case 'groups':
        await vscode.commands.executeCommand('connect-workbuddy.syncGroups');
        return;
      case 'login':
        await vscode.commands.executeCommand('connect-workbuddy.login');
        needCheckin = true;
        break;
      case 'update':
        await vscode.commands.executeCommand('connect-workbuddy.checkUpdates');
        return;
      case 'logs':
        output.show();
        return;
      default:
        break;
    }
  }
}

async function selectAccount(id, region = 'cn') {
  const body = { id };
  if (region === 'global') body.region = 'global';
  const res = await fetch(baseUrl() + '/accounts/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getApiKey() },
    body: JSON.stringify(body),
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

/** 查账号数。-1 表示查不到（代理没起）。两个区域合起来算。 */
async function checkAccountCount(force = false) {
  if (!force && Date.now() - accountCountCache.at < ACCOUNT_COUNT_TTL) {
    return accountCountCache.value;
  }
  try {
    const n = (await fetchPool()).length;
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

function safeJson(v) {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * 估算一条消息里所有 part 的 token。
 *
 * ⚠️ 以前只统计 LanguageModelTextPart，工具调用 / 工具结果 / 图片**全算 0**，
 * 导致 agent 模式下上下文占用严重偏低（工具结果是真实上下文的大头）。
 * 这里按 part 类型分类统计 —— 做法参考 vizards.deepseek-v4-for-copilot
 * 的 provider/tokens.js，但只保留对我们有意义的几类。
 */
function estimateContentTokens(parts) {
  if (!Array.isArray(parts)) return 0;
  const DataPart = vscode.LanguageModelDataPart;
  const CallPart = vscode.LanguageModelToolCallPart;
  const ResultPart = vscode.LanguageModelToolResultPart;
  let total = 0;
  for (const part of parts) {
    if (!part) continue;
    if (part instanceof vscode.LanguageModelTextPart) {
      total += estimateTokens(part.value);
    } else if (typeof CallPart === 'function' && part instanceof CallPart) {
      // callId + 名字 + 参数 JSON 都是真实上下文
      total += estimateTokens(part.callId || '') + estimateTokens(part.name || '');
      total += estimateTokens(safeJson(part.input));
    } else if (typeof ResultPart === 'function' && part instanceof ResultPart) {
      total += estimateTokens(part.callId || '');
      // 工具结果本身是 part 数组，递归下去；不能被识别就退化成序列化长度
      const nested = estimateContentTokens(part.content);
      total += nested > 0 ? nested : estimateTokens(safeJson(part.content));
    } else if (typeof DataPart === 'function' && part instanceof DataPart) {
      const mime = String(part.mimeType || '');
      if (mime === USAGE_MIME) continue; // 我们自己上报的 usage，不算上下文
      // 图片：上游会把它压成一小段文字描述，给个保守常量而不是按字节数算
      if (mime.startsWith('image/')) { total += 768; continue; }
      total += Math.min(Math.floor((part.data?.byteLength || 0) / 4), 4000);
    } else {
      // 未知 part（含 ThinkingPart）：用序列化长度粗略兜底
      total += estimateTokens(safeJson(part));
    }
  }
  return total;
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

    // 诊断：把每次调用都记下来（排查「启动时混组」用，2026-11-22）
    const hasGroups = hasAccountGroups(this._context);

    // ── 无组调用：绝不能返回「全部账号混在一起」 ──────────────────
    // 两条路都会走到这里：
    //   · 正常情况：配置里已有分组 → 直接返回空，让 VS Code 走分组调用
    //   · 冷启动竞态：分组还没写进去 → 等一小会儿再看，避免把混合组
    //     喂给 VS Code 并被写进 chat.cachedLanguageModels.v2 缓存
    if (!wantAccount) {
      if (hasGroups) {
        log('[provider] 无组调用 → 返回空（已有分组）');
        return [];
      }
      // 还没分组：先确认到底有没有账号，没账号就直接空
      const cnt = await checkAccountCount().catch(() => 0);
      if (cnt > 0) {
        log(`[provider] 无组调用但分组未就绪（账号 ${cnt} 个）→ 等分组…`);
        await waitGroupsReady(8000);
        if (hasAccountGroups(this._context)) {
          log('[provider] 分组已就绪 → 返回空');
          return [];
        }
        log('[provider] 等分组超时，仍无分组 → 返回空，避免混合组');
      }
      // 没账号 或 等超时：一律返回空。
      // 返回全部模型会造成混合组 + 缓存污染，代价远大于「暂时没有模型」。
      return [];
    }

    log(
      `[provider] 分组调用 rawOptions=${JSON.stringify(options)} ` +
      `groupType=${typeof options?.group} account=${wantAccount}`
    );

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
    // ⚠️ `model` 在这里是**模型 id 字符串**，不是对象 ——
    //    workbench 的 computeTokenLength(o,e,t) 直接把 id 传下来。
    //    早先写 `model?.id` 导致这段逻辑从未生效（见上面的长注释）。
    //    主路径现在是监听 state.vscdb，这里只作为「对端调用时顺手对齐」。
    const idStr = typeof model === 'string' ? model : (model?.id ?? '');
    const parsed = parseAccountModelId(idStr);
    if (parsed && parsed.accountId !== trackedAccountId) {
      trackAccount(parsed.accountId, { force: false }).catch(() => {});
    }

    if (typeof text === 'string') return estimateTokens(text);
    let total = 0;
    try {
      total = estimateContentTokens(text?.content);
    } catch { /* ignore */ }
    return Math.max(1, total);
  }
}

// ── 自动更新（GitHub Release）─────────────────────────────────────
// 为什么必须自己做：VS Code 自带的「自动更新」勾选框对 vsix 装的扩展**无效**。
// 源码里 `get outdated()` 第一个条件就是 `if (!this.gallery || !this.local) return false;`
// —— 从 vsix 装的扩展没有 gallery 元数据，永远不算 outdated，自动更新器不看它。
// （2026-11-23 查 workbench.desktop.main.js 确认。）

/** 版本号比较：a > b 返回正数，a < b 返回负数，相等返回 0。忽略前缀 v。 */
function compareVersions(a, b) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 当前扩展版本。优先问 VS Code（权威），其次读随包的 package.json。 */
function currentVersion() {
  try {
    const fromHost = extensionContext?.extension?.packageJSON?.version;
    if (fromHost) return String(fromHost);
  } catch { /* 继续 */ }
  try {
    return String(require('./package.json').version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

// ── 更新用的网络层 ────────────────────────────────────────────────
// 底层的 http/https / SOCKS5 / CONNECT 隧道都在 update-net.js
// （不依赖 vscode，可以用 Node 直接跑测试）。这里只保留
// 「跟 VS Code 配置/日志打交道」的那层薄封装。
//
// ⚠️ 不能用内置 fetch：扩展宿主里的 fetch（undici）不经过 @vscode/proxy-agent
//    给 http/https 打的补丁，不读 http.proxy，也不读系统代理。
//    国内用户不开 TUN 时直连 api.github.com 必然超时（2026-11-23 实测）。

const { parseProxy, normalizeProxyUrl, systemProxy, httpGet, readStreamAll } = require('./update-net');

/** 读某个配置节里的 proxy 字段（string） */
function configProxyOf(section) {
  try {
    const v = vscode.workspace.getConfiguration(section).get('proxy');
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

/** 跟随 VS Code 的 http.proxyStrictSSL（公司自签证书代理需要关掉校验） */
function strictSSLSetting() {
  try {
    return vscode.workspace.getConfiguration('http').get('proxyStrictSSL') !== false;
  } catch {
    return true;
  }
}

let cachedDetectedProxy; // undefined = 还没探测过

/** 探测可用代理。返回 '' 表示直连。 */
function detectProxyUrl() {
  if (cachedDetectedProxy !== undefined) return cachedDetectedProxy;

  // http.proxy 若是 PAC 脚本地址，我们**不支持**，跳过它继续往下找系统代理。
  const fromVSCode = configProxyOf('http');
  const vsCodeUsable = fromVSCode && parseProxy(fromVSCode).type !== 'pac' ? normalizeProxyUrl(fromVSCode) : '';

  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    '';

  cachedDetectedProxy = vsCodeUsable || normalizeProxyUrl(fromEnv) || systemProxy();
  return cachedDetectedProxy;
}

/** 直连失败一次后记忆「本机需要代理」，后续请求直接走隧道 */
let preferProxy = false;

/** 清掉探测缓存（用户改了代理设置后手动重查用） */
function invalidateProxyCache() {
  cachedDetectedProxy = undefined;
  preferProxy = false;
}

/**
 * 带代理兜底的 GET。
 *
 * 顺序：
 *   1. 用户显式配了 `connect-workbuddy.proxy` → 直接走隧道（用户说了算）
 *   2. 没有显式配置 → **先直连**。VS Code 的 proxy-agent 若已生效，
 *      直连其实已经走了系统代理，不会走到第 3 步
 *   3. 直连失败且探测到代理 → 走隧道重试，并记住这次教训
 */
async function httpGetSmart(url, opts = {}) {
  const strictSSL = strictSSLSetting();
  const explicit = normalizeProxyUrl(configProxyOf(SECTION));
  if (explicit) return httpGet(url, { ...opts, proxy: explicit, strictSSL });

  if (preferProxy) {
    const detected = detectProxyUrl();
    if (detected) return httpGet(url, { ...opts, proxy: detected, strictSSL });
  }

  try {
    return await httpGet(url, { ...opts, proxy: '', strictSSL });
  } catch (e) {
    const detected = detectProxyUrl();
    if (!detected) throw e;
    log(`直连 ${new URL(url).host} 失败（${e?.message || e}），改走代理 ${detected} 重试`);
    preferProxy = true;
    return httpGet(url, { ...opts, proxy: detected, strictSSL });
  }
}

/**
 * 查最新 Release。返回 { version, vsixUrl, digest, notes, htmlUrl } 或 null。
 * 网络失败/没有 Release 都返回 null（调用方静默处理，不打扰用户）。
 */
async function fetchLatestRelease() {
  const url = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
  try {
    const res = await httpGetSmart(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'vscode-connect-workbuddy-updater',
      },
      timeout: 15_000,
    });
    if (res.status !== 200) {
      res.stream.resume();
      log(`查更新失败：HTTP ${res.status}`);
      lastUpdateError = `HTTP ${res.status}`;
      return null;
    }
    const j = JSON.parse((await readStreamAll(res.stream)).toString('utf8'));
    const version = String(j.tag_name || j.name || '').replace(/^v/i, '').trim();
    if (!version) return null;

    // 找 vsix 附件（优先名字里带当前版本号的）
    const assets = Array.isArray(j.assets) ? j.assets : [];
    const vsix = assets.find((a) => /\.vsix$/i.test(a.name || ''))
      || assets.find((a) => /\.vsix$/i.test(a.browser_download_url || ''));
    if (!vsix) {
      log('最新 Release 里没有 .vsix 附件');
      return null;
    }

    // GitHub 会自己算 sha256，格式 "sha256:..."。有就用来校验，没有就只走 HTTPS。
    let digest = '';
    if (typeof vsix.digest === 'string' && vsix.digest.startsWith('sha256:')) {
      digest = vsix.digest.slice(7).toLowerCase();
    } else if (typeof j.body === 'string') {
      // 兜底：允许在 Release 说明里写 `sha256: <64 位 hex>`（老版本 API 没有 digest）
      const m = /sha256[:=]\s*([0-9a-f]{64})/i.exec(j.body);
      if (m) digest = m[1].toLowerCase();
    }

    return {
      version,
      vsixUrl: vsix.browser_download_url,
      vsixName: vsix.name || `vscode-connect-workbuddy-${version}.vsix`,
      size: typeof vsix.size === 'number' ? vsix.size : 0,
      digest,
      notes: typeof j.body === 'string' ? j.body.slice(0, 1200) : '',
      htmlUrl: j.html_url || `https://github.com/${RELEASE_REPO}/releases`,
    };
  } catch (e) {
    lastUpdateError = String(e?.message || e);
    log('查更新异常：' + lastUpdateError);
    return null;
  }
}

/** 下载 vsix 到临时目录，顺带校验 sha256。返回本地路径。 */
async function downloadVsix(release, progress) {
  const dir = path.join(os.tmpdir(), 'vscode-connect-workbuddy-update');
  fs.mkdirSync(dir, { recursive: true });
  // 清掉上次遗留的 vsix，免得临时目录越积越多
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/\.vsix$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch { /* 清理失败不影响下载 */ }
  const target = path.join(dir, release.vsixName);

  progress?.report({ message: '正在下载…' });
  const res = await httpGetSmart(release.vsixUrl, {
    headers: { 'user-agent': 'vscode-connect-workbuddy-updater' },
    timeout: 120_000,
  });
  if (res.status !== 200) {
    res.stream.resume();
    throw new Error(`下载失败：HTTP ${res.status}`);
  }

  const total = Number(res.headers['content-length']) || release.size || 0;
  const chunks = [];
  let received = 0;
  for await (const chunk of res.stream) {
    chunks.push(chunk);
    received += chunk.length;
    if (total > 0) {
      const pct = Math.min(100, Math.round((received / total) * 100));
      progress?.report({ message: `正在下载… ${pct}%` });
    }
  }
  const buf = Buffer.concat(chunks);

  // Ⱑ 大小校验只在「没有 sha256 可校」时才当硬错。
  //    有 digest 时它才是权威 —— content-length 在压缩传输/重定向下
  //    可能和实际字节数不一致，拿它当硬错会误报。
  if (!release.digest && release.size && buf.length !== release.size) {
    throw new Error(`下载大小不符（期望 ${release.size}，实际 ${buf.length}）`);
  }

  if (release.digest) {
    progress?.report({ message: '正在校验 SHA256…' });
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== release.digest) {
      throw new Error(
        `SHA256 校验失败，已中止安装。\n期望：${release.digest}\n实际：${actual}\n` +
        '如果你刚换了网络环境（代理/镜像），请重试；否则请到 GitHub 手动确认。'
      );
    }
    log('SHA256 校验通过');
  } else {
    log('⚠ Release 未提供 sha256，跳过校验（仅靠 HTTPS 保护）');
  }

  fs.writeFileSync(target, buf);
  return target;
}

/**
 * 完整更新流程：查 → 问 → 下载 → 装 → 提示重载。
 * @param {{silent?:boolean, force?:boolean}} opts
 *   silent=不弹「已是最新/检查失败」；force=忽略「跳过此版本」
 *   （有新版本时即使 silent 也会弹窗问，否则自动检查就毫无意义了）
 */
async function checkForUpdates({ silent = false, force = false } = {}) {
  const cur = currentVersion();
  const latest = await fetchLatestRelease();
  if (!latest) {
    if (!silent) {
      const detected = detectProxyUrl();
      const why = lastUpdateError || '未知原因';
      const hint = detected
        ? `已探测到代理 ${detected} 但仍失败，可在设置里显式指定 \`connect-workbuddy.proxy\`。`
        : '如果你访问 GitHub 需要代理，请在设置里填 `connect-workbuddy.proxy`（如 http://127.0.0.1:7897）。';
      void vscode.window
        .showWarningMessage(`WorkBuddy：检查更新失败 — ${why}`, '查看日志', '打开设置')
        .then((pick) => {
          if (pick === '查看日志') vscode.commands.executeCommand(`${SECTION}.showLogs`);
          else if (pick === '打开设置') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'connect-workbuddy.proxy');
          }
        });
      output.appendLine(`[更新] 检查失败：${why}`);
      output.appendLine(`[更新] ${hint}`);
    }
    return { status: 'error', error: lastUpdateError };
  }

  if (compareVersions(latest.version, cur) <= 0) {
    log(`已是最新：${cur}（远端 ${latest.version}）`);
    pendingUpdateVersion = null;
    renderStatusBarForUpdate();
    if (!silent) vscode.window.showInformationMessage(`WorkBuddy 已是最新版本（${cur}）`);
    return { status: 'current', version: cur };
  }

  log(`发现新版本：${cur} → ${latest.version}`);

  // 用户点过「跳过这个版本」就不再问（除非 force）
  const skipped = extensionContext?.globalState.get(UPDATE_SKIP_KEY);
  if (!force && skipped === latest.version) {
    log(`用户跳过 ${latest.version}`);
    pendingUpdateVersion = latest.version;
    renderStatusBarForUpdate();
    return { status: 'skipped', version: latest.version };
  }

  // 先记住有新版本，状态栏可以显示
  pendingUpdateVersion = latest.version;
  renderStatusBarForUpdate();
  const detail = [
    `当前版本：${cur}`,
    `最新版本：${latest.version}`,
    latest.digest ? '安装前会校验 SHA256' : '⚠ 该 Release 未提供 SHA256，仅靠 HTTPS 保护',
    '',
    latest.notes ? latest.notes.slice(0, 800) : '（无发布说明）',
  ].join('\n');

  const pick = await vscode.window.showInformationMessage(
    `WorkBuddy 有新版本 ${latest.version}`,
    { modal: true, detail },
    '立即更新',
    '前往 Release 页面',
    `跳过 ${latest.version}`,
  );
  if (!pick) return { status: 'dismissed' };

  if (pick === '前往 Release 页面') {
    await vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl));
    return { status: 'opened-page' };
  }
  if (pick.startsWith('跳过')) {
    await extensionContext?.globalState.update(UPDATE_SKIP_KEY, latest.version);
    return { status: 'skipped', version: latest.version };
  }

  // ── 下载并安装 ────────────────────────────────────────────────
  try {
    const file = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `WorkBuddy ${latest.version}`, cancellable: false },
      (progress) => downloadVsix(latest, progress)
    );

    output.appendLine(`新版本已下载：${file}`);

    // 调 VS Code 内置命令装本地 vsix（这是唯一受支持的扩展自更新途径）
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vscode.Uri.file(file),
    );

    const reload = await vscode.window.showInformationMessage(
      `WorkBuddy ${latest.version} 已安装`,
      { modal: true, detail: '新版本的代码需要重载窗口才会生效。' },
      '立即重载',
      '稍后'
    );
    if (reload === '立即重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return { status: 'installed', version: latest.version, file };
  } catch (e) {
    const msg = String(e?.message || e);
    output.appendLine('自动更新失败：' + msg);
    const pick2 = await vscode.window.showErrorMessage(
      'WorkBuddy：自动更新失败 — ' + msg.split('\n')[0],
      { modal: true, detail: msg },
      '打开 Release 页面',
    );
    if (pick2 === '打开 Release 页面') {
      await vscode.env.openExternal(vscode.Uri.parse(latest.htmlUrl));
    }
    return { status: 'failed', error: msg };
  }
}

/**
 * 启动时的自动检查：每天最多一次，且只在用户没关掉这功能时。
 *
 * ⚠️ 时间戳只在**检查成功**（拿到 Release 且完成版本比较）后才写。
 *    早先是无条件先写，后果是：启动时网络不通 → 检查失败 → 也记了时间戳
 *    → 接下来 24 小时不再重试，哪怕网络早就恢复了。
 *    现在失败就留空，下次启动继续试。
 */
async function maybeAutoCheckUpdates(context) {
  if (vscode.workspace.getConfiguration(SECTION).get('autoUpdate') === false) {
    log('用户关闭了自动检查更新');
    return;
  }
  const last = Number(context.globalState.get(UPDATE_LAST_CHECK_KEY)) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < UPDATE_CHECK_INTERVAL_MS) {
    log(`距上次检查 ${Math.round(elapsed / 60000)} 分钟，跳过（阈值 ${UPDATE_CHECK_INTERVAL_MS / 60000} 分钟）`);
    return;
  }
  log('开始自动检查更新');
  const r = await checkForUpdates({ silent: true }).catch((e) => {
    log('自动检查更新异常：' + (e?.message || e));
    return null;
  });
  if (r && r.status !== 'error') {
    await context.globalState.update(UPDATE_LAST_CHECK_KEY, Date.now());
    log(`自动检查完成（${r.status}），已记录时间戳`);
  } else {
    log('自动检查失败，不记录时间戳（下次启动会重试）');
  }
}

// ── 旧版本共存检测 ────────────────────────────────────────────────
// 0.7.9 起 publisher 从 `local` 改成了 `connect-workbuddy`，扩展 ID 跟着变。
// VS Code 把不同 ID 当成两个**不同扩展**，所以「装新版」不会顶掉旧版 ——
// 两个会同时激活，各自：
//   · registerLanguageModelChatProvider('workbuddy') 注册同一个 vendor
//     → 模型下拉框出现两份 WorkBuddy 模型
//   · 各自拉起一个代理进程 → 两个进程同时刷新同一账号的 token
//     → 互相让对方的 refreshToken 失效，表现为「登录反复失效」
// 所以检测到旧版还在时，直接不激活自己，让用户先卸载。
const LEGACY_EXTENSION_IDS = ['local.vscode-connect-workbuddy'];

function findInstalledLegacyExtension() {
  for (const id of LEGACY_EXTENSION_IDS) {
    try {
      const ext = vscode.extensions.getExtension(id);
      if (ext) return ext;
    } catch { /* 旧版 VS Code 上该 API 行为可能不同，忽略 */ }
  }
  return null;
}

// ── 激活 / 停用 ───────────────────────────────────────────────────
async function activate(context) {
  output = vscode.window.createOutputChannel('WorkBuddy for Copilot');
  context.subscriptions.push(output);
  extensionContext = context;

  // ⚠️ 必须在拉代理之前判断：否则已经多起了一个进程，credentials 冲突照样发生
  const legacyExt = findInstalledLegacyExtension();
  if (legacyExt) {
    const msg =
      '检测到旧版 Connect WorkBuddy（' + legacyExt.id + '）仍处于安装状态。\n' +
      '两个版本会同时注册模型、同时刷新凭据，可能导致登录反复失效。\n' +
      '请先卸载旧版，然后重载窗口。';
    output.appendLine('⚠ ' + msg.replace(/\n/g, ' '));
    vscode.window
      .showErrorMessage('WorkBuddy：请先卸载旧版本扩展', '立即卸载', '查看说明')
      .then(async (pick) => {
        if (pick === '立即卸载') {
          await vscode.commands.executeCommand(
            'workbench.extensions.uninstallExtension',
            legacyExt.id,
          );
          vscode.window.showInformationMessage('已发出卸载请求，请重载窗口后使用。');
        } else if (pick === '查看说明') {
          await vscode.env.openExternal(vscode.Uri.parse(
            'https://github.com/a2689307431/vscode-connect-workbuddy#从-078-及更早版本升级',
          ));
        }
      }, () => { /* 用户关掉提示，不处理 */ });
    // 不注册 provider、不拉代理、不建状态栏 —— 让旧版继续工作，避免两个都半死不活
    return;
  }

  // 先把代理准备好（要么复用，要么自己拉起），失败不阻塞激活
  log('=== activate 开始 ===');
  try {
    await ensureProxy(context);
    log('ensureProxy 完成, url=' + proxyState.url);
  } catch (e) {
    output.appendLine('⚠ 自动拉起代理失败：' + (e?.message || e));
    // 不要写死 .bat —— Linux / macOS 上没有这个文件
    output.appendLine('  排查：确认 node 可用（设置 connect-workbuddy.nodePath），或查看 README 的故障排查。');
    proxyState.url = DEFAULT_PROXY_URL;
    proxyState.child = null;
  }

  // ── 同步账号分组（必须在注册 provider 之前）───────────────────────
  //
  // VS Code 的 _resolveAllLanguageModels 会先调一次「无组」的
  // provideLanguageModelChatInfo({ silent })，再为 chatLanguageModels.json
  // 里的每个组各调一次。
  //
  // ① package.json 的 activationEvents 现在包含
  //    `onLanguageModelChatProvider:workbuddy` —— VS Code 要模型时会用它
  //    立即激活扩展。之前只有 `onStartupFinished`，所以「刚 reload 就点开
  //    下拉框」时扩展还没激活，VS Code 拿 chat.cachedLanguageModels.v2 里的
  //    旧缓存渲染 → 混合组；十几秒后 onStartupFinished 才触发。
  //    （2026-11-22 实测：provider 注册后 17 秒才被第一次调用。）
  //
  // ② 即使激活提前了，分组也可能还没写进配置文件。所以这里先同步，
  //    并 markGroupsReady() 放行 provider 的等待逻辑。
  //
  // 失败不阻塞激活 —— 没有分组时退化成「暂无模型」，比混合组容易恢复。
  try {
    const early = await fetchPool();
    log(`提前同步分组：账号数=${early.length}`);
    if (early.length) {
      const r = syncAccountGroups(context, early);
      log(`分组写入 changed=${r.changed} +${r.added.length} -${r.removed.length} 共${early.length}组`);
      if (r.changed) {
        output.appendLine(
          `分组已同步（+${r.added.length} -${r.removed.length}，共 ${early.length} 组）`
        );
      }
    }
  } catch (e) {
    log('提前同步分组失败：' + (e?.message || e));
    log('提前同步分组失败（不影响使用，稍后会重试）：' + (e?.message || e));
  }
  // 无论成功与否都要放行 provider，否则它的无组调用会一直等到超时
  markGroupsReady();

  const provider = new WorkBuddyProvider(context);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
  );
  log('provider 已注册');

  // ── 主动催一次首轮解析 ────────────────────────────────────────────
  // 这是「刚 reload 点开下拉框是混合组」的真正修复点。
  //
  // VS Code 的首屏模型列表来自 computeMergedModels()，它优先读
  // chat.cachedLanguageModels.v2 缓存；只有 _resolveAllLanguageModels()
  // 跑过之后 live 数据才会覆盖缓存。而那个函数**不由首屏渲染触发**，
  // 只在这些时机跑：
  //   · provider 的 onDidChange 事件（registerLanguageModelProvider 里挂的）
  //   · 扩展主动调 lm.selectChatModels()
  //   · 用户在配置里增删组
  //   · 点下拉框里的「+」（这才是用户发现「点了就恢复」的原因）
  //
  // 所以我们注册完 provider 后主动 fire 一次，把首轮解析提前到激活阶段。
  // 实测（2026-11-22）：不 fire 时首次调用在 15~17 秒后；fire 后 3 毫秒内
  // 就完成 4 个分组的解析。
  //
  // 只 fire 一次：早先加了 800ms 的第二次，会让 VS Code 完整重解析两轮，
  // 反而拖慢首屏并可能触发二次重绘。
  try {
    provider._onDidChange.fire();
    log('已 fire onDidChange 催首轮解析');
  } catch (e) {
    log('fire onDidChange 失败：' + (e?.message || e));
  }

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

  // ── 检查更新 ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.checkUpdates', async () => {
      try {
        // 手动检查时重新探测代理：用户可能刚改完设置，不该被旧缓存拦住
        invalidateProxyCache();
        const proxy = detectProxyUrl();
        output.appendLine(`[更新] 代理：${proxy || '（无，直连）'}`);
        await checkForUpdates({ silent: false, force: true });
      } catch (e) {
        const pick = await vscode.window.showErrorMessage(
          'WorkBuddy：检查更新失败 — ' + (e?.message || e),
          '显示日志'
        );
        if (pick === '显示日志') output.show();
      }
    })
  );

  // 重置「每日检查」的节流计时，让下次启动重新走自动检查流程。
  // 排查用：想立刻验证启动自动检查，不用去改 VS Code 的 state.vscdb。
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.resetUpdateCheck', async () => {
      await context.globalState.update(UPDATE_LAST_CHECK_KEY, 0);
      const skipped = context.globalState.get(UPDATE_SKIP_KEY);
      if (skipped) await context.globalState.update(UPDATE_SKIP_KEY, undefined);
      output.appendLine('已重置更新检查计时' + (skipped ? `，并清掉「跳过 ${skipped}」` : ''));
      vscode.window.showInformationMessage(
        'WorkBuddy：已重置更新检查计时，重载窗口后会重新自动检查更新。',
        '立即重载'
      ).then((p) => {
        if (p === '立即重载') vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    })
  );

  // ── 钱包（账号池总览 → 单账号明细）───────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.showCredits', async () => {
      try {
        await showWallet(context);
      } catch (e) {
        const pick = await vscode.window.showErrorMessage(
          'WorkBuddy：打开钱包失败 — ' + (e?.message || e),
          '显示日志'
        );
        if (pick === '显示日志') output.show();
      }
    })
  );

  // ── 每个账号一个模型分组 ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('connect-workbuddy.syncGroups', async () => {
      let accounts = [];
      try {
        accounts = await fetchPool();
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
        beforeIds = new Set((await fetchPool()).map((a) => a.id));
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
        await refreshPoolSnapshot({ force: true });
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
        info = await fetchPool({ withCredits: true });
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：读取账号失败 — ' + (e?.message || e));
        return;
      }
      if (!info.length) {
        vscode.window.showWarningMessage(
          'WorkBuddy：没找到账号。请先安装并登录 WorkBuddy 桌面客户端。'
        );
        return;
      }

      const items = info.map((a) => {
        const credit = formatCredits(a.credits);
        return {
          label: (a.isCurrent ? '$(check) ' : '$(account) ') + a.name,
          description: [
            credit === null ? '积分 —' : `${credit} 积分`,
            REGION_LABEL[a.region] || a.region,
            a.source,
            a.desktopSelected ? '桌面端选中' : '',
            a.isLastUsed ? '最近使用' : '',
          ]
            .filter(Boolean)
            .join(' · '),
          detail: `token 到期 ${a.tokenExpiresAt || '未知'}`,
          id: a.id,
          region: a.region,
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
        const r = await selectAccount(pick.id, pick.region);
        cachedModels = null;
        provider._onDidChange.fire();
        output.appendLine(`已切换当前账号 → ${r?.current?.name || pick.id}`);
        vscode.window.showInformationMessage(`WorkBuddy：已切换到「${r?.current?.name || pick.id}」`);
        // 账号变了：状态栏跟踪的账号一起切过去，并绕过缓存拿新数字
        await trackAccount(pick.id, { force: true, region: pick.region });
      } catch (e) {
        vscode.window.showErrorMessage('WorkBuddy：切换失败 — ' + (e?.message || e));
      }
    })
  );

  log('已激活，vendor=' + VENDOR + '，代理=' + getProxyUrl());
  output.appendLine('WorkBuddy provider 已注册（vendor=' + VENDOR + '，代理=' + getProxyUrl() + '）');

  // ── 启动后初始化 ─────────────────────────────────────────────────
  // ⚠️ 别再用 `setTimeout(…, 6000)` 包住这里。
  //
  //    以前等 6 秒才做分组同步/账号池/积分，理由写的是「等代理把凭据扫完」。
  //    但那 6 秒正好覆盖了「用户刚打开窗口、第一次点开模型下拉框」的窗口期：
  //      · 分组同步还没跑，provider 的 hasAccountGroups() 读到「无组」
  //      · 于是 VSCode 的 _resolveAllLanguageModels 第一步（无组调用）拿到
  //        全部模型 → 渲染成一个混合组（2026-11-22 截图里的现象）
  //      · 用户点一下「+」会强制重解析，于是立刻恢复成按账号分组
  //
  //    现在：代理一就绪就立刻跑。代理侧的 WB_PROXY_READY 已经保证账号池
  //    和模型目录都预热完毕（见 workbuddy-proxy.mjs 的 listen 回调）。
  const runStartup = async () => {
    const n = await checkAccountCount(true);

    // 定时刷新：**不管当下有没有账号都装上**。
    // 早先只在「启动时已经有账号」的分支里装，结果后来才登录的用户
    // 状态栏再也不会自动刷新（只有发请求或手动刷新才更新）。
    const startTimer = () => {
      if (creditsTimer) clearInterval(creditsTimer);
      creditsTimer = setInterval(() => {
        refreshCreditsStatus({ quiet: true }).catch(() => {});
        // 顺带把账号池也刷一遍，状态栏 tooltip 里的合计才不会是启动时的旧值
        refreshPoolSnapshot().catch(() => {});
      }, creditsRefreshMs());
      if (typeof creditsTimer.unref === 'function') creditsTimer.unref();
    };

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
      // 账号池先读一遍：状态栏 tooltip 和默认区域都依赖它
      await refreshPoolSnapshot({ force: true });
      await refreshCreditsStatus();
      // 自动签到默认关闭；开启后每天最多一次，不阻塞激活流程
      maybeAutoCheckin(context).catch((e) => output.appendLine('自动签到异常：' + (e?.message || e)));
    } else {
      output.appendLine('⚠ 无法读取账号列表（代理可能没起来）');
    }

    startTimer();
    context.subscriptions.push({ dispose: () => { if (creditsTimer) clearInterval(creditsTimer); } });

    // 监听「用户在模型下拉框里选了哪个模型」→ 状态栏立刻跟着换
    // （这是唯一能感知切模型的途径，详见 startSelectedModelWatch 上的注释）
    try {
      startSelectedModelWatch(context);
    } catch (e) {
      log('启动模型选择监听失败：' + (e?.message || e));
    }
    // 设置改了（间隔或开关）→ 重设定时器
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION + '.creditsRefreshSeconds')) startTimer();
        if (e.affectsConfiguration(SECTION + '.showCreditsInStatusBar')) refreshCreditsStatus({ quiet: true });
      })
    );

    // 自动检查更新：每天最多一次，不阻塞启动。
    // 单独放在这里而不是 runStartup 开头 —— 让代理/模型/积分先就绪，
    // 更新检查（一次网络请求）排到后面，不抢首屏。
    maybeAutoCheckUpdates(context).catch((e) => log('自动检查更新异常：' + (e?.message || e)));
  };

  // 立刻跑，不等定时器。用 void 是为了让激活流程不被它卡住
  // （activate() 早于 provider 注册完成也不会阻塞模型下拉框）。
  void runStartup().catch((e) => output.appendLine('启动初始化异常：' + (e?.message || e)));
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
