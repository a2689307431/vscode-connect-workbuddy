// update-net.js 的离线测试（CI 跑，**不依赖外网、不依赖 TLS 证书**）
//
// 用法: node proxy/tests/update-net.mock.cjs
//
// 思路：本地起三个服务
//   · target      —— 假的「GitHub」，提供 JSON / 302 / 大文件 / 慢响应
//   · httpProxy   —— 假的 HTTP 代理，支持 CONNECT 和绝对 URI，可切 407
//   · socks5Proxy —— 假的 SOCKS5 代理，支持无认证 / 用户名密码
//
// 为什么用 http 目标而不是 https：
//   要测 https 得先有一张自签证书，仓库里不想放私钥、也不想给 CI 加依赖。
//   而 SOCKS5 隧道和「绝对 URI」两条路径跟目标是不是 https 无关，
//   所以用 http 目标就能把协议实现完整测掉。
//   CONNECT 只测「请求格式正确」和「407 的报错文案」（TLS over CONNECT 是 Node
//   标准行为，交给真实的 proxy/tests/update-net.cjs 去验）。

const http = require('node:http');
const net = require('node:net');
const { parseProxy, httpGet, readStreamAll } = require('../../update-net');

let pass = 0;
let fail = 0;
const ok = (n, extra = '') => {
  pass++;
  console.log(`  ✓ ${n}${extra ? '  ' + extra : ''}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  ✗ ${n}  → ${e?.message || e}`);
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ── 假目标站 ────────────────────────────────────────────────────
function makeTarget() {
  return http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'x.vsix', size: 3 }] }));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/json' });
      res.end();
      return;
    }
    if (req.url === '/bin') {
      const buf = Buffer.alloc(1024 * 1024, 0x5a); // 1MB
      res.writeHead(200, { 'content-length': String(buf.length) });
      res.end(buf);
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        try {
          res.writeHead(200);
          res.end('late');
        } catch {
          /* 已被调用方断开 */
        }
      }, 3000);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

// ── 假 HTTP 代理 ────────────────────────────────────────────────
// 允许两种用法：
//   · 绝对 URI：GET http://target/xxx  —— 用于 http 目标
//   · CONNECT target:port              —— 用于 https 目标
function makeHttpProxy({ forceStatus = 0 } = {}) {
  const proxy = http.createServer((req, res) => {
    if (forceStatus) {
      res.writeHead(forceStatus);
      return res.end();
    }
    let u;
    try {
      u = new URL(req.url);
    } catch {
      res.writeHead(400);
      return res.end('not absolute URI');
    }
    const up = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      }
    );
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });

  proxy.on('connect', (req, clientSocket, head) => {
    if (forceStatus) {
      clientSocket.write(`HTTP/1.1 ${forceStatus} Denied\r\n\r\n`);
      return clientSocket.destroy();
    }
    const idx = req.url.lastIndexOf(':');
    const host = req.url.slice(0, idx);
    const port = Number(req.url.slice(idx + 1));
    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    const kill = () => {
      serverSocket.destroy();
      clientSocket.destroy();
    };
    serverSocket.on('error', kill);
    clientSocket.on('error', kill);
  });

  return proxy;
}

// ── 假 SOCKS5 代理（RFC1928 + RFC1929）─────────────────────────
function makeSocks5Proxy({ auth = null } = {}) {
  return net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let stage = 0; // 0=问候 1=认证 2=请求 3=已转发

    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0) {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = [...buf.subarray(2, 2 + n)];
          buf = buf.subarray(2 + n);
          if (auth) {
            if (!methods.includes(0x02)) {
              socket.write(Buffer.from([0x05, 0xff]));
              return socket.destroy();
            }
            socket.write(Buffer.from([0x05, 0x02]));
            stage = 1;
          } else {
            if (!methods.includes(0x00)) {
              socket.write(Buffer.from([0x05, 0xff]));
              return socket.destroy();
            }
            socket.write(Buffer.from([0x05, 0x00]));
            stage = 2;
          }
          continue;
        }

        if (stage === 1) {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 3 + ulen) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.toString('utf8', 2, 2 + ulen);
          const pwd = buf.toString('utf8', 3 + ulen, 3 + ulen + plen);
          buf = buf.subarray(3 + ulen + plen);
          if (user !== auth.username || pwd !== auth.password) {
            socket.write(Buffer.from([0x01, 0x01]));
            return socket.destroy();
          }
          socket.write(Buffer.from([0x01, 0x00]));
          stage = 2;
          continue;
        }

        if (stage === 2) {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let host;
          let port;
          let headLen;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = [...buf.subarray(4, 8)].join('.');
            port = buf.readUInt16BE(8);
            headLen = 10;
          } else if (atyp === 0x03) {
            const l = buf[4];
            if (buf.length < 5 + l + 2) return;
            host = buf.toString('utf8', 5, 5 + l);
            port = buf.readUInt16BE(5 + l);
            headLen = 5 + l + 2;
          } else if (atyp === 0x04) {
            if (buf.length < 22) return;
            host = '::1';
            port = buf.readUInt16BE(20);
            headLen = 22;
          } else {
            socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return socket.destroy();
          }
          const rest = buf.subarray(headLen);
          buf = Buffer.alloc(0);
          stage = 3;
          socket.off('data', onData);

          const target = net.connect(port, host, () => {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (rest.length) target.write(rest);
            target.pipe(socket);
            socket.pipe(target);
          });
          target.on('error', () => {
            try {
              socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            } catch {
              /* ignore */
            }
            socket.destroy();
          });
          socket.on('error', () => target.destroy());
          return;
        }

        return;
      }
    };

    socket.on('data', onData);
    socket.on('error', () => {});
  });
}

(async () => {
  const target = makeTarget();
  const proxyOk = makeHttpProxy();
  const proxy407 = makeHttpProxy({ forceStatus: 407 });
  const socksPlain = makeSocks5Proxy();
  const socksAuth = makeSocks5Proxy({ auth: { username: 'u', password: 'p@ss' } });

  const targetPort = await listen(target);
  const proxyPort = await listen(proxyOk);
  const proxy407Port = await listen(proxy407);
  const socksPort = await listen(socksPlain);
  const socksAuthPort = await listen(socksAuth);

  const T = `http://127.0.0.1:${targetPort}`;
  const P = `http://127.0.0.1:${proxyPort}`;
  const P407 = `http://127.0.0.1:${proxy407Port}`;
  const S = `socks5://127.0.0.1:${socksPort}`;
  const SA = `socks5://u:p%40ss@127.0.0.1:${socksAuthPort}`;
  const SA_BAD = `socks5://u:wrong@127.0.0.1:${socksAuthPort}`;

  // ── 1. 直连 ──────────────────────────────────────────────────
  console.log('\n=== 1. 直连 ===');
  try {
    const r = await httpGet(`${T}/json`, { timeout: 5000 });
    const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
    r.status === 200 && j.tag_name === 'v9.9.9' ? ok('直连 JSON') : bad('直连 JSON', JSON.stringify(j));
  } catch (e) {
    bad('直连 JSON', e);
  }

  // ── 2. 302 跟随 ─────────────────────────────────────────────
  console.log('\n=== 2. 重定向 ===');
  try {
    const r = await httpGet(`${T}/redirect`, { timeout: 5000 });
    const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
    r.status === 200 && j.tag_name === 'v9.9.9' ? ok('302 自动跟随') : bad('302', JSON.stringify(j));
  } catch (e) {
    bad('302', e);
  }

  // ── 3. HTTP 代理（绝对 URI）──────────────────────────────────
  console.log('\n=== 3. HTTP 代理（绝对 URI）===');
  try {
    const r = await httpGet(`${T}/json`, { timeout: 5000, proxy: P });
    const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
    j.tag_name === 'v9.9.9' ? ok('经代理取 JSON') : bad('经代理取 JSON', JSON.stringify(j));
  } catch (e) {
    bad('经代理取 JSON', e);
  }
  try {
    const r = await httpGet(`${T}/bin`, { timeout: 10000, proxy: P });
    const buf = await readStreamAll(r.stream, 8 * 1024 * 1024);
    buf.length === 1024 * 1024 ? ok('经代理传 1MB') : bad('经代理传 1MB', `收到 ${buf.length}`);
  } catch (e) {
    bad('经代理传 1MB', e);
  }

  // ── 4. 代理 CONNECT 失败（407）应给出认证提示 ────────────────
  console.log('\n=== 4. 代理 CONNECT 报错 ===');
  try {
    await httpGet('https://example.invalid/x', { timeout: 5000, proxy: P407 });
    bad('407 分支', '竟然成功了');
  } catch (e) {
    /CONNECT 失败.*407|407.*认证/.test(e.message) ? ok('407 提示要认证', e.message) : bad('407 文案', e.message);
  }

  // ── 5. SOCKS5 无认证 ────────────────────────────────────────
  console.log('\n=== 5. SOCKS5 无认证 ===');
  try {
    const r = await httpGet(`${T}/json`, { timeout: 5000, proxy: S });
    const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
    j.tag_name === 'v9.9.9' ? ok('SOCKS5 取 JSON') : bad('SOCKS5 取 JSON', JSON.stringify(j));
  } catch (e) {
    bad('SOCKS5 取 JSON', e);
  }
  try {
    const r = await httpGet(`${T}/redirect`, { timeout: 5000, proxy: S });
    const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
    j.tag_name === 'v9.9.9' ? ok('SOCKS5 + 302') : bad('SOCKS5 + 302', JSON.stringify(j));
  } catch (e) {
    bad('SOCKS5 + 302', e);
  }
  try {
    const r = await httpGet(`${T}/bin`, { timeout: 10000, proxy: S });
    const buf = await readStreamAll(r.stream, 8 * 1024 * 1024);
    buf.length === 1024 * 1024 ? ok('SOCKS5 传 1MB') : bad('SOCKS5 传 1MB', `收到 ${buf.length}`);
  } catch (e) {
    bad('SOCKS5 传 1MB', e);
  }

  // ── 6. SOCKS5 用户名密码 ────────────────────────────────────
  console.log('\n=== 6. SOCKS5 认证 ===');
  try {
    const r = await httpGet(`${T}/json`, { timeout: 5000, proxy: SA });
    const j = JSON.parse((await readStreamAll(r.stream)).toString('utf8'));
    j.tag_name === 'v9.9.9' ? ok('SOCKS5 认证成功') : bad('SOCKS5 认证成功', JSON.stringify(j));
  } catch (e) {
    bad('SOCKS5 认证成功', e);
  }
  try {
    await httpGet(`${T}/json`, { timeout: 5000, proxy: SA_BAD });
    bad('SOCKS5 密码错误', '竟然成功了');
  } catch (e) {
    /认证失败/.test(e.message) ? ok('SOCKS5 密码错误报错', e.message) : bad('SOCKS5 密码错误文案', e.message);
  }

  // ── 7. 超时 ─────────────────────────────────────────────────
  console.log('\n=== 7. 超时 ===');
  try {
    await httpGet(`${T}/slow`, { timeout: 800 });
    bad('超时', '竟然成功了');
  } catch (e) {
    /超时/.test(e.message) ? ok('超时被中断', e.message) : bad('超时文案', e.message);
  }

  // ── 8. 不支持的代理类型要明确报错（不能静默直连）────────────
  console.log('\n=== 8. 不支持的代理明确报错 ===');
  for (const [name, proxy, re] of [
    ['PAC', 'http://x/proxy.pac', /PAC/],
    ['SOCKS4', 'socks4://127.0.0.1:1080', /SOCKS4/],
  ]) {
    try {
      await httpGet(`${T}/json`, { timeout: 3000, proxy });
      bad(`${name} 应报错`, '竟然成功了（会静默变直连）');
    } catch (e) {
      re.test(e.message) ? ok(`${name} 明确报错`) : bad(`${name} 文案`, e.message);
    }
  }

  // ── 9. 连接被拒 ─────────────────────────────────────────────
  console.log('\n=== 9. 代理不可达 ===');
  try {
    await httpGet(`${T}/json`, { timeout: 3000, proxy: 'socks5://127.0.0.1:1' });
    bad('SOCKS 不可达', '竟然成功了');
  } catch (e) {
    /ECONNREFUSED|拒绝/.test(e.message) ? ok('SOCKS 不可达报错', e.message) : bad('SOCKS 不可达文案', e.message);
  }

  console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
  for (const s of [target, proxyOk, proxy407, socksPlain, socksAuth]) s.close();
  process.exit(fail ? 1 : 0);
})();
