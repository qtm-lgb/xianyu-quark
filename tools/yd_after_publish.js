'use strict';
/**
 * 等批量上架完成后，自动配置 Ydisks 发货规则
 *
 * 背景：Ydisks 建规则前必须先把商品同步进它的 item_info 表，
 *      同步是阻塞式的（驱动浏览器翻页），要等上架全部完成再跑才稳。
 *
 * 用法: node tools/yd_after_publish.js [--wait-minutes 30]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIST_FILE = path.join(ROOT, 'data', 'listings.json');
const BASE = 'http://127.0.0.1:59188/api/v1';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(session, method, endpoint, body) {
  const r = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      cookie: `session=${session}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}

(async () => {
  const args = process.argv.slice(2);
  const wIdx = args.indexOf('--wait-minutes');
  const waitMin = wIdx >= 0 ? parseInt(args[wIdx + 1], 10) : 30;

  const total = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')).length;
  say(`等待批量上架完成（目标 ${total} 个，最多等 ${waitMin} 分钟）`);

  const deadline = Date.now() + waitMin * 60 * 1000;
  let last = -1;
  while (Date.now() < deadline) {
    const l = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
    const done = l.filter((x) => x.itemId).length;
    if (done !== last) {
      say(`进度 ${done}/${total}`);
      last = done;
    }
    if (done >= total) break;
    await sleep(20000);
  }

  const l = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  const done = l.filter((x) => x.itemId).length;
  if (done < total) {
    say(`超时：只完成 ${done}/${total}，仍继续配置已完成的`);
  }

  const session = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8').trim() : null;
  if (!session) { say('✗ 无 Ydisks session'); process.exit(1); }
  const chk = await api(session, 'GET', '/session');
  if (!chk.json?.authenticated) { say('✗ session 失效'); process.exit(1); }

  // 同步商品到 Ydisks（阻塞，等它完成）
  say('\n同步商品到 Ydisks（会驱动浏览器翻页，需要几分钟）...');
  const t0 = Date.now();
  try {
    const r = await api(session, 'POST', '/items/get-all-from-account', { cookie_id: '2419336374' });
    say(`同步返回 HTTP ${r.status}，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    say('同步请求异常: ' + e.message.slice(0, 60));
  }

  // 校验商品数
  const items = await api(session, 'GET', '/items?cookie_id=2419336374&page=1&page_size=200');
  const list = Array.isArray(items.json) ? items.json : (items.json?.data?.items || items.json?.data || []);
  say(`Ydisks 现有商品: ${list.length} 个`);

  // 配置发货规则
  say('\n配置卡密与自动发货规则...');
  execFileSync(process.execPath, [path.join(__dirname, 'yd_setup_courses.js')], {
    cwd: ROOT, stdio: 'inherit',
  });

  say('\n完成');
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
