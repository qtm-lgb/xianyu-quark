/** 从闲鱼侧独立验证已上架商品 */
const fs=require('fs'), path=require('path');
const { launch, sleep, shot } = require('../src/lib');
const ROOT=path.resolve(__dirname,'..');
(async()=>{
  const listings=JSON.parse(fs.readFileSync(path.join(ROOT,'data','listings.json'),'utf8'));
  const done=listings.filter(x=>x.itemId);
  console.log(`已上架 ${done.length} 个，抽查 3 个...\n`);
  const ctx=await launch('fish',{headless:true});
  const p=ctx.pages()[0]||await ctx.newPage();
  await p.setViewportSize({width:1400,height:900});
  const picks=[done[0], done[Math.floor(done.length/2)], done[done.length-1]].filter(Boolean);
  for(const l of picks){
    await p.goto(`https://www.goofish.com/item?id=${l.itemId}`,{waitUntil:'domcontentloaded'});
    await sleep(6000);
    const body=((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
    const price=(body.match(/¥\s*([\d.]+)/)||[])[1];
    const hasTitle=body.includes((l.title||'').replace(/个人整理版/g,'').slice(0,10));
    const hasShip=body.includes('无需邮寄');
    console.log(`${l.itemId}  ¥${price||'?'}  标题匹配=${hasTitle}  无需邮寄=${hasShip}`);
    console.log(`   ${l.xyTitle.slice(0,44)}`);
  }
  await shot(p,'verify_batch_published');
  await ctx.close();
})();
