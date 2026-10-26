'use strict';
/**
 * 登录引导 v2 —— 用独立浏览器窗口 + 明确的用户提示
 *
 * 相比 v1 的改进：
 *   - 日志实时落盘到 data/login_<kind>.log，便于随时查看进度
 *   - 窗口置前 + 独立 profile，避免和用户日常浏览器抢占
 *   - 同时检测 URL 与页面文本，覆盖多种登录完成形态
 *
 * 用法: node src/login.js x | fish | both
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, log, DATA, shot } = require('./lib');

/** 轮询等待某个文本出现并点击（SPA 渲染慢，一次性查会漏） */
async function waitAndClick(page, texts, { timeout = 40000, interval = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const t of texts) {
      const loc = page.locator(`text=${t}`).first();
      const n = await loc.count().catch(() => 0);
      if (n > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click({ timeout: 5000, force: true }).catch(() => {});
        await sleep(3000);
        return t;
      }
    }
    await sleep(interval);
  }
  return null;
}

/** 在所有 frame（含跨域）里查找文本 */
async function findInFrames(page, texts) {
  for (const f of page.frames()) {
    for (const t of texts) {
      const loc = f.locator(`text=${t}`).first();
      const n = await loc.count().catch(() => 0);
      if (n > 0 && (await loc.isVisible().catch(() => false))) return { frame: f, text: t, loc };
    }
  }
  return null;
}

const TARGETS = {
  x: {
    url: 'https://x.com/i/flow/login',
    label: 'X (Twitter)',
    // 登录完成标志
    isDone: (url, body) =>
      /\/home(\?|$)/.test(url) ||
      (/Search|搜索/.test(body) && !/Sign in|Log in/.test(body.slice(0, 300))),
    // 点开扫码/手机登录入口
    prepare: async (page) => {
      const hit = await waitAndClick(page, ['使用手机继续', 'Continue with phone', '使用手机号继续']);
      if (hit) return hit;
      // 兜底：按坐标点第一个黑色大按钮
      const btn = page.locator('button, [role="button"]').filter({ hasText: /手机/ }).first();
      if ((await btn.count().catch(() => 0)) > 0) {
        await btn.click({ timeout: 5000, force: true }).catch(() => {});
        await sleep(3000);
        return '手机继续(兜底)';
      }
      return null;
    },
  },
  fish: {
    url: 'https://www.goofish.com/publish',
    label: '闲鱼',
    isDone: (url, body) =>
      /发闲置/.test(body) && !/立即登录/.test(body.slice(0, 400)),
    prepare: async (page) => {
      // 闲鱼未登录时底部有「立即登录」按钮，点击后弹出淘宝登录 iframe
      const hit = await waitAndClick(page, ['立即登录'], { timeout: 30000 });
      if (!hit) return null;
      await sleep(4000);
      // 在 iframe 里找扫码页签
      const inFrame = await findInFrames(page, ['扫码登录', '二维码登录', '支付宝登录']);
      if (inFrame) {
        await inFrame.loc.click({ timeout: 5000, force: true }).catch(() => {});
        await sleep(2000);
        return `${hit} + iframe:${inFrame.text}`;
      }
      return hit;
    },
  },
};

async function doLogin(kind) {
  const t = TARGETS[kind];
  const logFile = path.join(DATA, `login_${kind}.log`);
  const say = (m) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  };

  say(`打开 ${t.label} 登录窗口: ${t.url}`);
  const ctx = await launch(kind, { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1280, height: 900 });

  // 尝试置前
  await page.bringToFront().catch(() => {});
  await page.goto(t.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(2000);
  await page.bringToFront().catch(() => {});

  say(`>>> 请切到弹出的 Chrome 窗口完成 ${t.label} 登录（扫码即可）。`);
  say(`>>> 本窗口会保持 8 分钟，完成后自动关闭。进度可查看: ${logFile}`);

  // 点开扫码入口
  if (t.prepare) {
    const clicked = await t.prepare(page).catch(() => null);
    if (clicked) say(`已点击「${clicked}」，请在窗口中扫码登录`);
    else say('未找到扫码入口按钮，请手动在窗口中操作');
    await shot(page, `login_${kind}_ready`);
  }

  const deadline = Date.now() + 8 * 60 * 1000;
  let ok = false;
  let lastUrl = '';
  let lastShot = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
      const url = page.url();
      if (url !== lastUrl) { say(`页面: ${url.slice(0, 90)}`); lastUrl = url; }
      if (t.isDone(url, body)) {
        ok = true;
        say(`✓ ${t.label} 登录成功: ${url}`);
        await sleep(2500);
        await shot(page, `login_${kind}_ok`);
        break;
      }
      // 每 30 秒存一张当前画面，方便随时查看进度
      if (Date.now() - lastShot > 30000) {
        lastShot = Date.now();
        await shot(page, `login_${kind}_progress`);
      }
    } catch { /* 跳转中 */ }
  }
  if (!ok) {
    say(`✗ ${t.label} 未检测到登录成功（超时）。当前页面: ${lastUrl}`);
    await shot(page, `login_${kind}_timeout`);
  }
  await ctx.close();
  return ok;
}

(async () => {
  const which = process.argv[2] || 'both';
  const kinds = which === 'both' ? ['x', 'fish'] : [which];
  for (const k of kinds) {
    if (!TARGETS[k]) { console.error(`未知目标: ${k}`); process.exit(1); }
    await doLogin(k);
  }
  process.exit(0);
})();
