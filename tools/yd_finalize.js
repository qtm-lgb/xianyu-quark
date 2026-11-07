'use strict';
/**
 * 合并补发结果 -> 主 listings.json，然后导入 Ydisks 并配置发货规则
 *
 * 用法: node tools/yd_finalize.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'data', 'listings.json');
const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// 所有可能的补发文件
const EXTRA = ['listings_pending.json', 'listings_pending2.json', 'listings_to_publish.json'];

(async () => {
  const main = JSON.parse(fs.readFileSync(MAIN, 'utf8'));
  const bySlug = new Map(main.map((x) => [x.slug, x]));
  let merged = 0;

  for (const f of EXTRA) {
    const p = path.join(ROOT, 'data', f);
    if (!fs.existsSync(p)) continue;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const item of arr) {
      if (!item.itemId) continue;
      const cur = bySlug.get(item.slug);
      if (cur && !cur.itemId) {
        cur.itemId = item.itemId;
        cur.itemUrl = `https://www.goofish.com/item?id=${item.itemId}`;
        cur.publishedAt = item.publishedAt || new Date().toISOString();
        merged++;
      }
    }
  }
  fs.writeFileSync(MAIN, JSON.stringify(main, null, 2), 'utf8');
  const total = main.filter((x) => x.itemId).length;
  say(`合并 ${merged} 个 itemId -> 主表，共 ${total}/${main.length} 已上架`);

  if (!total) {
    say('没有已上架商品，终止');
    process.exit(1);
  }

  const missing = main.filter((x) => !x.itemId);
  if (missing.length) {
    say(`\n未上架 ${missing.length} 个：`);
    missing.forEach((x) => say(`  ${x.slug}  ${x.xyTitle.slice(0, 40)}`));
  }

  say('\n导入 Ydisks 并配置发货规则...');
  execFileSync(process.execPath, [path.join(__dirname, 'yd_import_items.js')], {
    cwd: ROOT, stdio: 'inherit',
  });
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
