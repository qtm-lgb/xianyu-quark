/** 从「我发布的」读所有商品标题，检查是否还有绝对化用语 */
const { launch, sleep, shot } = require('../src/lib');
(async()=>{
  const ctx=await launch('fish',{headless:true});
  const p=ctx.pages()[0]||await ctx.newPage();
  await p.setViewportSize({width:1500,height:1000});
  await p.goto('https://www.goofish.com/personal?tag=publish',{waitUntil:'domcontentloaded'});
  await sleep(9000);
  for(let i=0;i<12;i++){ await p.evaluate(()=>window.scrollBy(0,window.innerHeight*2)).catch(()=>{}); await sleep(1400); }
  const items=await p.evaluate(()=>{
    const out=[]; const seen=new Set();
    document.querySelectorAll('a[href*="item?id"]').forEach(a=>{
      const m=(a.getAttribute('href')||'').match(/item\?id=(\d+)/); if(!m||seen.has(m[1]))return; seen.add(m[1]);
      let el=a,best='';
      for(let d=0;d<6&&el;d++){const t=(el.innerText||'').replace(/\s+/g,' ').trim(); if(t.length>best.length&&t.length<300)best=t; el=el.parentElement;}
      out.push({id:m[1],text:best});
    });
    return out;
  });
  const ABS=/最全|最新|第一|唯一|100%|彻底|顶级|最强|最好|最佳|国家级|世界级/g;
  console.log('在售商品 '+items.length+' 个:');
  let bad=0;
  items.forEach(it=>{
    const t=it.text.replace(/¥\s*[\d.]+|爱看不看吧|24小时内发布|个人整理版/g,'').trim();
    const hit=t.match(ABS);
    if(hit){ bad++; console.log(`  ⚠ ${it.id} 含「${hit[0]}」  ${t.slice(0,44)}`); }
  });
  console.log(bad? `\n仍有 ${bad} 个含绝对化用语` : '\n✓ 无绝对化用语');
  // 打印几个标题确认改名生效
  console.log('\n抽查标题:');
  items.filter(i=>/公众号虚拟资料|微信小程序/.test(i.text)).forEach(i=>console.log(`  ${i.id}  ${i.text.slice(0,52)}`));
  await shot(p,'check_titles');
  await ctx.close();
})();
