'use strict';
/**
 * 打开 X 登录窗口，停在手机号输入页，等你手动完成登录。
 *
 * 用法: node src/login_x_manual.js
 *
 * 窗口里你会看到：
 *   1) 「使用手机继续」 -> 自动点开
 *   2) 区号默认 US +1 -> 你需要自己切成「中国 +86」（点 US 左边那个下拉箭头）
 *   3) 填手机号 -> 点「继续」
 *   4) 填短信验证码 -> 完成
 *
 * 登录成功后本窗口自动关闭，登录态写入 data/profile_x。
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, log, shot, DATA } = require('./lib');

const LOG = path.join(DATA, 'x_manual.log');
function say(m) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
}

(async () => {
  const ctx = await launch('x', { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(5000);

  // 自动点「使用手机继续」
  for (let i = 0; i < 12; i++) {
    const b = page.locator('text=使用手机继续').first();
    if ((await b.count().catch(() => 0)) > 0) {
      await b.click({ force: true, timeout: 5000 }).catch(() => {});
      say('已点「使用手机继续」，请在窗口里切区号+86并填手机号');
      break;
    }
    await sleep(2000);
  }
  await sleep(3000);
  await page.bringToFront().catch(() => {});
  await shot(page, 'x_manual_ready');

  console.log('\n' + '='.repeat(64));
  console.log('  X 登录窗口已打开（就在你的屏幕上）');
  console.log('');
  console.log('  请在这个 Chrome 窗口里完成：');
  console.log('    1) 区号从「US +1」切换成「中国 +86」（点 US 左侧的 ▼ 箭头）');
  console.log('    2) 输入手机号，点「继续」');
  console.log('    3) 输入收到的短信验证码，完成登录');
  console.log('');
  console.log('  登录成功后窗口会自动关闭，登录态保存到 data/profile_x');
  console.log('  本窗口最长保持 15 分钟');
  console.log('='.repeat(64) + '\n');

  const deadline = Date.now() + 15 * 60 * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(4000);
    try {
      const url = page.url();
      const cookies = await ctx.cookies('https://x.com');
      const hasAuth = cookies.some((c) => c.name === 'auth_token' && c.value);
      if (hasAuth && /\/home/.test(url)) {
        ok = true;
        say('✓ 登录成功: ' + url);
        await sleep(2000);
        await shot(page, 'x_manual_ok');
        break;
      }
    } catch { /* 跳转中 */ }
  }
  if (!ok) {
    say('✗ 超时未完成登录');
    await shot(page, 'x_manual_timeout');
  }
  await ctx.close();
  process.exit(ok ? 0 : 1);
})();
