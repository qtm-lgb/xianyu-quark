// 实测闲鱼是否真登录：访问发布页看有无登录态痕迹
const { launch, sleep } = require('../src/lib');
(async()=>{
  const ctx = await launch('fish',{headless:true});
  const p = await ctx.newPage();
  await p.setViewportSize({width:1400,height:900});
  await p.goto('https://www.goofish.com/publish',{waitUntil:'domcontentloaded'});
  await sleep(5000);
  const body=((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
  console.log('URL:', p.url());
  console.log('页面文本前200:', body.slice(0,200));
  console.log('\n有「立即登录」:', /立即登录/.test(body));
  // 关键：发布表单是否有可填字段
  const fields = await p.evaluate(()=>{
    const out=[];
    document.querySelectorAll('input,textarea').forEach(el=>{
      const r=el.getBoundingClientRect();
      if(r.width>0&&r.height>0) out.push({tag:el.tagName, type:el.type||'', ph:el.placeholder||''});
    });
    return out;
  });
  console.log('可见输入框:', fields.length);
  fields.forEach(f=>console.log(`   ${f.tag} type=${f.type} ph="${f.ph}"`));
  // 调用户信息接口确认
  const me = await p.evaluate(async()=>{
    try{
      const r=await fetch('/h5/mtop.taobao.idlemessage.pc.loginuser.get/1.0/',{method:'POST',credentials:'include'});
      const j=await r.json().catch(()=>null);
      return JSON.stringify(j).slice(0,400);
    }catch(e){ return 'err '+e.message; }
  });
  console.log('\nloginuser 接口:', me);
  await ctx.close();
})();
