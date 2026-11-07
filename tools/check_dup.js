/** 检查是否有重复商品（同标题多个 itemId） */
const { launch, sleep } = require('../src/lib');
(async()=>{
  const ctx=await launch('fish',{headless:true});
  const p=ctx.pages()[0]||await ctx.newPage();
  await p.setViewportSize({width:1500,height:1000});
  await p.goto('https://www.goofish.com/personal?tag=publish',{waitUntil:'domcontentloaded'});
  await sleep(9000);
  for(let i=0;i<12;i++){ await p.evaluate(()=>window.scrollBy(0,window.innerHeight*2)).catch(()=>{}); await sleep(1500); }
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
  // 按标题分组
  const g=new Map();
  for(const it of items){
    const t=it.text.replace(/个人整理版|24小时内发布|¥\s*[\d.]+|爱看不看吧|买家评价[""][^""]*[""]/g,'').trim();
    if(!g.has(t)) g.set(t,[]);
    g.get(t).push(it.id);
  }
  console.log('共', items.length, '个商品');
  const dups=[...g.entries()].filter(([k,v])=>v.length>1);
  console.log('\n重复标题', dups.length, '组:');
  dups.forEach(([t,ids])=>console.log(`  ${t.slice(0,44)}\n     ${ids.join(' , ')}`));
  await ctx.close();
})();
