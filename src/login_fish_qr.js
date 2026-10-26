'use strict';
/**
 * 闲鱼扫码登录（直接走 passport.goofish.com 二维码接口）
 *
 * 闲鱼网页版的登录框渲染有问题（弹层出不来），但底层二维码接口是通的：
 *   1) GET  .../newlogin/qrcode/generate.do   -> lgToken + ck
 *   2) POST .../newlogin/qrcode/query.do      -> 轮询扫码状态
 *   3) 扫码成功后把 cookie 注入浏览器 profile
 *
 * 用法:
 *   node src/login_fish_qr.js          拉二维码，等你扫
 *   node src/login_fish_qr.js --code 123456   用短信验证码登录（备用）
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, log, shot, DATA } = require('./lib');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const QR_IMG = path.join(DATA, 'xianyu_login_qr.png');

/** 把二维码链接渲染成 PNG（用浏览器画，避免依赖 qrcode 库） */
async function renderQr(codeContent, outFile) {
  const { chromium } = require('playwright');
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 420, height: 420 } });
  // 用 qrcode-generator 的 CDN 版（离线环境回退到纯色提示图）
  const html = `<!doctype html><html><body style="margin:0;background:#fff">
  <div id="q" style="width:400px;height:400px;display:flex;align-items:center;justify-content:center"></div>
  <script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"></script>
  <script>
    try{
      var qr=qrcode(0,'M'); qr.addData(${JSON.stringify(codeContent)}); qr.make();
      document.getElementById('q').innerHTML=qr.createSvgTag({cellSize:8,margin:0});
    }catch(e){ document.getElementById('q').innerHTML='<div style="font:14px sans-serif;padding:20px">二维码已生成，请在浏览器中用淘宝App扫码</div>'; }
  </script></body></html>`;
  await p.setContent(html, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  await sleep(1200);
  await p.screenshot({ path: outFile, clip: { x: 10, y: 10, width: 400, height: 400 } }).catch(() => {});
  await b.close();
  return outFile;
}

async function main() {
  const args = process.argv.slice(2);
  const codeIdx = args.indexOf('--code');
  const smsCode = codeIdx >= 0 ? args[codeIdx + 1] : null;

  // 1) 启动浏览器，拿到干净的会话
  const ctx = await launch('fish', { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('https://www.goofish.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(4000);

  // 2) 在浏览器上下文里请求二维码（自动带上浏览器的 cookie 与 csrf）
  const qrRes = await page.evaluate(async () => {
    const csrf = (document.cookie.match(/_csrf_token=([^;]+)/) || [])[1] || '';
    const r = await fetch(
      `https://passport.goofish.com/newlogin/qrcode/generate.do?appName=xianyu&fromSite=77&appEntrance=web&_csrf_token=${csrf}`,
      { credentials: 'include' }
    );
    const t = await r.text();
    try { return JSON.parse(t); }
    catch { return { error: 'non-json: ' + t.slice(0, 120) }; }
  }).catch((e) => ({ error: e.message }));

  const data = qrRes && qrRes.content && qrRes.content.data;
  if (!data || !data.codeContent) {
    log('err', '获取二维码失败: ' + JSON.stringify(qrRes).slice(0, 200));
    await ctx.close();
    process.exit(1);
  }
  log('ok', '二维码已获取');

  // 3) 渲染二维码图片
  const qrFile = await renderQr(data.codeContent, QR_IMG);
  log('ok', `二维码图片: ${qrFile}`);
  console.log('\n' + '='.repeat(60));
  console.log('  请用【手机淘宝 App】扫描下方二维码登录闲鱼');
  console.log('  （二维码图片已保存：' + QR_IMG + '）');
  console.log('='.repeat(60) + '\n');

  // 4) 轮询扫码状态
  const deadline = Date.now() + 15 * 60 * 1000;
  let done = false;
  while (Date.now() < deadline) {
    await sleep(3000);
    const st = await page.evaluate(async (lgToken) => {
      const csrf = (document.cookie.match(/_csrf_token=([^;]+)/) || [])[1] || '';
      const r = await fetch(
        `https://passport.goofish.com/newlogin/qrcode/query.do?appName=xianyu&fromSite=77&lgToken=${encodeURIComponent(lgToken)}&_csrf_token=${csrf}`,
        { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' } }
      );
      const t = await r.text();
      try { return JSON.parse(t); } catch { return null; }
    }, data.codeContent.split('lgToken=')[1] || '').catch(() => null);

    const d = st && st.content && st.content.data;
    if (!d) continue;
    const rc = d.resultCode;
    if (rc === 0) {
      log('ok', '扫码成功，正在同步登录态...');
      await page.goto('https://www.goofish.com/publish', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(4000);
      const body = ((await page.textContent('body').catch(() => '')) || '');
      if (!/立即登录/.test(body.slice(0, 400))) {
        done = true;
        await shot(page, 'fish_qr_logged_in');
        log('ok', '✓ 闲鱼登录成功！登录态已写入 data/profile_fish');
        break;
      }
    } else if (rc === 100) {
      // 等待扫码
    } else if (rc === 101) {
      log('warn', '二维码已过期，请重跑脚本');
      break;
    } else if (d.prompt || d.showErrMsg) {
      log('warn', `扫码状态: ${d.prompt || d.showErrMsg}`);
    }
  }

  if (!done) {
    log('warn', '未在时限内完成扫码登录');
    await shot(page, 'fish_qr_timeout');
  }
  await ctx.close();
  process.exit(done ? 0 : 1);
}

module.exports = { main };
if (require.main === module) main();
