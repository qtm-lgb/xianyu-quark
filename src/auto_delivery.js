'use strict';
/**
 * 闲鱼自动发货配置（鱼小铺 PC 工作台）
 *
 * 入口：https://seller.goofish.com/
 * 路径：商品 -> 商品管理 -> 找到商品 -> 编辑 -> 自动发货设置 -> 填入链接与提取码 -> 启用
 *
 * 鱼小铺 PC 端是 SPA，DOM 会随版本变动，所以这里用「文本锚点 + 分级兜底」定位，
 * 每一步都截图，方便失败时人工接管。
 *
 * 用法:
 *   node src/auto_delivery.js --slug abcff1f83e22   配置单个商品
 *   node src/auto_delivery.js --all                 配置全部
 *   node src/auto_delivery.js --explore             只探路，输出页面结构
 */
const fs = require('fs');
const path = require('path');
const {
  launch, newPage, sleep, log, readJSON, writeJSON, DATA, OUT, shot,
} = require('./lib');

const SELLER_URL = 'https://seller.goofish.com/';
const LIST_FILE = path.join(DATA, 'listings.json');

/** 列出页面可见文本块，找锚点 */
async function findByText(page, texts, { exact = false } = {}) {
  for (const t of texts) {
    const loc = exact
      ? page.getByText(t, { exact: true }).first()
      : page.getByText(t).first();
    const n = await loc.count().catch(() => 0);
    if (n > 0) {
      const vis = await loc.isVisible().catch(() => false);
      if (vis) return loc;
    }
  }
  return null;
}

/** 探路：输出鱼小铺页面结构 */
async function explore(page) {
  const ui = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="menuitem"],li,div[class*="menu"],span[class*="item"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 20) return;
      out.push({ tag: el.tagName, txt: txt.slice(0, 20), cls: (el.className || '').toString().slice(0, 50) });
    });
    // 去重
    const seen = new Set();
    return out.filter((x) => {
      const k = x.tag + x.txt + x.cls;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
  console.log('--- 页面可交互元素 ---');
  ui.slice(0, 60).forEach((x) => console.log(`  ${x.tag.padEnd(12)} "${x.txt}"  cls=${x.cls}`));
  const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
  console.log('\n--- body 片段 ---\n' + body.slice(0, 900));
}

/**
 * 配置一个商品的自动发货
 * 步骤：商品管理 -> 找到目标商品 -> 编辑 -> 自动发货 -> 填内容 -> 启用 -> 保存
 */
async function configureOne(page, item) {
  log('info', `配置自动发货: ${item.xyTitle}`);

  // 1) 进入商品管理
  const menu = await findByText(page, ['商品管理', '商品', '我的商品'], { exact: true });
  if (!menu) {
    log('warn', '未找到「商品管理」入口，尝试直接找「发货」菜单');
  } else {
    await menu.click().catch(() => {});
    await sleep(2500);
  }
  await shot(page, `delivery_${item.slug}_menu`);

  // 2) 找到目标商品行
  const row = await page
    .locator(`text=${item.xyTitle.slice(0, 12)}`)
    .first()
    .count()
    .catch(() => 0);
  if (!row) {
    log('warn', `商品列表中未找到「${item.xyTitle}」，可能尚未发布成功或标题被改写`);
    return { ok: false, reason: 'item_not_found' };
  }

  // 3) 点「编辑」或商品名进入编辑页
  const edit = await findByText(page, ['编辑', '配置发货', '更多'], { exact: true });
  if (edit) {
    await edit.click().catch(() => {});
    await sleep(2500);
  }
  await shot(page, `delivery_${item.slug}_edit`);

  // 4) 找自动发货设置
  const auto = await findByText(page, ['自动发货', '发货设置', '付款后发货', '发货内容'], { exact: true });
  if (!auto) {
    log('warn', '未找到「自动发货」入口（可能未开通鱼小铺，或入口为纯图片按钮）');
    await shot(page, `delivery_${item.slug}_noauto`);
    return { ok: false, reason: 'no_auto_delivery_entry' };
  }
  await auto.click().catch(() => {});
  await sleep(2500);
  await shot(page, `delivery_${item.slug}_autopanel`);

  // 5) 填写发货内容
  const filled = await fillDeliveryContent(page, item.deliveryText);
  log(filled ? 'ok' : 'warn', `发货内容${filled ? '已填入' : '未找到输入框'}`);

  // 6) 启用开关
  const enabled = await toggleEnable(page);
  log(enabled ? 'ok' : 'warn', `启用开关${enabled ? '已打开' : '未找到'}`);

  // 7) 保存
  const saved = await clickSave(page);
  log(saved ? 'ok' : 'warn', `保存${saved ? '已点击' : '未找到按钮'}`);
  await sleep(2500);
  await shot(page, `delivery_${item.slug}_saved`);

  return { ok: filled && saved, reason: filled ? (saved ? '' : 'save_failed') : 'no_input' };
}

async function fillDeliveryContent(page, text) {
  const cands = [
    () => page.locator('textarea').first(),
    () => page.locator('input[placeholder*="发货"], input[placeholder*="内容"], input[placeholder*="卡密"], input[placeholder*="链接"]').first(),
    () => page.locator('[contenteditable="true"]').first(),
  ];
  for (const mk of cands) {
    const l = mk();
    if ((await l.count().catch(() => 0)) > 0) {
      await l.click().catch(() => {});
      await l.fill(text).catch(async () => {
        await page.keyboard.type(text, { delay: 2 });
      });
      return true;
    }
  }
  return false;
}

async function toggleEnable(page) {
  // 找 label 附近的 switch/checkbox
  const sw = page.locator('button[class*="switch"], [class*="switch"], input[type="checkbox"], [class*="Switch"]').first();
  if ((await sw.count().catch(() => 0)) > 0) {
    await sw.click().catch(() => {});
    await sleep(800);
    return true;
  }
  const txt = await findByText(page, ['启用', '开启'], { exact: true });
  if (txt) {
    await txt.click().catch(() => {});
    await sleep(800);
    return true;
  }
  return false;
}

async function clickSave(page) {
  for (const t of ['保存', '确定', '提交', '完成']) {
    const l = await findByText(page, [t], { exact: true });
    if (l) {
      await l.click().catch(() => {});
      return true;
    }
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const exploreMode = args.includes('--explore');
  const all = args.includes('--all');
  const slugIdx = args.indexOf('--slug');
  const only = slugIdx >= 0 ? args[slugIdx + 1] : null;

  const listings = readJSON(LIST_FILE, []);
  if (!listings.length) { console.error('listings.json 为空'); process.exit(1); }
  const targets = only ? listings.filter((l) => l.slug === only) : all ? listings : [];

  const ctx = await launch('fish', { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1500, height: 950 });

  await page.goto(SELLER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(4000);
  const body = ((await page.textContent('body').catch(() => '')) || '');
  if (/登录/.test(body.slice(0, 300))) {
    log('err', '鱼小铺未登录，请先运行: node src/login.js fish');
    await shot(page, 'seller_login_required');
    await ctx.close();
    process.exit(1);
  }
  log('ok', '鱼小铺已登录');

  if (exploreMode || !targets.length) {
    await explore(page);
    await shot(page, 'seller_explore');
    console.log('\n提示: 用 --slug <id> 或 --all 配置具体商品');
    await ctx.close();
    process.exit(0);
  }

  const results = [];
  for (const item of targets) {
    try {
      const r = await configureOne(page, item);
      results.push({ slug: item.slug, ...r });
    } catch (e) {
      log('err', `配置 ${item.slug} 异常: ${e.message.split('\n')[0]}`);
      results.push({ slug: item.slug, ok: false, reason: e.message.split('\n')[0] });
    }
    await sleep(3000);
  }

  writeJSON(path.join(OUT, 'delivery_results.json'), results);
  console.log('\n=== 自动发货配置结果 ===');
  results.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${r.slug} ${r.reason || ''}`));
  console.log('\n截图目录: shots/');
  await ctx.close();
  process.exit(0);
}

module.exports = { configureOne, explore, SELLER_URL };

if (require.main === module) main();
