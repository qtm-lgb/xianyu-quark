'use strict';
/**
 * 夸克网盘：为每个课程文件夹准备永久分享链接
 *
 * 流程：
 *   1) 读「我的分享」列表（share/mypage/detail），按标题匹配已有分享
 *   2) 已有的直接复用（确认 expired_type=1 永久有效）
 *   3) 没有的用 POST /1/clouddrive/share 创建，再轮询 task 拿 share_id
 *   4) 结果写回 data/quark_courses.json
 *
 * 用法:
 *   node tools/quark_create_share.js --batch
 *   node tools/quark_create_share.js --batch --force   # 不复用，全部重建
 */
const fs = require('fs');
const path = require('path');
const { openQuark, qApi } = require('./quark_api');
const { pickSafe } = require('./quark_compliance');

const ROOT = path.resolve(__dirname, '..');
const COURSES = path.join(ROOT, 'data', 'quark_courses.json');
const MY_SHARE =
  '/1/clouddrive/share/mypage/detail?pr=ucpro&fr=pc&_page=1&_size=200' +
  '&_order_field=created_at&_order_type=desc&_fetch_total=1&_filter=all&_share_type=0,1';

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/** 读取我的分享列表 */
async function myShares(page) {
  const r = await qApi(page, 'GET', MY_SHARE);
  const list = r.json?.data?.list || r.json?.data?.items || [];
  return list;
}

/** 创建分享（异步任务 -> 轮询拿 share_id） */
async function createShare(page, fid, title) {
  const body = {
    fid_list: [fid],
    title: title || '',
    url_type: 1,
    expired_type: 1, // 永久有效
    password: '',
  };
  const r = await qApi(page, 'POST', '/1/clouddrive/share?pr=ucpro&fr=pc', body);
  if (r.status !== 200 || !r.json || (r.json.code !== undefined && r.json.code !== 0)) {
    return { ok: false, error: `HTTP ${r.status} code=${r.json?.code} ${r.json?.message || ''}` };
  }
  const taskId = r.json.data?.task_id;
  if (!taskId) return { ok: false, error: '未返回 task_id' };

  // 轮询任务
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1200);
    const t = await qApi(page, 'GET', `/1/clouddrive/task?pr=ucpro&fr=pc&task_id=${taskId}`);
    const d = t.json?.data;
    if (!d) continue;
    if (d.status === 2 || d.status === 3) {
      // 完成 -> 从我的分享里找刚建的
      const shares = await myShares(page);
      const hit = shares.find((s) => s.share_id === d.share_id) ||
                  shares.find((s) => s.title === title);
      if (hit) {
        return {
          ok: true,
          shareId: hit.share_id,
          pwdId: hit.pwd_id,
          url: `https://pan.quark.cn/s/${hit.pwd_id}`,
          expiredType: hit.expired_type,
          reused: false,
        };
      }
      return { ok: false, error: `任务完成但未在分享列表找到 (share_id=${d.share_id})` };
    }
    if (d.status === 4 || d.status === -1) {
      return { ok: false, error: `任务失败 status=${d.status}` };
    }
  }
  return { ok: false, error: '任务超时' };
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.includes('--batch')) {
    console.log('用法: node tools/quark_create_share.js --batch [--force]');
    process.exit(0);
  }
  const force = args.includes('--force');

  const courses = JSON.parse(fs.readFileSync(COURSES, 'utf8'));
  const { safe } = pickSafe(courses);
  say(`待处理合规课程: ${safe.length} 个`);

  const { ctx, page } = await openQuark({ headless: false });

  const existing = await myShares(page);
  say(`我的分享现有: ${existing.length} 条`);

  // 按标题建索引（同名取最近创建的）
  const byTitle = new Map();
  for (const s of existing) {
    const t = (s.title || '').trim();
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, s);
  }

  const results = [];
  let reused = 0, created = 0, failed = 0;

  for (let i = 0; i < safe.length; i++) {
    const c = safe[i];
    const title = c.title.trim();

    // 复用已有分享
    if (!force) {
      const hit = byTitle.get(title);
      if (hit && hit.pwd_id) {
        const isPermanent = hit.expired_type === 1;
        results.push({
          ...c,
          shareUrl: `https://pan.quark.cn/s/${hit.pwd_id}`,
          shareId: hit.share_id,
          pwdId: hit.pwd_id,
          expiredType: hit.expired_type,
          permanent: isPermanent,
          source: 'reused',
        });
        reused++;
        say(`  [${i + 1}/${safe.length}] ↺ 复用 ${title.slice(0, 28)}  ${hit.expired_type === 1 ? '永久' : '限时'}  ${hit.pwd_id}`);
        continue;
      }
    }

    // 新建
    const r = await createShare(page, c.fid, title);
    if (r.ok) {
      results.push({
        ...c,
        shareUrl: r.url,
        shareId: r.shareId,
        pwdId: r.pwdId,
        expiredType: r.expiredType ?? 1,
        permanent: (r.expiredType ?? 1) === 1,
        source: 'created',
      });
      created++;
      say(`  [${i + 1}/${safe.length}] ✓ 新建 ${title.slice(0, 28)}  ${r.url}`);
      byTitle.set(title, { share_id: r.shareId, pwd_id: r.pwdId, title, expired_type: r.expiredType ?? 1 });
    } else {
      results.push({ ...c, shareUrl: '', error: r.error, source: 'failed' });
      failed++;
      say(`  [${i + 1}/${safe.length}] ✗ ${title.slice(0, 28)}  ${r.error}`);
    }
    await page.waitForTimeout(1200);
  }

  fs.writeFileSync(COURSES, JSON.stringify(results, null, 2), 'utf8');
  say(`\n完成：复用 ${reused}，新建 ${created}，失败 ${failed}`);
  const withLink = results.filter((r) => r.shareUrl);
  say(`可用永久链接: ${withLink.length}/${results.length}`);
  await ctx.close();
  process.exit(0);
})().catch((e) => { say('异常: ' + e.message); process.exit(1); });
