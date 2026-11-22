'use strict';

/**
 * 自动更新用的 HTTP 客户端（代理感知）
 *
 * ⚠️ 为什么不用内置 fetch：
 *   VS Code 扩展宿主里的 fetch 是 Node 内置 undici，它**不经过**
 *   @vscode/proxy-agent 给 http/https 打的补丁，不读 `http.proxy` 设置，
 *   也不读系统代理。国内用户不开 TUN 时，直连 api.github.com 会直接超时。
 *   （2026-11-23 实测：系统代理 127.0.0.1:7897 一切正常，扩展里 fetch 仍失败。）
 *
 * 支持范围：
 *   · HTTP/HTTPS 代理（CONNECT 隧道，含 Basic 认证）
 *   · SOCKS5 代理（含用户名密码认证）—— Clash / V2RayN / mihomo 常见
 *   · PAC 脚本：**不支持**，但会给出明确提示，不会静默失败
 *
 * 单独成文件的目的：extension.js 依赖 `vscode` 模块，无法直接在 Node 里跑；
 * 抽出来后就能用真实代码做端到端测试（见 tests/update-net.test.cjs）。
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');

// ── 代理地址解析 ─────────────────────────────────────────────────

/**
 * 解析代理字符串，返回
 *   { type:'http'|'socks5', host, port, username, password, useTLS } |
 *   { type:'unsupported', raw, reason } |
 *   { type:'pac', raw } |
 *   { type:'', raw }  ← 空
 *
 * 认得的输入：
 *   127.0.0.1:7897                        → http
 *   http://127.0.0.1:7897                 → http
 *   https://proxy.corp:8443               → http + useTLS（CONNECT 本身走 TLS）
 *   socks5://127.0.0.1:7891               → socks5
 *   socks5h://user:pass@127.0.0.1:1080    → socks5 + 认证
 *   http=1.2.3.4:8080;https=1.2.3.4:8443  → 取 https 那项（Windows 注册表格式）
 *   http://host/proxy.pac                 → pac（不支持，调用方报错）
 */
function parseProxy(raw) {
  let s = String(raw || '').trim();
  if (!s) return { type: '', raw: s };

  // Windows 注册表格式 "http=1.2.3.4:8080;https=1.2.3.4:8443"
  // 优先取 https（我们只访问 https），注意不能用 /https?=/ —— 那会先匹到 http=
  if (s.includes('=')) {
    const m = /(?:^|;)\s*https=([^;]+)/i.exec(s) || /(?:^|;)\s*http=([^;]+)/i.exec(s);
    s = m ? m[1].trim() : s.split(';')[0].replace(/^[a-z]+=/i, '');
  }

  // PAC 脚本：明确不支持（要做完整的 PAC 求值器才能支持，不值得）
  if (/\.pac(\?|#|$)/i.test(s) || /^file:\/\//i.test(s)) return { type: 'pac', raw: s };

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    return { type: '', raw: s };
  }
  if (!u.hostname) return { type: '', raw: s };

  // URL.hostname 对 IPv6 会带方括号（"[::1]"），net.connect 要的是裸地址
  const host = u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;

  const proto = u.protocol.replace(':', '').toLowerCase();
  const username = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';

  if (proto === 'socks5' || proto === 'socks5h' || proto === 'socks') {
    return { type: 'socks5', host, port: Number(u.port || 1080), username, password, useTLS: false, raw: s };
  }
  if (proto === 'http' || proto === 'https') {
    return {
      type: 'http',
      host,
      port: Number(u.port || (proto === 'https' ? 443 : 80)),
      username,
      password,
      // https:// 代理：连代理本身要 TLS，再在其上发 CONNECT
      useTLS: proto === 'https',
      raw: s,
    };
  }
  if (proto === 'socks4' || proto === 'socks4a') {
    return { type: 'unsupported', raw: s, reason: 'SOCKS4 协议太老，本扩展不支持；请换成 SOCKS5 或 HTTP 代理' };
  }
  return { type: 'unsupported', raw: s, reason: `不支持的代理协议 ${proto}://` };
}

/** 把代理字符串归一成可展示/可复用的形式（老代码只想要一个字符串） */
function normalizeProxyUrl(raw) {
  const p = parseProxy(raw);
  if (p.type === 'http') {
    const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
    const port = p.port === 80 ? '' : ':' + p.port;
    return `http://${auth}${p.host}${port}`;
  }
  if (p.type === 'socks5') {
    const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
    return `socks5://${auth}${p.host}:${p.port}`;
  }
  if (p.type === 'pac') return p.raw;
  if (p.type === 'unsupported') return p.raw;
  return '';
}

// ── 系统代理探测 ─────────────────────────────────────────────────

/** Windows：注册表 Internet Settings（ProxyEnable=1 才认） */
function windowsSystemProxy() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 2500, windowsHide: true }
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) return '';
    const m = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out);
    return m ? normalizeProxyUrl(m[1]) : '';
  } catch {
    return '';
  }
}

/** macOS：scutil --proxy（HTTPS → HTTP → SOCKS 依次尝试） */
function macSystemProxy() {
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 2500 });
    const pick = (proto) => {
      if (!new RegExp(`${proto}Enable\\s*:\\s*1`).test(out)) return '';
      const host = new RegExp(`${proto}Proxy\\s*:\\s*(\\S+)`).exec(out)?.[1];
      const port = new RegExp(`${proto}Port\\s*:\\s*(\\d+)`).exec(out)?.[1];
      if (!host || !port || port === '0') return '';
      return `${proto === 'SOCKS' ? 'socks5' : 'http'}://${host}:${port}`;
    };
    return normalizeProxyUrl(pick('HTTPS') || pick('HTTP') || pick('SOCKS'));
  } catch {
    return '';
  }
}

/** Linux 桌面：GNOME 设置（gsettings）。非 GNOME / 无 DBus 时静默跳过 */
function linuxSystemProxy() {
  try {
    const mode = execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    if (mode !== "'manual'") return '';

    const read = (schema, key) =>
      execFileSync('gsettings', ['get', schema, key], { encoding: 'utf8', timeout: 2000 })
        .trim()
        .replace(/^['"]|['"]$/g, '');

    for (const scheme of ['https', 'http']) {
      const host = read(`org.gnome.system.proxy.${scheme}`, 'host');
      const port = read(`org.gnome.system.proxy.${scheme}`, 'port');
      if (host && port && port !== '0') return normalizeProxyUrl(`${host}:${port}`);
    }
    const shost = read('org.gnome.system.proxy.socks', 'host');
    const sport = read('org.gnome.system.proxy.socks', 'port');
    if (shost && sport && sport !== '0') return normalizeProxyUrl(`socks5://${shost}:${sport}`);
    return '';
  } catch {
    return '';
  }
}

/** 按平台取系统代理 */
function systemProxy() {
  if (process.platform === 'win32') return windowsSystemProxy();
  if (process.platform === 'darwin') return macSystemProxy();
  if (process.platform === 'linux') return linuxSystemProxy();
  return '';
}

// ── SOCKS5 握手 ─────────────────────────────────────────────────

const SOCKS5_REP = {
  0x01: '服务器故障',
  0x02: '规则不允许',
  0x03: '网络不可达',
  0x04: '主机不可达',
  0x05: '连接被拒绝',
  0x06: 'TTL 过期',
  0x07: '不支持的命令',
  0x08: '不支持的地址类型',
};

/**
 * 在已连上的 socket 上完成 SOCKS5 握手 + CONNECT。
 * 成功时把 socket 交还调用方（此时已是到目标的裸 TCP 通道）。
 */
function socks5Handshake(socket, host, port, { username, password } = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let step = 0; // 0=问候 1=认证 2=CONNECT
    let settled = false;

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.setTimeout(0); // 交还前取消超时，后续由 https 层管
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (buf.length) socket.unshift(buf); // 多读的字节还给上层
      resolve(socket);
    };

    const sendConnect = () => {
      step = 2;
      const h = Buffer.from(host, 'utf8');
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]),
          h,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ])
      );
    };

    const onError = (e) => fail(e);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        for (;;) {
          if (step === 0) {
            if (buf.length < 2) return;
            const ver = buf[0];
            const method = buf[1];
            buf = buf.subarray(2);
            if (ver !== 0x05) return fail(new Error(`不是 SOCKS5 服务（返回版本 0x${ver.toString(16)}）`));
            if (method === 0xff) return fail(new Error('SOCKS5 服务器不接受任何认证方式'));
            if (method === 0x02) {
              if (!username) return fail(new Error('SOCKS5 需要用户名密码，但代理地址里没提供'));
              const u = Buffer.from(username, 'utf8');
              const pw = Buffer.from(password || '', 'utf8');
              socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]));
              step = 1;
              continue;
            }
            if (method === 0x00) {
              sendConnect();
              continue;
            }
            return fail(new Error(`SOCKS5 选用了不支持的认证方式 0x${method.toString(16)}`));
          }

          if (step === 1) {
            if (buf.length < 2) return;
            const status = buf[1];
            buf = buf.subarray(2);
            if (status !== 0x00) return fail(new Error('SOCKS5 用户名/密码认证失败'));
            sendConnect();
            continue;
          }

          if (step === 2) {
            if (buf.length < 4) return;
            const rep = buf[1];
            const atyp = buf[3];
            let addrLen;
            let headLen;
            if (atyp === 0x01) {
              addrLen = 4;
              headLen = 4;
            } else if (atyp === 0x04) {
              addrLen = 16;
              headLen = 4;
            } else if (atyp === 0x03) {
              if (buf.length < 5) return;
              addrLen = buf[4];
              headLen = 5;
            } else {
              return fail(new Error(`SOCKS5 返回了未知地址类型 0x${atyp.toString(16)}`));
            }
            const total = headLen + addrLen + 2;
            if (buf.length < total) return;
            if (rep !== 0x00) {
              const why = SOCKS5_REP[rep] || `REP=0x${rep.toString(16)}`;
              return fail(new Error(`SOCKS5 连接 ${host}:${port} 失败：${why}`));
            }
            buf = buf.subarray(total);
            return ok();
          }

          return;
        }
      } catch (e) {
        fail(e);
      }
    };

    socket.on('data', onData);
    socket.once('error', onError);
    const methods = username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.concat([Buffer.from([0x05, methods.length]), Buffer.from(methods)]));
  });
}

// ── 请求 ────────────────────────────────────────────────────────

/**
 * GET 一个 URL，返回 { status, headers, stream }。
 * 自动跟随 3xx（GitHub Release 会 302 到 objects.githubusercontent.com）。
 *
 * @param {object} opts
 *   proxy     代理字符串，空则直连
 *   strictSSL 默认 true；false 才跳过证书校验（对应 http.proxyStrictSSL）
 */
function httpGet(targetUrl, { headers = {}, timeout = 20_000, proxy = '', redirects = 5, strictSSL = true } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port || (isHttps ? 443 : 80));
    const onErr = (e) => reject(e instanceof Error ? e : new Error(String(e)));
    const p = parseProxy(proxy);

    if (p.type === 'pac') {
      return reject(
        new Error('检测到 PAC 脚本代理，本扩展不支持。请在设置里填 HTTP 或 SOCKS5 代理地址（如 http://127.0.0.1:7897）')
      );
    }
    if (p.type === 'unsupported') {
      return reject(new Error(`代理不可用：${p.reason}`));
    }

    const handle = (res) => {
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc && redirects > 0) {
        res.resume(); // 必须排空，否则 socket 不释放
        let next;
        try {
          next = new URL(loc, targetUrl).href;
        } catch {
          return reject(new Error('重定向地址无效'));
        }
        return void httpGet(next, { headers, timeout, proxy, redirects: redirects - 1, strictSSL }).then(
          resolve,
          reject
        );
      }
      resolve({ status, headers: res.headers, stream: res });
    };

    const baseHeaders = { ...headers, Host: u.host };
    const optsFor = (socket) => ({
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: baseHeaders,
      agent: false,
      rejectUnauthorized: strictSSL,
      createConnection: () =>
        isHttps ? tls.connect({ socket, servername: u.hostname, rejectUnauthorized: strictSSL }) : socket,
    });

    // ① SOCKS5 隧道
    if (p.type === 'socks5') {
      const socket = net.connect({ host: p.host, port: p.port });
      socket.setTimeout(timeout, () => socket.destroy(new Error('SOCKS5 连接超时')));
      socket.once('error', onErr);
      socket.once('connect', () => {
        socks5Handshake(socket, u.hostname, port, p).then(
          () => {
            const req = (isHttps ? https : http).request(optsFor(socket), handle);
            req.once('error', onErr);
            req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
            req.end();
          },
          onErr
        );
      });
      return;
    }

    // ② HTTP CONNECT 隧道（只有 https 目标需要）
    if (p.type === 'http' && isHttps) {
      const auth = p.username
        ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${p.username}:${p.password || ''}`).toString('base64') }
        : {};
      // https:// 代理：连代理本身要 TLS（公司代理常见 8443 之类）
      const proxyMod = p.useTLS ? https : http;
      const connectReq = proxyMod.request({
        host: p.host,
        port: p.port,
        method: 'CONNECT',
        path: `${u.hostname}:${port}`,
        headers: auth,
        timeout,
        rejectUnauthorized: strictSSL,
      });
      connectReq.once('connect', (res, socket) => {
        if ((res.statusCode || 0) !== 200) {
          socket.destroy();
          const hint = res.statusCode === 407 ? '（代理要求认证，请在代理地址里带上 user:pass@）' : '';
          return reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}${hint}`));
        }
        const req = https.request(optsFor(socket), handle);
        req.once('error', onErr);
        req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
        req.end();
      });
      connectReq.once('error', onErr);
      connectReq.once('timeout', () => connectReq.destroy(new Error('代理连接超时')));
      connectReq.end();
      return;
    }

    // ③ 直连；或 http 目标走 http 代理（用绝对 URI）
    const useAbsolute = p.type === 'http' && !isHttps;
    // http 目标 + https 代理时要先跟代理建 TLS
    const dialMod = isHttps || (useAbsolute && p.useTLS) ? https : http;
    const req = dialMod.request(
      {
        host: useAbsolute ? p.host : u.hostname,
        port: useAbsolute ? p.port : port,
        path: useAbsolute ? u.href : u.pathname + u.search,
        method: 'GET',
        headers:
          useAbsolute && p.username
            ? {
                ...baseHeaders,
                'proxy-authorization': 'Basic ' + Buffer.from(`${p.username}:${p.password || ''}`).toString('base64'),
              }
            : baseHeaders,
        rejectUnauthorized: strictSSL,
      },
      handle
    );
    req.once('error', onErr);
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

/** 读干一个流，超过 limit 直接报错（防被塞超大响应） */
async function readStreamAll(stream, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > limit) throw new Error('响应体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

module.exports = {
  parseProxy,
  normalizeProxyUrl,
  systemProxy,
  windowsSystemProxy,
  macSystemProxy,
  linuxSystemProxy,
  socks5Handshake,
  httpGet,
  readStreamAll,
};
