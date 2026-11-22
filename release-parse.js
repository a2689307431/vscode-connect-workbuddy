'use strict';

/**
 * GitHub Release 的**静态**解析器（不依赖 API 配额）
 *
 * 抽成独立模块的原因：extension.js 依赖 `vscode`，没法直接跑测试。
 * 这里的函数是**纯函数**（输入字符串 → 输出结构），可以喂假数据离线单测，
 * 见 tests/release-parse.test.cjs。
 *
 * 背景：GitHub API 未认证配额按**出口 IP** 算（60 次/小时），
 * 机场 / 公司 NAT / 校园网共享出口时很容易被用光，一限就是一小时。
 * 这时用两个不消耗配额的静态端点兜底：
 *
 *   1. `/<repo>/releases.atom`                 → 最新 tag + 发布说明
 *   2. `/<repo>/releases/expanded_assets/<tag>` → 资产列表（含 .vsix 文件名）
 *
 * ⚠️ 别直接抓 Release 页面 HTML：资产列表是 JS 动态插入的，
 *    静态 HTML 里一个 `.vsix` 都没有（实测 149 KB 的页面里没有）。
 *
 * 这两个端点返回的格式都是纯 ASCII 结构 + UTF-8 文本，
 * 用 URL/正则解析，**不依赖 shell 或平台命令**，Windows/macOS/Linux 行为一致。
 */

/** 解 HTML/XML 实体（命名实体 + 数字实体，够用即可） */
function decodeEntities(s) {
  return String(s)
    // 数字实体：&#9888; / &#x26A0;
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 从 releases.atom 里取最新一条 Release。
 * @returns {{tag:string, version:string, notes:string, htmlUrl:string}|null}
 */
function parseReleaseAtom(xml) {
  const text = String(xml || '');
  // 第一个 <entry> 就是最新的（feed 按时间倒序）
  const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(text)?.[1];
  if (!entry) return null;

  // <link rel="alternate" type="text/html" href=".../releases/tag/v1.0.1"/>
  // 属性顺序不保证，所以单独匹配 href 再判断是否含 /releases/tag/
  const links = [...entry.matchAll(/<link\b[^>]*href="([^"]+)"/gi)].map((m) => m[1]);
  const tagHref = links.find((h) => /\/releases\/tag\//i.test(h));
  const tag = tagHref ? decodeURIComponent(tagHref.split('/').filter(Boolean).pop() || '') : '';
  if (!tag) return null;

  const version = tag.replace(/^v/i, '').trim();
  if (!/^\d+\.\d+/.test(version)) return null;

  // <content type="html"> 里是转义过的 HTML
  const rawContent = /<content\b[^>]*>([\s\S]*?)<\/content>/i.exec(entry)?.[1] || '';
  const notes = decodeEntities(rawContent)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  return { tag, version, notes, htmlUrl: tagHref };
}

/**
 * 从 expanded_assets 片段里挑出本扩展的 vsix 文件名。
 *
 * 该片段里是一堆 `<a href="/owner/repo/releases/download/v1.0.1/xxx.vsix">`，
 * 也可能混着 `.zip`、`.tar.gz`、旧版本的资产，所以：
 *   · 只认 `.vsix`
 *   · 优先选名字里带目标版本号的
 *   · 都不匹配时退回第一个 .vsix（总比没有强）
 */
function parseExpandedAssets(html, version) {
  const text = String(html || '');
  const names = [...text.matchAll(/\/releases\/download\/[^"'\s>]*?\/([^"'\s/>]+\.vsix)/gi)].map((m) => m[1]);
  if (!names.length) return '';

  const uniq = [...new Set(names)];
  if (!version) return uniq[0];
  const want = new RegExp(`-${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.vsix$`, 'i');
  return uniq.find((n) => want.test(n)) || uniq[0];
}

module.exports = { decodeEntities, parseReleaseAtom, parseExpandedAssets };
