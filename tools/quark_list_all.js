'use strict';
/** 列出 JonnyShares 全部条目并保存 */
const fs = require('fs');
const path = require('path');
const { openQuark, listDir } = require('./quark_api');
const ROOT = path.resolve(__dirname, '..');
const FID = 'a1031f76d30541b2bb7fa700182171e4';

(async () => {
  const { ctx, page } = await openQuark({ headless: false });
  const { list, total } = await listDir(page, FID);
  console.log(`总数: ${total}  返回: ${list.length}`);
  // 判定文件夹：看字段
  const sample = list[0];
  console.log('首条全字段:', JSON.stringify(sample).slice(0, 400));
  const dirs = list.filter((f) => f.dir_f === true || f.dir === true || (f.share_fid_token && !f.size));
  const files = list.filter((f) => !dirs.includes(f));
  console.log(`\n文件夹(按 dir_f): ${dirs.length}   其他: ${files.length}`);
  console.log('\n=== 文件夹清单 ===');
  dirs.forEach((d, i) => console.log(`  [${i}] ${d.file_name}  fid=${d.fid}`));
  console.log('\n=== 非文件夹(散文件) ===');
  files.forEach((d, i) => console.log(`  [${i}] ${d.file_name}  size=${d.size}`));
  fs.writeFileSync(path.join(ROOT, 'data', 'quark_raw.json'), JSON.stringify(list, null, 2), 'utf8');
  console.log('\n已存 data/quark_raw.json');
  await ctx.close();
  process.exit(0);
})();
