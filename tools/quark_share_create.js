'use strict';
/**
 * 夸克网盘：为指定文件夹创建永久分享链接（方案B）
 *
 * 关键：先用 UI 走一遍「创建分享」，抓包得到真实接口与参数，
 *       再用同一套参数批量创建。
 *
 * 用法:
 *   node tools/quark_share_create.js --explore          # 探路：打开网盘并列出可分享的文件夹
 *   node tools/quark_share_create.js --fid <fid> --name <名称>   # 单个创建
 *   node tools/quark_share_create.js --from-courses      # 按 quark_courses.json 批量创建
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE = path.join(os.homedir(), '.workbuddy', 'quark-profile');
const ROOT = path.resolve(__dirname, '..');
const COURSES = path.join(ROOT, 'data', 'quark_courses.json');
const OUTJSON = path.join(ROOT, 'data', 'quark_courses.json');
const LIST_URL = 'https://pan.quark.cn/list#/list/all/a1031f76d30541b2bb7fa700182171e4-JonnyShares';

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 在页面上下文调夸克 API */
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
        return { status: r.status, json: j, raw: t.slice(0, 500) };
      } catch (e) {
        return { error: e.message.slice(0, 120) };
      }
    },
    { method, path_, body }
  );
}

/** 记录所有 clouddrive 请求（含 body），用于还原建分享参数 */
function watch(page, bucket) {
  page.on('request', (req) => {
    const u = req.url();
    if (!/drive-pc\.quark\.cn\/1\/clouddrive/.test(u)) return;
    let body = '';
    try { body = req.postData() || ''; } catch { /* ignore */ }
    bucket.push({ m: req.method(), u: u.replace('https://drive-pc.quark.cn', ''), b: body });
  });
}

(async () => {
  const args = process.argv.slice(2);
  const explore = args.includes('--explore');
  const fromCourses = args.includes('--from-courses');
  const fidIdx = args.indexOf('--fid');
  const nameIdx = args.indexOf('--name');
  const oneFid = fidIdx >= 0 ? args[fidIdx + 1] : '';
  const oneName = nameIdx >= 0 ? args[nameIdx + 1] : '';

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
  watch(page, api);

  say('打开夸克网盘...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(9000);

  // 登录校验
  const cfg = await qApi(page, 'GET', '/1/clouddrive/config?pr=ucpro&fr=pc');
  if (!cfg.json?.data) {
    say('✗ 未登录。请先运行 node tools/quark_login.js');
    await page.screenshot({ path: 'shots/quark_not_logged.png' }).catch(() => {});
    await ctx.close();
    process.exit(1);
  }
  say(`✓ 已登录: ${cfg.json.data.nickname || cfg.json.data.member_type}`);

  // 读共享列表
  say('\n读取共享列表接口响应...');
  const listPaths = [
    '/1/clouddrive/share/mypage/list?pr=ucpro&fr=pc&_page=1&_size=100',
    '/1/clouddrive/share/list?pr=ucpro&fr=pc&_page=1&_size=100',
    '/1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=0&_page=1&_size=100',
  ];
  let shareData = null;
  for (const p of listPaths) {
    const r = await qApi(page, 'GET', p);
    if (r.json && r.json.data) {
      const d = r.json.data;
      const arr = Array.isArray(d) ? d : d.list || d.items || [];
      if (arr.length) {
        say(`  ✓ ${p.split('?')[0]} -> ${arr.length} 条`);
        shareData = arr;
        break;
      }
    } else {
      say(`  ✗ ${p.split('?')[0]} -> ${r.status} ${r.json?.message || ''}`);
    }
  }

  say('\n=== 页面实际调用的接口 ===');
  const uniq = [...new Map(api.map((x) => [x.m + ' ' + x.u.split('?')[0], x])).values()];
  uniq.forEach((x) => {
    say(`  ${x.m} ${x.u.split('?')[0].slice(0, 90)}`);
    if (/share/i.test(x.u) && x.b) say(`      body: ${x.b.slice(0, 220)}`);
  });

  if (shareData) {
    say('\n=== 共享列表内容 ===');
    shareData.slice(0, 30).forEach((s, i) => {
      say(`  [${i}] ${s.title || s.name || '(无标题)'}  fid=${String(s.fid || s.file_id || '').slice(0, 12)}`);
    });
  }

  // DOM 兜底读文件名
  const dom = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[class*="file-name"], [class*="fileName"], [class*="name-cell"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      out.push({
        name: (el.innerText || '').trim(),
        fid: el.getAttribute('data-fid') || el.dataset?.fid || '',
        attrs: el.getAttributeNames().reduce((a, k) => { a[k] = el.getAttribute(k); return a; }, {}),
      });
    });
    return out;
  });
  if (dom.length) {
    say(`\n=== DOM 文件名 (${dom.length}) ===`);
    dom.slice(0, 25).forEach((d) => say(`  ${d.name}  attrs=${JSON.stringify(d.attrs).slice(0, 100)}`));
  }

  await page.screenshot({ path: 'shots/quark_shared_list.png' }).catch(() => {});
  fs.writeFileSync(path.join(ROOT, 'out', 'quark_api_capture.json'), JSON.stringify(api, null, 2), 'utf8');
  say('\n抓包已存 out/quark_api_capture.json');

  if (explore || (!fromCourses && !oneFid)) {
    say('\n探路完成。下一步用 UI 手动创建一次分享以抓取参数，或直接用 --from-courses 批量创建。');
    await ctx.close();
    process.exit(0);
  }

  await ctx.close();
  process.exit(0);
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
