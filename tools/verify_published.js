const { launch, sleep, shot } = require('../src/lib');
(async () => {
  const ctx = await launch('fish', { headless: true });
  const p = ctx.pages()[0] || (await ctx.newPage());
  await p.setViewportSize({ width: 1400, height: 900 });
  await p.goto('https://www.goofish.com/search?q=%E5%A7%9C%E8%83%91%E8%AF%B4%E5%90%88%E9%9B%86', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  const items = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href*="/item"], a[href*="/item?id"]').forEach(a => {
      const t = (a.innerText || '').replace(/\s+/g,' ').trim();
      if (t) out.push({ href: a.getAttribute('href'), txt: t.slice(0,80) });
    });
    return out.slice(0, 10);
  });
  console.log('=== 搜索结果 ===');
  items.forEach(i => console.log(`  ${i.href}\n    ${i.txt}`));
  const body = ((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
  console.log('\n是否含我们的标题:', /姜胡说/.test(body) ? '✓ 在售' : '✗ 未找到');
  await shot(p, 'verify_published');
  await ctx.close();
})();
