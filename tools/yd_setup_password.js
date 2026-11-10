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
 *   node tools/yd_setup_password.js                       # ★ 交互模式（推荐，密码不回显）
 *   node tools/yd_setup_password.js --username <账号> --password <密码>
 *   node tools/yd_setup_password.js --from-file           # 从 ~/.workbuddy/yd_xianyu_pwd.txt 读
 *   node tools/yd_setup_password.js --status              # 看当前配置状态
 *   node tools/yd_setup_password.js --clear               # 清除密码（退回扫码）
 *
 * 交互模式最安全：密码不回显，也不会进 shell 历史。
 *
 * 注意：密码由 Ydisks 服务端用 AES 加密后存库（data-key 文件），明文不落盘。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

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

/**
 * 取一个可用的 session。
 * 缓存过期时自动从数据库取最新的有效 session 顶上
 * （数据库里始终有——会话是用户登录面板时生成的）
 */
async function liveToken() {
  let t = token();
  if (t) {
    const r = await api('GET', '/session', { token: t }).catch(() => null);
    if (r && r.json && r.json.authenticated === true) return t;
  }
  // 缓存失效 -> 从数据库同步
  try {
    const { execFileSync } = require('child_process');
    const DB = 'C:/ProgramData/YdisksXianyuHelper/data/xianyu_data.db';
    const tmp = path.join(os.tmpdir(), `yd_pwd_${process.pid}.db`);
    for (const suffix of ['', '-wal', '-shm']) {
      const src = DB + suffix; const dst = tmp + suffix;
      if (!fs.existsSync(src)) continue;
      const s = src.replace(/\//g, '\\'); const d = dst.replace(/\//g, '\\');
      try {
        execFileSync('powershell', ['-NoProfile', '-Command',
          `$fs=[IO.File]::Open('${s}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete);` +
          `$o=[IO.File]::Create('${d}');$fs.CopyTo($o);$o.Close();$fs.Close();`], { stdio: 'ignore' });
      } catch { /* ignore */ }
      if (!fs.existsSync(dst)) { try { fs.copyFileSync(src, dst); } catch { /* ignore */ } }
    }
    const out = execFileSync('python', ['-c',
      `import sqlite3,sys,time,json
c=sqlite3.connect(sys.argv[1])
r=c.execute("SELECT session_id FROM sessions WHERE expires_at > ? ORDER BY expires_at DESC LIMIT 1",(time.time(),)).fetchone()
print(r[0] if r else "")`, tmp], { encoding: 'utf8' }).trim();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* ignore */ } }
    if (out) {
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, out, 'utf8');
      return out;
    }
  } catch { /* ignore */ }
  return t;
}

/**
 * 交互式输入密码（不回显）
 *
 * 关键：必须用 raw mode 关闭终端回显，否则密码会明文打出来。
 * 不能靠 readline 的 question() —— 它一定回显。
 */
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write(question);

    if (!stdin.isTTY) {
      // 非交互终端（管道/重定向）：只能按行读，无法屏蔽回显
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question('', (a) => { rl.close(); stdout.write('\n'); resolve(a.trim()); });
      return;
    }

    try { stdin.setRawMode(true); } catch { /* 某些环境不支持 */ }
    stdin.resume();
    if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');

    let buf = '';
    const cleanup = () => {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      try { stdin.pause(); } catch { /* ignore */ }
      stdin.removeListener('data', onData);
      stdout.write('\n');
    };

    const onData = (key) => {
      // Ctrl+C
      if (key === '\u0003') { cleanup(); process.exit(130); }
      // 回车
      if (key === '\r' || key === '\n') { cleanup(); resolve(buf); return; }
      // 退格（DEL=0x7f，BS=0x08，有些终端发 0x08）
      const code = key.charCodeAt(0);
      if (code === 127 || code === 8) { buf = buf.slice(0, -1); return; }
      // 忽略其余控制字符
      if (code < 32) return;
      buf += key;
    };

    stdin.on('data', onData);
  });
}

/** 交互式输入普通文本 */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function getDetails(t) {
  const r = await api('GET', '/accounts/details', { token: t });
  const list = Array.isArray(r.json) ? r.json : (r.json && r.json.data) || [];
  return list.find((x) => x.id === CID) || null;
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

  const t = await liveToken();
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

  // ★ 交互模式：没给参数就引导输入
  if (!username || !password) {
    say('════════ 配置闲鱼账号密码登录 ════════');
    say('');
    say('这一步的作用：给助手开通「密码登录」续期通路。');
    say('目前账号只有扫码登录一条路，闲鱼一旦触发「疲劳窗口」，');
    say('就只能人工扫码 —— 填上密码后会多一条不受限制的备用路。');
    say('');
    const d = await getDetails(t);
    if (d && d.nickname) say(`  当前账号: ${d.nickname} (${d.id})`);
    say('');

    username = await ask('  闲鱼账号（手机号或淘宝账号）: ');
    if (!username) { say('✗ 未输入账号，已取消'); process.exit(1); }

    password = await askHidden('  闲鱼密码: ');
    if (!password) { say('✗ 未输入密码，已取消'); process.exit(1); }

    say('');
    say('  密码不会显示，也不会进 shell 历史。');
    say(`  将通过本机 ${API} 发送给 Ydisks，由它 AES 加密后存库。`);
    say('');
    const confirm = await ask('  确认提交？(输入 y 确认): ');
    if (!/^y(es)?$/i.test(confirm)) { say('已取消，未做任何修改'); process.exit(0); }
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

// 被 require 时不自动执行（供测试调用内部函数）
if (require.main === module) {
  main().catch((e) => { say('异常: ' + e.message); process.exit(1); });
}

// 导出供测试调用（不影响主流程）
module.exports = { askHidden, ask, liveToken };
