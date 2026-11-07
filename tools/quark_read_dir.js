'use strict';
/**
 * 读取夸克网盘 JonnyShares 目录下的所有文件夹
 *
 * 已实测：登录后页面直接渲染目录（面包屑「全部文件 / JonnyShares」），
 * 列表是表格（文件名/大小/修改日期），左侧是共享列表。
 *
 * 关键：登录判定不能只看 config 接口的 member_type，
 *      用「页面是否出现文件列表」更可靠。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE = path.join(os.homedir(), '.workbuddy', 'quark-profile');
const ROOT = path.resolve(__dirname, '..');
const LIST_URL = 'https://pan.quark.cn/list#/list/all/a1031f76d30541b2bb7fa700182171e4-JonnyShares';
const OUTJSON = path.join(ROOT, 'data', 'quark_courses.json');

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    userAgent: UA,
    locale: 'zh-CN',
    viewport: { width: 1500, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 记录接口
  const api = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/drive-pc\.quark\.cn\/1\/clouddrive/.test(u)) {
      let b = '';
      try { b = r.postData() || ''; } catch { /* ignore */ }
      api.push({ m: r.method(), u: u.replace('https://drive-pc.quark.cn', ''), b });
    }
  });

  say('打开 JonnyShares 目录...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(10000);

  // 滚动加载全部
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => {
      const sc = document.querySelector('[class*="virtual-list"], [class*="virtualList"], .ant-table-body, [class*="file-list"]') ||
        document.scrollingElement || document.body;
      sc.scrollTop = sc.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await sleep(1500);
  }

  // 读取表格行
  const rows = await page.evaluate(() => {
    const out = [];
    // 表格行
    document.querySelectorAll('tr').forEach((tr) => {
      const tds = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim());
      if (tds.length >= 2 && tds[0] && tds[0] !== '文件名') {
        out.push({ name: tds[0], size: tds[1] || '', date: tds[2] || '', kind: 'row' });
      }
    });
    if (out.length) return out;
    // 兜底：按文件名元素
    const seen = new Set();
    document.querySelectorAll('[class*="file-name"], [class*="fileName"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const name = (el.innerText || '').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      // 找同行的大小/日期
      const row = el.closest('tr') || el.closest('[class*="item"]') || el.parentElement;
      const txt = (row?.innerText || '').replace(/\s+/g, ' ').trim();
      out.push({ name, size: '', date: '', kind: 'name', rowText: txt });
    });
    return out;
  });

  say(`\n读到 ${rows.length} 行`);
  rows.forEach((r, i) => say(`  [${i}] ${r.name}  ${r.size || ''}  ${r.date || ''}`));

  // 接口清单
  say('\n=== 页面调用的接口 ===');
  const uniq = [...new Map(api.map((x) => [x.m + ' ' + x.u.split('?')[0], x])).values()];
  uniq.forEach((x) => {
    say(`  ${x.m} ${x.u.split('?')[0].slice(0, 95)}`);
    if (x.b) say(`      ${x.b.slice(0, 200)}`);
  });

  fs.writeFileSync(path.join(ROOT, 'out', 'quark_api_capture.json'), JSON.stringify(api, null, 2), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'out', 'quark_dir_rows.json'), JSON.stringify(rows, null, 2), 'utf8');
  await page.screenshot({ path: 'shots/quark_dir_list.png', fullPage: false }).catch(() => {});
  say('\n已保存 out/quark_api_capture.json 与 out/quark_dir_rows.json');
  await ctx.close();
  process.exit(0);
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
