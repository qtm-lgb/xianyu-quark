'use strict';
/**
 * 夸克网盘登录引导（扫码）
 *
 * 用持久化 profile 保存登录态，后续所有网盘操作复用。
 * 登录成功后缓存 profile 路径，供其他脚本使用。
 *
 * 用法: node tools/quark_login.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE = path.join(os.homedir(), '.workbuddy', 'quark-profile');
const URL = 'https://pan.quark.cn/list#/list/all/a1031f76d30541b2bb7fa700182171e4-JonnyShares';

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/** 判断是否已登录（能拿到用户信息接口）
 *  注意：登录成功时页面会跳 hash 路由，evaluate 的执行上下文会被销毁，
 *  所以必须捕获异常并重试，不能让异常冒泡。
 */
async function isLoggedIn(page) {
  try {
    const r = await page.evaluate(async () => {
      try {
        const resp = await fetch('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc', {
          credentials: 'include',
        });
        const j = await resp.json().catch(() => null);
        return {
          status: resp.status,
          member: j && (j.data?.member_type || null),
          nickname: j?.data?.nickname || null,
        };
      } catch (e) {
        return { error: e.message.slice(0, 80) };
      }
    });
    return r;
  } catch (e) {
    // 上下文销毁 = 页面正在跳转，等一下再来
    return { busy: true, error: e.message.split('\n')[0].slice(0, 60) };
  }
}

/** 用独立请求上下文查登录态（不受页面跳转影响，更稳） */
async function checkLoginViaApi(ctx) {
  try {
    const r = await ctx.request.get('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc', {
      headers: { accept: 'application/json' },
      timeout: 8000,
    });
    const j = await r.json().catch(() => null);
    return {
      status: r.status(),
      member: j?.data?.member_type || null,
      nickname: j?.data?.nickname || null,
    };
  } catch (e) {
    return { error: e.message.slice(0, 60) };
  }
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    viewport: { width: 1400, height: 950 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(6000);

  let st = await checkLoginViaApi(ctx);
  if (st.member || st.nickname) {
    say(`✓ 已是登录态: ${st.nickname || st.member}`);
  } else {
    console.log('\n' + '='.repeat(66));
    console.log('  请在弹出的 Chrome 窗口用夸克 App / 夸克网盘 App 扫码登录');
    console.log('  （二维码区域已另存为 shots/quark_login_qr.png）');
    console.log('  登录后本窗口会自动继续');
    console.log('='.repeat(66) + '\n');
    // 截取登录二维码，方便直接扫码
    await sleep(2500);
    const qr = page.locator('canvas, [class*="qrcode"], [class*="qr-code"], img[src*="qr"]').first();
    if (await qr.count().catch(() => 0)) {
      await qr.screenshot({ path: 'shots/quark_login_qr.png' }).catch(async () => {
        await page.screenshot({ path: 'shots/quark_login_qr.png' }).catch(() => {});
      });
      say('二维码已保存: shots/quark_login_qr.png');
    } else {
      await page.screenshot({ path: 'shots/quark_login_qr.png' }).catch(() => {});
      say('登录页截图: shots/quark_login_qr.png');
    }
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(4000);
      st = await checkLoginViaApi(ctx);
      if (st.member || st.nickname) {
        say(`✓ 登录成功: ${st.nickname || st.member}`);
        break;
      }
      // 页面内再确认一次（覆盖 cookie 已写入但请求上下文未同步的情况）
      const inPage = await isLoggedIn(page);
      if (inPage.member || inPage.nickname) {
        say(`✓ 登录成功: ${inPage.nickname || inPage.member}`);
        st = inPage;
        break;
      }
    }
    if (!st.member && !st.nickname) {
      say('✗ 登录超时');
      await ctx.close();
      process.exit(1);
    }
  }

  // 记录登录态标记，供其他脚本判断
  fs.writeFileSync(path.join(PROFILE, '.logged_in'), '1', 'utf8');
  say(`profile: ${PROFILE}`);
  await page.screenshot({ path: 'shots/quark_logged_in.png' }).catch(() => {});
  await ctx.close();
  say('完成，登录态已保存');
  process.exit(0);
})();
