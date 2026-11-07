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

/** 选择商品分类
 *  分类控件是懒渲染的（填完标题后才出现），Ant Design Select 结构。
 *  不选分类时闲鱼会拦截发布：「网页版暂不支持发布此分类」。
 *
 *  实测（2026-11）：
 *  - 页面上共 2 个 .ant-select-selector：
 *      [0] = 分类（y≈600）    [1] = 出版国家/地区
 *  - 分类候选随标题动态变化，只有「电子资料」这类是网页版支持的；
 *    「AI视频工具/服务」「AI设计工具/服务」等只能 APP 发布，选了会被拦截。
 *  - 填完标题后闲鱼会自动预选一个分类，但可能是 APP-only 的，
 *    所以必须显式改成「电子资料」。
 */
async function selectCategory(page, name = '电子资料') {
  // 等分类控件渲染
  for (let i = 0; i < 12; i++) {
    const n = await page.locator('.ant-select-selector').count().catch(() => 0);
    if (n > 0) break;
    await sleep(1000);
  }

  // 分类是第 0 个 select（按 y 排序也稳定在「出版国家/地区」之前）
  const idx = await page.evaluate(() => {
    const sels = [...document.querySelectorAll('.ant-select-selector')];
    if (!sels.length) return -1;
    // 用「出版国家/地区」作为参照排除掉它，取剩下的第一个
    let other = -1;
    sels.forEach((s, i) => {
      if (/出版国家|国家\/地区/.test(s.innerText || '')) other = i;
    });
    if (other === 0) return 1;
    return 0;
  }).catch(() => 0);

  const sel = page.locator('.ant-select-selector').nth(idx >= 0 ? idx : 0);
  if ((await sel.count().catch(() => 0)) === 0) {
    log('warn', '未找到分类下拉控件');
    return false;
  }

  // 已选中目标分类就不用动
  const current = ((await sel.textContent().catch(() => '')) || '').trim();
  if (current.includes(name)) {
    log('ok', `分类已是「${name}」`);
    return true;
  }

  await sel.click({ force: true }).catch(() => {});
  await sleep(1800);

  const opt = page.locator(`.ant-select-item-option[title="${name}"], [role="option"]:has-text("${name}")`).first();
  if ((await opt.count().catch(() => 0)) === 0) {
    const all = await page.evaluate(() =>
      [...document.querySelectorAll('.ant-select-item-option, [role="option"]')]
        .map((el) => (el.innerText || '').trim())
        .filter(Boolean)
    );
    log('warn', `分类候选无「${name}」（闲鱼按标题推荐，可能只能 APP 发布）: ${all.slice(0, 6).join('/')}`);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(600);
    return false;
  }
  await opt.click({ force: true }).catch(() => {});
  await sleep(1200);

  // 校验：重新读回该 select 的值
  const picked = ((await sel.textContent().catch(() => '')) || '').trim();
  const ok = picked.includes(name);
  log(ok ? 'ok' : 'warn', ok ? `分类已选「${name}」` : `分类选择未确认（当前=${picked}）`);
  return ok;
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

  // 分类（懒渲染，必须在标题填完后再选；不选会被闲鱼拦截发布）
  const cat = await selectCategory(page, '电子资料');
  log(cat ? 'ok' : 'warn', `分类${cat ? '已选「电子资料」' : '未手动选择（按标题自动归类）'}`);

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
  // 成功判定（闲鱼有多种提示形态）：
  //   1) 顶部横幅「闲鱼发布成功物品及并推荐！」
  //   2) 跳转后 URL 变成 /item?id=xxx
  //   3) 页面上出现「已发布/审核通过/立即可见」等字样
  //   4) 按钮从「发布」变成「下架/删除」（说明已进入自己商品的管理态）
  const byBanner = /发布成功/.test(after);
  const byUrl = /\/item\?id=\d+/.test(page.url());
  const byText = /已发布|审核通过|立即可见|宝贝发布成功/.test(after);
  const byManage = /下架/.test(after) && /删除/.test(after);
  const published = byBanner || byUrl || byText || byManage;
  log(
    published ? 'ok' : 'warn',
    published
      ? `发布成功${byBanner ? '（横幅）' : byUrl ? '（URL）' : byText ? '（文案）' : '（管理态）'}`
      : '点击后未检测到成功提示，请核对截图'
  );
  // 抓取发布后的商品ID（用于后续配置自动发货规则）
  const itemId = (page.url().match(/item\?id=(\d+)/) || [])[1] || '';
  if (published && itemId) {
    log('ok', `商品ID: ${itemId}`);
    // 回填到 listings.json，供发货规则使用
    try {
      const backFile = process.env.PUBLISH_BACK_FILE || path.join(DATA, 'listings.json');
      const all = readJSON(backFile, []);
      const hit = all.find((x) => x.slug === item.slug);
      if (hit && !hit.itemId) {
        hit.itemId = itemId;
        hit.itemUrl = `https://www.goofish.com/item?id=${itemId}`;
        hit.publishedAt = new Date().toISOString();
        writeJSON(backFile, all);
        log('ok', `已回填 itemId 到 ${path.basename(backFile)}`);
      }
    } catch (e) {
      log('warn', '回填 itemId 失败: ' + e.message.split('\n')[0].slice(0, 60));
    }
  }
  return { ok: published, url: page.url(), itemId };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const slugIdx = args.indexOf('--slug');
  const only = slugIdx >= 0 ? args[slugIdx + 1] : null;

  // --file <path>：从指定文件读待发布清单（不污染主 listings.json）
  const fileIdx = args.indexOf('--file');
  const listFile = fileIdx >= 0 ? path.resolve(args[fileIdx + 1]) : LIST_FILE;
  const listings = readJSON(listFile, []);
  if (!listings.length) {
    console.error('listings.json 为空，先跑 build_listings.js');
    process.exit(1);
  }
  // 合规拦截：标题含禁用词 / 已标记不发的，一律不发布
  const { filterPublishable, reportBlocked } = require('./compliance');
  const { ok: targets, blocked } = filterPublishable(listings);
  if (blocked.length) {
    log('warn', `合规拦截 ${blocked.length} 个商品，不予发布:`);
    console.log(reportBlocked(blocked));
  }
  if (!targets.length) {
    console.error(`没有 slug=${only} 的商品`);
    process.exit(1);
  }

  const throttle = makeThrottle(12000);
  let ctx = await launch('fish', { headless: false });
  let page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1500, height: 1000 });

  const results = [];
  for (const item of targets) {
    await throttle(`发布 ${item.slug}`);
    try {
      const r = await publishOne(page, item, { dryRun });
      results.push({ slug: item.slug, title: item.xyTitle, ...r });
    } catch (e) {
      const msg = e.message.split('\n')[0];
      log('err', `发布 ${item.slug} 异常: ${msg}`);
      results.push({ slug: item.slug, ok: false, reason: msg });
      // 浏览器被关闭/上下文销毁 -> 重建后继续
      if (/Target page, context or browser has been closed|browser has been closed|Connection closed/i.test(msg)) {
        log('warn', '浏览器已关闭，重建上下文后继续...');
        try { await ctx.close(); } catch { /* ignore */ }
        ctx = await launch('fish', { headless: false });
        page = ctx.pages()[0] || (await ctx.newPage());
        await page.setViewportSize({ width: 1500, height: 1000 });
        await sleep(3000);
      }
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
