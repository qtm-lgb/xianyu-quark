/**
 * 用 GitHub REST API 推送代码（处理空仓库场景）
 *
 * 空仓库不能直接创建 blob（GitHub 要求仓库至少有一个 commit），
 * 所以先用 Contents API 上传一个 README 作为初始提交，之后再用 Git Data API 推全量。
 */
const fs=require('fs'), path=require('path'), os=require('os');
const { execFileSync } = require('child_process');
const REPO=process.env.GH_REPO||'xianyu-quark';
const BRANCH=process.env.GH_BRANCH||'main';
const OWNER=process.env.GH_OWNER||'qtm-lgb';
const PROJ=path.resolve(__dirname,'..');
const API='https://api.github.com';
const say=(m)=>console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`);

function getToken(){
  if(process.argv[2]) return process.argv[2];
  const cf=path.join(os.homedir(),'.git-credentials');
  if(fs.existsSync(cf)){
    const m=fs.readFileSync(cf,'utf8').match(/https:(\/\/)?([^\s:@]+)@github\.com/);
    if(m) return m[2];
  }
  return null;
}
async function api(token,method,endpoint,body){
  const r=await fetch(`${API}${endpoint}`,{method,
    headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'xq-publisher',...(body?{'Content-Type':'application/json'}:{})},
    body: body?JSON.stringify(body):undefined});
  const text=await r.text();
  let json=null; try{json=JSON.parse(text);}catch{}
  return {status:r.status,json,text};
}

async function main(){
  const token=getToken();
  if(!token){ say('✗ 未找到 token'); process.exit(1); }
  say(`token ${token.slice(0,8)}...`);

  const me=await api(token,'GET','/user');
  if(me.status!==200){ say('✗ token 无效'); process.exit(1); }
  say(`✓ 认证: ${me.json.login}`);

  const repo=await api(token,'GET',`/repos/${OWNER}/${REPO}`);
  if(repo.status!==200){ say('✗ 仓库不可访问'); process.exit(1); }
  say(`✓ 仓库: ${repo.json.full_name} (${repo.json.private?'私有':'公开'})`);

  // 判断是否空仓库
  const ref=await api(token,'GET',`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  let baseCommit=null;
  if(ref.status===200){ baseCommit=ref.json.object.sha; say(`✓ 分支存在 ${baseCommit.slice(0,8)}`); }
  else {
    say('仓库为空，先用 Contents API 建初始提交');
    const init=await api(token,'PUT',`/repos/${OWNER}/${REPO}/contents/README.md`,{
      message:'chore: 初始化仓库', content:Buffer.from('# xianyu-quark\n\n初始化占位，稍后由完整提交覆盖。').toString('base64'),
      branch:BRANCH});
    if(init.status!==201&&init.status!==200){ say('✗ 初始提交失败: '+(init.json?.message||init.status)); process.exit(1); }
    say('✓ 初始提交完成');
    const ref2=await api(token,'GET',`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    baseCommit=ref2.json.object.sha;
    say(`✓ base commit: ${baseCommit.slice(0,8)}`);
  }

  const files=execFileSync('git',['ls-files'],{cwd:PROJ,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  say(`待上传 ${files.length} 个文件`);

  // blob
  const entries=[];
  for(let i=0;i<files.length;i++){
    const f=files[i];
    const content=fs.readFileSync(path.join(PROJ,f)).toString('base64');
    const b=await api(token,'POST',`/repos/${OWNER}/${REPO}/git/blobs`,{content,encoding:'base64'});
    if(b.status!==201){ say(`✗ blob 失败 ${f}: ${b.json?.message||b.status}`); process.exit(1); }
    entries.push({path:f,mode:'100644',type:'blob',sha:b.json.sha});
    if((i+1)%12===0) say(`  blob ${i+1}/${files.length}`);
  }
  say(`✓ blob ${entries.length} 个`);

  const tree=await api(token,'POST',`/repos/${OWNER}/${REPO}/git/trees`,{base_tree:baseCommit,tree:entries});
  if(tree.status!==201){ say('✗ tree 失败: '+(tree.json?.message||tree.status)); process.exit(1); }
  say(`✓ tree ${tree.json.sha.slice(0,8)}`);

  const msg=execFileSync('git',['log','-1','--pretty=%B'],{cwd:PROJ,encoding:'utf8'}).trim();
  const commit=await api(token,'POST',`/repos/${OWNER}/${REPO}/git/commits`,{message:msg||'feat: 初始提交',tree:tree.json.sha,parents:[baseCommit]});
  if(commit.status!==201){ say('✗ commit 失败: '+(commit.json?.message||commit.status)); process.exit(1); }
  say(`✓ commit ${commit.json.sha.slice(0,8)}`);

  const upd=await api(token,'PATCH',`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`,{sha:commit.json.sha,force:true});
  if(upd.status!==200){ say('✗ ref 更新失败: '+(upd.json?.message||upd.status)); process.exit(1); }
  say(`✓ 分支 ${BRANCH} 已更新`);

  try{ execFileSync('git',['update-ref','refs/heads/main',commit.json.sha],{cwd:PROJ,stdio:'ignore'}); say('✓ 本地 main 已对齐'); }catch{}

  console.log('\n完成:');
  console.log(`  https://github.com/${OWNER}/${REPO}`);
  console.log(`  commit ${commit.json.sha.slice(0,8)}  ${files.length} files`);
}
main();
