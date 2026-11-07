'use strict';
/**
 * Ydisks 助手 —— 补发历史未回复的咨询消息
 *
 * 背景：配置自动客服之前，有 6 个买家问了「姜胡说合集」但没人回。
 * 配置已就绪，这里用同样的客服话术补发，避免冷处理丢单。
 *
 * 用法: node tools/yd_reply_pending.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'http://127.0.0.1:59188/api/v1';
const ACCOUNT = '2419336374';
const ITEM = '1094008366209';
const ITEM_TITLE = '姜胡说合集 个人整理版';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

const REPLY =
  '您好，这份是个人整理版的学习资料合集，内容较多。\n' +
  '拍下后我会把夸克网盘链接和提取码直接发您，按目录对应取用即可。\n' +
  '建议拍之前先留言说明您主要需要哪部分，我确认后再发，避免重复下单哦~';

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
  const dry = process.argv.includes('--dry-run');
  const session = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8').trim() : null;
  if (!session) { say('✗ 无 session，先跑 node tools/yd_session.js'); process.exit(1); }

  const chk = await api(session, 'GET', '/session');
  if (!chk.json?.authenticated) { say('✗ session 失效，重新跑 tools/yd_session.js'); process.exit(1); }
  say(`✓ 认证: ${chk.json.username}`);

  // 取会话
  const sres = await api(session, 'GET', `/chat/sessions?account_id=${ACCOUNT}`);
  const sessions = sres.json?.sessions || [];
  say(`会话总数: ${sessions.length}`);

  // 找出该商品、且最后一条是买家提问（未回复）的会话
  const targets = sessions.filter((s) => {
    if (s.item_id !== ITEM) return false;
    const lm = String(s.last_message || '');
    // 排除通知类、订单状态类，以及已经由我方回复过的（last_message 以「您好，这里是」开头）
    if (!lm) return false;
    if (lm.startsWith('[')) return false;                       // [我发起了退款申请] 等系统消息
    if (/我发起了|交易成功|订单即将|有新交易评价/.test(lm)) return false;
    if (/^您好，(这里|这份)/.test(lm)) return false;            // 已经是我们的客服话术
    return true;
  });

  say(`待补发会话: ${targets.length} 个`);
  for (const t of targets) {
    say(`  - ${t.buyer_name} (chat=${t.chat_id}) 问: ${String(t.last_message).slice(0, 24)}`);
  }

  if (dry) { say('dry-run，未发送'); return; }

  for (const t of targets) {
    const r = await api(session, 'POST', '/chat/messages', {
      account_id: ACCOUNT,
      chat_id: t.chat_id,
      buyer_id: t.buyer_id,
      buyer_name: t.buyer_name,
      item_id: t.item_id,
      item_title: t.item_title || ITEM_TITLE,
      text: REPLY,
    });
    const ok = r.json?.message?.status === 'sent';
    say(`  ${ok ? '✓' : '✗'} ${t.buyer_name}: ${ok ? '已发送' : r.json?.message || r.text.slice(0, 90)}`);
    await new Promise((s) => setTimeout(s, 1500));
  }
  say('完成');
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
