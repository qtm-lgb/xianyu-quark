'use strict';
/** 把限时分享重建为永久 */
const fs=require('fs'), path=require('path');
const { openQuark, qApi } = require('./quark_api');
const ROOT=path.resolve(__dirname,'..');
const F=path.join(ROOT,'data','quark_courses.json');
const say=(m)=>console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);

(async()=>{
  const courses=JSON.parse(fs.readFileSync(F,'utf8'));
  const bad=courses.filter(c=>c.expiredType!==1);
  if(!bad.length){ say('全部已是永久链接'); process.exit(0); }
  say(`需重建: ${bad.length} 个`);
  const {ctx,page}=await openQuark({headless:false});
  for(const c of bad){
    const r=await qApi(page,'POST','/1/clouddrive/share?pr=ucpro&fr=pc',
      {fid_list:[c.fid],title:c.title,url_type:1,expired_type:1,password:''});
    const taskId=r.json?.data?.task_id;
    if(!taskId){ say(`  ✗ ${c.title.slice(0,30)} ${r.json?.message||''}`); continue; }
    for(let i=0;i<15;i++){
      await page.waitForTimeout(1200);
      const t=await qApi(page,'GET',`/1/clouddrive/task?pr=ucpro&fr=pc&task_id=${taskId}`);
      const d=t.json?.data;
      if(d&&(d.status===2||d.status===3)){
        const list=(await qApi(page,'GET','/1/clouddrive/share/mypage/detail?pr=ucpro&fr=pc&_page=1&_size=200&_order_field=created_at&_order_type=desc&_fetch_total=1&_filter=all&_share_type=0,1')).json?.data?.list||[];
        const hit=list.find(s=>s.share_id===d.share_id)||list.find(s=>s.title===c.title.trim());
        if(hit){
          c.shareUrl=`https://pan.quark.cn/s/${hit.pwd_id}`;
          c.shareId=hit.share_id; c.pwdId=hit.pwd_id;
          c.expiredType=hit.expired_type; c.permanent=hit.expired_type===1;
          c.source='recreated';
          say(`  ✓ ${c.title.slice(0,32)}  ${c.shareUrl}  expired_type=${hit.expired_type}`);
        } else say(`  ✗ 未找到新分享 ${c.title.slice(0,30)}`);
        break;
      }
    }
    await page.waitForTimeout(1000);
  }
  fs.writeFileSync(F,JSON.stringify(courses,null,2),'utf8');
  const stillBad=courses.filter(c=>c.expiredType!==1).length;
  say(`\n剩余非永久: ${stillBad} / ${courses.length}`);
  await ctx.close();
  process.exit(0);
})();
