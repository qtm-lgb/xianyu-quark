'use strict';
/**
 * 夸克课程 → 闲鱼商品 一键流水线
 *
 * 步骤：
 *   1. 登录夸克（复用已保存的登录态，没登录会提示）
 *   2. 读 JonnyShares 共享列表，逐个文件夹建永久分享链接
 *   3. 生成商品文案 + 主图
 *   4. 上架到闲鱼（回填 itemId）
 *   5. Ydisks 配卡密 + 自动发货规则 + 客服规则
 *
 * 用法:
 *   node tools/quark_pipeline.js --dry-run
 *   node tools/quark_pipeline.js
 *   node tools/quark_pipeline.js --skip-publish   # 只建链接和文案，不上架
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const say = (m) => console.log(`\n${'═'.repeat(62)}\n${m}\n${'═'.repeat(62)}`);

function run(script, args = []) {
  const p = path.join(ROOT, 'tools', script);
  console.log(`\n▶ 执行 ${script} ${args.join(' ')}\n${'-'.repeat(62)}`);
  execFileSync(process.execPath, [p, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, HOME: process.env.HOME || process.env.USERPROFILE },
  });
}

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const skipPublish = args.includes('--skip-publish');

(async () => {
  // 1) 登录
  say('步骤 1/5：夸克网盘登录');
  const marker = path.join(process.env.HOME || process.env.USERPROFILE, '.workbuddy', 'quark-profile', '.logged_in');
  if (!fs.existsSync(marker)) {
    console.log('未检测到登录态，请先运行: node tools/quark_login.js');
    process.exit(1);
  }
  console.log('✓ 已有夸克登录态');

  // 2) 读列表 + 建分享
  say('步骤 2/5：读取 JonnyShares 并为每个文件夹建永久分享');
  run('quark_list_courses.js', dry ? ['--create', '--dry-run'] : ['--create']);

  // 3) 文案 + 主图
  say('步骤 3/5：生成商品文案与主图');
  run('quark_build_listings.js');

  // 4) 上架
  if (!skipPublish) {
    say('步骤 4/5：上架到闲鱼');
    execFileSync(process.execPath, [path.join(ROOT, 'src', 'publish_xianyu.js'), ...(dry ? ['--dry-run'] : [])], {
      cwd: ROOT, encoding: 'utf8', stdio: 'inherit',
    });
  } else {
    say('步骤 4/5：跳过上架');
  }

  // 5) Ydisks 配置
  if (!skipPublish && !dry) {
    say('步骤 5/5：配置卡密 + 自动发货规则 + 客服规则');
    run('yd_setup_courses.js');
  } else {
    say('步骤 5/5：跳过（需先真实上架拿到 itemId）');
  }

  say('流水线完成');
})().catch((e) => {
  console.error('流水线中断: ' + e.message);
  process.exit(1);
});
