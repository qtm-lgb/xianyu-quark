'use strict';
/**
 * 闲鱼网页版：修改已发布商品的标题
 *
 * 背景：闲鱼对「最全/最新/第一」等绝对化用语（广告法第九条）会判违规并删除商品。
 *       发现被判违规后，需要在 15 天申诉期内把同类标题改掉。
 *
 * 用法: node tools/rename_item.js <itemId> "新标题"
 *       node tools/rename_item.js --from-file data/rename_map.json
 */
const fs = require('fs');
const path = require('path');
const { launch, sleep, shot } = require('../src/lib');

const ROOT = path.resolve(__dirname, '..');

/** 在商品页找到「编辑」入口并改标题 */
async function renameOne(page, itemId, newTitle) {
  // 闲鱼网页版不提供列表页/商品页的「编辑」按钮，
  // 但发布页支持 ?itemId=<id> 载入已有商品进行编辑（实测可用）。
  await page.goto(`https://www.goofish.com/publish?itemId=${itemId}`, { waitUntil: 'domcontentloaded' });
  await sleep(8000);

  const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
  if (!body.includes('个人整理版')) {
    return { ok: false, reason: '发布页未载入该商品（可能已删除或不属于当前账号）' };
  }

  // 标题是「宝贝描述」富文本框的**首行**，正文在第二行起。
  // 不能 Ctrl+A 全选（会把正文也删掉），只改首行。
  const ed = page.locator('[contenteditable="true"]').first();
  if ((await ed.count().catch(() => 0)) === 0) {
    return { ok: false, reason: '未找到标题输入框' };
  }
  const cur = await ed.evaluate((el) => (el.innerText || '').split('\n')[0].trim()).catch(() => '');
  if (cur === newTitle) {
    return { ok: true, reason: '标题已是目标值', url: page.url() };
  }
  await ed.click({ force: true }).catch(() => {});
  await sleep(600);
  // 光标移到首行行首
  await page.keyboard.press('Home').catch(() => {});
  await page.keyboard.press('Control+Home').catch(() => {});
  await sleep(200);
  // 选中首行（Shift+End）
  await page.keyboard.down('Shift').catch(() => {});
  await page.keyboard.press('End').catch(() => {});
  await page.keyboard.up('Shift').catch(() => {});
  await sleep(300);
  await page.keyboard.type(newTitle, { delay: 8 });
  await sleep(900);
  const after1 = await ed.evaluate((el) => (el.innerText || '').split('\n')[0].trim()).catch(() => '');
  if (after1 !== newTitle) {
    return { ok: false, reason: `首行未替换（当前="${after1.slice(0, 30)}"）` };
  }

  // 提交：编辑态下按钮文案是「发布」（不是「保存」）
  let saved = false;
  for (const t of ['发布', '保存', '确定', '提交']) {
    const btn = page.locator(`button:has-text("${t}"), .ant-modal-confirm-btns button:has-text("${t}")`).first();
    if ((await btn.count().catch(() => 0)) > 0) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(400);
      await btn.click({ force: true }).catch(() => {});
      saved = true;
      break;
    }
  }
  if (!saved) {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await sleep(5000);

  const after = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
  const ok = after.includes(newTitle.slice(0, 10));
  return { ok, reason: ok ? '' : '未确认标题已更新', url: page.url() };
}

(async () => {
  const args = process.argv.slice(2);
  let jobs = [];
  if (args[0] === '--from-file') {
    const f = path.resolve(args[1]);
    jobs = JSON.parse(fs.readFileSync(f, 'utf8'));
  } else if (args.length >= 2) {
    jobs = [{ itemId: args[0], newTitle: args[1] }];
  } else {
    console.log('用法: node tools/rename_item.js <itemId> "新标题" | --from-file <json>');
    process.exit(1);
  }

  const ctx = await launch('fish', { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.setViewportSize({ width: 1500, height: 1000 });

  const results = [];
  for (const j of jobs) {
    process.stdout.write(`  ${j.itemId} -> "${j.newTitle}" ... `);
    const r = await renameOne(page, String(j.itemId), j.newTitle);
    console.log(r.ok ? '✓' : `✗ ${r.reason}`);
    results.push({ ...j, ...r });
    await sleep(2000);
  }
  fs.writeFileSync(path.join(ROOT, 'out', 'rename_results.json'), JSON.stringify(results, null, 2), 'utf8');
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n完成 ${ok}/${results.length}`);
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error('异常: ' + e.message); process.exit(1); });
