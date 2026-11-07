'use strict';
/** 扫描每个课程文件夹：文件数、大小、是否有提取码需求 */
const fs = require('fs');
const path = require('path');
const { openQuark, listDir, qApi } = require('./quark_api');
const ROOT = path.resolve(__dirname, '..');

(async () => {
  const { ctx, page } = await openQuark({ headless: false });
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'quark_raw.json'), 'utf8'));
  const dirs = raw.filter((f) => f.dir_f === true || f.dir === true || (f.share_fid_token && !f.size));
  console.log(`扫描 ${dirs.length} 个文件夹...\n`);

  const courses = [];
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    let count = 0, size = 0, sample = [];
    try {
      const { list, total } = await listDir(page, d.fid);
      count = total || list.length;
      for (const f of list) {
        size += Number(f.size || 0);
        if (sample.length < 3) sample.push(f.file_name);
      }
    } catch (e) {
      console.log(`  [${i}] ${d.file_name}  读取失败: ${e.message.slice(0, 40)}`);
    }
    courses.push({
      index: i + 1,
      title: d.file_name,
      fid: d.fid,
      fileCount: count,
      size,
      sizeText: size > 1024 * 1024 * 1024 ? (size / 1024 ** 3).toFixed(2) + 'G'
        : size > 1024 * 1024 ? (size / 1024 ** 2).toFixed(1) + 'M' : (size / 1024).toFixed(0) + 'K',
      sampleFiles: sample,
    });
    console.log(`  [${String(i + 1).padStart(2)}] ${d.file_name.slice(0, 42).padEnd(44)} ${String(count).padStart(4)} 个  ${courses[i].sizeText.padStart(7)}`);
    await page.waitForTimeout(400);
  }
  fs.writeFileSync(path.join(ROOT, 'data', 'quark_courses.json'), JSON.stringify(courses, null, 2), 'utf8');
  console.log('\n已存 data/quark_courses.json');
  await ctx.close();
  process.exit(0);
})();
