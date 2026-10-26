/**
 * 从浏览器登录态换取 GitHub 凭据并推送
 *
 * 浏览器登录 GitHub 后，Chrome 里会有 github.com 的会话 Cookie，
 * 但 git push 需要的是 PAT 或 OAuth token —— 拿浏览器 Cookie 推不了。
 *
 * 正解：浏览器登录后，用 GitHub 的网页表单创建 Personal Access Token，
 * 再把 token 写进 git 凭据。本脚本负责把 PAT 安全地写入本地 git 凭据存储。
 *
 * 用法: node tools/gh_push_token.js <PAT>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const token = process.argv[2];
if (!token) {
  console.error('用法: node tools/gh_push_token.js <PAT>');
  console.error('PAT 生成地址: https://github.com/settings/tokens/new');
  console.error('  勾选 scope: repo (private_repo 若为私有仓库)');
  process.exit(1);
}

const projDir = path.resolve(__dirname, '..');
const credFile = path.join(os.homedir(), '.git-credentials');

// 写入凭据（权限 600）
const line = `https://${token}@github.com\n`;
fs.writeFileSync(credFile, line, { encoding: 'utf8', mode: 0o600 });
try { fs.chmodSync(credFile, 0o600); } catch { /* Windows 忽略 */ }

// 配置凭据助手
try {
  execFileSync('git', ['config', '--global', 'credential.helper', 'store'], { stdio: 'ignore' });
} catch { /* ignore */ }

// 测试连通性并推送
try {
  const out = execFileSync('git', ['push', '-u', 'origin', 'main'], {
    cwd: projDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(out.trim() || '推送完成');
  console.log('✓ 推送成功');
} catch (e) {
  console.error('✗ 推送失败:');
  console.error((e.stderr || e.stdout || e.message).toString().split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}
