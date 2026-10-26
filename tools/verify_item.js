const { launch, sleep, shot } = require('../src/lib');
const fs = require('fs');
(async () => {
  const ctx = await launch('fish', { headless: true });
  const p = ctx.pages()[0] || (await ctx.newPage());
  await p.setViewportSize({ width: 1400, height: 900 });
  // 找自己发布的商品（personal 页里的 item 链接）
  await p.goto('https://www.goofish.com/personal?tag=publish', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  const links = await p.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="item?id"]')].map(a=>a.getAttribute('href')))]);
  console.log('我发布的商品数:', links.length);
  let found = null;
  for (const l of links) {
    await p.goto('https://www.goofish.com' + l, { waitUntil: 'domcontentloaded' }).catch(()=>{});
    await sleep(4000);
    const body = ((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
    if (/姜胡说/.test(body)) {
      console.log('\n✓ 找到我们的商品:', l);
      const idx = body.indexOf('姜胡说');
      console.log('  片段:', body.slice(Math.max(0,idx-80), idx+200));
      const price = body.match(/¥\s*([\d.]+)/);
      console.log('  价格:', price ? price[0] : '?');
      found = l;
      await shot(p, 'verify_item_found');
      break;
    }
  }
  if (!found) {
    console.log('\n未在前几个商品中找到（可能是审核中或需要滚动加载）');
    await shot(p, 'verify_item_list');
  }
  await ctx.close();
})();
