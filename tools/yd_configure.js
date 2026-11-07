'use strict';
/**
 * Ydisks 闲鱼助手 —— 自动客服 + 自动发货配置
 *
 * ============ 诊断结论（2026-11-07 实测）============
 * 助手本身一切正常：WebSocket 通道通、token 正常、买家消息实时入库（56344 条）。
 * 问题纯粹是「配置缺失」：
 *   1. automation_rule_actions 里 3 条规则的 send_card 绑定都在，但
 *      「姜胡说合集」(item 1094008366209) 没有对应规则和卡密
 *   2. 规则 2（写作陪跑营）enabled=0，被禁用
 *   3. reply-rules 表 0 条、default_replies 表 0 行 —— 这就是没人回咨询的原因
 *
 * 本脚本通过助手自身的 REST API 配置（不改数据库，服务在运行中）。
 *
 * 用法:
 *   node tools/yd_configure.js --dry-run   # 只看要做什么
 *   node tools/yd_configure.js             # 实际执行
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = null; // 不用 sqlite，纯 REST

const BASE = 'http://127.0.0.1:59188/api/v1';
const CID = '2419336374';          // 闲鱼账号 cookie_id
const DB = 'C:/ProgramData/YdisksXianyuHelper/data/xianyu_data.db';

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/* ---------------- 认证 ---------------- */
function getSession() {
  // 从助手数据库读最近的有效 session（服务端加密，脚本读不了，这里用 psqlite 走 HTTP 侧）
  // 实际做法：读 ~/.workbuddy 里缓存的 token，或用 YD_SESSION 环境变量
  if (process.env.YD_SESSION) return process.env.YD_SESSION;
  const cache = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');
  if (fs.existsSync(cache)) return fs.readFileSync(cache, 'utf8').trim();
  return null;
}

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
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

/* ---------------- 业务配置 ---------------- */

/** 1) 「姜胡说合集」卡密 + 付款发货规则 */
const JIANG = {
  cardName: '姜胡说合集',
  cardContent:
    '我用夸克网盘给你分享了「姜胡说合集」，点击链接或复制整段内容，打开「夸克网盘APP」即可获取。\n' +
    '/~e1d5b8f3a2c~/:\n' +
    '链接：https://pan.quark.cn/s/3f05be5e6c5c\n\n' +
    '共 1 个文件（合集打包）。资料仅供个人学习参考，禁止商用与二次传播。\n' +
    '如链接打开异常请随时留言，会第一时间补发。',
  itemId: '1094008366209',
  itemTitle: '姜胡说合集 个人整理版',
  ruleName: '付款后自动发货 - 姜胡说合集',
};

/** 2) 自动客服：关键词 -> 回复 */
const SUPPORT_RULES = [
  {
    keyword: '有哪些内容',
    reply:
      '您好，这份是个人整理版的学习资料合集，内容较多。\n' +
      '拍下后我会把夸克网盘链接和提取码直接发您，按目录对应取用即可。\n' +
      '建议拍之前先留言说明您主要需要哪部分，我确认后再发，避免重复下单哦~',
  },
  {
    keyword: '啥内容',
    reply:
      '您好，是个人整理的学习资料合集。拍下后我直接发夸克网盘链接，\n' +
      '内容比较多，建议先留言说下您主要关注哪部分，我确认后发您，避免买错~',
  },
  {
    keyword: '都有啥',
    reply:
      '您好，是个人整理的学习资料合集。\n' +
      '拍下后立刻发网盘链接和提取码。有具体想看的部分可以先留言，我按需发送~',
  },
  {
    keyword: '截图',
    reply:
      '您好，我这边可以拍下后直接把网盘链接发您，里面目录能看得很清楚。\n' +
      '需要的话先留言，我发您截图~',
  },
  {
    keyword: '怎么下载',
    reply:
      '拍下后我会把夸克网盘链接和提取码发您，\n' +
      '手机装「夸克网盘」App 打开链接输入提取码即可，云端查看不占手机内存。\n' +
      '建议及时转存到自己网盘，避免分享过期~',
  },
  {
    keyword: '链接',
    reply:
      '您好，链接需要下单后发送哦，这样能保证每个买家都拿到可用链接。\n' +
      '直接拍下即可，拍完我马上发您~',
  },
  {
    keyword: '多少钱',
    reply:
      '页面价格就是实价，直接拍下即可~ 拍完我把网盘链接和提取码发您。',
  },
  {
    keyword: '发货',
    reply:
      '您好，付款后立刻自动发货，夸克网盘链接+提取码直接发您聊天窗口。\n' +
      '正常几分钟内到，链接长期有效~',
  },
];

/** 3) 默认回复（未命中关键词时的兜底） */
const DEFAULT_REPLY = {
  enabled: true,
  reply_content:
    '您好，这里是个人整理的学习资料合集，页面价格即实价，直接拍下即可。\n' +
    '拍完后我会把夸克网盘链接和提取码发到您的聊天窗口，正常几分钟内。\n' +
    '资料仅供个人学习参考，禁止商用与二次传播；如链接打开异常随时留言，会第一时间补发。',
  reply_once: false,
};

/* ---------------- 主流程 ---------------- */
async function main() {
  const dry = process.argv.includes('--dry-run');
  const session = getSession();
  if (!session) {
    say('✗ 没有可用 session。请先设置 YD_SESSION 环境变量，或运行 tools/yd_session.js 获取');
    process.exit(1);
  }

  const chk = await api(session, 'GET', '/session');
  if (!chk.json?.authenticated) {
    say('✗ session 无效（authenticated=false）');
    process.exit(1);
  }
  say(`✓ 认证成功: ${chk.json.username} (admin=${chk.json.is_admin})`);

  // 读现状
  const rulesRes = await api(session, 'GET', `/automation-rules?page=1&pageSize=50`);
  const existing = rulesRes.json?.data || [];
  say(`现有自动化规则: ${existing.length} 条`);
  for (const r of existing) {
    const acts = (r.actions || []).map((a) => `${a.action_type}(card=${a.card_id})`).join(' + ');
    say(`  [${r.id}] ${r.name} | enabled=${r.enabled} | ${acts}`);
  }

  const cardsRes = await api(session, 'GET', '/cards');
  const cards = cardsRes.json || [];
  say(`现有卡密: ${cards.length} 条`);

  // ---- 任务1: 姜胡说合集 卡密 + 规则 ----
  const jiRule = existing.find((r) => r.item_id === JIANG.itemId);
  const jiCard = cards.find((c) => c.name === JIANG.cardName);

  if (jiRule && jiRule.enabled) {
    say(`✓ 「姜胡说合集」规则已存在且启用 (id=${jiRule.id})`);
  } else if (jiRule) {
    say(`! 「姜胡说合集」规则存在但被禁用 (id=${jiRule.id})，将启用`);
    if (!dry) {
      const body = { ...jiRule, actions: jiRule.actions.map((a) => ({ ...a })) };
      const r = await api(session, 'PUT', `/automation-rules/${jiRule.id}`, body);
      say(r.status === 200 ? '  ✓ 已启用' : `  ✗ 失败 ${r.status} ${r.text.slice(0, 120)}`);
    }
  } else {
    say(`! 「姜胡说合集」无规则，需要新建`);
    if (!dry) {
      // 先建卡密
      let cardId = jiCard?.id;
      if (!cardId) {
        const cr = await api(session, 'POST', '/cards', {
          name: JIANG.cardName,
          type: 'text',
          text_content: JIANG.cardContent,
          enabled: true,
          delay_seconds: 0,
        });
        if (cr.status === 200 || cr.status === 201) {
          cardId = cr.json?.id || cr.json?.data?.id;
          say(`  ✓ 卡密已创建 id=${cardId}`);
        } else {
          say(`  ✗ 卡密创建失败 ${cr.status}: ${cr.text.slice(0, 160)}`);
          return;
        }
      } else {
        say(`  ✓ 卡密已存在 id=${cardId}`);
      }

      // 建规则：send_card + confirm_shipment
      const rr = await api(session, 'POST', '/automation-rules', {
        cookie_id: CID,
        item_id: JIANG.itemId,
        item_title: JIANG.itemTitle,
        name: JIANG.ruleName,
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
      });
      if (rr.status === 200 || rr.status === 201) {
        say(`  ✓ 规则已创建 id=${rr.json?.id || rr.json?.data?.id}`);
      } else {
        say(`  ✗ 规则创建失败 ${rr.status}: ${rr.text.slice(0, 200)}`);
      }
    }
  }

  // ---- 任务2: 启用被禁用的规则 ----
  for (const r of existing.filter((x) => !x.enabled && x.trigger_type === 'order_paid')) {
    say(`! 规则 [${r.id}] ${r.name} 被禁用，将启用`);
    if (!dry) {
      const rr = await api(session, 'PUT', `/automation-rules/${r.id}`, {
        ...r, enabled: true, actions: (r.actions || []).map((a) => ({ ...a })),
      });
      say(rr.status === 200 ? '  ✓ 已启用' : `  ✗ 失败 ${rr.status} ${rr.text.slice(0, 140)}`);
    }
  }

  // ---- 任务3: 自动客服关键词规则 ----
  const rrRes = await api(session, 'GET', `/reply-rules/${CID}/typed`);
  const typed = rrRes.json?.data?.items?.rules || rrRes.json?.items?.rules || [];
  say(`现有自动回复规则: ${typed.length} 条`);

  for (const sr of SUPPORT_RULES) {
    const hit = typed.find((t) => t.keyword === sr.keyword);
    if (hit) {
      say(`✓ 关键词「${sr.keyword}」已存在`);
      continue;
    }
    say(`! 新增关键词「${sr.keyword}」`);
    if (!dry) {
      const rr = await api(session, 'POST', `/reply-rules/${CID}/items`, {
        keyword: sr.keyword,
        reply: sr.reply,
        item_id: '',
        type: 'text',
        image_url: '',
      });
      say(rr.status === 200 || rr.status === 201 ? '  ✓ 已创建' : `  ✗ 失败 ${rr.status} ${rr.text.slice(0, 140)}`);
    }
  }

  // ---- 任务4: 默认回复 ----
  const drRes = await api(session, 'GET', `/default-replies/${CID}`);
  const dr = drRes.json || {};
  if (dr.enabled && dr.reply_content) {
    say('✓ 默认回复已启用');
  } else {
    say('! 默认回复未启用，将配置');
    if (!dry) {
      const rr = await api(session, 'PUT', `/default-replies/${CID}`, DEFAULT_REPLY);
      say(rr.status === 200 ? '  ✓ 已配置' : `  ✗ 失败 ${rr.status} ${rr.text.slice(0, 140)}`);
    }
  }

  say('完成。' + (dry ? '（dry-run，未实际修改）' : ''));
}

main().catch((e) => {
  say('异常: ' + e.message);
  process.exit(1);
});
