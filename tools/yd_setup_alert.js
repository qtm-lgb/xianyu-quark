'use strict';
/**
 * 配置「授权异常主动告警」
 *
 * 背景：平台授权过期时，Ydisks 不会主动告诉你。
 *      之前 11-05 有一笔买家下单没人发货、11-07 又有 3 个商品被判违规，
 *      都是「等买家反馈」才发现的被动局面。
 *
 * 这里配置飞书/钉钉/Bark 机器人 + 账号绑定，
 * 让「登录已失效 / 需要验证 / 续期连续失败」时主动推一条消息给你。
 *
 * 用法：
 *   node tools/yd_setup_alert.js --feishu <webhook>      # 飞书机器人
 *   node tools/yd_setup_alert.js --dingtalk <webhook>    # 钉钉机器人
 *   node tools/yd_setup_alert.js --bark <url>            # Bark 推送
 *   node tools/yd_setup_alert.js --list                  # 查看现有渠道
 *   node tools/yd_setup_alert.js --test                 # 发一条测试消息
 *   node tools/yd_setup_alert.js --unbind                # 解绑账号
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

/** 直接测 webhook 是否通（不依赖 Ydisks，先确认 webhook 本身有效） */
function testWebhook(kind, url) {
  return new Promise((resolve) => {
    let req;
    let payload;
    if (kind === 'feishu') {
      payload = JSON.stringify({ msg_type: 'text', content: { text: 'Ydisks 告警通道测试消息 ✓' } });
      req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
    } else if (kind === 'dingtalk') {
      payload = JSON.stringify({ msgtype: 'text', text: { content: 'Ydisks 告警通道测试消息 ✓' } });
      req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
    } else {
      // Bark: GET url/title/body
      const u = new URL(url);
      u.searchParams.set('title', 'Ydisks 告警通道测试');
      u.searchParams.set('body', 'Ydisks 告警通道测试消息 ✓');
      req = https.request(u.toString(), { method: 'GET' });
    }
    req.on('response', (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const t = token();
  if (!t) { say('✗ 没有可用的控制台 session，先跑 node tools/yd_keepalive.js --status'); process.exit(1); }

  if (args.includes('--list')) {
    const r = await api('GET', '/notifications/channels', { token: t });
    const list = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
    say(`现有通知渠道 ${list.length} 个:`);
    list.forEach((c) => say(`  [${c.id}] ${c.type || c.channel_type}  ${c.name || ''}  enabled=${c.enabled}`));
    const b = await api('GET', `/notifications/accounts/${CID}/bindings`, { token: t });
    say(`\n账号绑定: ${JSON.stringify(b.json).slice(0, 400)}`);
    return;
  }

  if (args.includes('--unbind')) {
    const r = await api('DELETE', `/notifications/accounts/${CID}/bindings`, { token: t });
    say(`解绑结果: ${r.status} ${r.raw.slice(0, 200)}`);
    return;
  }

  let kind = null;
  let url = null;
  if (getArg('--feishu')) { kind = 'feishu'; url = getArg('--feishu'); }
  else if (getArg('--dingtalk')) { kind = 'dingtalk'; url = getArg('--dingtalk'); }
  else if (getArg('--bark')) { kind = 'bark'; url = getArg('--bark'); }
  else if (getArg('--email')) { kind = 'email'; url = getArg('--email'); }

  if (!kind) {
    say('用法:');
    say('  node tools/yd_setup_alert.js --feishu <webhook>');
    say('  node tools/yd_setup_alert.js --dingtalk <webhook>');
    say('  node tools/yd_setup_alert.js --bark <推送地址>');
    say('  node tools/yd_setup_alert.js --list');
    say('  node tools/yd_setup_alert.js --unbind');
    process.exit(1);
  }

  say(`① 测试 ${kind} webhook 可用性...`);
  const probe = await testWebhook(kind, url);
  if (probe.error) { say(`✗ webhook 无法访问: ${probe.error}`); process.exit(1); }
  say(`  HTTP ${probe.status}  ${String(probe.body || '').slice(0, 120)}`);
  if (probe.status >= 400) { say('✗ webhook 返回错误，请检查地址'); process.exit(1); }

  say('② 创建通知渠道...');
  const createBody = { type: kind, name: `Ydisks 授权告警`, enabled: true };
  if (kind === 'feishu') createBody.webhook = url;
  else if (kind === 'dingtalk') createBody.webhook = url;
  else if (kind === 'bark') createBody.url = url;
  else createBody.address = url;

  const cr = await api('POST', '/notifications/channels', { token: t, body: createBody });
  if (cr.status >= 400) {
    say(`✗ 创建渠道失败: ${cr.status} ${cr.raw.slice(0, 300)}`);
    process.exit(1);
  }
  const channel = cr.json && (cr.json.data || cr.json);
  const cid = channel && (channel.id || channel.channel_id);
  say(`  ✓ 渠道已创建 id=${cid}`);

  say('③ 绑定到闲鱼账号（绑定后账号异常才会推送）...');
  const bindBody = { channel_ids: cid ? [cid] : [], events: ['account_error', 'login_expired', 'captcha_failed', 'renew_failed'] };
  const br = await api('POST', `/notifications/accounts/${CID}/bindings`, { token: t, body: bindBody });
  if (br.status >= 400) {
    say(`  ⚠ 绑定失败: ${br.status} ${br.raw.slice(0, 300)}`);
    say('  渠道已创建，可稍后在面板里手动绑定');
  } else {
    say(`  ✓ 绑定成功: ${br.raw.slice(0, 200)}`);
  }

  say('④ 通过 Ydisks 发一条测试消息...');
  const tr = await api('POST', `/notifications/channels/${cid}/test`, { token: t, body: {} });
  say(`  ${tr.status < 400 ? '✓' : '⚠'} ${tr.raw.slice(0, 200)}`);
}

main().catch((e) => { say('异常: ' + e.message); process.exit(1); });
