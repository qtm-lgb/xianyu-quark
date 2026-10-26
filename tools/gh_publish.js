'use strict';
/**
 * GitHub 发布工具（统一入口）
 *
 * ============ 网络要点（踩过的坑）============
 * 1) 建仓 / 建 Token 必须【直连】（--no-proxy-server）：
 *    走 WARP 共享 IP（104.28.x.x，Cloudflare 机房段）时 GitHub 会拒绝，
 *    报 "sanctioned region"；国内直连出口是 residential IP，一切正常。
 * 2) 但 git over HTTPS 通道在本机被重置（直连 "Connection was reset"，
 *    走代理则挂起），所以推送改用 REST API（Git Data API），走 HTTPS 稳定。
 * 3) GitHub REST API 不认浏览器会话 Cookie，只认 PAT —— 所以要先建 Token。
 *
 * ============ 用法 ============
 * node tools/gh_publish.js            # 引导登录 + 建仓 + 生成Token + API推送
 * node tools/gh_publish.js --login    # 只引导登录
 * node tools/gh_publish.js --push     # 只推送（复用已有 token）
 *
 * 后续迭代：本地改完 -> git add -A && git commit -m "..." -> node tools/gh_publish.js --push
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = process.env.GH_REPO || 'xianyu-quark';
const OWNER = process.env.GH_OWNER || 'qtm-lgb';
const BRANCH = process.env.GH_BRANCH || 'main';
const PROJ = path.resolve(__dirname, '..');
const API = 'https://api.github.com';

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const cf = path.join(os.homedir(), '.git-credentials');
  if (fs.existsSync(cf)) {
    const m = fs.readFileSync(cf, 'utf8').match(/https:(\/\/)?([^\s:@]+)@github\.com/);
    if (m) return m[2];
  }
  return null;
}

async function api(token, method, endpoint, body) {
  const r = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xianyu-quark-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

/** 用 Git Data API 推送本地提交 */
async function pushViaApi(token) {
  const me = await api(token, 'GET', '/user');
  if (me.status !== 200) { say('✗ token 无效: ' + (me.json?.message || me.status)); return false; }
  say(`✓ 认证: ${me.json.login}`);

  const repo = await api(token, 'GET', `/repos/${OWNER}/${REPO}`);
  if (repo.status !== 200) { say('✗ 仓库不可访问: ' + (repo.json?.message || repo.status)); return false; }
  say(`✓ 仓库: ${repo.json.full_name} (${repo.json.private ? '私有' : '公开'})`);

  let baseCommit = null;
  const ref = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  if (ref.status === 200) {
    baseCommit = ref.json.object.sha;
    say(`✓ 远端分支 ${BRANCH}: ${baseCommit.slice(0, 8)}`);
  } else {
    say('远端为空，先建初始提交');
    const init = await api(token, 'PUT', `/repos/${OWNER}/${REPO}/contents/README.md`, {
      message: 'chore: 初始化仓库',
      content: Buffer.from('# xianyu-quark\n').toString('base64'),
      branch: BRANCH,
    });
    if (init.status !== 201 && init.status !== 200) {
      say('✗ 初始提交失败: ' + (init.json?.message || init.status)); return false;
    }
    const ref2 = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    baseCommit = ref2.json.object.sha;
  }

  const files = execFileSync('git', ['ls-files'], { cwd: PROJ, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  say(`待上传 ${files.length} 个文件`);

  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const content = fs.readFileSync(path.join(PROJ, f)).toString('base64');
    const b = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding: 'base64' });
    if (b.status !== 201) { say(`✗ blob 失败 ${f}: ${b.json?.message || b.status}`); return false; }
    entries.push({ path: f, mode: '100644', type: 'blob', sha: b.json.sha });
    if ((i + 1) % 12 === 0) say(`  blob ${i + 1}/${files.length}`);
  }

  const tree = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: baseCommit, tree: entries });
  if (tree.status !== 201) { say('✗ tree 失败: ' + (tree.json?.message || tree.status)); return false; }

  const msg = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: PROJ, encoding: 'utf8' }).trim();
  const commit = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: msg || 'feat: 提交', tree: tree.json.sha, parents: [baseCommit],
  });
  if (commit.status !== 201) { say('✗ commit 失败: ' + (commit.json?.message || commit.status)); return false; }

  const upd = await api(token, 'PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.json.sha, force: true,
  });
  if (upd.status !== 200) { say('✗ ref 更新失败: ' + (upd.json?.message || upd.status)); return false; }

  try { execFileSync('git', ['update-ref', 'refs/heads/main', commit.json.sha], { cwd: PROJ, stdio: 'ignore' }); } catch { /* ignore */ }

  say(`✓ 推送完成: ${commit.json.sha.slice(0, 8)}  ${files.length} 文件`);
  console.log(`  https://github.com/${OWNER}/${REPO}`);
  return true;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--push')) {
    const token = getToken();
    if (!token) {
      say('✗ 没有可用 token。先跑 node tools/gh_publish.js 生成');
      process.exit(1);
    }
    process.exit((await pushViaApi(token)) ? 0 : 1);
  }

  // 完整流程：登录 -> 建仓 -> 建 Token -> 推送
  say('步骤 1/4: GitHub 登录与建仓');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'gh_publish.js'), '--login-only'], {
      stdio: 'inherit', cwd: PROJ,
    });
  } catch { /* 登录环节自行处理 */ }

  say('步骤 2/4: 建仓');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'gh_publish.js')], {
      stdio: 'inherit', cwd: PROJ,
    });
  } catch { /* 仓库可能已存在 */ }

  say('步骤 3/4: 生成 Token');
  let token = getToken();
  if (!token) {
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'gh_create_token.js')], {
        stdio: 'inherit', cwd: PROJ,
      });
    } catch (e) { say('✗ Token 生成失败'); process.exit(1); }
    token = getToken();
  }
  if (!token) { say('✗ 仍无 token'); process.exit(1); }

  say('步骤 4/4: 推送');
  process.exit((await pushViaApi(token)) ? 0 : 1);
})();
