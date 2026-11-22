// release-parse.js 的离线单测（CI 跑，不联网）
//
// 用法: node proxy/tests/release-parse.test.cjs
//
// 为什么要有它：GitHub API 限流时靠 atom feed + expanded_assets 兜底，
// 而这两处的格式是 GitHub 私有实现，随时可能变。用真实样本做断言，
// 格式一变 CI 就会红，而不是等用户报「检查更新失败」。

const { parseReleaseAtom, parseExpandedAssets, decodeEntities } = require('../../release-parse');

let pass = 0;
let fail = 0;
const ok = (n, extra = '') => {
  pass++;
  console.log(`  ✓ ${n}${extra ? '  ' + extra : ''}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  ✗ ${n}  → ${e}`);
};
const eq = (n, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(n, JSON.stringify(actual));
  else bad(n, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};

// ── 真实样本（2026-11-23 从 releases.atom 抓的，已裁剪）──────────
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/o/r/releases</id>
  <title>Release notes from r</title>
  <updated>2026-11-22T17:41:34Z</updated>
  <entry>
    <id>tag:github.com,2008:Repository/1441532900/v1.0.1</id>
    <updated>2026-11-22T17:44:32Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1.0.1"/>
    <title>v1.0.1 — something</title>
    <content type="html">&lt;h2&gt;&lt;g-emoji class=&quot;g-emoji&quot; alias=&quot;warning&quot;&gt;&amp;#9888;&amp;#65039;&lt;/g-emoji&gt; &#22836;&#26465;&lt;/h2&gt;
&lt;p&gt;&#27491;&#25991; &lt;code&gt;x&lt;/code&gt;&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1441532900/v1.0.0</id>
    <link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1.0.0"/>
    <title>v1.0.0 — older</title>
    <content type="html">older</content>
  </entry>
</feed>`;

// 属性顺序不同的变体（GitHub 改版过模板，必须容错）
const ATOM_ATTR_REORDERED = `<feed><entry>
  <link href="https://github.com/o/r/releases/tag/2.3.4" rel="alternate" type="text/html"/>
  <title>2.3.4</title>
</entry></feed>`;

// 没有 tag 链接的坏数据
const ATOM_BROKEN = `<feed><entry><title>oops</title></entry></feed>`;

// ── expanded_assets 样本 ───────────────────────────────────────
const ASSETS = `<div class="Box">
  <ul>
    <li><a href="/o/r/releases/download/v1.0.1/vscode-connect-workbuddy-1.0.1.vsix" rel="nofollow">
      <span>vscode-connect-workbuddy-1.0.1.vsix</span></a></li>
    <li><a href="/o/r/releases/download/v1.0.1/source.zip">source.zip</a></li>
  </ul>
</div>`;

// 同时出现新旧版本资产（GitHub 偶尔会把旧资产一起列出来）
const ASSETS_MULTI = `
  <a href="/o/r/releases/download/v0.9.0/vscode-connect-workbuddy-0.9.0.vsix">old</a>
  <a href="/o/r/releases/download/v1.0.1/vscode-connect-workbuddy-1.0.1.vsix">new</a>
  <a href="/o/r/releases/download/v1.0.1/other-tool-1.2.3.vsix">other</a>
`;

const ASSETS_NONE = `<div>No assets</div>`;

console.log('\n=== 1. parseReleaseAtom ===');

const a = parseReleaseAtom(ATOM);
eq('最新 tag', a && a.tag, 'v1.0.1');
eq('去掉 v 前缀', a && a.version, '1.0.1');
eq('htmlUrl', a && a.htmlUrl, 'https://github.com/o/r/releases/tag/v1.0.1');
if (a && a.notes && !/[<>]/.test(a.notes)) ok('notes 已剥 HTML 标签', a.notes.slice(0, 30) + '…');
else bad('notes 含标签', a && a.notes);

const b = parseReleaseAtom(ATOM_ATTR_REORDERED);
eq('属性顺序不同也能解析', b && b.version, '2.3.4');

eq('坏数据返回 null', parseReleaseAtom(ATOM_BROKEN), null);
eq('空字符串返回 null', parseReleaseAtom(''), null);
eq('undefined 返回 null', parseReleaseAtom(undefined), null);

// tag 不带 v 的情况
const noV = `<feed><entry><link href="https://github.com/o/r/releases/tag/3.1.4"/></entry></feed>`;
eq('tag 不带 v', parseReleaseAtom(noV) && parseReleaseAtom(noV).version, '3.1.4');

// 非语义化 tag 应被拒绝（防止把 "latest" 之类当版本号）
const weird = `<feed><entry><link href="https://github.com/o/r/releases/tag/nightly"/></entry></feed>`;
eq('非数字 tag 返回 null', parseReleaseAtom(weird), null);

console.log('\n=== 2. parseExpandedAssets ===');
eq('挑出版本匹配的 vsix', parseExpandedAssets(ASSETS, '1.0.1'), 'vscode-connect-workbuddy-1.0.1.vsix');
eq('多资产里选对版本', parseExpandedAssets(ASSETS_MULTI, '1.0.1'), 'vscode-connect-workbuddy-1.0.1.vsix');
eq('版本不匹配时退回第一个 vsix', parseExpandedAssets(ASSETS_MULTI, '9.9.9'), 'vscode-connect-workbuddy-0.9.0.vsix');
eq('没有 vsix 返回空串', parseExpandedAssets(ASSETS_NONE, '1.0.1'), '');
eq('空输入返回空串', parseExpandedAssets('', '1.0.1'), '');

// 版本号里的点必须当字面量（否则 1.0.1 会匹配 1x0x1）
const dotTrap = `<a href="/o/r/releases/download/v1.0.1/vscode-connect-workbuddy-1x0x1.vsix">trap</a>`;
eq('点号当字面量不误匹配', parseExpandedAssets(dotTrap, '1.0.1'), 'vscode-connect-workbuddy-1x0x1.vsix');

console.log('\n=== 3. decodeEntities ===');
eq('常见实体', decodeEntities('&lt;a&gt;&amp;&quot;x&quot;&#39;'), `<a>&"x"'`);
eq('数字实体 39', decodeEntities('&#39;'), "'");
eq('十进制实体（emoji）', decodeEntities('&#9888;&#65039;'), '\u26A0\uFE0F');
eq('十六进制实体', decodeEntities('&#x26A0;'), '\u26A0');
eq('&nbsp;', decodeEntities('a&nbsp;b'), 'a b');
eq('&amp; 不重复解码', decodeEntities('&amp;lt;'), '&lt;');

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
