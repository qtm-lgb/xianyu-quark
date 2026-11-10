'use strict';
/**
 * Ydisks 控制台会话守护 —— 解决「授权总是过期」
 *
 * 问题背景
 * --------
 * Ydisks 助手有两个完全不同的「授权」，用户常混淆：
 *
 *   ① 控制台会话（sessions 表）
 *      - 本机 Web 面板的登录态，硬编码 24 小时过期
 *      - 过期了只是打不开面板，**不影响**自动发货/客服
 *      - 但我们所有 API 脚本都依赖它，所以每次都要重新登录
 *
 *   ② 闲鱼账号 Cookie（sdkSilent）
 *      - 真正影响业务的授权
 *      - 助手每 4 小时跑一次 api_cookie_renew 静默续期
 *      - 但闲鱼对同一账号的静默续期有「疲劳窗口」，频繁请求会被跳过
 *      - 一旦某次因滑块风控失败，疲劳窗口就卡住 -> 只能人工扫码
 *
 * 本脚本解决 ①：自动检测会话即将过期 -> 用保存的密码自动重新登录 -> 刷新缓存
 *
 * 用法
 * ----
 *   node tools/yd_keepalive.js              # 前台跑，每 30 分钟检查一次
 *   node tools/yd_keepalive.js --once       # 只检查一次（适合放进计划任务）
 *   node tools/yd_keepalive.js --status     # 只看状态不改
 *
 * 密码来源（优先级）：
 *   1. 环境变量 YDISKS_PASSWORD
 *   2. ~/.workbuddy/yd_password.txt（首次运行会提示你写进去）
 *
 * 密码不对时脚本不会乱试（避免锁定），只会明确报错。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const BASE = 'http://127.0.0.1:59188';
const API = `${BASE}/api/v1`;
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');
const PW_FILE = path.join(os.homedir(), '.workbuddy', 'yd_password.txt');
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
// 剩余不足这个时间就续（session 共 24h）
const RENEW_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 小时

function say(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

/** 读缓存的 session */
function readCached() {
  try {
    const s = fs.readFileSync(CACHE, 'utf8').trim();
    return s || null;
  } catch { return null; }
}

function writeCached(token) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, token, 'utf8');
}

/** 调 API */
function api(method, p, { body, token, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(data);
    }
    if (token) headers.cookie = `session=${token}`;

    const req = http.request(
      `${API}${p}`,
      { method, headers, timeout },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* ignore */ }
          resolve({ status: res.statusCode, json, raw: buf });
        });
      }
    );
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

/** 探测当前 session 是否还有效，并读出账号运行状态 */
async function probe(token) {
  if (!token) return { ok: false, reason: '无缓存 session' };
  const r = await api('GET', '/session', { token }).catch(() => null);
  if (!r) return { ok: false, reason: '服务无响应' };
  if (r.status === 401) return { ok: false, reason: 'session 已失效' };
  if (!r.json || r.json.authenticated !== true) {
    return { ok: false, reason: `未认证（${r.status}）` };
  }
  return { ok: true, reason: '有效' };
}

/** 从数据库读 session 的过期时间（判断还剩多久） */
function readSessionExpiry() {
  const { execFileSync } = require('child_process');
  const DB = 'C:/ProgramData/YdisksXianyuHelper/data/xianyu_data.db';
  const tmp = path.join(os.tmpdir(), `yd_ka_${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    const src = DB + suffix;
    const dst = tmp + suffix;
    if (!fs.existsSync(src)) continue;
    const s = src.replace(/\//g, '\\');
    const d = dst.replace(/\//g, '\\');
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `$fs=[IO.File]::Open('${s}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete);` +
        `$o=[IO.File]::Create('${d}');$fs.CopyTo($o);$o.Close();$fs.Close();`],
        { stdio: 'ignore' });
    } catch { /* ignore */ }
    if (!fs.existsSync(dst)) { try { fs.copyFileSync(src, dst); } catch { /* ignore */ } }
  }
  const py = `
import sqlite3, time, json, sys
try:
    c = sqlite3.connect(sys.argv[1])
    now = time.time()
    row = c.execute("SELECT session_id, expires_at FROM sessions WHERE expires_at > ? ORDER BY expires_at DESC LIMIT 1", (now,)).fetchone()
    if row:
        print(json.dumps({"token": row[0], "expires_at": row[1], "remaining": row[1] - now}))
    else:
        print(json.dumps({"token": None}))
except Exception as e:
    print(json.dumps({"error": str(e)[:80]}))
`;
  try {
    const out = execFileSync('python', ['-c', py, tmp], { encoding: 'utf8' });
    return JSON.parse(out.trim());
  } catch (e) {
    return { error: String(e.message).slice(0, 80) };
  } finally {
    try { fs.unlinkSync(tmp); fs.unlinkSync(tmp + '-wal'); fs.unlinkSync(tmp + '-shm'); } catch { /* ignore */ }
  }
}

/** 取控制台密码 */
function getPassword() {
  if (process.env.YDISKS_PASSWORD) return process.env.YDISKS_PASSWORD;
  try {
    const p = fs.readFileSync(PW_FILE, 'utf8').trim();
    return p || null;
  } catch { return null; }
}

/** 用用户名+密码重新登录控制台 */
async function login(username, password) {
  const r = await api('POST', '/session/login', { body: { username, password } });
  if (r.status === 200 && r.json) {
    const token = r.json.token || r.json.session_id || r.json.sessionId;
    if (token) return { ok: true, token };
    // 有些版本直接返回 cookie
    return { ok: false, reason: `登录返回无 token: ${r.raw.slice(0, 120)}` };
  }
  return { ok: false, reason: `登录失败(${r.status}): ${(r.json && r.json.message) || r.raw.slice(0, 120)}` };
}

/** 读控制台用户名（admin） */
function readAdminUsername() {
  const { execFileSync } = require('child_process');
  const DB = 'C:/ProgramData/YdisksXianyuHelper/data/xianyu_data.db';
  const tmp = path.join(os.tmpdir(), `yd_ka_u_${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    const src = DB + suffix; const dst = tmp + suffix;
    if (!fs.existsSync(src)) continue;
    try { fs.copyFileSync(src, dst); } catch { /* ignore */ }
  }
  try {
    const out = execFileSync('python', ['-c',
      `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1])
r=c.execute("SELECT username FROM users WHERE is_admin=1 LIMIT 1").fetchone()
print(json.dumps({"username": r[0] if r else None}))`,
      tmp], { encoding: 'utf8' });
    return JSON.parse(out.trim()).username;
  } catch { return null; }
  finally {
    try { fs.unlinkSync(tmp); fs.unlinkSync(tmp + '-wal'); fs.unlinkSync(tmp + '-shm'); } catch { /* ignore */ }
  }
}

async function doCheck({ renew = true } = {}) {
  // 先从数据库取最新的有效 token —— 缓存可能是旧的（这正是 401 的常见原因）
  let dbInfo = {};
  try { dbInfo = readSessionExpiry(); } catch (e) { dbInfo = { error: String(e).slice(0, 60) }; }

  let cached = readCached();
  if (dbInfo.token && dbInfo.token !== cached) {
    say(`→ 缓存 token 已过期，用数据库中最新 token 同步（${dbInfo.token.slice(0, 10)}…）`);
    writeCached(dbInfo.token);
    cached = dbInfo.token;
  }

  const probeRes = await probe(cached);
  const remainingH = dbInfo.remaining != null ? (dbInfo.remaining / 3600).toFixed(1) : '?';
  say(`会话探测: ${probeRes.ok ? '✓ ' + probeRes.reason : '✗ ' + probeRes.reason}  剩余约 ${remainingH}h`);

  if (!renew) {
    if (probeRes.ok) { say('✓ 当前 session 有效，无需处理'); return true; }
    say('✗ session 已失效');
    return false;
  }

  if (probeRes.ok && dbInfo.remaining != null && dbInfo.remaining > RENEW_THRESHOLD_MS) {
    say(`✓ 剩余 ${remainingH}h，未到阈值 (${RENEW_THRESHOLD_MS / 3600000}h)，跳过`);
    return true;
  }

  // 需要续
  say('→ 需要重新登录控制台');
  const pw = getPassword();
  if (!pw) {
    say('! 未找到控制台密码，无法自动登录');
    say(`  请把密码写入: ${PW_FILE}`);
    say(`  或设置环境变量 YDISKS_PASSWORD`);
    say('  密码是 Ydisks 控制台的管理员密码（不是闲鱼账号密码）');
    return false;
  }
  const user = readAdminUsername() || 'admin';
  const r = await login(user, pw);
  if (!r.ok) {
    say(`✗ 自动登录失败: ${r.reason}`);
    return false;
  }
  writeCached(r.token);
  say(`✓ 已自动登录并刷新缓存（${PW_FILE.replace(os.homedir(), '~')}）`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const status = args.includes('--status');

  if (status) {
    // 状态查询也同步缓存（缓存过期是 API 401 的最常见原因）
    let db = {};
    try { db = readSessionExpiry(); } catch { /* ignore */ }
    const cached = readCached();
    if (db.token && db.token !== cached) {
      writeCached(db.token);
      say('→ 缓存 token 已过期，已用数据库中最新 token 同步');
    }
    const probeRes = await probe(readCached());
    const dbInfo = db;
    console.log('════════ Ydisks 会话状态 ════════');
    console.log(`  服务        : ${BASE}`);
    console.log(`  缓存 token  : ${(readCached() || '(无)').slice(0, 12)}…`);
    console.log(`  认证状态    : ${probeRes.ok ? '✓ 有效' : '✗ ' + probeRes.reason}`);
    console.log(`  剩余时间    : ${dbInfo.remaining != null ? (dbInfo.remaining / 3600).toFixed(1) + ' 小时' : '未知'}`);
    console.log(`  密码文件    : ${fs.existsSync(PW_FILE) ? '✓ 已配置' : '✗ 未配置（无法自动续期）'}`);
    return;
  }

  if (once) {
    const ok = await doCheck({ renew: true });
    process.exit(ok ? 0 : 1);
  }

  say('守护启动，每 30 分钟检查一次（Ctrl+C 退出）');
  await doCheck({ renew: true });
  setInterval(() => { doCheck({ renew: true }).catch(() => {}); }, CHECK_INTERVAL_MS);
}

main().catch((e) => { say('异常: ' + e.message); process.exit(1); });
