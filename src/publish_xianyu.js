'use strict';
/**
 * 闲鱼自动上架
 *
 * 已按真实 DOM 对齐（2026-10 实测验证）：
 *   - 页面【没有独立标题栏】，只有一个「宝贝描述」富文本框（contenteditable），
 *     标题由描述首行智能识别 —— 所以第一行必须放标题
 *   - 首图上传：点击「添加首图」区域 -> input[type=file]
 *   - 价格：input[placeholder="0.00"]（第1个售价，第2个原价）
 *   - 运费：radio 组，包邮/按距离计费/一口价/无需邮寄
 *   - 发布：button[type="submit"]
 *
 * 用法:
 *   node src/publish_xianyu.js --dry-run     只填不发布，截图给你看
 *   node src/publish_xianyu.js               真实发布
 *   node src/publish_xianyu.js --slug xxx    只发某一条
 */
const fs = require('fs');
const path = require('path');
const {
  launch, sleep, log, makeThrottle, readJSON, writeJSON, DATA, OUT, shot,
} = require('./lib');

const LIST_FILE = path.join(DATA, 'listings.json');
const PUBLISH_URL = 'https://www.goofish.com/publish';

/** 往富文本框输入内容 */
async function typeIntoRich(page, locator, text) {
  const n = await locator.count().catch(() => 0);
  if (n === 0) return false;
  await locator.click({ force: true }).catch(() => {});
  await sleep(700);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await sleep(400);
  for (const line of text.split('\n')) {
    if (line) await page.keyboard.type(line, { delay: 3 });
    await page.keyboard.press('Enter');
  }
  await sleep(800);
  return true;
}

/**
 * 填描述框：首行是标题（平台据此识别标题），随后是正文
 */
async function fillDesc(page, title, body) {
  const ed = page.locator('[contenteditable="true"]');
  const n = await ed.count().catch(() => 0);
  if (n === 0) return false;
  const target = ed.first();
  await target.click({ force: true }).catch(() => {});
  await sleep(700);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await sleep(400);
  // 首行：标题
  await page.keyboard.type(title, { delay: 5 });
  await page.keyboard.press('Enter');
  await sleep(400);
  // 正文
  for (const line of body.split('\n')) {
    if (line) await page.keyboard.type(line, { delay: 3 });
    await page.keyboard.press('Enter');
  }
  await sleep(1000);
  return true;
}

/** 上传首图 */
async function uploadCover(page, file) {
  const input = page.locator('input[type="file"]').first();
  if ((await input.count().catch(() => 0)) > 0) {
    await input.setInputFiles(file).catch(() => {});
    await sleep(4000);
    const zone = ((await page.textContent('body').catch(() => '')) || '');
    if (!/添加首图/.test(zone)) return true;
  }
  const zone = page.locator('text=添加首图').first();
  if ((await zone.count().catch(() => 0)) > 0) {
    await zone.click({ force: true }).catch(() => {});
    await sleep(1200);
    const inp2 = page.locator('input[type="file"]').first();
    if ((await inp2.count().catch(() => 0)) > 0) {
      await inp2.setInputFiles(file).catch(() => {});
      await sleep(4000);
      return true;
    }
  }
  return false;
}

/** 填价格 */
async function fillPrice(page, price) {
  const inputs = page.locator('input[placeholder="0.00"]');
  const n = await inputs.count().catch(() => 0);
  if (n === 0) return false;
  const first = inputs.first();
  await first.click({ force: true }).catch(() => {});
  await sleep(400);
  await first.fill(String(price)).catch(async () => {
    await page.keyboard.type(String(price), { delay: 40 });
  });
  await sleep(600);
  return true;
}

/** 选「无需邮寄」 */
async function setNoShipping(page) {
  // React 受控组件对 Playwright 的 .click() 不一定响应，
  // 这里用原生 DOM 派发事件（pointerdown/mousedown/click/input/change），
  // 让 React 的 onChange 能收到。
  const ok = await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    const target = radios.find((r) => {
      let label = r.closest('label')?.textContent || '';
      if (!label) {
        let el = r.parentElement;
        for (let d = 0; d < 3 && el && !label.trim(); d++) {
          label = el.textContent || '';
          el = el.parentElement;
        }
      }
      return /无需邮寄/.test(label);
    });
    if (!target) return false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    // React 依赖 change 事件同步内部状态
    target.dispatchEvent(new Event('change', { bubbles: true }));
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.click();
    return true;
  }).catch(() => false);

  await sleep(800);

  // 校验
  const checked = await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    for (const r of radios) {
      if (!r.checked) continue;
      let label = r.closest('label')?.textContent || '';
      if (!label) {
        let el = r.parentElement;
        for (let d = 0; d < 3 && el && !label.trim(); d++) {
          label = el.textContent || '';
          el = el.parentElement;
        }
      }
      return label.replace(/\s+/g, ' ').trim().slice(0, 10);
    }
    return '';
  }).catch(() => '');

  if (/无需邮寄/.test(checked)) return true;

  // 兜底：点文字左侧的 radio 圆点
  const label = page.locator('text=无需邮寄').first();
  if ((await label.count().catch(() => 0)) > 0) {
    const box = await label.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.click(box.x - 32, box.y + box.height / 2).catch(() => {});
      await sleep(700);
    }
  }
  return false;
}

/** 校验表单填写情况 */
async function readFormState(page) {
  return page.evaluate(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    const prices = [...document.querySelectorAll('input[placeholder="0.00"]')].map((i) => i.value);
    const radios = [...document.querySelectorAll('input[type="radio"]')].map((r) => ({
      checked: r.checked,
      label: (r.closest('label')?.textContent || r.parentElement?.textContent || '').trim().slice(0, 10),
    }));
    return {
      desc: ed ? (ed.innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '',
      descLen: ed ? (ed.innerText || '').length : 0,
      prices,
      radios,
      hasImage: !/添加首图/.test(document.body.innerText),
      submitText: document.querySelector('button[type="submit"]')?.textContent?.trim() || '',
    };
  });
}

async function publishOne(page, item, { dryRun = false } = {}) {
  const cover = path.join(OUT, `cover_${item.slug}.png`);
  log('info', `准备发布: ${item.xyTitle}  ¥${item.price}`);

  await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded' });
  await sleep(6000);

  const body = ((await page.textContent('body').catch(() => '')) || '');
  if (/立即登录/.test(body.slice(0, 400))) {
    log('err', '闲鱼未登录，请先运行: node src/login_fish_qr.js');
    return { ok: false, reason: 'not_logged_in' };
  }

  // 图片先传（上传期间页面会变化）
  const up = await uploadCover(page, cover);
  log(up ? 'ok' : 'warn', `主图${up ? '已上传' : '未找到上传控件'}`);

  // 描述首行=标题，正文紧随
  const d = await fillDesc(page, item.xyTitle, item.description);
  log(d ? 'ok' : 'warn', `描述${d ? '已填' : '未找到输入框'}`);

  const pr = await fillPrice(page, item.price);
  log(pr ? 'ok' : 'warn', `价格${pr ? '已填' : '未找到输入框'}: ${item.price}`);

  const s = await setNoShipping(page);
  log(s ? 'ok' : 'warn', `运费${s ? '已选无需邮寄' : '需手动选择'}`);

  await sleep(1500);
  const state = await readFormState(page);
  log('info', `表单状态: 字符=${state.descLen} 价格=${state.prices.join('/')} 有图=${state.hasImage} 运费=${state.radios.filter(r => r.checked).map(r => r.label).join(',') || '未选'}`);
  await shot(page, `publish_${item.slug}_${dryRun ? 'dry' : 'ready'}`);

  if (dryRun) {
    log('ok', '[dry-run] 已填完但未点击发布');
    return { ok: true, dryRun: true, state };
  }

  // 发布按钮固定在底部，先滚动到底再找
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(1200);

  let btn = page.locator('button[type="submit"]:has-text("发布"), button:has-text("发布")').first();
  if ((await btn.count().catch(() => 0)) === 0) {
    // 兜底：找所有可见按钮里文案含「发布」的
    const idx = await page.evaluate(() => {
      const list = [...document.querySelectorAll('button')];
      for (let i = 0; i < list.length; i++) {
        const t = (list[i].innerText || '').trim();
        const r = list[i].getBoundingClientRect();
        if (t.includes('发布') && r.width > 0 && r.height > 0) return i;
      }
      return -1;
    }).catch(() => -1);
    if (idx >= 0) btn = page.locator('button').nth(idx);
  }

  if ((await btn.count().catch(() => 0)) === 0) {
    log('err', '未找到发布按钮，请查看截图 shots/publish_' + item.slug + '_ready.png');
    return { ok: false, reason: 'no_button' };
  }
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(600);
  await btn.click({ force: true, timeout: 8000 }).catch((e) =>
    log('err', '点击发布失败: ' + e.message.split('\n')[0].slice(0, 80))
  );
  await sleep(7000);
  await shot(page, `publish_${item.slug}_done`);
  const after = ((await page.textContent('body').catch(() => '')) || '');
  // 闲鱼发布成功的提示文案有多种：发布成功 / 审核通过立即可见 / 宝贝发布成功 等
  const published =
    /发布成功|已发布|发布完成|审核中|审核通过|宝贝发布成功|发布宝贝|您的宝贝|立即可见/.test(after);
  log(published ? 'ok' : 'warn', published ? '发布成功' : '点击后未检测到成功提示，请核对截图');
  return { ok: published, url: page.url() };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const slugIdx = args.indexOf('--slug');
  const only = slugIdx >= 0 ? args[slugIdx + 1] : null;

  const listings = readJSON(LIST_FILE, []);
  if (!listings.length) {
    console.error('listings.json 为空，先跑 build_listings.js');
    process.exit(1);
  }
  const targets = only ? listings.filter((l) => l.slug === only) : listings;
  if (!targets.length) {
    console.error(`没有 slug=${only} 的商品`);
    process.exit(1);
  }

  const throttle = makeThrottle(10000);
  const ctx = await launch('fish', { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1500, height: 1000 });

  const results = [];
  for (const item of targets) {
    await throttle(`发布 ${item.slug}`);
    try {
      const r = await publishOne(page, item, { dryRun });
      results.push({ slug: item.slug, title: item.xyTitle, ...r });
    } catch (e) {
      log('err', `发布 ${item.slug} 异常: ${e.message.split('\n')[0]}`);
      results.push({ slug: item.slug, ok: false, reason: e.message.split('\n')[0] });
    }
  }

  writeJSON(path.join(OUT, 'publish_results.json'), results);
  console.log('\n=== 发布结果 ===');
  results.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${r.slug} ${r.title || ''} ${r.reason || ''}`));

  if (!dryRun) {
    log('info', '窗口保持 20 秒供你确认，然后自动关闭');
    await sleep(20000);
  }
  await ctx.close();
  process.exit(0);
}

module.exports = { publishOne, fillDesc, fillPrice, uploadCover, setNoShipping, readFormState };

if (require.main === module) main();
