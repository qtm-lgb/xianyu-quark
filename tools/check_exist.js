/** 查指定关键词的商品是否已在售 */
const { launch, sleep } = require('../src/lib');
const KWS = process.argv.slice(2);
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
  for(const kw of KWS){
    const hit=items.filter(i=>i.text.includes(kw));
    console.log(`「${kw}」 -> ${hit.length} 个`);
    hit.forEach(h=>console.log(`    ${h.id}  ${h.text.slice(0,60)}`));
  }
  await ctx.close();
})();
