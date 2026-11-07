'use strict';
/**
 * 下架指定的闲鱼商品
 *
 * 用法: node tools/offline_items.js <itemId> [更多itemId...]
 *   或: node tools/offline_items.js --title Codex
 */
const { launch, sleep, shot } = require('../src/lib');
const fs=require('fs'), path=require('path');

(async()=>{
  const args=process.argv.slice(2);
  if(!args.length){ console.log('用法: node tools/offline_items.js <itemId...> | --title <关键词>'); process.exit(1); }

  let ids=[];
  if(args[0]==='--title'){
    const kw=args[1];
    const listFile=path.resolve(__dirname,'..','data','listings.json');
    const l=JSON.parse(fs.readFileSync(listFile,'utf8'));
    ids=l.filter(x=>x.itemId && new RegExp(kw,'i').test(x.title||'') || (x.itemId && new RegExp(kw,'i').test(x.xyTitle||''))).map(x=>String(x.itemId));
    console.log('匹配到', ids.length, '个商品');
  } else {
    ids=args.filter(a=>/^\d+$/.test(a));
  }
  if(!ids.length){ console.log('没有匹配到商品'); process.exit(1); }

  const ctx=await launch('fish',{headless:false});
  const p=ctx.pages()[0]||await ctx.newPage();
  await p.setViewportSize({width:1500,height:1000});

  for(const id of ids){
    await p.goto(`https://www.goofish.com/item?id=${id}`,{waitUntil:'domcontentloaded'});
    await sleep(6000);
    const body=((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
    const title=(body.match(/¥\s*[\d.]+/)||[])[0]||'';
    // 找「下架」按钮
    const btn=p.locator('text=下架').first();
    const has=await btn.count().catch(()=>0);
    if(!has){ console.log(`  ${id}  未找到「下架」按钮（可能已是下架状态）`); continue; }
    await btn.click({force:true}).catch(()=>{});
    await sleep(2500);
    // 可能有二次确认
    const confirm=p.locator('button:has-text("确定"), button:has-text("确认"), .ant-modal-confirm-btns button').first();
    if(await confirm.count().catch(()=>0)){ await confirm.click({force:true}).catch(()=>{}); await sleep(2500); }
    const after=((await p.textContent('body').catch(()=>''))||'');
    const ok=/已下架|下架成功|已下架的宝贝/.test(after);
    console.log(`  ${id} ${ok?'✓ 下架成功':'⚠ 已点击，下架状态待确认'} ${title}`);
    await shot(p,`offline_${id}`);
    await sleep(2000);
  }
  await ctx.close();
  process.exit(0);
})();
