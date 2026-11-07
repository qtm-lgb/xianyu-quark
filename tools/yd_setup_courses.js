'use strict';
/**
 * Ydisks —— 为夸克课程批量建卡密 + 付款自动发货规则
 *
 * 输入：data/listings.json
 * 动作：每个 listing 建一条卡密（网盘链接+提取码）+ 一条 order_paid 规则
 *       并按商品标题关键词补充客服规则
 *
 * 用法:
 *   node tools/yd_setup_courses.js --dry-run
 *   node tools/yd_setup_courses.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'http://127.0.0.1:59188/api/v1';
const ACCOUNT = '2419336374';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');
const LIST_FILE = path.join(__dirname, '..', 'data', 'listings.json');

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

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

/** 卡密内容：链接 + 提取码 + 使用说明 + 合规声明 */
function cardContent(l) {
  return (
    `您好，资料已整理好，链接如下：\n\n` +
    `链接：${l.sourceLink}\n` +
    (l.code ? `提取码：${l.code}\n` : '') +
    (l.fileCount ? `\n共 ${l.fileCount} 个文件，打开云端链接后按目录对应取用即可。\n` : '\n') +
    `本资料仅供个人学习参考，禁止商用与二次传播。\n` +
    `如遇链接打开异常请随时留言，会第一时间补发。`
  );
}

(async () => {
  const dry = process.argv.includes('--dry-run');
  const sid = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8').trim() : null;
  if (!sid) { say('✗ 无 session，先跑 node tools/yd_session.js'); process.exit(1); }
  const chk = await api(sid, 'GET', '/session');
  if (!chk.json?.authenticated) { say('✗ session 失效'); process.exit(1); }
  say(`✓ 认证: ${chk.json.username}`);

  const all = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  // 只处理已上架（有 itemId）的商品
  // 排除被平台处罚过的商品：不上架也不配自动发货规则
  const listings = all.filter((x) => x.itemId && !x.penalized && !x.skipPublish);
  const penalized = all.filter((x) => x.penalized || (x.skipPublish && x.itemIdBeforePenalty));
  if (penalized.length) {
    say(`\n已跳过 ${penalized.length} 个被处罚商品（不配发货规则）:`);
    penalized.forEach((x) => say(`  · ${x.xyTitle.slice(0, 40)}  ${x.note || ''}`));
  }
  const pending = all.length - listings.length;
  say(`待配置商品: ${listings.length} 条${pending ? `（另有 ${pending} 条未上架，跳过）` : ''}`);
  if (!listings.length) { say('没有已上架商品，先跑 src/publish_xianyu.js'); process.exit(1); }

  // 现状
  const rulesRes = await api(sid, 'GET', `/automation-rules?page=1&pageSize=100`);
  const existingRules = rulesRes.json?.data || [];
  const cardsRes = await api(sid, 'GET', '/cards');
  const existingCards = cardsRes.json || [];
  const typedRes = await api(sid, 'GET', `/reply-rules/${ACCOUNT}/typed`);
  const typedRules = typedRes.json || [];

  const done = [];
  const skipped = [];

  for (const l of listings) {
    const cardName = l.title.slice(0, 24);
    if (!l.itemId) { say(`  ! 跳过（无 itemId）: ${l.xyTitle}`); continue; }
    const hasCard = existingCards.find((c) => c.name === cardName);
    // 匹配已有规则：优先 item_id 精确匹配，否则按标题关键词
    const key = (l.title || '').replace(/个人整理版/g, '').trim().slice(0, 8);
    const hasRule = existingRules.find(
      (r) => String(r.item_id) === String(l.itemId) ||
             (r.name || '').includes(key) ||
             (r.item_title || '').includes(key)
    );

    if (hasRule && hasRule.enabled) {
      say(`  ✓ 已有规则: ${l.xyTitle} (id=${hasRule.id})`);
      skipped.push({ slug: l.slug, ruleId: hasRule.id, cardId: hasCard?.id });
      continue;
    }

    say(`  ! 新建: ${l.xyTitle}`);
    if (dry) {
      say('      [dry-run] 将建卡密 + 规则');
      continue;
    }

    // 1) 卡密
    let cardId = hasCard?.id;
    if (!cardId) {
      const cr = await api(sid, 'POST', '/cards', {
        name: cardName,
        type: 'text',
        text_content: cardContent(l),
        enabled: true,
        delay_seconds: 0,
      });
      if (cr.status === 200 || cr.status === 201) {
        cardId = cr.json?.id || cr.json?.data?.id;
        say(`      ✓ 卡密 id=${cardId}`);
      } else {
        say(`      ✗ 卡密失败 ${cr.status}: ${(cr.json?.message || cr.text).slice(0, 100)}`);
        continue;
      }
    }

    // 2) 发货规则
    const ruleBody = {
      cookie_id: ACCOUNT,
      item_id: l.itemId,
      item_title: l.xyTitle,
      name: `付款后自动发货 - ${l.title.slice(0, 20)}`,
      trigger_type: 'order_paid',
      enabled: true,
      priority: 100,
      config_json: '{}',
      actions: [
        {
          action_type: 'send_card',
          card_id: cardId,
          delivery_count: 1,
          message_template: '',
          delay_seconds: 0,
          config_json: '{"custom_variables":{},"delay_override":false,"spec_name":"","spec_value":""}',
          enabled: true,
          sort_order: 1,
        },
        {
          action_type: 'confirm_shipment',
          card_id: 0,
          delivery_count: 1,
          message_template: '',
          delay_seconds: 0,
          config_json: '{"custom_variables":{}}',
          enabled: true,
          sort_order: 2,
        },
      ],
    };
    const rr = hasRule
      ? await api(sid, 'PUT', `/automation-rules/${hasRule.id}`, { ...ruleBody, enabled: true })
      : await api(sid, 'POST', '/automation-rules', ruleBody);
    if (rr.status === 200 || rr.status === 201) {
      const rid = rr.json?.id || rr.json?.data?.id || hasRule?.id;
      say(`      ✓ 规则 id=${rid}`);
      done.push({ slug: l.slug, itemId: l.itemId, title: l.xyTitle, cardId, ruleId: rid });
    } else {
      say(`      ✗ 规则失败 ${rr.status}: ${(rr.json?.message || rr.text).slice(0, 140)}`);
    }
    await new Promise((s) => setTimeout(s, 800));
  }

  // 3) 客服关键词：按每门课标题的关键字
  say('\n=== 客服规则 ===');
  const KEYWORDS = ['有哪些内容', '啥内容', '都有啥', '截图', '怎么下载', '链接', '多少钱', '发货'];
  for (const kw of KEYWORDS) {
    if (typedRules.some((t) => t.keyword === kw)) { say(`  ✓ 「${kw}」已有`); continue; }
    if (dry) { say(`  ! 将新增「${kw}」`); continue; }
    const r = await api(sid, 'POST', `/reply-rules/${ACCOUNT}/items`, {
      keyword: kw,
      reply:
        '您好，这里是个人整理的学习资料合集，页面价格即实价，直接拍下即可。\n' +
        '拍完后我会把夸克网盘链接和提取码发到您的聊天窗口，正常几分钟内。\n' +
        '资料仅供个人学习参考，禁止商用与二次传播；如链接打开异常随时留言，会第一时间补发。',
      item_id: '',
      type: 'text',
      image_url: '',
    });
    say(`  ${r.status === 200 || r.status === 201 ? '✓' : '✗'} 「${kw}」${r.status === 200 || r.status === 201 ? '已创建' : (r.json?.message || r.text).slice(0, 80)}`);
  }

  // 4) 默认回复兜底
  const dr = await api(sid, 'GET', `/default-replies/${ACCOUNT}`);
  if (!dr.json?.enabled) {
    if (dry) say('  ! 将启用默认回复');
    else {
      const r = await api(sid, 'PUT', `/default-replies/${ACCOUNT}`, {
        enabled: true,
        reply_content:
          '您好，这里是个人整理的学习资料合集，页面价格即实价，直接拍下即可。\n' +
          '拍完后我会把夸克网盘链接和提取码发到您的聊天窗口，正常几分钟内。\n' +
          '资料仅供个人学习参考，禁止商用与二次传播；如链接打开异常随时留言，会第一时间补发。',
        reply_once: false,
      });
      say(`  ${r.status === 200 ? '✓' : '✗'} 默认回复已启用`);
    }
  } else {
    say('  ✓ 默认回复已启用');
  }

  fs.writeFileSync(
    path.join(__dirname, '..', 'out', 'yd_course_setup.json'),
    JSON.stringify({ done, skipped, at: new Date().toISOString() }, null, 2),
    'utf8'
  );
  say(`\n完成：新建 ${done.length} 条，跳过 ${skipped.length} 条`);
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
