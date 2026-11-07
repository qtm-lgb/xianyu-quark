const { launch, sleep } = require('../src/lib');
const id=process.argv[2];
(async()=>{
  const ctx=await launch('fish',{headless:true});
  const p=ctx.pages()[0]||await ctx.newPage();
  await p.setViewportSize({width:1400,height:900});
  await p.goto(`https://www.goofish.com/item?id=${id}`,{waitUntil:'domcontentloaded'});
  await sleep(7000);
  const body=((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
  // 分类一般在标题下方或标签区
  const catMatch = body.match(/(电子资料|其他服务|AI[^ ]{0,8}|写作指导|工具会员充值|副业培训|创业|电子壁纸|网络推广运营)[^\s]{0,10}/);
  console.log('可能分类:', catMatch? catMatch[0]:'(未识别)');
  const i=body.indexOf('个人整理版');
  console.log('上下文:', body.slice(Math.max(0,i-60), i+180));
  await ctx.close();
})();
