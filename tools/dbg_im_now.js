const { launch, sleep, shot } = require('../src/lib');
(async()=>{
  const ctx = await launch('fish',{headless:true});
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.setViewportSize({width:1500,height:1000});
  await p.goto('https://www.goofish.com/im',{waitUntil:'domcontentloaded'});
  await sleep(9000);
  console.log('URL:', p.url());
  const body=((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
  console.log('\n=== 消息中心文本(前600) ===');
  console.log(body.slice(0,600));
  const convs = await p.evaluate(()=>{
    const out=[];
    document.querySelectorAll('[class*="conversation-item--"]').forEach(el=>{
      const r=el.getBoundingClientRect();
      if(r.width<=0||r.height<=0) return;
      out.push((el.innerText||'').replace(/\s+/g,' ').trim());
    });
    return out;
  });
  console.log('\n=== 会话数:', convs.length, '===');
  convs.slice(0,12).forEach((c,i)=>console.log(`  [${i}] ${c.slice(0,90)}`));
  await shot(p,'dbg_im_now');
  await ctx.close();
})();
