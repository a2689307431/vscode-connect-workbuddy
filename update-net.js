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
 * 所以这里用 http/https + 自己建 CONNECT 隧道，不依赖任何外部包。
 *
 * 单独成文件的目的：extension.js 依赖 `vscode` 模块，无法直接在 Node 里跑；
 * 抽出来后就能用真实代码做端到端测试（见 tests/update-net.test.mjs）。
 */

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');

/** 把 "127.0.0.1:7897"、"http=1.2.3.4:8080;https=..." 之类归一成带协议的 URL */
function normalizeProxyUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // Windows 注册表可能是 "http=1.2.3.4:8080;https=1.2.3.4:8080"
  // 优先取 https 那一项（我们只访问 https），注意不能用 /https?=/ —— 那会先匹到 http=
  if (s.includes('=')) {
    const m = /(?:^|;)\s*https=([^;]+)/i.exec(s) || /(?:^|;)\s*http=([^;]+)/i.exec(s);
    s = m ? m[1].trim() : s.split(';')[0].replace(/^[a-z]+=/i, '');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname) return '';
    const auth = u.username
      ? `${encodeURIComponent(decodeURIComponent(u.username))}:${encodeURIComponent(decodeURIComponent(u.password || ''))}@`
      : '';
    return `${u.protocol}//${auth}${u.host}`;
  } catch {
    return '';
  }
}

/** Windows 注册表里的系统代理（ProxyEnable=1 才认） */
function windowsSystemProxy() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) return '';
    const m = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(out);
    return m ? normalizeProxyUrl(m[1]) : '';
  } catch {
    return '';
  }
}

/** macOS 系统代理（scutil --proxy） */
function macSystemProxy() {
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 4000 });
    if (!/HTTPSEnable\s*:\s*1/.test(out)) return '';
    const host = /HTTPSProxy\s*:\s*(\S+)/.exec(out)?.[1];
    const port = /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1];
    return host && port ? normalizeProxyUrl(`${host}:${port}`) : '';
  } catch {
    return '';
  }
}

/** 按平台取系统代理 */
function systemProxy() {
  if (process.platform === 'win32') return windowsSystemProxy();
  if (process.platform === 'darwin') return macSystemProxy();
  return '';
}

/**
 * GET 一个 URL，返回 { status, headers, stream }。
 * 自动跟随 3xx（GitHub Release 会 302 到 objects.githubusercontent.com）。
 * proxy 非空时对 https 目标建 CONNECT 隧道。
 */
function httpGet(targetUrl, { headers = {}, timeout = 20_000, proxy = '', redirects = 5 } = {}) {
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
        return void httpGet(next, { headers, timeout, proxy, redirects: redirects - 1 }).then(resolve, reject);
      }
      resolve({ status, headers: res.headers, stream: res });
    };

    const baseHeaders = { ...headers, Host: u.host };

    // 有代理 + https 目标 → CONNECT 隧道
    if (proxy && isHttps) {
      const p = new URL(proxy);
      const auth = p.username
        ? {
            'proxy-authorization':
              'Basic ' +
              Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || '')}`).toString('base64'),
          }
        : {};
      const connectReq = http.request({
        host: p.hostname,
        port: Number(p.port || 80),
        method: 'CONNECT',
        path: `${u.hostname}:${port}`,
        headers: auth,
        timeout,
      });
      connectReq.once('connect', (res, socket) => {
        if ((res.statusCode || 0) !== 200) {
          socket.destroy();
          return reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        }
        const req = https.request(
          {
            host: u.hostname,
            port,
            path: u.pathname + u.search,
            method: 'GET',
            headers: baseHeaders,
            agent: false,
            createConnection: () => tls.connect({ socket, servername: u.hostname }),
          },
          handle
        );
        req.once('error', onErr);
        req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
        req.end();
      });
      connectReq.once('error', onErr);
      connectReq.once('timeout', () => connectReq.destroy(new Error('代理连接超时')));
      connectReq.end();
      return;
    }

    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        host: u.hostname,
        port,
        path: proxy ? u.href : u.pathname + u.search, // http 目标走代理用绝对 URI
        method: 'GET',
        headers: baseHeaders,
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

module.exports = { normalizeProxyUrl, systemProxy, windowsSystemProxy, macSystemProxy, httpGet, readStreamAll };
