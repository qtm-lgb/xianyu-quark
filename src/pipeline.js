'use strict';
/**
 * 一键流水线：X采集 -> 夸克探活 -> 生成文案与主图 -> 上架 -> 自动发货监听
 *
 * 用法:
 *   node src/pipeline.js                      采集+探活+生成文案主图（不上架）
 *   node src/pipeline.js --publish            含真实发布
 *   node src/pipeline.js --publish --dry-run  只填不发布，截图给你确认
 *   node src/pipeline.js --keyword "资料整理 夸克" --max 10
 *   node src/pipeline.js --listen             发布后常驻监听消息并自动发货
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { log, readJSON, writeJSON, DATA, ROOT } = require('./lib');

function run(script, args = []) {
  const p = path.join(ROOT, 'src', script);
  log('info', `▶ 执行 ${script} ${args.join(' ')}`);
  execFileSync(process.execPath, [p, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
}

(async () => {
  const args = process.argv.slice(2);
  const doPublish = args.includes('--publish');
  const doListen = args.includes('--listen');
  const dryRun = args.includes('--dry-run');

  const kwIdx = args.indexOf('--keyword');
  const maxIdx = args.indexOf('--max');
  const kw = kwIdx >= 0 ? args[kwIdx + 1] : null;
  const max = maxIdx >= 0 ? args[maxIdx + 1] : '20';

  // 1) X 采集
  const scrapeArgs = ['--mode', 'intercept', '--max', max];
  if (kw) scrapeArgs.push('--keyword', kw);
  run('scrape_x.js', scrapeArgs);

  // 2) 探活
  run('probe_quark.js', ['--file']);

  // 3) 文案 + 主图
  run('build_listings.js', []);

  const listings = readJSON(path.join(DATA, 'listings.json'), []);
  if (!listings.length) {
    log('err', '没有可上架的商品，流程中止');
    process.exit(1);
  }
  log('ok', `准备上架 ${listings.length} 个商品`);

  // 4) 上架
  if (doPublish) {
    run('publish_xianyu.js', dryRun ? ['--dry-run'] : []);
  } else {
    log('info', '跳过发布（加 --publish 开启；建议先加 --dry-run 预览）');
  }

  // 5) 自动发货监听
  if (doListen) {
    log('info', '开始监听消息并自动发货（Ctrl+C 退出）');
    run('auto_reply.js', []);
  } else {
    log('info', '跳过自动发货监听（加 --listen 开启）');
  }

  log('ok', '流水线完成');
  console.log('\n产物:');
  console.log('  data/resources.json  采集到的夸克资源');
  console.log('  data/listings.json   商品文案');
  console.log('  out/cover_*.png      商品主图');
  console.log('  shots/               各步骤截图');
  process.exit(0);
})();
