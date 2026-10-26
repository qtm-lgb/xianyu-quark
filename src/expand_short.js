'use strict';
/**
 * t.co 短链展开
 *
 * X 推文里的链接都被转成 t.co 短链，真实地址藏在后面。
 * t.co 返回的是一个 HTML 跳转页（不是 302），目标地址在
 * <META refresh> / location.replace() / <title> 里，解析即可。
 *
 * 批量展开用高并发 + 单条超时保护，避免个别慢链接拖垮整批。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const TCO_RE = /https?:\/\/t\.co\/[A-Za-z0-9]+/g;

/** 从文本里提取所有 t.co 链接 */
function extractShortLinks(text) {
  if (!text) return [];
  return [...new Set(text.match(TCO_RE) || [])];
}

/** 从 t.co 的 HTML 跳转页里解析目标地址 */
function extractTargetFromHtml(html) {
  if (!html) return null;
  // 1) <META http-equiv="refresh" content="0;URL=...">
  const m1 = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*URL=([^"'>\s]+)/i);
  if (m1) return m1[1].replace(/&amp;/g, '&');
  // 2) location.replace("...")
  const m2 = html.match(/location\.(?:replace|href)\s*=\s*["']([^"']+)["']/i);
  if (m2) return m2[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
  // 3) <title>https://...</title>
  const m3 = html.match(/<title>\s*(https?:\/\/[^\s<]+)\s*<\/title>/i);
  if (m3) return m3[1];
  return null;
}

/**
 * 展开单个短链（HTTP 方式，带超时保护）
 */
async function expandOne(ctx, shortUrl, { timeout = 10000 } = {}) {
  const doExpand = async () => {
    let url = shortUrl;
    for (let i = 0; i < 4; i++) {
      let resp;
      try {
        resp = await ctx.request.get(url, {
          maxRedirects: 0,
          timeout: 7000,
          headers: { 'user-agent': UA, accept: '*/*' },
        });
      } catch (e) {
        const m = e.message.match(/redirected to (\S+)/i);
        if (m && m[1]) { url = m[1]; continue; }
        return i === 0 ? null : url;
      }
      const status = resp.status();
      const loc = resp.headers()['location'];
      if (status >= 300 && status < 400 && loc) {
        url = new URL(loc, url).toString();
        continue;
      }
      const body = await resp.text().catch(() => '');
      const target = extractTargetFromHtml(body);
      if (target) { url = target; continue; }
      const finalUrl = resp.url();
      return finalUrl && finalUrl !== shortUrl ? finalUrl : url;
    }
    return url;
  };

  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), timeout));
  return Promise.race([doExpand(), timeoutPromise]);
}

/**
 * 展开一批短链（高并发），返回 {shortUrl: finalUrl}
 */
async function expandAll(ctx, shortUrls, { concurrency = 10 } = {}) {
  const map = {};
  const queue = [...new Set(shortUrls)];
  if (!queue.length) return map;
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      const final = await expandOne(ctx, s);
      if (final) map[s] = final;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return map;
}

/**
 * 在推文文本里找到夸克链接：
 *   1) 文本里直接有 pan.quark.cn -> 直接用
 *   2) 只有 t.co 短链 -> 展开后判断是否是夸克
 *   3) 展开后是中转站（如 wpss.best）-> 进页面里再找夸克链接
 * @returns {quarkLinks:string[], shortMap:object}
 */
async function resolveQuarkLinks(ctx, text) {
  const direct = (text.match(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/g) || []);
  const shortLinks = extractShortLinks(text);
  const shortMap = await expandAll(ctx, shortLinks);
  const quarkLinks = [...new Set(direct)];

  for (const [s, final] of Object.entries(shortMap)) {
    if (/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/.test(final)) {
      const m = final.match(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/);
      if (m) quarkLinks.push(m[0]);
      continue;
    }
    // 中转站：进页面找夸克链接
    if (final && /^https?:\/\//.test(final)) {
      const inner = await findQuarkInPage(ctx, final);
      if (inner.length) {
        quarkLinks.push(...inner);
        shortMap[s] = `${final} -> ${inner.join(',')}`;
      }
    }
  }
  return { quarkLinks: [...new Set(quarkLinks)], shortMap };
}

/** 在一个页面里找夸克链接（含页面内的 JS 变量） */
async function findQuarkInPage(ctx, url) {
  try {
    const resp = await ctx.request.get(url, {
      timeout: 10000,
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
    });
    const body = await resp.text().catch(() => '');
    if (!body) return [];
    const found = [...new Set(body.match(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/g) || [])];
    if (found.length) return found;
    const target = extractTargetFromHtml(body);
    if (target && target !== url) {
      const resp2 = await ctx.request.get(target, {
        timeout: 10000,
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      });
      const body2 = await resp2.text().catch(() => '');
      return [...new Set((body2 || '').match(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/g) || [])];
    }
    return [];
  } catch {
    return [];
  }
}

module.exports = {
  extractShortLinks, expandOne, expandAll, resolveQuarkLinks,
  findQuarkInPage, extractTargetFromHtml, TCO_RE,
};
