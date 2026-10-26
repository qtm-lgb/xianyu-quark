'use strict';
/**
 * 从 resources.json 生成商品文案与主图
 * 用法: node src/build_listings.js
 */
const path = require('path');
const { buildListings, renderCovers, cleanTitle } = require('./listing');
const { writeJSON, readJSON, log, DATA } = require('./lib');

(async () => {
  const resFile = path.join(DATA, 'resources.json');
  const resources = readJSON(resFile, []);
  if (!resources.length) {
    console.error('resources.json 为空，先跑 scrape_x.js');
    process.exit(1);
  }
  const valid = resources.filter((r) => r.probed && r.probed.valid);
  log('info', `资源 ${resources.length} 条，其中探活有效 ${valid.length} 条`);

  const listings = buildListings(resources);
  writeJSON(path.join(DATA, 'listings.json'), listings);
  log('ok', `生成 ${listings.length} 条商品文案 -> data/listings.json`);

  listings.forEach((l) => {
    console.log(`\n[${l.slug}] ¥${l.price}`);
    console.log(`  闲鱼标题: ${l.xyTitle}`);
    console.log(`  真实标题: ${l.title}`);
    console.log(`  文件数: ${l.fileCount}`);
  });

  if (listings.length) {
    await renderCovers(listings);
  }
  process.exit(0);
})();
