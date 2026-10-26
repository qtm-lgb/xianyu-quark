'use strict';
/**
 * 中转站解析器（松果盘搜 wpss.best）
 *
 * X 上的资源账号用 t.co 短链指到中转站，中转站再指向夸克网盘。
 * 链路：
 *   t.co -> (HTML 跳转页解析) -> https://www.wpss.best/res/<temp_id>
 *        -> POST /api/v1/resources/<temp_id>/claim  -> 得到真实 pan.quark.cn 链接
 *
 * claim 接口需要登录态（/api/v1/user/me），无登录时可能返回验证码要求。
 */
const { sleep, log } = require('./lib');

const RELAY_HOST = 'https://www.wpss.best';

/** 解析中转站资源页，返回 {tempId, title, platform, fileSize, quarkLink} */
async function resolveRelay(ctx, relayUrl, { headless = true } = {}) {
  const out = { relayUrl, tempId: '', title: '', platform: '', fileSize: '', quarkLink: '', error: '' };
  const m = relayUrl.match(/\/res\/([A-Za-z0-9_-]+)/);
  if (!m) { out.error = '不是中转站资源链接'; return out; }
  out.tempId = m[1];

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(relayUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(5000);

  // 1) 先取资源元信息
  const meta = await page.evaluate(async (id) => {
    try {
      const r = await fetch(`/api/v1/resources/${id}`, { credentials: 'include' });
      if (!r.ok) return { error: 'HTTP ' + r.status };
      return await r.json();
    } catch (e) { return { error: e.message }; }
  }, out.tempId).catch(() => null);

  if (meta && !meta.error) {
    out.title = meta.title || '';
    out.platform = meta.platform || '';
    out.fileSize = meta.file_size || '';
    // 有些资源直接带链接
    const direct = (JSON.stringify(meta).match(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/) || [])[0];
    if (direct) { out.quarkLink = direct; return out; }
  }

  // 2) 点击「获取资源」触发 claim
  const btn = page.locator('button:has-text("获取资源"), text=获取资源').first();
  if ((await btn.count().catch(() => 0)) > 0) {
    await btn.click({ force: true }).catch(() => {});
    await sleep(4500);
  }

  // 3) 从 DOM 里读夸克链接
  const html = await page.evaluate(() => document.documentElement.innerHTML).catch(() => '');
  const q = (html.match(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/) || [])[0];
  if (q) { out.quarkLink = q; return out; }

  // 4) 从弹窗/提示里再找
  const txt = ((await page.textContent('body').catch(() => '')) || '');
  const q2 = (txt.match(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/) || [])[0];
  if (q2) { out.quarkLink = q2; return out; }

  // 5) 直接调 claim 接口
  const claimed = await page.evaluate(async (id) => {
    try {
      const r = await fetch(`/api/v1/resources/${id}/claim`, { method: 'POST', credentials: 'include' });
      const t = await r.text();
      try { return { status: r.status, json: JSON.parse(t) }; }
      catch { return { status: r.status, text: t.slice(0, 300) }; }
    } catch (e) { return { error: e.message }; }
  }, out.tempId).catch(() => null);

  if (claimed) {
    const s = JSON.stringify(claimed);
    const q3 = (s.match(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/) || [])[0];
    if (q3) { out.quarkLink = q3; return out; }
    if (claimed.json) {
      out.title = out.title || claimed.json.title || '';
      out.platform = out.platform || claimed.json.platform || '';
      out.fileSize = out.fileSize || claimed.json.file_size || '';
    }
    if (!out.error) out.error = `claim HTTP ${claimed.status}`;
  }
  if (!out.error && !out.quarkLink) out.error = '未取到夸克链接（可能需要登录或触发验证码）';
  return out;
}

module.exports = { resolveRelay, RELAY_HOST };
