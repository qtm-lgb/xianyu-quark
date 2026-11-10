'use strict';
/**
 * 配置闲鱼账号密码登录 —— 从根上解决「授权总是过期」
 *
 * 为什么需要这个
 * --------------
 * Ydisks 续期有两条独立通路：
 *
 *   ① auto_login_plugin（当前在用）
 *      走 sdkSilent 静默续期。闲鱼服务端对同一账号的静默续期有「疲劳窗口」，
 *      请求过频会被直接跳过。实测 11-08 之后连续 8 次全部 skipped。
 *
 *   ② passwordLoginByCookie / passwordRenewalResult（未启用）
 *      走闲鱼账号密码登录。**不受 sdkSilent 疲劳窗口限制**，
 *      是疲劳窗口卡住时的兜底通路。
 *
 * 而你的账号现在是：
 *   login_method = qr_scan，username = 空，password = 空
 *   -> 只有 ① 一条路，一旦被疲劳窗口卡住，只能人工扫码。
 *
 * 二进制里还有 `autoLoginModeWithoutFatigue`（无疲劳的自动登录模式），
 * 说明官方就是这么设计的：填了密码才有第二条路。
 *
 * 用法
 * ----
 *   node tools/yd_setup_password.js --username <闲鱼账号> --password <密码>
 *   node tools/yd_setup_password.js --status        # 看当前配置状态
 *   node tools/yd_setup_password.js --clear         # 清除密码（退回扫码）
 *   node tools/yd_setup_password.js --from-file     # 从 ~/.workbuddy/yd_xianyu_pwd.txt 读
 *
 * 注意：密码由 Ydisks 服务端用 AES 加密后存库（data-key 文件），明文不落盘。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const API = 'http://127.0.0.1:59188/api/v1';
const CID = '2419336374';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');
const XIAN_YU_PWD_FILE = path.join(os.homedir(), '.workbuddy', 'yd_xianyu_pwd.txt');

function say(m) { console.log(m); }

function api(method, p, { body, token, timeout = 30000 } = {}) {
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

async function getDetails(t) {
  const r = await api('GET', '/accounts/details', { token: t });
  const list = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
  return list.find((x) => x.id === CID) || null;
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

  const t = token();
  if (!t) { say('✗ 没有可用的控制台 session，先跑: node tools/yd_keepalive.js --status'); process.exit(1); }

  if (args.includes('--status')) {
    const d = await getDetails(t);
    say('════════ 账号登录配置状态 ════════');
    say(`  账号 ID     : ${CID}`);
    say(`  昵称        : ${d ? d.nickname : '?'}`);
    say(`  登录方式    : ${d ? d.login_method : '?'}`);
    say(`  用户名      : ${d && d.username ? d.username : '(未填写)'}`);
    say(`  自动评价    : ${d ? d.auto_confirm : '?'}`);
    say(`  自动擦亮    : ${d ? d.auto_polish_enabled : '?'}`);
    say('');
    say('  密码续期通路: ' + (d && d.username ? '✓ 已具备（密码登录兜底可用）' : '✗ 未启用（只能靠扫码）'));
    return;
  }

  if (args.includes('--clear')) {
    say('→ 清除账号密码（退回扫码登录）');
    const r = await api('PUT', `/accounts/${CID}/settings`, {
      token: t,
      body: { username: '', clear_password: true },
    });
    say(`  ${r.status < 400 ? '✓' : '✗'} ${r.status} ${r.raw.slice(0, 200)}`);
    return;
  }

  let username = getArg('--username');
  let password = getArg('--password');

  if (args.includes('--from-file')) {
    try {
      const raw = fs.readFileSync(XIAN_YU_PWD_FILE, 'utf8').trim();
      const obj = JSON.parse(raw);
      username = obj.username || username;
      password = obj.password || password;
      say(`从 ${XIAN_YU_PWD_FILE} 读取账号凭据`);
    } catch (e) {
      say(`✗ 读取失败: ${e.message}`);
      say(`  请在该文件写入 JSON: {"username":"你的闲鱼账号","password":"你的密码"}`);
      process.exit(1);
    }
  }

  if (!username || !password) {
    say('用法:');
    say('  node tools/yd_setup_password.js --username <闲鱼账号> --password <密码>');
    say('  node tools/yd_setup_password.js --from-file   # 从 ' + XIAN_YU_PWD_FILE + ' 读');
    say('  node tools/yd_setup_password.js --status');
    say('  node tools/yd_setup_password.js --clear');
    say('');
    say('闲鱼账号 = 手机号或淘宝账号；密码 = 闲鱼/淘宝登录密码。');
    say('密码只发给本机 127.0.0.1:59188 的 Ydisks 服务，由它 AES 加密后存库。');
    process.exit(1);
  }

  say(`→ 为账号 ${CID} 配置密码登录（${username}）`);
  const r = await api('PUT', `/accounts/${CID}/settings`, {
    token: t,
    body: {
      username,
      login_password: password,
      clear_password: false,
    },
  });

  if (r.status >= 400) {
    say(`✗ 配置失败: ${r.status} ${r.raw.slice(0, 300)}`);
    process.exit(1);
  }
  say(`  ✓ 服务端已接受: ${r.raw.slice(0, 200)}`);

  // 验证
  const d = await getDetails(t);
  say('');
  say('════════ 配置结果 ════════');
  say(`  登录方式: ${d.login_method}`);
  say(`  用户名  : ${d.username || '(未写入)'}`);
  say(`  密码通路: ${d.username ? '✓ 已具备' : '✗ 未生效'}`);

  if (d.login_method !== 'qr_scan' || d.username) {
    say('');
    say('下一步：触发一次账号重启，让助手用新凭据重新登录并建立续期通路。');
    say('  node tools/yd_auth_health.js --json   # 看状态');
    say('  或在面板里点「重启账号」。');
  } else {
    say('');
    say('⚠ 用户名没写进去，可能是服务端要求密码至少 8 位或账号格式特殊。');
    say('  建议改用面板：账号列表 -> 编辑 -> 「登录信息」区域填写。');
  }
}

main().catch((e) => { say('异常: ' + e.message); process.exit(1); });
