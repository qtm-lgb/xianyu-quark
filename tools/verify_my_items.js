const { launch, sleep, shot } = require('../src/lib');
(async () => {
  const ctx = await launch('fish', { headless: true });
  const p = ctx.pages()[0] || (await ctx.newPage());
  await p.setViewportSize({ width: 1400, height: 900 });
  for (const u of ['https://www.goofish.com/personal?tag=publish', 'https://www.goofish.com/im', 'https://www.goofish.com/']) {
    await p.goto(u, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await sleep(5000);
    const body = ((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
    console.log(`\n=== ${u} ===`);
    console.log('  含「姜胡说」:', /姜胡说/.test(body) ? '✓ 是' : '否');
    if (/姜胡说/.test(body)) {
      const idx = body.indexOf('姜胡说');
      console.log('  片段:', body.slice(Math.max(0,idx-120), idx+180));
    }
    const links = await p.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="item?id"]')].map(a=>a.getAttribute('href')))].slice(0,5));
    if (links.length) console.log('  商品链接:', links.join(' | '));
  }
  await shot(p, 'verify_my_items');
  await ctx.close();
})();
