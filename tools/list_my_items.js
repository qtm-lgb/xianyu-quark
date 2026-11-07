/** 列出「我发布的」全部商品，标记本地已知状态 */
const fs=require('fs'), path=require('path');
const { launch, sleep, shot } = require('../src/lib');
const ROOT=path.resolve(__dirname,'..');
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
  const l=JSON.parse(fs.readFileSync(path.join(ROOT,'data','listings.json'),'utf8'));
  const byId=new Map(l.map(x=>[String(x.itemId||''),x]));
  const ABS=/最全|最新|第一|唯一|100%|彻底|顶级|最强|最好|最佳/;
  const RISK=/换脸|破解|激活|解锁|敏感词|印章|暴力/;
  console.log('════ 我的在售商品 '+items.length+' 件 ════\n');
  let risky=0;
  for(const it of items){
    const t=it.text.replace(/个人整理版|24小时内发布|¥\s*[\d.]+|爱看不看吧|买家评价[""][^""]*[""]/g,'').trim();
    const local=byId.get(String(it.id));
    const flags=[];
    if(ABS.test(t)) { flags.push('绝对化:'+t.match(ABS)[0]); risky++; }
    if(RISK.test(t)) { flags.push('高危:'+t.match(RISK)[0]); risky++; }
    const pen=local&&local.penalized;
    console.log(`  ${it.id}  ${t.slice(0,40).padEnd(42)} ${flags.join(' ')}${pen?'  [已被处罚标记]':''}`);
  }
  console.log(`\n合计 ${items.length} 件，风险词命中 ${risky} 件`);
  await shot(p,'list_my_items');
  await ctx.close();
})();
