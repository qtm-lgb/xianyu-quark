'use strict';
/**
 * 夸克课程 -> 闲鱼商品
 *
 * 输入：data/quark_courses.json（每个文件夹一门课，含永久分享链接）
 * 输出：data/listings.json + out/cover_*.png（复用 src/listing.js 的文案与主图逻辑）
 *
 * 用法: node tools/quark_build_listings.js
 */
const fs = require('fs');
const path = require('path');
const { buildListings, renderCovers, buildTitle, buildDescription, buildDeliveryText, buildCoverSVG, cleanTitle } = require('../src/listing');
const { log, DATA, OUT } = require('../src/lib');

const SRC = path.join(DATA, 'quark_courses.json');
const PRICE = 1.9;

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到 ${SRC}\n先跑 node tools/quark_list_courses.js --create`);
    process.exit(1);
  }
  const courses = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const usable = courses.filter((c) => c.shareUrl && /pan\.quark\.cn\/s\//.test(c.shareUrl));
  log('info', `夸克课程 ${courses.length} 条，可用 ${usable.length} 条`);

  if (!usable.length) {
    console.error('没有可用课程（缺永久分享链接）');
    process.exit(1);
  }

  // 转成 src/listing.js 认识的资源结构
  const resources = usable.map((c) => {
    const slug = (c.shareUrl.split('/s/')[1] || c.fid || c.title).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
    return {
      link: c.shareUrl,
      code: c.code || '',
      title: c.title,
      probed: {
        valid: true,
        title: c.title,
        fileCount: c.fileCount || c.itemCount || 0,
        files: c.files || [],
        totalSize: c.size || '',
      },
      courseFolder: c.folderName || c.title,
      fileCount: c.fileCount || 0,
      _slug: slug,
    };
  });

  const listings = buildListings(resources, { price: PRICE });

  // buildListings 用 link 尾段做 slug，这里改成用课程名更可读
  listings.forEach((l, i) => {
    const r = resources[i];
    l.slug = r._slug || l.slug;
    l.courseFolder = r.courseFolder;
    l.fileCount = r.fileCount;
    // 用课程文件夹名做标题（比分享链接的标题更准）
    if (r.courseFolder && r.courseFolder !== l.title) {
      l.title = r.courseFolder;
      l.xyTitle = buildTitle(r.courseFolder);
      l.description = buildDescription({
        title: r.courseFolder,
        link: l.sourceLink,
        code: l.code,
        fileCount: l.fileCount,
        files: r.probed.files,
      });
      l.deliveryText = buildDeliveryText({
        link: l.sourceLink,
        code: l.code,
        fileCount: l.fileCount,
      });
      l.coverSvg = buildCoverSVG({
        title: cleanTitle(r.courseFolder),
        subtitle: '云端交付 · 长期可用',
        badges: ['个人整理版', '学习参考', '长期可用'],
        fileCount: l.fileCount,
      });
    }
  });

  // 合并写入：保留已上架商品的 itemId（发布进程回填的，不能被覆盖掉）
  const LIST_FILE = path.join(DATA, 'listings.json');
  const prev = fs.existsSync(LIST_FILE) ? JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) : [];
  const prevBySlug = new Map(prev.map((x) => [x.slug, x]));
  let kept = 0;
  for (const l of listings) {
    const old = prevBySlug.get(l.slug);
    if (!old) continue;
    if (old.itemId) { l.itemId = old.itemId; l.itemUrl = old.itemUrl; l.publishedAt = old.publishedAt; kept++; }
  }
  fs.writeFileSync(LIST_FILE, JSON.stringify(listings, null, 2), 'utf8');
  log('ok', `生成 ${listings.length} 条商品文案 -> data/listings.json（保留 ${kept} 个已上架 itemId）`);

  listings.forEach((l) => {
    console.log(`\n[${l.slug}] ¥${l.price}`);
    console.log(`  闲鱼标题: ${l.xyTitle}`);
    console.log(`  真实标题: ${l.title}`);
    console.log(`  文件数: ${l.fileCount}`);
    console.log(`  链接: ${l.sourceLink}`);
  });

  await renderCovers(listings);
  log('ok', '主图已生成');
  process.exit(0);
})();
