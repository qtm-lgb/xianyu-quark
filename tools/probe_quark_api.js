// 列出夸克网盘前端 bundle 里的 API 路径
const { chromium } = require('playwright');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const ctx = await chromium.launchPersistentContext(process.env.HOME+'/.workbuddy/quark-profile',{
    channel:'chrome', headless:true, viewport:{width:1400,height:900}});
  const p = ctx.pages()[0] || await ctx.newPage();
  const js=[];
  p.on('response', r=>{ if(/\.js(\?|$)/.test(r.url())) js.push(r.url()); });
  await p.goto('https://pan.quark.cn/',{waitUntil:'domcontentloaded'}).catch(()=>{});
  await sleep(6000);
  console.log('加载的 js 数:', js.length);
  const {execFileSync}=require('child_process');
  const fs=require('fs');
  const dir='/tmp/quark_js'; fs.mkdirSync(dir,{recursive:true});
  let idx=0; const all=new Set();
  for(const u of js.slice(0,30)){
    try{
      const r=await ctx.request.get(u);
      const t=await r.text();
      const m=t.match(/\/1\/clouddrive\/[a-zA-Z0-9_\/-]+/g);
      if(m) m.forEach(x=>all.add(x));
    }catch(e){}
  }
  console.log('\n=== 夸克 clouddrive API 路径 ===');
  [...all].sort().forEach(x=>console.log('  '+x));
  await ctx.close();
})();
