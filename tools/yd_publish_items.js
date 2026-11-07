'use strict';
/**
 * 用 Ydisks 的发布接口上架商品（比 Playwright 走网页更稳）
 *
 * 接口：POST /api/v1/items/publish   （FormData）
 * 字段：
 *   cookie_id, title, description, price, original_price, quantity,
 *   postage_mode=free, postage, location(JSON), images(文件)
 *   default_cookie_id, fallback_category_id, fallback_category_name,
 *   fallback_channel_category_id
 *
 * 分类策略：
 *   Ydisks 用 POST /api/v1/items/publish-categories/recommend 按关键词推荐分类，
 *   但推荐的可能是「AI视频工具/服务」这类**只能 APP 发布**的分类，
 *   网页版会被拦（"网页版暂不支持发布此分类"）。
 *   所以这里用「电子资料」类关键词拿到可用的兜底分类（channel_cat_id=202036301）。
 *
 * 用法:
 *   node tools/yd_publish_items.js --dry-run
 *   node tools/yd_publish_items.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'http://127.0.0.1:59188/api/v1';
const ACCOUNT = '2419336374';
const CACHE = path.join(os.homedir(), '.workbuddy', 'yd_session.txt');
const ROOT = path.resolve(__dirname, '..');
const LIST_FILE = path.join(ROOT, 'data', 'listings.json');
const OUT_FILE = path.join(ROOT, 'out', 'yd_publish_results.json');

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

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
  return { status: r.status, json: j, text: t };
}

/**
 * 拿一个**网页版支持**的兜底分类
 *
 * 关键（2026-11 实测）：分类是按标题语义推荐的，可能给出
 * 「AI视频工具/服务」「AI设计工具/服务」这类**只能 APP 发布**的分类，
 * 网页版点发布会被拦：「网页版暂不支持发布此分类」。
 * 只有「电子资料」(channel_cat_id=202036301) 是网页版支持的。
 * 所以这里固定用「电子资料」，推荐结果只作参考。
 */
const SAFE_CATEGORY = { catId: '50023914', catName: '电子资料', channelCatId: '202036301' };

async function getFallbackCategory(session, keyword) {
  let recommended = '(推荐失败)';
  try {
    const r = await api(session, 'POST', '/items/publish-categories/recommend', {
      cookie_id: ACCOUNT,
      keyword: `${keyword} 电子资料 学习`,
    });
    if (r.json?.category?.cat_name) recommended = r.json.category.cat_name;
  } catch { /* ignore */ }
  return { ...SAFE_CATEGORY, recommended };
}

/** 发布单个商品 */
async function publishOne(session, item, coverFile) {
  const cat = await getFallbackCategory(session, item.title || '');

  const fd = new FormData();
  fd.set('cookie_id', ACCOUNT);
  fd.set('default_cookie_id', ACCOUNT);
  fd.set('title', item.xyTitle);
  fd.set('description', item.description);
  fd.set('price', String(item.price || 1.9));
  fd.set('original_price', '');
  fd.set('quantity', '1');
  fd.set('postage_mode', 'free');           // 无需邮寄
  fd.set('postage', '');
  fd.set('location', JSON.stringify({ city: '祥龙商业广场' }));
  fd.set('fallback_category_id', cat.catId);
  fd.set('fallback_category_name', cat.catName);
  fd.set('fallback_channel_category_id', cat.channelCatId);
  if (coverFile && fs.existsSync(coverFile)) {
    // 必须显式给 MIME type，否则服务端判定「只能上传图片文件」
    const buf = fs.readFileSync(coverFile);
    fd.append('images', new Blob([buf], { type: 'image/png' }), path.basename(coverFile));
  }

  const r = await fetch(`${BASE}/items/publish`, {
    method: 'POST',
    headers: { cookie: `session=${session}`, accept: 'application/json' },
    body: fd,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return {
    ok: r.ok && json?.success !== false,
    status: r.status,
    cat,
    json,
    text: text.slice(0, 400),
  };
}

(async () => {
  const dry = process.argv.includes('--dry-run');
  const sid = fs.existsSync(CACHE) ? fs.readFileSync(CACHE, 'utf8').trim() : null;
  if (!sid) { say('✗ 无 Ydisks session，先跑 node tools/yd_session.js'); process.exit(1); }
  const chk = await api(sid, 'GET', '/session');
  if (!chk.json?.authenticated) { say('✗ session 失效'); process.exit(1); }
  say(`✓ 认证: ${chk.json.username}`);

  const listings = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
  // 统一合规拦截（src/compliance.js）—— 所有发布入口共用同一把尺子
  const { filterPublishable, reportBlocked } = require('../src/compliance');
  const { ok: allowed, blocked } = filterPublishable(listings);
  const todo = allowed.filter((x) => !x.itemId);
  const skipped = blocked.filter((b) => !b.item.itemId);
  if (skipped.length) {
    say(`合规拦截 ${skipped.length} 个，不予发布:`);
    console.log(reportBlocked(skipped));
  }
  say(`待发布: ${todo.length} 个`);

  if (dry) {
    for (const it of todo.slice(0, 5)) {
      const cat = await getFallbackCategory(sid, it.title || '');
      say(`  ${it.xyTitle.slice(0, 30)} -> 分类「${cat.catName}」(${cat.channelCatId}) 推荐=${cat.recommended}`);
    }
    say('dry-run，未发布');
    return;
  }

  const results = [];
  for (let i = 0; i < todo.length; i++) {
    const it = todo[i];
    const cover = path.join(ROOT, 'out', `cover_${it.slug}.png`);
    const r = await publishOne(sid, it, cover);
    if (r.ok) {
      const itemId = r.json?.item_id || r.json?.data?.item_id || '';
      say(`  [${i + 1}/${todo.length}] ✓ ${it.xyTitle.slice(0, 26)}  分类=${r.cat.catName}  ${itemId || ''}`);
      if (itemId) {
        it.itemId = String(itemId);
        it.itemUrl = `https://www.goofish.com/item?id=${itemId}`;
        it.publishedAt = new Date().toISOString();
        fs.writeFileSync(LIST_FILE, JSON.stringify(listings, null, 2), 'utf8');
      }
      results.push({ slug: it.slug, ok: true, itemId, cat: r.cat.catName });
    } else {
      say(`  [${i + 1}/${todo.length}] ✗ ${it.xyTitle.slice(0, 26)}  ${(r.text || '').slice(0, 140)}`);
      results.push({ slug: it.slug, ok: false, error: (r.text || '').slice(0, 200) });
    }
    await new Promise((s) => setTimeout(s, 8000));
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');
  const ok = results.filter((r) => r.ok).length;
  say(`\n完成：成功 ${ok}/${results.length}`);
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
