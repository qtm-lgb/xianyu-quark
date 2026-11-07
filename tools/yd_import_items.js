'use strict';
/**
 * Ydisks —— 导入商品到 item_info 表
 *
 * 背景：Ydisks 建自动发货规则时校验「商品是否属于当前用户」，
 *      实际就是查 item_info 表。而它的自动同步接口
 *      (POST /api/v1/items/get-all-from-account) 走 MTOP 接口，
 *      实测会超时失败（TLS handshake timeout）。
 *
 * 所以直接写数据库更稳：
 *   1) 停掉 YdisksXianyuHelper 服务（数据库被它独占锁）
 *   2) 备份数据库
 *   3) 批量插入 item_info 记录
 *   4) 起回服务
 *   5) 用 API 建卡密 + 自动发货规则
 *
 * 用法: node tools/yd_import_items.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DB_DIR = 'C:\\ProgramData\\YdisksXianyuHelper\\data';
const DB = path.join(DB_DIR, 'xianyu_data.db');
const SERVICE = 'YdisksXianyuHelper';
const ACCOUNT = '2419336374';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');
const LIST_FILE = path.join(ROOT, 'data', 'listings.json');
const BASE = 'http://127.0.0.1:59188/api/v1';

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(cmd) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return ''; }
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
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}

(async () => {
  const dry = process.argv.includes('--dry-run');
  const listings = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  const published = listings.filter((x) => x.itemId);
  say(`已上架商品: ${published.length}/${listings.length}`);

  // 现有 item_info
  const py = `
import sqlite3, json, sys
c = sqlite3.connect(r'${DB.replace(/\\/g, '\\\\')}')
rows = c.execute("SELECT item_id, item_title FROM item_info WHERE cookie_id='${ACCOUNT}' AND deleted_at IS NULL").fetchall()
print(json.dumps([{"item_id":r[0],"title":r[1]} for r in rows], ensure_ascii=False))
`;
  const pyFile = path.join(os.tmpdir(), 'yd_read_items.py');
  fs.writeFileSync(pyFile, py, 'utf8');
  let existing = [];
  try {
    existing = JSON.parse(execFileSync('python', [pyFile], { encoding: 'utf8' }));
  } catch (e) {
    say('读取现有商品失败: ' + e.message.split('\n')[0]);
  }
  const have = new Set(existing.map((x) => String(x.item_id)));
  say(`Ydisks 已有商品: ${existing.length} 个`);

  const toAdd = published.filter((x) => !have.has(String(x.itemId)));
  say(`需导入: ${toAdd.length} 个`);
  toAdd.slice(0, 5).forEach((x) => say(`  ${x.itemId}  ${x.xyTitle.slice(0, 36)}`));
  if (toAdd.length > 5) say(`  ... 其余 ${toAdd.length - 5} 个`);

  if (dry) { say('dry-run，未写入'); return; }
  if (!toAdd.length) { say('无需导入'); return; }

  // 1) 停服务
  say('\n停止 Ydisks 服务...');
  ps(`Stop-Service -Name '${SERVICE}' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3`);
  await sleep(3500);
  const state = ps(`(Get-Service -Name '${SERVICE}').Status`).trim();
  say(`服务状态: ${state}`);

  // 2) 备份
  const backup = path.join(os.tmpdir(), `xianyu_data.backup.${Date.now()}.db`);
  try {
    fs.copyFileSync(DB, backup);
    say(`✓ 已备份 -> ${backup}`);
  } catch (e) {
    say('备份失败: ' + e.message.split('\n')[0]);
  }

  // 3) 写入（用 python，避开 node 的 sqlite 依赖问题）
  const rows = toAdd.map((x) => ({
    item_id: String(x.itemId),
    title: x.xyTitle,
    price: '¥1.90',
    category: '50023914',
  }));
  const py2 = `
import sqlite3, json
c = sqlite3.connect(r'${DB.replace(/\\/g, '\\\\')}')
c.execute("PRAGMA journal_mode=WAL")
rows = json.loads(r'''${JSON.stringify(rows)}''')
detail = '{"auction_type":"b","card_type":1003}'
now = datetime('now','localtime')
n = 0
for r in rows:
    exists = c.execute("SELECT id FROM item_info WHERE cookie_id=? AND item_id=?", ('${ACCOUNT}', r['item_id'])).fetchone()
    if exists:
        c.execute("UPDATE item_info SET item_title=?, item_price=?, deleted_at=NULL, updated_at=? WHERE id=?", (r['title'], r['price'], now, exists[0]))
    else:
        c.execute("INSERT INTO item_info (cookie_id,item_id,item_title,item_description,item_category,item_price,item_detail,is_multi_spec,multi_quantity_delivery,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,0,?,?)",
                  ('${ACCOUNT}', r['item_id'], r['title'], None, r['category'], r['price'], detail, now, now))
    n += 1
c.commit()
total = c.execute("SELECT COUNT(*) FROM item_info WHERE cookie_id=? AND deleted_at IS NULL", ('${ACCOUNT}',)).fetchone()[0]
print(f"inserted={n} total_active={total}")
`;
  const pyFile2 = path.join(os.tmpdir(), 'yd_write_items.py');
  fs.writeFileSync(pyFile2, py2, 'utf8');
  try {
    const out = execFileSync('python', [pyFile2], { encoding: 'utf8' }).trim();
    say(`✓ 写入完成: ${out}`);
  } catch (e) {
    say('✗ 写入失败: ' + (e.stderr || e.message).toString().split('\n').slice(0, 3).join(' '));
  }

  // 4) 起服务
  say('\n启动 Ydisks 服务...');
  ps(`Start-Service -Name '${SERVICE}' -ErrorAction SilentlyContinue`);
  await sleep(6000);
  const state2 = ps(`(Get-Service -Name '${SERVICE}').Status`).trim();
  say(`服务状态: ${state2}`);

  // 5) 校验 + 建规则
  const session = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8').trim() : null;
  if (!session) { say('✗ 无 session'); return; }
  const chk = await api(session, 'GET', '/session');
  if (!chk.json?.authenticated) { say('✗ session 失效，需重新获取'); return; }

  const items = await api(session, 'GET', `/items?cookie_id=${ACCOUNT}&page=1&page_size=200`);
  const list = Array.isArray(items.json) ? items.json : (items.json?.data?.items || []);
  say(`Ydisks 现在认识 ${list.length} 个商品`);

  say('\n配置卡密与自动发货规则...');
  execFileSync(process.execPath, [path.join(__dirname, 'yd_setup_courses.js')], {
    cwd: ROOT, stdio: 'inherit',
  });
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
