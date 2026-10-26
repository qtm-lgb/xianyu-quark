// 跑通"探活->文案->主图"全链路（不依赖登录）
const { probeAll } = require('../src/probe_quark');
const { buildListings, renderCovers } = require('../src/listing');
const { writeJSON, log, DATA } = require('../src/lib');
const path = require('path');
(async()=>{
  const seeds = [
    {link:'https://pan.quark.cn/s/abcff1f83e22', code:'', title:'各类技术教程'},
    {link:'https://pan.quark.cn/s/c01c97be79a9', code:'', title:'【2026教师招聘】'},
    {link:'https://pan.quark.cn/s/93970473128f', code:'', title:'AI短视频情绪共鸣文案'},
  ];
  const res = await probeAll(seeds);           // 顺序已与输入对齐
  const resources = res.map((r,i)=>({...seeds[i], probed:{valid:r.valid,title:r.title,fileCount:r.fileCount,files:r.files,author:r.author,totalSize:r.totalSize,error:r.error}}));
  writeJSON(path.join(DATA,'resources.json'), resources);
  const listings = buildListings(resources);
  log('ok',`生成 ${listings.length} 条商品`);
  listings.forEach(l=>console.log(`\n[${l.slug}] ¥${l.price}\n  闲鱼标题: ${l.xyTitle}\n  真实资源: ${l.title}`));
  writeJSON(path.join(DATA,'listings.json'), listings);
  const covers = await renderCovers(listings);
  console.log('\n主图:'); covers.forEach(c=>console.log('  '+c));
})();
