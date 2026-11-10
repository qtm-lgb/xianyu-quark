'use strict';
/**
 * Ydisks 账号授权健康检查
 *
 * 盯的是**真正影响业务**的授权（闲鱼账号 Cookie / WS Token），
 * 而不是控制台会话（那个只影响看面板）。
 *
 * 检查项：
 *   1. 账号运行状态（online / 登录已失效 / 需要验证 …）
 *   2. WS Token 剩余有效期与上次刷新结果
 *   3. 最近的续期记录（成功 / 被疲劳窗口跳过 / 失败）
 *   4. 累计的风控滑块失败次数（这是授权频繁过期的真凶）
 *   5. 控制台会话有效期
 *
 * 用法：
 *   node tools/yd_auth_health.js           # 人读的报告
 *   node tools/yd_auth_health.js --json    # 机器读（给告警用）
 *   node tools/yd_auth_health.js --watch   # 每 5 分钟刷一次，异常时退出码 1
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const DB = 'C:/ProgramData/YdisksXianyuHelper/data/xianyu_data.db';
const API = 'http://127.0.0.1:59188/api/v1';
const CID = '2419336374';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');

function say(m) { console.log(m); }

function api(method, p, { body, token, timeout = 15000 } = {}) {
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

/** 复制数据库（含 WAL）到临时目录再读 */
function readDb() {
  const tmp = path.join(os.tmpdir(), `yd_health_${process.pid}.db`);
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
  const py = `
import sqlite3, sys, json, time
c = sqlite3.connect(sys.argv[1])
c.row_factory = sqlite3.Row
out = {}
now = time.time()

row = c.execute("SELECT session_id, expires_at FROM sessions WHERE expires_at > ? ORDER BY expires_at DESC LIMIT 1", (now,)).fetchone()
out['session'] = {"token": row["session_id"], "expires_at": row["expires_at"], "remaining": row["expires_at"] - now} if row else None

out['token'] = None
r = c.execute("SELECT cookie_id, expire_at, updated_at FROM account_tokens LIMIT 1").fetchone()
if r:
    out['token'] = {"expire_at": r["expire_at"], "remaining": r["expire_at"] - now, "updated_at": r["updated_at"]}

out['renew'] = [dict(x) for x in c.execute(
    "SELECT created_at, status, message, renew_method, updated_cookie_count, duration_ms FROM scheduled_api_cookie_renew_log ORDER BY id DESC LIMIT 8")]

out['risk'] = [dict(x) for x in c.execute(
    "SELECT created_at, event_type, processing_status, processing_result, error_message FROM risk_control_logs ORDER BY id DESC LIMIT 5")]

out['risk_total'] = c.execute("SELECT COUNT(*) FROM risk_control_logs").fetchone()[0]
out['risk_failed'] = c.execute("SELECT COUNT(*) FROM risk_control_logs WHERE processing_status='failed'").fetchone()[0]
out['risk_last30'] = c.execute("SELECT COUNT(*) FROM risk_control_logs WHERE created_at > datetime('now','-30 days')").fetchone()[0]

out['login_logs'] = [dict(x) for x in c.execute(
    "SELECT created_at, method, status, trigger_reason, message FROM account_login_logs ORDER BY id DESC LIMIT 5")]

out['acct'] = None
r = c.execute("SELECT id, username, login_method, last_login_at, paused_until FROM cookies LIMIT 1").fetchone()
if r:
    out['acct'] = dict(r)

print(json.dumps(out, ensure_ascii=False))
`;
  try {
    const o = execFileSync('python', ['-c', py, tmp], { encoding: 'utf8' });
    return JSON.parse(o.trim());
  } catch (e) {
    return { error: String(e.message).slice(0, 120) };
  } finally {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + s); } catch { /* ignore */ } }
  }
}

async function collect() {
  const db = readDb();
  let token = null;
  try { token = fs.readFileSync(CACHE, 'utf8').trim(); } catch { /* ignore */ }
  // 缓存过期就用数据库里最新的
  if (db.session && db.session.token && db.session.token !== token) {
    token = db.session.token;
    try {
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, token, 'utf8');
    } catch { /* ignore */ }
  }

  const runtime = await api('GET', '/accounts/runtime-status', { token }).catch(() => null);
  const longLogin = await api('GET', `/accounts/${CID}/long-login`, { token }).catch(() => null);

  return {
    db,
    runtime: runtime && runtime.json ? runtime.json : null,
    longLogin: longLogin && longLogin.json ? longLogin.json : null,
    sessionToken: token,
  };
}

function buildReport(d) {
  const issues = [];
  const lines = [];

  const sess = d.db.session;
  lines.push('════════ Ydisks 授权健康检查 ════════');
  lines.push('');

  // ① 账号运行状态
  lines.push('【① 账号运行状态】');
  const rt = d.runtime && d.runtime[CID];
  if (rt) {
    const ok = rt.state === 'online' && rt.connected;
    lines.push(`  ${ok ? '✓' : '✗'} ${rt.state}  ${rt.message || ''}  失败次数=${rt.failures}`);
    if (rt.token_expires_at) {
      const hrs = rt.token_remaining_seconds != null ? (rt.token_remaining_seconds / 3600).toFixed(1) : '?';
      lines.push(`    WS Token 剩余 ${hrs}h（${rt.token_expires_at}）`);
      lines.push(`    上次刷新: ${rt.token_refresh_status}（${rt.token_refresh_at || rt.updated_at}）`);
      if (rt.token_refresh_status && rt.token_refresh_status !== 'success') {
        issues.push(`WS Token 刷新状态异常: ${rt.token_refresh_status}`);
      }
    }
    if (!ok) issues.push(`账号状态: ${rt.state} / ${rt.message}`);
  } else {
    lines.push('  ✗ 无法获取运行状态（服务无响应或未授权）');
    issues.push('无法获取账号运行状态');
  }

  // ② 长登录
  lines.push('');
  lines.push('【② 闲鱼长登录】');
  if (d.longLogin) {
    const on = d.longLogin.enabled;
    lines.push(`  ${on ? '✓ 已开启' : '✗ 未开启'}  (can_open=${d.longLogin.can_open_long_login})`);
    if (d.longLogin.can_open_long_login && !on) {
      issues.push('闲鱼长登录可用但未开启 —— 开启后可显著降低授权过期频率');
    }
  } else {
    lines.push('  ? 读取失败');
  }

  // ③ 续期记录
  lines.push('');
  lines.push('【③ 最近续期记录】');
  const renew = d.db.renew || [];
  if (renew.length) {
    let skipFatigue = 0;
    for (const r of renew) {
      const at = String(r.created_at || '').slice(5, 16);
      const st = r.status === 'skipped' ? '○' : r.status === 'cookie_updated' ? '✓' : '✗';
      lines.push(`  ${st} ${at}  ${r.status}${r.renew_method ? ' / ' + r.renew_method : ''}  ${String(r.message || '').slice(0, 46)}`);
      if (r.status === 'skipped' && /疲劳/.test(r.message || '')) skipFatigue++;
    }
    if (skipFatigue >= renew.length) {
      issues.push(`连续 ${skipFatigue} 次续期被「疲劳窗口」跳过 —— 静默续期已失效，需要账号密码自动登录兜底`);
    }
  } else {
    lines.push('  (无记录)');
  }

  // ④ 风控
  lines.push('');
  lines.push('【④ 闲鱼风控（滑块）】');
  const risk = d.db.risk || [];
  lines.push(`  累计 ${d.db.risk_total || 0} 次，失败 ${d.db.risk_failed || 0} 次，近 30 天 ${d.db.risk_last30 || 0} 次`);
  for (const r of risk.slice(0, 3)) {
    lines.push(`  · ${String(r.created_at).slice(5, 16)} ${r.processing_status}  ${String(r.processing_result || '').slice(0, 50)}`);
  }
  if ((d.db.risk_last30 || 0) > 0) {
    issues.push(`近 30 天发生 ${d.db.risk_last30} 次滑块风控 —— 这是授权反复过期的直接原因`);
  }

  // ⑤ 登录方式
  lines.push('');
  lines.push('【⑤ 登录方式】');
  const a = d.db.acct;
  if (a) {
    lines.push(`  方式=${a.login_method}  账号=${a.username || '(未填写)'}`);
    if (a.login_method === 'qr_scan' && !a.username) {
      issues.push('未配置账号密码 —— 只能靠人工扫码，助手无自动恢复能力');
    }
  }

  // ⑥ 控制台会话
  lines.push('');
  lines.push('【⑥ 控制台会话】');
  if (sess) {
    lines.push(`  ✓ 剩余 ${(sess.remaining / 3600).toFixed(1)} 小时（不影响发货，仅影响面板访问）`);
  } else {
    lines.push('  ✗ 无有效会话');
  }

  lines.push('');
  lines.push('【结论】');
  if (!issues.length) {
    lines.push('  ✓ 一切正常，无异常项');
  } else {
    issues.forEach((i, n) => lines.push(`  ${n + 1}. ${i}`));
  }
  return { text: lines.join('\n'), issues };
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');

  const d = await collect();
  const { text, issues } = buildReport(d);

  if (asJson) {
    console.log(JSON.stringify({
      ok: issues.length === 0,
      issues,
      runtime: d.runtime,
      longLogin: d.longLogin,
      sessionRemainingHours: d.db.session ? +(d.db.session.remaining / 3600).toFixed(2) : null,
      tokenRemainingHours: d.db.token ? +(d.db.token.remaining / 3600).toFixed(2) : null,
      risk30d: d.db.risk_last30,
      accountMethod: d.db.acct ? d.db.acct.login_method : null,
      accountUsername: d.db.acct ? d.db.acct.username : null,
    }, null, 2));
    process.exit(issues.length ? 1 : 0);
  }

  say(text);
  process.exit(issues.length ? 1 : 0);
}

main().catch((e) => { say('异常: ' + e.message); process.exit(2); });
