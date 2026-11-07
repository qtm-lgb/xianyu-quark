'use strict';
/**
 * 夸克网盘 API 封装（页面上下文调用，自动带 cookie）
 */
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const PROFILE = path.join(os.homedir(), '.workbuddy', 'quark-profile');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 打开一个已登录的夸克页面上下文 */
async function openQuark({ headless = false } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless,
    userAgent: UA,
    locale: 'zh-CN',
    viewport: { width: 1500, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://pan.quark.cn/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(6000);
  return { ctx, page };
}

/** 调 API */
async function qApi(page, method, path_, body) {
  return page.evaluate(
    async ({ method, path_, body }) => {
      try {
        const r = await fetch(`https://drive-pc.quark.cn${path_}`, {
          method,
          credentials: 'include',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch { /* ignore */ }
        return { status: r.status, json: j, raw: t.slice(0, 600) };
      } catch (e) {
        return { error: e.message.slice(0, 150) };
      }
    },
    { method, path_, body }
  );
}

/** 列目录（pdir_fid 为空则根目录） */
async function listDir(page, pdirFid, { pageSize = 200 } = {}) {
  const q = new URLSearchParams({
    pr: 'ucpro', fr: 'pc', uc_param_str: '',
    pdir_fid: pdirFid || '0',
    _page: '1', _size: String(pageSize), _fetch_total: '1', _fetch_sub_dirs: '0',
    _sort: 'file_type:asc,updated_at:desc',
    fetch_all_file: '1', fetch_risk_file_name: '1',
  });
  const r = await qApi(page, 'GET', `/1/clouddrive/file/sort?${q}`);
  const list = r.json?.data?.list || [];
  return { list, total: r.json?.data?.metadata?._total ?? list.length, raw: r };
}

module.exports = { openQuark, qApi, listDir, PROFILE, UA };

if (require.main === module) {
  (async () => {
    const { ctx, page } = await openQuark({ headless: false });
    const fid = process.argv[2] || 'a1031f76d30541b2bb7fa700182171e4';
    const { list, total } = await listDir(page, fid);
    console.log(`总数: ${total}  返回: ${list.length}`);
    list.forEach((f, i) =>
      console.log(
        `  [${i}] ${f.file_name}  dir=${f.dir_f}  size=${f.size || '-'}  ` +
        `fid=${f.fid}  sft=${(f.share_fid_token || '-').slice(0, 12)}`
      )
    );
    await ctx.close();
    process.exit(0);
  })();
}
