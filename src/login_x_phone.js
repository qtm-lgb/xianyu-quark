'use strict';
/**
 * X 手机号登录助手（完整版）
 *
 * 流程：
 *   1) 打开登录页 -> 点「使用手机继续」
 *   2) 点区号下拉（US +1 旁边的箭头）-> 选中国 +86
 *   3) 填手机号 -> 点继续 -> 收短信验证码
 *   4) 填验证码 -> 登录成功
 *
 * 用法:
 *   node src/login_x_phone.js 13800138000          填号码，等你收验证码
 *   node src/login_x_phone.js 13800138000 123456   号码 + 验证码一次完成
 *   node src/login_x_phone.js --step state          只看当前状态
 */
const path = require('path');
const { launch, sleep, log, shot, DATA } = require('./lib');

const LOGIN_URL = 'https://x.com/i/flow/login';
const LOG = path.join(DATA, 'x_phone.log');

function say(m) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  try { require('fs').appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
}

/** 找到区号下拉并展开 */
async function openCountryPicker(page) {
  // 「US +1」文本所在的可点击容器
  const cands = [
    () => page.locator('[dir="ltr"]').first(),
    () => page.locator('span:has-text("+1")').first(),
    () => page.locator('div[role="button"]:has-text("+1")').first(),
  ];
  for (const mk of cands) {
    const l = mk();
    if ((await l.count().catch(() => 0)) > 0) {
      await l.click({ force: true, timeout: 5000 }).catch(() => {});
      await sleep(2500);
      // 展开后找搜索框或国家项
      const hasSearch = await page
        .locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="搜索"]')
        .count()
        .catch(() => 0);
      if (hasSearch) return 'picker+search';
      const cn = page.locator('text=China').first();
      if ((await cn.count().catch(() => 0)) > 0) {
        await cn.click({ force: true, timeout: 5000 }).catch(() => {});
        await sleep(1500);
        return 'picker+china';
      }
      return 'picker';
    }
  }
  return null;
}

/** 选中国 +86 */
async function selectChina(page) {
  const search = page
    .locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="搜索"]')
    .first();
  if ((await search.count().catch(() => 0)) > 0) {
    await search.fill('China').catch(() => {});
    await sleep(2000);
    for (const t of ['China +86', '中国 +86', 'China', '中国大陆']) {
      const l = page.locator(`text=${t}`).first();
      if ((await l.count().catch(() => 0)) > 0) {
        await l.click({ force: true, timeout: 5000 }).catch(() => {});
        await sleep(1500);
        say(`已选区号 (${t})`);
        return true;
      }
    }
  }
  // 无搜索框：直接在列表里找
  for (const t of ['China +86', 'China', '中国 +86']) {
    const l = page.locator(`text=${t}`).first();
    if ((await l.count().catch(() => 0)) > 0) {
      await l.click({ force: true, timeout: 5000 }).catch(() => {});
      await sleep(1500);
      say(`已选区号 (${t})`);
      return true;
    }
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const phone = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const code = args[1] && !args[1].startsWith('--') ? args[1] : null;

  const ctx = await launch('x', { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(4000);

  // 1) 使用手机继续
  let ok = false;
  for (let i = 0; i < 15; i++) {
    const b = page.locator('text=使用手机继续').first();
    if ((await b.count().catch(() => 0)) > 0) {
      await b.click({ force: true, timeout: 5000 }).catch(() => {});
      ok = true;
      break;
    }
    await sleep(2000);
  }
  say(ok ? '已进入手机登录' : '未找到「使用手机继续」');
  await sleep(4000);

  if (!phone) {
    const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
    console.log('当前 URL:', page.url());
    console.log('页面文本:', body.slice(0, 250));
    await shot(page, 'x_phone_state');
    await ctx.close();
    return;
  }

  // 2) 区号 -> 中国
  const picker = await openCountryPicker(page);
  say('区号下拉: ' + (picker || '未找到'));
  if (picker) {
    const cn = await selectChina(page);
    if (!cn) {
      say('未能自动选中国区号，请手动在窗口中切换');
      await shot(page, 'x_country_manual');
    }
  }

  // 3) 填号码
  const tel = page.locator('input[name="phone"]').first();
  const hasTel = (await tel.count().catch(() => 0)) > 0;
  if (!hasTel) {
    say('未找到手机号输入框');
    await shot(page, 'x_no_phone_input');
    await ctx.close();
    return;
  }
  await tel.click({ force: true }).catch(() => {});
  await tel.fill(phone).catch(async () => {
    await page.keyboard.type(phone, { delay: 30 });
  });
  say(`已填号码 ${phone}`);

  // 4) 继续
  const next = page.locator('text=继续').first();
  if ((await next.count().catch(() => 0)) > 0) {
    await next.click({ force: true, timeout: 5000 }).catch(() => {});
    await sleep(5000);
  }
  await shot(page, 'x_phone_sent');
  say('已提交号码，请查收短信验证码');

  // 5) 验证码
  if (code) {
    await sleep(3000);
    const codeInput = page
      .locator('input[name="code"], input[autocomplete="one-time-code"]')
      .first();
    const target = (await codeInput.count().catch(() => 0)) > 0
      ? codeInput
      : page.locator('input[type="text"]').first();
    await target.click({ force: true }).catch(() => {});
    await target.fill(code).catch(async () => {
      await page.keyboard.type(code, { delay: 30 });
    });
    await sleep(800);
    const submit = page.locator('text=继续, text=登录, text=Log in, text=提交').first();
    if ((await submit.count().catch(() => 0)) > 0) {
      await submit.click({ force: true, timeout: 5000 }).catch(() => {});
    }
    await sleep(6000);
    await shot(page, 'x_login_result');
    const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
    say('登录后 URL: ' + page.url());
    say('是否出现首页: ' + (/\/home/.test(page.url()) ? '是' : '否'));
  }

  const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
  console.log('当前 URL:', page.url());
  console.log('页面文本:', body.slice(0, 200));
  await ctx.close();
}

module.exports = { main };
if (require.main === module) main();
