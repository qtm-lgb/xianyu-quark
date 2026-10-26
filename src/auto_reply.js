'use strict';
/**
 * 自动发货兜底 —— 监控闲鱼消息中心，识别新订单并自动回复发货内容
 *
 * 场景：账号没开通鱼小铺，平台没有原生自动发货能力时，用脚本接管。
 *
 * 已按真实 DOM 对齐（2026-10 实测）：
 *   - 会话列表项： [class*="conversation-item--"]
 *   - 需要先点开会话，聊天输入框才会出现
 *
 * 用法:
 *   node src/auto_reply.js              # 常驻监听（Ctrl+C 退出）
 *   node src/auto_reply.js --once       # 只扫一轮
 *   node src/auto_reply.js --dry-run    # 只识别不发送
 */
const fs = require('fs');
const path = require('path');
const {
  launch, sleep, log, readJSON, writeJSON, DATA, OUT, shot,
} = require('./lib');

const IM_URL = 'https://www.goofish.com/im';

/** 判定为「需要发货」的关键词 */
const ORDER_PATTERNS = [
  /拍下/i, /已拍/i, /已付款/i, /付款了/i, /已支付/i, /已下单/i,
  /请发货/i, /发货/i, /什么时候发/i, /怎么下载/i, /链接/i, /资料/i, /怎么拿/i,
];

/** 纯闲聊、无需发货的关键词（优先级更高） */
const CHAT_PATTERNS = [
  /你好/, /在吗/, /在么/, /谢谢/, /收到/, /好的/, /多少钱/, /还有吗/,
  /在的/, /嗯/, /ok/i, /稍等/, /你好呀/,
];

/** 从消息文本里认出商品标题 -> 匹配 listing */
function matchListing(text, listings, { fallback = true } = {}) {
  if (!text) return null;
  let best = null;
  let bestScore = 0;
  for (const l of listings) {
    const t = (l.xyTitle || '').replace(/个人整理版/g, '').trim();
    if (!t) continue;
    for (let len = Math.min(t.length, 12); len >= 4; len--) {
      for (let i = 0; i + len <= t.length; i++) {
        const frag = t.slice(i, i + len);
        if (frag.length >= 4 && text.includes(frag)) {
          if (frag.length > bestScore) { bestScore = frag.length; best = l; }
          break;
        }
      }
      if (bestScore >= len) break;
    }
  }
  if (best) return best;
  // 兜底：店铺只有一两个在售商品时，买家只说「已拍下」不带商品名，
  // 也应该把唯一的商品发过去（虚拟资料店通常就卖这一个）
  if (fallback && listings.length === 1) return listings[0];
  return null;
}

/** 抓取会话列表 */
async function harvestConversations(page) {
  const items = await page.evaluate(() => {
    const out = [];
    const nodes = document.querySelectorAll('[class*="conversation-item--"]');
    nodes.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!txt) return;
      out.push({ text: txt.slice(0, 300) });
    });
    return out;
  }).catch(() => []);
  const seen = new Set();
  return items.filter((x) => {
    const k = x.text.slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 点开会话，返回聊天区是否就绪 */
async function openConversation(page, keyword) {
  const loc = page.locator(`[class*="conversation-item--"]:has-text("${keyword}")`).first();
  if ((await loc.count().catch(() => 0)) === 0) return false;
  await loc.click({ force: true }).catch(() => {});
  await sleep(2500);
  return true;
}

/** 在聊天区找输入框并发送消息 */
async function sendMessage(page, text) {
  const input = page.locator(
    'textarea, [contenteditable="true"], input[placeholder*="消息"], input[placeholder*="说"], textarea[placeholder*="消息"]'
  );
  const n = await input.count().catch(() => 0);
  if (n === 0) return false;
  // 取最后一个可见的（通常是聊天输入框）
  for (let i = n - 1; i >= 0; i--) {
    const el = input.nth(i);
    const vis = await el.isVisible().catch(() => false);
    if (!vis) continue;
    await el.click({ force: true }).catch(() => {});
    await sleep(600);
    await el.fill(text).catch(async () => {
      await page.keyboard.type(text, { delay: 10 });
    });
    await sleep(600);
    // 发送按钮
    const btn = page.locator('text=发送, button:has-text("发送"), [class*="send"]').first();
    if ((await btn.count().catch(() => 0)) > 0) {
      await btn.click({ force: true, timeout: 5000 }).catch(() => {});
    } else {
      await page.keyboard.press('Enter').catch(() => {});
    }
    await sleep(1800);
    return true;
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const dryRun = args.includes('--dry-run');

  const listings = readJSON(path.join(DATA, 'listings.json'), []);
  if (!listings.length) {
    console.error('listings.json 为空，先跑 build_listings.js');
    process.exit(1);
  }
  log('ok', `已加载 ${listings.length} 个商品的发货内容`);

  const ctx = await launch('fish', { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1500, height: 1000 });

  await page.goto(IM_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(7000);
  const body = ((await page.textContent('body').catch(() => '')) || '');
  if (/立即登录/.test(body.slice(0, 400))) {
    log('err', '闲鱼未登录，请先运行 node src/login_fish_qr.js');
    await ctx.close();
    process.exit(1);
  }
  log('ok', '消息中心已加载，开始监听');

  const sentLog = readJSON(path.join(OUT, 'auto_reply_log.json'), []);
  const sent = new Set(sentLog.map((x) => x.key));

  const deadline = once ? Date.now() + 15000 : Date.now() + 24 * 60 * 60 * 1000;
  let cycle = 0;
  while (Date.now() < deadline) {
    cycle++;
    await sleep(once ? 2000 : 8000);
    const convs = await harvestConversations(page);
    if (!convs.length) continue;

    for (const c of convs) {
      const text = c.text;
      const key = text.slice(0, 80);
      if (sent.has(key)) continue;

      // 纯闲聊跳过（但仍标记，避免反复判定）
      if (CHAT_PATTERNS.some((p) => p.test(text)) && !/链接|发货|拍下|付款|资料/.test(text)) {
        sent.add(key);
        sentLog.push({ key, at: new Date().toISOString(), action: 'skip_chat', text: text.slice(0, 120) });
        continue;
      }
      if (!ORDER_PATTERNS.some((p) => p.test(text))) continue;

      // 提取会话名（第一段）
      const convName = text.split(/\s+/)[0];
      const item = matchListing(text, listings);
      if (!item) {
        log('warn', `疑似订单但未匹配到商品: ${text.slice(0, 50)}`);
        sent.add(key);
        sentLog.push({ key, at: new Date().toISOString(), action: 'no_match', text: text.slice(0, 120) });
        continue;
      }

      log('ok', `匹配订单: ${item.xyTitle} (会话「${convName}」)`);
      if (dryRun) {
        console.log(`\n[DRY-RUN] 识别到订单 -> ${item.xyTitle}`);
        console.log(`  将回复:\n${item.deliveryText.split('\n').map((l) => '    ' + l).join('\n')}`);
        sent.add(key);
        sentLog.push({ key, at: new Date().toISOString(), action: 'dryrun', slug: item.slug });
        continue;
      }

      // 点开会话 -> 发消息
      await openConversation(page, convName);
      const ok = await sendMessage(page, item.deliveryText);
      log(ok ? 'ok' : 'err', ok ? `已自动发货: ${item.slug}` : '发送失败');
      sent.add(key);
      sentLog.push({ key, at: new Date().toISOString(), action: ok ? 'sent' : 'send_failed', slug: item.slug, conv: convName });
      writeJSON(path.join(OUT, 'auto_reply_log.json'), sentLog);
      await shot(page, `auto_reply_${item.slug}`);
      await sleep(2500);
    }
    if (once) break;
    if (cycle % 15 === 0) log('info', `仍在监听中（第 ${cycle} 轮）`);
  }

  writeJSON(path.join(OUT, 'auto_reply_log.json'), sentLog);
  log('ok', `结束，共处理 ${sentLog.length} 条`);
  await ctx.close();
  process.exit(0);
}

module.exports = { matchListing, harvestConversations, sendMessage, openConversation, ORDER_PATTERNS };

if (require.main === module) main();
