'use strict';
/**
 * 夸克网盘目录遍历 + 为每个文件夹创建永久分享
 *
 * 目标目录（我的分享列表页）：
 *   https://pan.quark.cn/list#/list/all/a1031f76d30541b2bb7fa700182171e4-JonnyShares
 *
 * 夸克相关接口（凭记忆整理，首次跑会抓包校正）：
 *   列表      GET  /1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=<fid>
 *   分享列表  GET  /1/clouddrive/share/mypage/list?pr=ucpro&fr=pc&_page=1&_size=50
 *   建分享    POST /1/clouddrive/share?pr=ucpro&fr=pc
 *   改分享    POST /1/clouddrive/share/password/update  (设置提取码/有效期)
 *
 * 用法:
 *   node tools/quark_list_courses.js            # 只列目录，不建分享
 *   node tools/quark_list_courses.js --create   # 列目录并为每个文件夹建永久分享
 *   node tools/quark_list_courses.js --create --dry-run
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE = path.join(os.homedir(), '.workbuddy', 'quark-profile');
const OUT = path.resolve(__dirname, '..', 'data', 'quark_courses.json');
const LIST_URL = 'https://pan.quark.cn/list#/list/all/a1031f76d30541b2bb7fa700182171e4-JonnyShares';

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 统一的夸克 API 调用（在页面上下文里发，自动带 cookie） */
async function qApi(page, method, path_, body) {
  return page.evaluate(
    async ({ method, path_, body }) => {
      try {
        const r = await fetch(`https://drive-pc.quark.cn${path_}`, {
          method,
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch { /* 非 JSON */ }
        return { status: r.status, json: j, raw: t.slice(0, 400) };
      } catch (e) {
        return { error: e.message.slice(0, 120) };
      }
    },
    { method, path_, body }
  );
}

/** 抓包：记录页面实际调用的夸克接口，用来校正路径 */
function watchApi(page, bucket) {
  page.on('response', async (r) => {
    const u = r.url();
    if (!/drive-pc\.quark\.cn\/1\/clouddrive/.test(u)) return;
    let body = '';
    try { body = (await r.text()).slice(0, 260); } catch { /* ignore */ }
    bucket.push({ m: r.request().method(), u: u.replace('https://drive-pc.quark.cn', ''), b: body });
  });
}

(async () => {
  const args = process.argv.slice(2);
  const doCreate = args.includes('--create');
  const dryRun = args.includes('--dry-run');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    userAgent: UA,
    locale: 'zh-CN',
    viewport: { width: 1500, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const api = [];
  watchApi(page, api);

  say('打开夸克网盘分享列表...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(8000);

  // 登录校验
  const cfg = await qApi(page, 'GET', '/1/clouddrive/config?pr=ucpro&fr=pc');
  if (!cfg.json?.data) {
    say('✗ 未登录或接口无返回，请重新登录: node tools/quark_login.js');
    await ctx.close();
    process.exit(1);
  }
  say(`✓ 已登录: ${cfg.json.data.nickname || cfg.json.data.member_type || 'ok'}`);

  // 抓到的接口列表（用于校正）
  say('\n=== 页面实际调用的接口 ===');
  const uniq = [...new Map(api.map((x) => [x.m + ' ' + x.u.split('?')[0], x])).values()];
  uniq.forEach((x) => say(`  ${x.m} ${x.u.split('?')[0].slice(0, 100)}`));

  // 尝试读取分享列表（两个可能的路径）
  const candidates = [
    '/1/clouddrive/share/mypage/list?pr=ucpro&fr=pc&_page=1&_size=100',
    '/1/clouddrive/share/list?pr=ucpro&fr=pc&_page=1&_size=100',
    '/1/clouddrive/share/mypage/list?pr=ucpro&fr=pc&_page=1&_size=100&_sort=0',
  ];
  let shareList = null;
  let usedPath = null;
  for (const c of candidates) {
    const r = await qApi(page, 'GET', c);
    if (r.json && r.json.data) {
      const list = Array.isArray(r.json.data)
        ? r.json.data
        : r.json.data.list || r.json.data.items || [];
      if (list.length) {
        shareList = list;
        usedPath = c;
        say(`\n✓ 分享列表接口: ${c.split('?')[0]}  条数=${list.length}`);
        break;
      }
    }
  }

  if (!shareList) {
    // 退而用页面 DOM 读（列表可能是前端渲染的虚拟列表）
    say('\n接口未返回数据，改用页面 DOM 读取...');
    const dom = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[class*="file-name"], [class*="fileName"], [class*="item-name"]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        out.push({
          name: (el.innerText || '').trim(),
          cls: (el.className || '').toString().slice(0, 50),
          attrs: el.getAttributeNames().reduce((a, k) => {
            a[k] = el.getAttribute(k);
            return a;
          }, {}),
        });
      });
      return out;
    });
    say(`DOM 文件名元素: ${dom.length}`);
    dom.slice(0, 20).forEach((d) => say(`  ${d.name}  attrs=${JSON.stringify(d.attrs).slice(0, 120)}`));
    const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
    say(`\n页面文本(600): ${body.slice(0, 600)}`);
    await page.screenshot({ path: 'shots/quark_list_dom.png' }).catch(() => {});
    await ctx.close();
    process.exit(1);
  }

  // 解析分享列表
  say('\n=== 分享列表 ===');
  const courses = [];
  for (const s of shareList) {
    const title = s.title || s.name || s.share_title || '(无标题)';
    const fid = s.fid || s.file_id || s.share_fid || s.id || '';
    const url = s.url || s.share_url || (s.pwd_id ? `https://pan.quark.cn/s/${s.pwd_id}` : '');
    const exp = s.expired_at || s.expire_time;
    const expType = s.expired_type;
    say(`  ${title}  | fid=${String(fid).slice(0, 12)} | ${expType === 1 ? '永久' : '限时'} | ${String(url).slice(0, 60)}`);
    courses.push({
      title,
      fid,
      shareUrl: url,
      pwdId: s.pwd_id || '',
      expiredType: expType,
      expiredAt: exp,
      fileCount: s.total_filies ?? s.file_count ?? null,
      size: s.file_size || s.size || '',
      raw: s,
    });
  }

  fs.writeFileSync(OUT, JSON.stringify(courses, null, 2), 'utf8');
  say(`\n✓ 已写入 ${OUT}（${courses.length} 条）`);

  if (doCreate) {
    say('\n=== 建分享流程 ===');
    if (dryRun) { say('[dry-run] 不会真的建分享'); }
    else {
      say('（下一步：为每个文件夹创建新的永久分享链接）');
    }
  }

  await page.screenshot({ path: 'shots/quark_share_list.png' }).catch(() => {});
  await ctx.close();
  process.exit(0);
})().catch((e) => {
  say('异常: ' + e.message);
  process.exit(1);
});
