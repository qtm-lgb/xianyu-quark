'use strict';
/**
 * 从 Ydisks 助手数据库取最近的有效 session，并缓存到 ~/.workbuddy/yd_session.txt
 *
 * 助手服务在运行，数据库被独占锁，所以用 SQLite 的 URI 只读模式 + immutable 打开
 * （先复制文件再读最稳）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DB = 'C:/ProgramData/YdisksXianyuHelper/data/xianyu_data.db';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');

function say(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

(async () => {
  // 复制 db + wal + shm 到临时目录再读
  // Chrome/助手运行时文件被独占锁，用 PowerShell 的共享读方式复制
  const tmp = path.join(os.tmpdir(), 'yd_session_read.db');
  const tmpWal = tmp + '-wal';
  const tmpShm = tmp + '-shm';
  const copies = [[DB, tmp], [DB + '-wal', tmpWal], [DB + '-shm', tmpShm]];
  for (const [src, dst] of copies) {
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

  const { execFileSync: ex } = require('child_process');
  const py = `
import sqlite3, time
c = sqlite3.connect(r'${tmp.replace(/\\/g, '\\\\')}')
now = time.time()
rows = c.execute("SELECT session_id, username, is_admin, expires_at, created_at FROM sessions ORDER BY created_at DESC").fetchall()
best = None
for sid, un, adm, exp, cre in rows:
    # expires_at 可能是秒或毫秒
    e = (exp / 1000.0) if exp and exp > 1e11 else (exp or 0)
    left = e - now
    if left > 0:
        best = (sid, un, adm, left)
        break
if best:
    print(f"{best[0]}\\t{best[1]}\\t{best[2]}\\t{best[3]/86400:.2f}")
else:
    print("NONE")
`;
  const pyFile = path.join(os.tmpdir(), 'yd_sess.py');
  fs.writeFileSync(pyFile, py, 'utf8');
  const out = ex('python', [pyFile], { encoding: 'utf8' }).trim();
  const [sid, un, adm, days] = out.split('\t');

  if (!sid || sid === 'NONE') {
    say('✗ 没有有效 session。请在 Chrome 里登录 http://127.0.0.1:59188/ 后重试');
    process.exit(1);
  }
  say(`✓ session: ${sid.slice(0, 12)}... 用户=${un} admin=${adm} 剩余=${days} 天`);
  fs.writeFileSync(CACHE, sid, 'utf8');
  say(`已缓存到 ${CACHE}`);
  console.log(sid);
})();
