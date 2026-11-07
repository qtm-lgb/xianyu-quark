'use strict';
/**
 * Ydisks 助手 —— 主动送链接给咨询过的买家
 *
 * 场景：买家咨询了「姜胡说合集」但没下单，按运营决定直接把链接送出去（不收钱）。
 *
 * 已核实的前提：
 *   - 链接 https://pan.quark.cn/s/3f05be5e6c5c 有效、永久有效、共 321 个文件 / 134.2M
 *   - 该分享未开启「1 人转存即失效」（share_config 里无 saveLimit 配置），
 *     所以同一个链接可以多人使用，不会被第一个人转存后抢光
 *
 * 用法:
 *   node tools/yd_send_free.js --dry-run   # 只看要发给谁、发什么
 *   node tools/yd_send_free.js             # 实际发送
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'http://127.0.0.1:59188/api/v1';
const ACCOUNT = '2419336374';
const ITEM = '1094008366209';
const ITEM_TITLE = '姜胡说合集 个人整理版';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');

const LINK = 'https://pan.quark.cn/s/3f05be5e6c5c';

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/** 送链接的话术
 *  数据均来自分享页实测：共 321 个文件 / 134.2M / 永久有效 / 顶层 1 个目录「姜胡说合集(3项)」
 *  内部 3 个子目录需在夸克 App 内展开才可见，网页端拿不到，故不编造具体分类名。
 */
const FREE_MSG =
  '您好，看到您咨询了这份资料，直接把链接发您，不收钱。\n' +
  `\n链接：${LINK}\n` +
  '夸克网盘 · 永久有效 · 共 321 个文件（134.2M）\n\n' +
  '使用方法：手机装「夸克网盘」App → 打开上面的链接 → 右上角「保存到网盘」，' +
  '保存到自己网盘后再打开，不占手机内存。建议尽早转存。\n\n' +
  '内容是个人整理的资料合集，顶层是一个「姜胡说合集」文件夹，' +
  '里面分了 3 个分类、合计 321 个文件，具体目录打开链接就能看到，' +
  '按目录取用即可。\n\n' +
  '资料仅供个人学习参考，禁止商用与二次传播。祝您使用愉快～';

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

/** 该买家是否已收到我们的客服话术（避免重复打扰） */
function alreadyReplied(session) {
  return session; // 占位，实际用 last_message 判断
}

(async () => {
  const dry = process.argv.includes('--dry-run');
  const sid = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8').trim() : null;
  if (!sid) { say('✗ 无 session，先跑 node tools/yd_session.js'); process.exit(1); }

  const chk = await api(sid, 'GET', '/session');
  if (!chk.json?.authenticated) { say('✗ session 失效，重新跑 tools/yd_session.js'); process.exit(1); }
  say(`✓ 认证: ${chk.json.username}`);

  // 取会话
  const sres = await api(sid, 'GET', `/chat/sessions?account_id=${ACCOUNT}`);
  const sessions = sres.json?.sessions || [];

  // 目标：咨询过「姜胡说合集」的买家（含已退款那位）
  const targets = sessions.filter((s) => s.item_id === ITEM);
  say(`咨询过该商品的会话: ${targets.length} 个`);

  // 取订单状态，标注是否已退款
  const ores = await api(sid, 'GET', `/orders?page=1&pageSize=50`);
  const orders = ores.json?.data || [];
  const orderByBuyer = new Map();
  for (const o of orders) {
    if (o.item_id === ITEM) orderByBuyer.set(String(o.buyer_id), o);
  }

  const list = [];
  for (const s of targets) {
    const o = orderByBuyer.get(String(s.buyer_id));
    const refunded = o && o.order_status === 'cancelled';
    list.push({
      chat_id: s.chat_id,
      buyer_id: s.buyer_id,
      buyer_name: s.buyer_name,
      last_message: String(s.last_message || ''),
      order_status: o ? o.order_status : '无订单',
      refunded,
    });
  }

  say('\n=== 发送名单 ===');
  for (const t of list) {
    const tag = t.refunded ? '已退款' : '未下单';
    say(`  ${t.buyer_name.padEnd(12)} ${tag.padEnd(8)} 订单=${t.order_status.padEnd(10)} last="${t.last_message.slice(0, 22)}"`);
  }

  if (dry) {
    say('\n--- dry-run，未发送。话术预览 ---');
    say(FREE_MSG);
    return;
  }

  say('\n=== 发送 ===');
  let ok = 0;
  for (const t of list) {
    const r = await api(sid, 'POST', '/chat/messages', {
      account_id: ACCOUNT,
      chat_id: t.chat_id,
      buyer_id: t.buyer_id,
      buyer_name: t.buyer_name,
      item_id: ITEM,
      item_title: ITEM_TITLE,
      text: FREE_MSG,
    });
    const sent = r.json?.message?.status === 'sent';
    if (sent) ok++;
    say(`  ${sent ? '✓' : '✗'} ${t.buyer_name} (${t.refunded ? '已退款' : '未下单'}): ${sent ? '已发送' : (r.json?.message || r.text).slice(0, 90)}`);
    await new Promise((s) => setTimeout(s, 2000));
  }
  say(`\n完成：成功 ${ok}/${list.length}`);
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
