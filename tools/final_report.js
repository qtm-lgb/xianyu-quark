'use strict';
/**
 * 端到端验收：上架商品 + 发货规则 + 链接有效性
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:59188/api/v1';
const CACHE = path.join(require('os').homedir(), '.workbuddy', 'yd_session.txt');
const ACCOUNT = '2419336374';

const say = (m) => console.log(m);

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
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* ignore */ }
  return { status: r.status, json: j };
}

(async () => {
  const listings = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listings.json'), 'utf8'));
  const published = listings.filter((x) => x.itemId);

  say('═'.repeat(66));
  say('  夸克课程批量上架 —— 验收报告');
  say('═'.repeat(66));

  say(`\n【1】商品上架`);
  say(`  已上架 ${published.length} / ${listings.length}`);
  const missing = listings.filter((x) => !x.itemId);
  if (missing.length) {
    say(`  未上架 ${missing.length} 个：`);
    missing.forEach((x) => say(`    · ${x.xyTitle.slice(0, 44)}`));
  }

  say(`\n【2】夸克永久链接`);
  const courses = fs.existsSync(path.join(ROOT, 'data', 'quark_courses.json'))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'quark_courses.json'), 'utf8')) : [];
  const withLink = courses.filter((c) => c.shareUrl);
  const permanent = withLink.filter((c) => c.expiredType === 1 || c.permanent);
  say(`  已建链接 ${withLink.length} 个，其中永久有效 ${permanent.length} 个`);
  const notPerm = withLink.filter((c) => !(c.expiredType === 1 || c.permanent));
  if (notPerm.length) notPerm.forEach((c) => say(`    ! 非永久: ${c.title.slice(0, 40)}`));

  say(`\n【3】Ydisks 自动发货规则`);
  const session = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8').trim() : null;
  if (!session) {
    say('  ✗ 无 Ydisks session');
  } else {
    const chk = await api(session, 'GET', '/session');
    if (!chk.json?.authenticated) {
      say('  ✗ session 失效');
    } else {
      const rulesRes = await api(session, 'GET', `/automation-rules?page=1&pageSize=200`);
      const rules = rulesRes.json?.data || [];
      const onRules = rules.filter((r) => r.enabled && r.trigger_type === 'order_paid');
      const covered = new Set(onRules.map((r) => String(r.item_id)));
      const need = published.filter((x) => !covered.has(String(x.itemId)));

      say(`  规则总数 ${rules.length}，启用的付款发货规则 ${onRules.length}`);
      say(`  覆盖商品 ${covered.size} 个`);

      const cardsRes = await api(session, 'GET', '/cards');
      const cards = cardsRes.json || [];
      say(`  卡密 ${cards.length} 条（启用 ${cards.filter((c) => c.enabled).length}）`);

      const typedRes = await api(session, 'GET', `/reply-rules/${ACCOUNT}/typed`);
      say(`  客服关键词规则 ${(typedRes.json || []).length} 条`);
      const dr = await api(session, 'GET', `/default-replies/${ACCOUNT}`);
      say(`  默认回复 enabled=${dr.json?.enabled}`);

      if (need.length) {
        say(`\n  ⚠ 未配发货规则 ${need.length} 个：`);
        need.forEach((x) => say(`    · ${x.xyTitle.slice(0, 44)}`));
      } else {
        say('\n  ✓ 所有已上架商品都已配置自动发货规则');
      }
    }
  }

  say(`\n【4】链接有效性抽查`);
  const picks = published.slice(0, 5).map((x) => x.sourceLink);
  if (picks.length) {
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, 'src', 'probe_quark.js'), ...picks], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const line = (out.match(/=== 汇总 ===[\s\S]*$/) || [''])[0].trim();
      say('  ' + line.split('\n').map((l) => '  ' + l).join('\n').trim());
    } catch (e) {
      say('  探活失败: ' + String(e.stdout || e.message).split('\n').slice(-3).join(' '));
    }
  }

  say('\n' + '═'.repeat(66));
})();
