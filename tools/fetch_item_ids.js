'use strict';
/**
 * 从闲鱼「我发布的」抓取商品 itemId + 标题，回填 listings.json
 *
 * 这是 itemId 的唯一真相来源。
 * 匹配用「去括号后的标题前缀」，因为闲鱼会去掉标题里的【】（）等符号，
 * 且长标题在列表页可能被截断，所以逐级缩短前缀去匹配。
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, shot } = require('../src/lib');
const { cleanTitle } = require('../src/listing');

const ROOT = path.resolve(__dirname, '..');
const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/** 去掉页面上的噪声，得到可比对的标题核心 */
function normalize(s) {
  return String(s || '')
    .replace(/个人整理版/g, '')
    .replace(/24小时内发布|刚刚发布|发布中|审核中|已下架|在售|卖掉了/g, '')
    .replace(/买家评价[""][^""]*[""]/g, '')
    .replace(/¥\s*[\d.]+/g, '')
    .replace(/爱看不看吧/g, '')
    .replace(/\s+/g, '')
    .trim();
}

(async () => {
  const ctx = await launch('fish', { headless: true });
  const p = ctx.pages()[0] || (await ctx.newPage());
  await p.setViewportSize({ width: 1500, height: 1000 });
  await p.goto('https://www.goofish.com/personal?tag=publish', { waitUntil: 'domcontentloaded' });
  await sleep(9000);
  for (let i = 0; i < 12; i++) {
    await p.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {});
    await sleep(1600);
  }

  const items = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href*="item?id"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/item\?id=(\d+)/);
      if (!m) return;
      let el = a, best = '';
      for (let d = 0; d < 6 && el; d++) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > best.length && t.length < 300) best = t;
        el = el.parentElement;
      }
      out.push({ id: m[1], text: best });
    });
    return out;
  });

  const map = new Map();
  for (const it of items) if (!map.has(it.id)) map.set(it.id, it);
  say(`抓到 ${map.size} 个已发布商品`);

  const index = [];
  for (const [, it] of map) {
    const n = normalize(it.text);
    if (n) index.push([n, it.id]);
  }

  const listFile = path.join(ROOT, 'data', 'listings.json');
  const listings = JSON.parse(fs.readFileSync(listFile, 'utf8'));

  let filled = 0;
  const unmatched = [];
  for (const l of listings) {
    const core = normalize(cleanTitle(l.title || ''));
    if (!core) continue;
    let hit = null;
    for (let len = Math.min(core.length, 16); len >= 4 && !hit; len--) {
      const frag = core.slice(0, len);
      for (const [n, id] of index) {
        if (n.includes(frag)) { hit = id; break; }
      }
    }
    if (hit) {
      if (!l.itemId) filled++;
      l.itemId = hit;
      l.itemUrl = `https://www.goofish.com/item?id=${hit}`;
      l.publishedAt = l.publishedAt || new Date().toISOString();
    } else if (!l.itemId) {
      unmatched.push(l);
    }
  }

  fs.writeFileSync(listFile, JSON.stringify(listings, null, 2), 'utf8');
  const total = listings.filter((x) => x.itemId).length;
  say(`回填 ${filled} 个，共 ${total}/${listings.length} 已上架`);

  if (unmatched.length) {
    say(`\n未匹配（需补发）${unmatched.length} 个：`);
    unmatched.forEach((l) => say(`  ${l.slug}  ${l.xyTitle.slice(0, 40)}`));
    fs.writeFileSync(path.join(ROOT, 'data', 'listings_pending.json'), JSON.stringify(unmatched, null, 2), 'utf8');
    say('已写入 data/listings_pending.json');
  }
  await shot(p, 'fetch_item_ids');
  await ctx.close();
  process.exit(0);
})();
