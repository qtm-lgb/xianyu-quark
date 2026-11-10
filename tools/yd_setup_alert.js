'use strict';
/**
 * 配置「授权异常主动告警」
 *
 * 背景：平台授权过期时，Ydisks 不会主动告诉你。
 *      之前 11-05 有买家下单没人发货、11-07 又有 3 个商品被判违规，
 *      都是「等买家反馈」才发现的被动局面。
 *
 * ⚠ 创建渠道的 body 结构（实测正确格式）：
 *   { name, type, config: JSON.stringify({...}), event_types: [...], enabled }
 *   —— config 是**字符串化的 JSON**，不是扁平字段！传错会存成空配置，
 *      表现为「创建成功但发送失败 internal_error」。
 *
 * 可用事件类型（来自前端枚举）：
 *   account_offline    账号掉线
 *   account_disabled   账号被停用
 *   account_recovered  账号恢复
 *   token_renewal      令牌续期
 *   message            收到消息
 *   error / system_error
 *   delivery_result    发货结果
 *
 * 用法：
 *   node tools/yd_setup_alert.js --feishu <webhook_url> [--secret <签名密钥>]
 *   node tools/yd_setup_alert.js --wechat <webhook_url>
 *   node tools/yd_setup_alert.js --dingtalk <webhook_url> [--secret <加签密钥>]
 *   node tools/yd_setup_alert.js --bark <推送地址>
 *   node tools/yd_setup_alert.js --list        # 查看现有渠道
 *   node tools/yd_setup_alert.js --test <id>   # 测试某个渠道
 *   node tools/yd_setup_alert.js --delete <id> # 删除渠道
 *   node tools/yd_setup_alert.js --unbind      # 解绑账号
 *   node tools/yd_setup_alert.js --guide       # 各平台获取 webhook 的步骤
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const API = 'http://127.0.0.1:59188/api/v1';
const CID = '2419336374';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');

function say(m) { console.log(m); }

function api(method, p, { body, token, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(data);
    }
    if (token) headers.cookie = `session=${token}`;
    const req = http.request(`${API}${p}`, { method, headers, timeout }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, raw: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function token() {
  try { return fs.readFileSync(CACHE, 'utf8').trim(); } catch { return null; }
}

/** 占位符检测 —— 防止再拿 xxx 当真地址用 */
function looksLikePlaceholder(url) {
  if (!url) return true;
  const u = url.toLowerCase();
  return /\/xxx\b|\/xxx$|\.\.\.|\bexample\b|your[-_]?key|placeholder|<.*>/i.test(u);
}

/**
 * 直接测 webhook 是否真能发出去。
 * 关键：飞书/钉钉 HTTP 200 不代表成功，必须看业务 code。
 *   飞书：{ code: 0, msg: 'success' }             成功
 *         { code: 19001, msg: '...token invalid' } 失败
 *   钉钉/企微：{ errcode: 0, errmsg: 'ok' }        成功
 */
function testWebhook(kind, url, secret) {
  return new Promise((resolve) => {
    let req;
    let payload;
    let parse;

    if (kind === 'feishu') {
      const body = { msg_type: 'text', content: { text: 'Ydisks 告警通道测试消息 ✓' } };
      if (secret) {
        const crypto = require('crypto');
        const ts = Math.floor(Date.now() / 1000).toString();
        const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
        body.timestamp = ts;
        body.sign = sign;
      }
      payload = JSON.stringify(body);
      parse = (j) => ({
        ok: j && (j.code === 0 || j.StatusCode === 0),
        msg: (j && (j.msg || j.StatusMessage)) || (j && j.code) || '未知',
      });
      req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
    } else if (kind === 'wechat') {
      payload = JSON.stringify({ msgtype: 'text', text: { content: 'Ydisks 告警通道测试消息 ✓' } });
      parse = (j) => ({ ok: j && j.errcode === 0, msg: (j && j.errmsg) || '未知' });
      req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
    } else if (kind === 'dingtalk') {
      payload = JSON.stringify({ msgtype: 'text', text: { content: 'Ydisks 告警通道测试消息 ✓' } });
      if (secret) {
        const crypto = require('crypto');
        const ts = Date.now();
        const sign = crypto.createHmac('sha256', secret).update(`${ts}\r\n${secret}`).digest('base64');
        const u = new URL(url);
        u.searchParams.set('timestamp', String(ts));
        u.searchParams.set('sign', sign);
        req = https.request(u.toString(), { method: 'POST', headers: { 'content-type': 'application/json' } });
      } else {
        req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
      }
      parse = (j) => ({ ok: j && j.errcode === 0, msg: (j && j.errmsg) || '未知' });
    } else {
      // Bark：GET url/title/body
      const u = new URL(url);
      u.searchParams.set('title', 'Ydisks 告警通道测试');
      u.searchParams.set('body', 'Ydisks 告警通道测试消息 ✓');
      parse = (j) => ({ ok: j && j.code === 200, msg: (j && j.message) || '未知' });
      req = https.request(u.toString(), { method: 'GET' });
    }

    req.on('response', (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch { /* ignore */ }
        const verdict = parse(j);
        resolve({
          http: res.statusCode,
          ok: res.statusCode < 400 && verdict.ok,
          msg: verdict.msg,
          body: buf.slice(0, 200),
        });
      });
    });
    req.on('error', (e) => resolve({ error: e.message, ok: false }));
    if (payload) req.write(payload);
    req.end();
  });
}

const GUIDE = `
════════ 各平台获取 Webhook 的步骤 ════════

【企业微信】群机器人（推荐）
  1. 企业微信进入一个内部群 → 右上角「…」→「群设置」
  2. 找到「群机器人」（新版可能叫「消息推送」）
  3. 「添加」→ 选择「自定义机器人」
  4. 完成页给出 Webhook 地址（含 ?key=），复制
  5. 命令：
     node tools/yd_setup_alert.js --wechat "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx"
  不需要 secret，URL 里的 key 就是唯一凭证，注意别泄露。频率限制 20 条/分钟

【飞书】自定义机器人
  1. 飞书进入目标群 → 右上角「更多」→「设置」
  2. 「群机器人」→「添加机器人」→「自定义机器人」
  3. 安全设置建议选「签名校验」，复制生成的密钥（sec- 开头）
  4. 完成页会给出 Webhook 地址，复制
  5. 命令：
     node tools/yd_setup_alert.js --feishu "https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx" --secret "sec-xxx"
  频率限制：单机器人 100 次/分钟

【钉钉】自定义机器人
  1. 钉钉进入一个群（可建单人群）→ 右上角「群设置」
  2. 「机器人」→「添加机器人」→「自定义机器人」
  3. 安全设置勾选「加签」，复制 SEC 开头的 Secret
  4. 完成页同时展示 Webhook 地址和 Secret，两个都复制
  5. 命令：
     node tools/yd_setup_alert.js --dingtalk "https://oapi.dingtalk.com/robot/send?access_token=xxx" --secret "SECxxx"

【Bark】iOS 推送
  命令：node tools/yd_setup_alert.js --bark "https://api.day.app/你的设备Key"
  地址从 Bark App 里复制
`;

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

  const t = token();
  if (!t) { say('✗ 没有可用的控制台 session，先跑: node tools/yd_keepalive.js --status'); process.exit(1); }

  if (args.includes('--guide')) { say(GUIDE); return; }

  if (args.includes('--list')) {
    const r = await api('GET', '/notifications/channels', { token: t });
    const list = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
    say(`现有通知渠道 ${list.length} 个:`);
    for (const c of list) {
      say(`  [${c.id}] ${c.type}  ${c.name || ''}  enabled=${c.enabled}`);
      if (c.config) {
        try {
          const cfg = JSON.parse(c.config);
          const masked = {};
          for (const [k, v] of Object.entries(cfg)) {
            masked[k] = /url|key|secret|token/i.test(k) && String(v).length > 12
              ? String(v).slice(0, 28) + '…' : v;
          }
          say(`       config: ${JSON.stringify(masked)}`);
        } catch { /* ignore */ }
      }
    }
    const b = await api('GET', `/notifications/accounts/${CID}/bindings`, { token: t });
    say(`\n账号绑定: ${JSON.stringify(b.json)}`);
    return;
  }

  if (getArg('--delete')) {
    const id = getArg('--delete');
    const r = await api('DELETE', `/notifications/channels/${id}`, { token: t });
    say(`删除渠道 ${id}: ${r.status < 400 ? '✓' : '✗'} ${r.raw.slice(0, 200)}`);
    return;
  }

  if (getArg('--test')) {
    const id = getArg('--test');
    const r = await api('POST', `/notifications/channels/${id}/test`, { token: t, body: {} });
    say(`测试渠道 ${id}: ${r.status < 400 ? '✓' : '✗'}`);
    say(`  ${r.raw.slice(0, 400)}`);
    return;
  }

  if (args.includes('--unbind')) {
    const r = await api('DELETE', `/notifications/accounts/${CID}/bindings`, { token: t });
    say(`解绑: ${r.status < 400 ? '✓' : '✗'} ${r.raw.slice(0, 200)}`);
    return;
  }

  // ---- 主流程：创建渠道 ----
  let kind = null;
  let url = null;
  for (const [flag, k] of [['--feishu', 'feishu'], ['--wechat', 'wechat'], ['--dingtalk', 'dingtalk'], ['--bark', 'bark']]) {
    const v = getArg(flag);
    if (v) { kind = k; url = v; break; }
  }

  if (!kind) {
    say('用法:');
    say('  node tools/yd_setup_alert.js --feishu <webhook_url> [--secret <签名密钥>]');
    say('  node tools/yd_setup_alert.js --wechat <webhook_url>');
    say('  node tools/yd_setup_alert.js --dingtalk <webhook_url> [--secret <加签密钥>]');
    say('  node tools/yd_setup_alert.js --bark <推送地址>');
    say('  node tools/yd_setup_alert.js --list | --test <id> | --delete <id> | --unbind | --guide');
    say('');
    say(GUIDE);
    process.exit(1);
  }

  const secret = getArg('--secret') || '';

  if (looksLikePlaceholder(url)) {
    say('✗ 这个地址看起来是占位符（xxx / example / your-key 之类），不是真实的 Webhook。');
    say('');
    say(GUIDE);
    process.exit(1);
  }

  say(`① 测试 ${kind} webhook 是否真能发出去...`);
  const probe = await testWebhook(kind, url, secret);
  if (probe.error) { say(`✗ 无法访问: ${probe.error}`); process.exit(1); }
  say(`   HTTP ${probe.http}  业务结果: ${probe.msg}`);
  if (!probe.ok) {
    say('✗ Webhook 不可用，已中止（不会创建无效渠道）');
    say(`   返回: ${probe.body}`);
    if (/19001|token invalid/i.test(probe.body)) {
      say('   → 这是「access token 无效」，说明 Webhook 地址抄错了或已失效，请重新复制。');
    }
    process.exit(1);
  }
  say('   ✓ Webhook 可用');

  say('② 创建通知渠道...');
  // ⚠ 正确结构：config 必须是字符串化的 JSON
  const config = {};
  if (kind === 'feishu' || kind === 'wechat') config.webhook_url = url;
  else if (kind === 'dingtalk') config.webhook = url;
  else if (kind === 'bark') config.url = url;
  if (secret) config.secret = secret;

  // ⚠ event_types 必须是**逗号分隔的字符串**，传数组会导致整个 body 解析失败
  //   （服务端会误报「name 和 type 必填」）；enabled 必须是布尔，传字符串同样失败
  const EVENTS = 'account_offline,account_disabled,account_recovered,token_renewal,error,system_error';
  const createBody = {
    name: 'Ydisks 授权告警',
    type: kind,
    config: JSON.stringify(config),
    event_types: EVENTS,
    enabled: true,
  };
  const cr = await api('POST', '/notifications/channels', { token: t, body: createBody });
  if (cr.status >= 400) {
    say(`✗ 创建失败: ${cr.status} ${cr.raw.slice(0, 300)}`);
    process.exit(1);
  }
  const channel = (cr.json && (cr.json.data || cr.json)) || {};
  const cid = channel.id || channel.channel_id;
  say(`   ✓ 渠道已创建 id=${cid}`);

  say('③ 绑定到闲鱼账号...');
  const br = await api('POST', `/notifications/accounts/${CID}/bindings`, {
    token: t,
    body: { channel_ids: cid ? [cid] : [], event_types: createBody.event_types },
  });
  say(`   ${br.status < 400 ? '✓' : '⚠'} ${br.status} ${br.raw.slice(0, 200)}`);

  say('④ 通过 Ydisks 发一条测试消息...');
  const tr = await api('POST', `/notifications/channels/${cid}/test`, { token: t, body: {} });
  say(`   ${tr.status < 400 ? '✓' : '⚠'} ${tr.raw.slice(0, 300)}`);
}

main().catch((e) => { say('异常: ' + e.message); process.exit(1); });
