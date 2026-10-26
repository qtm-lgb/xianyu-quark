'use strict';
/**
 * X 采集器 v2 —— 监听浏览器真实搜索请求
 *
 * 为什么不直接调 GraphQL API：
 *   X 的 queryId 与 features 签名成对，猜错就是 422/404。
 *   最稳的做法是让浏览器自己发搜索请求，我们拦截响应解析。
 *
 * 流程：
 *   1) 打开 x.com/search?q=<关键词>，浏览器自动发 GraphQL 请求
 *   2) 拦截 /SearchTimeline 响应，解析出推文
 *   3) 滚动触发更多请求，累积采集
 *
 * 用法:
 *   node src/scrape_x.js --mode api --max 30 --keyword "夸克网盘"
 *   node src/scrape_x.js --mode both --max 30
 */
const path = require('path');
const {
  launch, newPage, sleep, log, makeThrottle, config, writeJSON, readJSON, DATA, shot,
} = require('./lib');
const { extractQuarkLinks, extractSingleLinks } = require('./probe_quark');
const { guessTitle, guessCode } = require('./parse');
const { resolveQuarkLinks, expandAll, extractShortLinks } = require('./expand_short');
const { resolveRelay } = require('./relay');

const OUT_FILE = path.join(DATA, 'resources.json');
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCO4M5suS8ESY5uJFo8mMguS3f3D4f6vNy4Q';

/**
 * 从 GraphQL 响应里递归找出推文对象
 *
 * 注意：X 的搜索响应结构是
 *   data.search_by_raw_query.search_timeline.timeline.instructions[].entries[]
 *   每个 entry 里可能挂在 itemContent.tweet_results.result 或 content.tweet_results.result
 * 所以用递归遍历最稳，不依赖具体路径。
 */
function extractTweets(json) {
  const out = [];
  const seen = new Set();

  const push = (legacy, user) => {
    if (!legacy || !legacy.full_text || !legacy.id_str) return;
    if (seen.has(legacy.id_str)) return;
    seen.add(legacy.id_str);
    out.push({
      text: legacy.full_text,
      url: user && user.screen_name
        ? `https://x.com/${user.screen_name}/status/${legacy.id_str}`
        : '',
      author: user && user.name ? `${user.name} (@${user.screen_name})` : '',
      time: legacy.created_at || '',
    });
  };

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    // 标准结构
    const legacy =
      node.tweet_results?.result?.legacy ||
      node.tweet?.legacy ||
      node.tweet_results?.result?.tweet?.legacy;
    if (legacy) {
      const user =
        node.tweet_results?.result?.core?.user_results?.result?.legacy ||
        node.tweet?.core?.user_results?.result?.legacy ||
        node.core?.user_results?.result?.legacy ||
        node.user_results?.result?.legacy;
      push(legacy, user);
    }
    for (const k of Object.keys(node)) {
      if (k === 'legacy') continue;
      walk(node[k]);
    }
  };
  walk(json);
  return out;
}

/** 监听模式：开页面 + 拦截响应 */
async function scrapeByIntercept(ctx, kws, max, scrolls) {
  const found = new Map();
  const relayCandidates = [];
  const relayMeta = new Map();
  const collectedTweets = [];
  const throttle = makeThrottle(3000);
  const page = ctx.pages()[0] || (await ctx.newPage());
  // 收集所有异步响应处理任务，函数结束前必须 await 完，
  // 否则回调里的 found 写入会晚于快照，造成「命中但没采到」
  const pending = [];

  // 挂响应监听（注意：必须用 resp.body()，resp.text() 会因响应体已被浏览器消费而失败）
  page.on('response', (resp) => {
    const u = resp.url();
    if (!/SearchTimeline|SearchAdaptive|graphql\/.*\/Search/i.test(u)) return;
    pending.push((async () => {
    let j = null;
    try {
      const buf = await resp.body();
      j = JSON.parse(buf.toString('utf8'));
    } catch {
      try { j = await resp.json(); } catch { return; }
    }
    if (!j) return;
    const tweets = extractTweets(j);
    if (!tweets.length) return;
    collectedTweets.push(...tweets);
    for (const tw of tweets) {
      // 先看文本里的直链（只认 /s/ 单文件分享，/g/ 是群聊邀请不可作商品）
      let links = extractSingleLinks(tw.text);
      // 没有直链就展开 t.co（可能指中转站）
      if (!links.length && /t\.co\//.test(tw.text)) {
        const { quarkLinks, shortMap } = await resolveQuarkLinks(ctx, tw.text);
        links = quarkLinks.filter((l) => /pan\.quark\.cn\/s\//.test(l));
        for (const [s, f] of Object.entries(shortMap)) {
          if (/wpss\.best/.test(f)) relayCandidates.push({ tweet: tw, short: s, relay: f.split(' -> ')[0] });
        }
        if (!links.length && relayCandidates.length) {
          // 中转站需要再解析一层
          const cand = relayCandidates[relayCandidates.length - 1];
          const r = await resolveRelay(ctx, cand.relay).catch(() => null);
          if (r && r.quarkLink && /pan\.quark\.cn\/s\//.test(r.quarkLink)) {
            links = [r.quarkLink];
            relayMeta.set(r.quarkLink, r);
          }
        }
      }
      for (const lk of links) {
        if (found.has(lk)) continue;
        const meta = relayMeta.get(lk);
        found.set(lk, {
          link: lk,
          code: guessCode(tw.text),
          title: (meta && meta.title) || guessTitle(tw.text, lk),
          sourceUrl: tw.url,
          author: tw.author,
          postedAt: tw.time,
          tweetText: tw.text.slice(0, 500),
          viaRelay: meta ? meta.relayUrl : '',
          relayTitle: meta ? meta.title : '',
          fileSize: meta ? meta.fileSize : '',
          scrapedAt: new Date().toISOString(),
          probed: null,
        });
        log('ok', `  ✓ 命中 ${lk}${meta ? ' (经中转站)' : ''}`);
      }
    }
    })().catch(() => {}));
  });

  for (const kw of kws) {
    await throttle(`搜索「${kw}」`);
    const q = encodeURIComponent(kw);
    await page.goto(`https://x.com/search?q=${q}&src=typed_query&f=live`, {
      waitUntil: 'domcontentloaded',
    }).catch(() => {});
    await sleep(7000);

    // 等待首屏响应处理完
    await sleep(3000);

    for (let i = 0; i < scrolls; i++) {
      if (found.size >= max) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.8)).catch(() => {});
      await sleep(3000);
    }
    if (found.size >= max) break;
  }

  // 关键：等所有响应处理完成，否则快照会漏掉最后一批命中
  await Promise.allSettled(pending);

  // 兜底：若仍无命中，直接对已收集的推文正文展开 t.co
  if (!found.size && collectedTweets.length) {
    // 只处理正文里提到「夸克/网盘/资料」的推文，避免无谓的网络请求
    const candidates = collectedTweets.filter((t) =>
      /夸克|网盘|资料|课程|合集|资源/.test(t.text) && /t\.co\//.test(t.text)
    );
    log('info', `回退：展开 ${candidates.length}/${collectedTweets.length} 条候选推文的短链`);

    // 一次性收集所有 t.co，批量并发展开（比逐条串行快一个数量级）
    const allShorts = [];
    const shortOwner = new Map(); // shortUrl -> tweet
    for (const tw of candidates) {
      for (const s of extractShortLinks(tw.text)) {
        allShorts.push(s);
        if (!shortOwner.has(s)) shortOwner.set(s, tw);
      }
    }
    const shortMap = await expandAll(ctx, allShorts, { concurrency: 12 });
    log('info', `短链展开完成 ${Object.keys(shortMap).length}/${allShorts.length}`);

    for (const [s, final] of Object.entries(shortMap)) {
      const tw = shortOwner.get(s) || {};
      let link = null;
      const direct = (final.match(/https?:\/\/pan\.quark\.cn\/s\/[A-Za-z0-9]+/) || [])[0];
      if (direct) {
        link = direct;
      } else if (/wpss\.best/.test(final)) {
        const r = await resolveRelay(ctx, final.split(' -> ')[0]).catch(() => null);
        if (r && r.quarkLink && /pan\.quark\.cn\/s\//.test(r.quarkLink)) {
          link = r.quarkLink;
          relayMeta.set(r.quarkLink, r);
        }
      }
      if (!link || found.has(link)) continue;
      const meta = relayMeta.get(link);
      found.set(link, {
        link,
        code: guessCode(tw.text || ''),
        title: (meta && meta.title) || guessTitle(tw.text || '', link),
        sourceUrl: tw.url || '',
        author: tw.author || '',
        postedAt: tw.time || '',
        tweetText: (tw.text || '').slice(0, 500),
        viaRelay: meta ? meta.relayUrl : '',
        relayTitle: meta ? meta.title : '',
        fileSize: meta ? meta.fileSize : '',
        scrapedAt: new Date().toISOString(),
        probed: null,
      });
      log('ok', `  ✓ 命中 ${link}${meta ? ' (经中转站)' : ''}`);
    }
  }

  return [...found.values()].slice(0, max);
}

/** API 模式：直接调 GraphQL（queryId 从缓存读，失败回退到 intercept） */
async function scrapeByApi(ctx, kws, max) {
  const fs = require('fs');
  const qidFile = path.join(DATA, 'x_queryid.txt');
  const queryId = fs.existsSync(qidFile) ? fs.readFileSync(qidFile, 'utf8').trim() : '';
  if (!queryId) {
    log('warn', '没有缓存的 queryId，改用 intercept 模式');
    return [];
  }
  const { auth_token, ct0 } = await getAuthCookies(ctx);
  if (!auth_token || !ct0) return [];

  const found = new Map();
  const throttle = makeThrottle(2500);
  for (const kw of kws) {
    await throttle(`API 搜索「${kw}」`);
    const variables = {
      rawQuery: kw, count: 20, querySource: 'typed_query', product: 'Latest',
    };
    const features = {
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_explore_v2: true,
      graphql_timeline_v2: true,
      creator_mentions: true,
    };
    const url =
      `https://x.com/i/api/graphql/${queryId}/SearchTimeline` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(features))}&queryId=${queryId}`;
    const resp = await ctx.request.post(url, {
      headers: {
        authorization: `Bearer ${BEARER}`,
        'x-csrf-token': ct0,
        'x-twitter-active-user': 'yes',
        'content-type': 'application/json',
        origin: 'https://x.com',
        referer: 'https://x.com/search',
      },
      data: { variables: JSON.stringify(variables), features: JSON.stringify(features), queryId },
    });
    if (!resp.ok()) {
      log('warn', `API 搜索返回 ${resp.status()}，改用 intercept 模式`);
      return [];
    }
    const json = await resp.json().catch(() => null);
    for (const tw of extractTweets(json)) {
      for (const lk of extractQuarkLinks(tw.text)) {
        if (found.has(lk)) continue;
        found.set(lk, {
          link: lk,
          code: guessCode(tw.text),
          title: guessTitle(tw.text, lk),
          sourceUrl: tw.url,
          author: tw.author,
          postedAt: tw.time,
          tweetText: tw.text.slice(0, 500),
          scrapedAt: new Date().toISOString(),
          probed: null,
        });
      }
    }
  }
  return [...found.values()].slice(0, max);
}

/** 从浏览器上下文取 X 认证 cookie */
async function getAuthCookies(ctx) {
  const cookies = await ctx.cookies('https://x.com');
  const get = (n) => (cookies.find((c) => c.name === n) || {}).value || '';
  return { auth_token: get('auth_token'), ct0: get('ct0') };
}

/** UI 模式：直接抓 DOM */
async function scrapeByUi(ctx, kws, max, scrolls) {
  const found = new Map();
  const throttle = makeThrottle(3000);
  const page = ctx.pages()[0] || (await ctx.newPage());
  for (const kw of kws) {
    await throttle(`UI 搜索「${kw}」`);
    const q = encodeURIComponent(kw);
    await page.goto(`https://x.com/search?q=${q}&src=typed_query&f=live`, {
      waitUntil: 'domcontentloaded',
    }).catch(() => {});
    await sleep(4000);
    for (let i = 0; i < scrolls; i++) {
      const tweets = await page.evaluate(() => {
        const nodes = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
        return [...nodes].map((a) => ({
          text: a.querySelector('[data-testid="tweetText"]')?.innerText || a.innerText || '',
          url: (() => { const h = a.querySelector('a[href*="/status/"]')?.getAttribute('href'); return h ? 'https://x.com' + h : ''; })(),
          author: a.querySelector('[data-testid="User-Name"]')?.innerText.replace(/\s+/g, ' ') || '',
          time: a.querySelector('time')?.getAttribute('datetime') || '',
        }));
      });
      let added = 0;
      for (const tw of tweets) {
        for (const lk of extractSingleLinks(tw.text)) {
          if (found.has(lk)) continue;
          found.set(lk, {
            link: lk, code: guessCode(tw.text), title: guessTitle(tw.text, lk),
            sourceUrl: tw.url, author: tw.author, postedAt: tw.time,
            tweetText: tw.text.slice(0, 500), scrapedAt: new Date().toISOString(), probed: null,
          });
          added++;
        }
      }
      if (added) log('ok', `  新增 ${added} 个链接（累计 ${found.size}）`);
      if (found.size >= max) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.6));
      await sleep(2000);
    }
    if (found.size >= max) break;
  }
  return [...found.values()].slice(0, max);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = { mode: 'intercept', max: 30, scrolls: 8, keywords: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') opt.mode = args[++i];
    else if (args[i] === '--max') opt.max = parseInt(args[++i], 10);
    else if (args[i] === '--scrolls') opt.scrolls = parseInt(args[++i], 10);
    else if (args[i] === '--keyword') opt.keywords.push(args[++i]);
    else if (!args[i].startsWith('--')) opt.keywords.push(args[i]);
  }
  const cfg = config();
  const kws = opt.keywords.length ? opt.keywords : cfg.keywords;
  // 代理：命令行 > 环境变量 > 配置文件
  const proxy = cfg.proxy || null;
  if (proxy) log('info', `使用代理: ${proxy}`);

  const ctx = await launch('x', { headless: true, proxy });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 注意：不要先访问 /home 再进 search 页。
  // X 的前端路由会复用首次加载的会话，之后 search 页不再发 SearchTimeline 请求，
  // 导致拦截模式收不到任何数据。直接开 search 页即可。
  const { auth_token } = await getAuthCookies(ctx);
  if (!auth_token) {
    log('err', 'X 未登录（无 auth_token），请先运行: node src/login_x_manual.js');
    await shot(page, 'scrape_x_not_logged_in');
    await ctx.close();
    process.exit(1);
  }
  log('ok', 'X 登录态正常');

  let list = [];
  if (opt.mode === 'api') {
    list = await scrapeByApi(ctx, kws, opt.max);
    if (!list.length) list = await scrapeByIntercept(ctx, kws, opt.max, opt.scrolls);
  } else if (opt.mode === 'ui') {
    list = await scrapeByUi(ctx, kws, opt.max, opt.scrolls);
  } else if (opt.mode === 'intercept') {
    // intercept 模式自带 t.co 展开 + 中转站解析，是最完整的模式
    list = await scrapeByIntercept(ctx, kws, opt.max, opt.scrolls);
  } else {
    // both：先 intercept（能展开短链），不够再补 UI
    list = await scrapeByIntercept(ctx, kws, opt.max, opt.scrolls);
    if (list.length < opt.max) {
      const more = await scrapeByUi(ctx, kws, opt.max - list.length, opt.scrolls);
      const seen = new Set(list.map((x) => x.link));
      list.push(...more.filter((x) => !seen.has(x.link)));
    }
  }
  await shot(page, 'scrape_x_last');
  await ctx.close();

  if (!list.length) {
    log('warn', '没有采集到夸克链接');
  } else {
    const prev = readJSON(OUT_FILE, []);
    const merged = [...list];
    for (const p of prev) {
      const hit = merged.find((m) => m.link === p.link);
      if (hit) { if (p.probed) hit.probed = p.probed; }
      else merged.push(p);
    }
    writeJSON(OUT_FILE, merged);
    log('ok', `采集完成：新增 ${list.length} 条，累计 ${merged.length} 条`);
  }

  console.log('\n=== 采集结果 ===');
  list.slice(0, 20).forEach((x) =>
    console.log(`\n链接: ${x.link}\n标题: ${x.title}\n码: ${x.code || '-'}\n来源: ${x.sourceUrl}\n作者: ${x.author}`)
  );
  process.exit(0);
}

module.exports = { extractTweets, scrapeByIntercept, scrapeByApi, scrapeByUi, getAuthCookies };

if (require.main === module) main();
