/**
 * 用浏览器登录态的 Cookie 调 GitHub API 建仓
 * GitHub 网页的 user_session cookie 在 API 里同样有效（对同源 API）
 */
const { chromium } = require('playwright');
const path=require('path'), os=require('os');
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const ctx = await chromium.launchPersistentContext(path.join(os.homedir(),'.workbuddy','gh-publish-profile'),{
    channel:'chrome', headless:true, viewport:{width:1400,height:900}});
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.goto('https://github.com/settings/tokens/new',{waitUntil:'domcontentloaded'}).catch(()=>{});
  await sleep(6000);
  console.log('当前 URL:', p.url());
  console.log('title:', await p.title());
  const body=((await p.textContent('body').catch(()=>''))||'').replace(/\s+/g,' ');
  // 是否有 PAT 创建表单
  const hasForm = await p.locator('#token_name, input[name="token_name"], [name="note"]').count().catch(()=>0);
  console.log('PAT表单:', hasForm>0?'✓ 可创建':'✗ 无');
  console.log('页面提示片段:', body.slice(body.indexOf('Personal access'), body.indexOf('Personal access')+200) || body.slice(0,300));
  await p.screenshot({path:'shots/gh_pat_page.png'}).catch(()=>{});
  await ctx.close();
})();
