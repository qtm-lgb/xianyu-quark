'use strict';
/**
 * 公共库：浏览器上下文（持久化登录态）、UA、日志、限速、文件工具
 *
 * 关键点：必须用 channel:'chrome' 启动系统 Chrome，而不是 Playwright 自带的 Chromium。
 * 原因：X 需要走系统代理，bundled Chromium 不继承 Windows 系统代理设置，
 *      自带 Chromium 版本也与本机已装浏览器不匹配。
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'out');
const SHOTS = path.join(ROOT, 'shots');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const PROFILE = {
  x: path.join(DATA, 'profile_x'),
  fish: path.join(DATA, 'profile_fish'),
};

function ensureDirs() {
  for (const d of [DATA, OUT, SHOTS]) fs.mkdirSync(d, { recursive: true });
}

/**
 * 启动持久化上下文，登录一次后续复用
 *
 * 代理策略：
 *   - 默认继承 Windows 系统代理（channel:'chrome' 的行为）
 *   - 若设置了 X_PROXY 环境变量或传入 proxy，则显式指定（更可靠，
 *     因为系统代理经常指向不通的端口）
 */
async function launch(kind, { headless = true, proxy = null } = {}) {
  ensureDirs();
  const userDataDir = PROFILE[kind];
  fs.mkdirSync(userDataDir, { recursive: true });
  const explicitProxy = proxy || process.env.X_PROXY || null;
  const opts = {
    channel: 'chrome',
    headless,
    userAgent: UA,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  };
  if (explicitProxy) {
    opts.proxy = { server: explicitProxy };
    // 显式代理时把系统代理也带上，避免 PAC 干扰
    opts.args.push(`--proxy-server=${explicitProxy}`);
  }
  const ctx = await chromium.launchPersistentContext(userDataDir, opts);
  ctx.setDefaultTimeout(30000);
  ctx.setDefaultNavigationTimeout(45000);
  return ctx;
}

/** 新页面（复用已有 context 的登录态） */
async function newPage(ctx, url) {
  const p = await ctx.newPage();
  if (url) {
    await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带重试的操作 */
async function retry(fn, { times = 3, delay = 1500, label = 'op' } = {}) {
  let lastErr;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      log(`warn`, `${label} 第${i}次失败: ${e.message.split('\n')[0]}`);
      if (i < times) await sleep(delay * i);
    }
  }
  throw lastErr;
}

/** 限速器，避免触发平台风控 */
function makeThrottle(minGapMs = 2500) {
  let last = 0;
  return async function throttle(label = '') {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    if (label) log('info', `节奏控制: ${label}`);
  };
}

const ts = () => new Date().toISOString().slice(11, 23);
function log(level, msg) {
  const tag = { info: 'INFO ', warn: 'WARN ', ok: 'OK   ', err: 'ERROR' }[level] || 'INFO ';
  console.log(`[${ts()}] ${tag} ${msg}`);
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function config() {
  const f = path.join(DATA, 'config.json');
  if (!fs.existsSync(f)) {
    const def = {
      keywords: ['夸克网盘', '夸克 资料', 'pan.quark.cn'],
      price: 1.9,
      category: '图书音像/电子资料',
      shipping: '无需邮寄',
    };
    writeJSON(f, def);
    return def;
  }
  return readJSON(f, {});
}

async function shot(page, name) {
  ensureDirs();
  const p = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

module.exports = {
  ROOT, DATA, OUT, SHOTS, UA, PROFILE,
  ensureDirs, launch, newPage, sleep, retry, makeThrottle,
  log, readJSON, writeJSON, config, shot,
};
