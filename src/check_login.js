'use strict';
/** 检查两个平台的登录态（读 Chrome Cookie DB） */
const fs = require('fs');
const path = require('path');
const { DATA } = require('./lib');

function readCookies(profileDir) {
  const f = path.join(profileDir, 'Default', 'Network', 'Cookies');
  if (!fs.existsSync(f)) return null;
  let s;
  try {
    s = fs.readFileSync(f).toString('latin1');
  } catch (e) {
    // 浏览器运行时文件被锁，退而检查 Local State 里的 profile 状态
    const ls = path.join(profileDir, 'Local State');
    const exists = fs.existsSync(ls);
    return { locked: true, exists, hosts: [], fields: [] };
  }
  const hosts = [...new Set([...s.matchAll(/[a-z0-9.-]*\.(?:x\.com|twitter\.com|twimg\.com|goofish\.com|taobao\.com|alibaba\.com)/g)].map((m) => m[0]))];
  const fields = [...new Set([...s.matchAll(/auth_token|ct0|twid|cookie2|_tb_token_|unb|cna|tracknick|sgcookie|isg/g)].map((m) => m[0]))];
  return { hosts, fields, size: s.length };
}

const targets = [
  ['X', path.join(DATA, 'profile_x')],
  ['闲鱼', path.join(DATA, 'profile_fish')],
];

console.log('=== 登录态检查 ===');
for (const [name, dir] of targets) {
  if (!fs.existsSync(dir)) { console.log(`${name}: profile 不存在（未登录过）`); continue; }
  const c = readCookies(dir);
  if (!c) { console.log(`${name}: 无 Cookie DB`); continue; }
  if (c.locked) {
    console.log(`${name}: ⚠ Cookie DB 被浏览器占用（登录窗口仍在运行），无法读取`);
    console.log(`   profile 状态: ${c.exists ? 'Local State 已生成，浏览器已启动过' : '未启动'}`);
    continue;
  }
  const hasAuth = c.fields.some((f) => /auth_token|ct0|twid|unb|_tb_token_|cna/.test(f));
  console.log(`${name}: ${hasAuth ? '✓ 疑似已登录' : '✗ 未登录'}`);
  console.log(`   域名: ${c.hosts.join(', ') || '(无)'}`);
  console.log(`   认证字段: ${c.fields.join(', ') || '(无)'}`);
}
