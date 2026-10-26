'use strict';
/**
 * 自动创建 GitHub Personal Access Token（Classic）并推送代码
 *
 * 为什么需要：GitHub REST/git push 只认 PAT，不认浏览器会话 Cookie。
 * WorkBuddy 的 GitHub 连接器是 GitHub App 集成，只有只读权限（403）。
 *
 * 关键：必须直连（--no-proxy-server）。
 * 走 WARP 共享 IP（104.28.x.x，Cloudflare 机房段）时 GitHub 会拒绝建仓与建 Token；
 * 国内直连出口是 residential IP，一切正常。
 *
 * 流程：填 token 名称 -> 勾选 repo scope -> 生成 -> 捕获 token -> 写入 git 凭据 -> push
 *
 * 用法: node tools/gh_create_token.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE = path.join(os.homedir(), '.workbuddy', 'gh-publish-profile');
const PROJ = path.resolve(__dirname, '..');
const TOKEN_NAME = 'xianyu-quark-' + Date.now().toString(36);

function say(m) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1400, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 1) 打开 PAT 创建页
  await page.goto('https://github.com/settings/tokens/new', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(6000);

  const login = await page.evaluate(() => {
    const m = document.querySelector('meta[name="user-login"]');
    return m ? m.content : null;
  });
  if (!login) {
    say('✗ 未登录 GitHub，请先运行 node tools/gh_publish.js --login');
    await ctx.close();
    process.exit(1);
  }
  say(`✓ 已登录: ${login}`);

  // 2) 填 token 名称
  const nameInput = page.locator('#token_name, input[name="oauth_access[description]"]').first();
  await nameInput.fill(TOKEN_NAME).catch(() => {});
  await sleep(800);

  // 3) 勾选 repo scope
  // GitHub 的 scope checkbox 后面跟着 label 文案，用 label 文本定位更稳
  const repoScope = page.locator('input[name="oauth_access[scopes][]"]').nth(0);
  const scopes = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input[name="oauth_access[scopes][]"]').forEach((el, i) => {
      const lbl = el.closest('li') || el.parentElement;
      const t = (lbl?.textContent || '').replace(/\s+/g, ' ').trim();
      out.push({ i, txt: t.slice(0, 40), checked: el.checked });
    });
    return out;
  });
  const repoIdx = scopes.findIndex((s) => /^\s*repo\b/i.test(s.txt) || /Manage your public repositories/i.test(s.txt));
  say(`scope 数量: ${scopes.length}，repo scope 索引: ${repoIdx}`);
  if (repoIdx >= 0) {
    const target = page.locator('input[name="oauth_access[scopes][]"]').nth(repoIdx);
    await target.check({ force: true }).catch(() => {});
    await sleep(500);
  } else {
    // 兜底：勾前几个（repo 通常在列表靠前）
    for (let i = 0; i < Math.min(3, scopes.length); i++) {
      await page.locator('input[name="oauth_access[scopes][]"]').nth(i).check({ force: true }).catch(() => {});
    }
    await sleep(500);
  }
  const checked = await page.evaluate(() =>
    [...document.querySelectorAll('input[name="oauth_access[scopes][]"]')]
      .map((el, i) => (el.checked ? i : -1))
      .filter((i) => i >= 0)
  );
  say(`已勾选 scope 索引: ${checked.join(',')}`);

  // 4) 生成
  const genBtn = page.locator('button:has-text("Generate token"), button[type="submit"]:has-text("Generate")').first();
  if ((await genBtn.count().catch(() => 0)) === 0) {
    say('✗ 未找到 Generate token 按钮');
    await page.screenshot({ path: 'shots/gh_pat_no_button.png' }).catch(() => {});
    await ctx.close();
    process.exit(1);
  }
  await genBtn.click({ force: true });
  await sleep(8000);

  // 5) 捕获 token
  const url = page.url();
  let token = await page
    .evaluate(() => {
      const el = document.querySelector('#new-token, input[name="oauth_access[token]"], code[data-testid="token"]');
      if (el) return (el.value || el.textContent || '').trim();
      const m = document.body.innerText.match(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/);
      return m ? m[0] : null;
    })
    .catch(() => null);

  if (!token) {
    // GitHub 生成后只显示一次；若跳到列表页，需要重新生成
    const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
    token = (body.match(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/) || [])[0] || null;
    if (!token && /\/settings\/tokens/.test(page.url())) {
      say('  跳到 token 列表页（token 只显示一次），回到表单重试');
      await page.goto('https://github.com/settings/tokens/new', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(5000);
      const n2 = page.locator('#token_name, input[name="oauth_access[description]"]').first();
      await n2.fill(TOKEN_NAME + '-' + Math.random().toString(36).slice(2,6)).catch(() => {});
      await sleep(600);
      const sc = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('input[name="oauth_access[scopes][]"]').forEach((el, i) => {
          const lbl = el.closest('li') || el.parentElement;
          out.push({ i, txt: (lbl?.textContent || '').replace(/\s+/g,' ').trim().slice(0,40) });
        });
        return out;
      });
      const ri = sc.findIndex((s) => /^\s*repo\b/i.test(s.txt));
      if (ri >= 0) await page.locator('input[name="oauth_access[scopes][]"]').nth(ri).check({force:true}).catch(()=>{});
      await sleep(500);
      await page.locator('button:has-text("Generate token"), button[type="submit"]:has-text("Generate")').first().click({force:true});
      await sleep(9000);
      token = await page.evaluate(() => {
        const el = document.querySelector('#new-token, input[name="oauth_access[token]"], code[data-testid="token"]');
        if (el) return (el.value || el.textContent || '').trim();
        const m = document.body.innerText.match(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/);
        return m ? m[0] : null;
      }).catch(()=>null);
    }
  }
  await page.screenshot({ path: 'shots/gh_pat_result.png' }).catch(() => {});

  if (!token) {
    say('✗ 未能捕获 token，URL: ' + url);
    say('  可能需要二次密码验证，请在窗口里完成后再重跑');
    await ctx.close();
    process.exit(1);
  }
  say('✓ 已生成 token: ' + token.slice(0, 10) + '...' + token.slice(-4));

  // 6) 写入 git 凭据
  const credFile = path.join(os.homedir(), '.git-credentials');
  fs.writeFileSync(credFile, `https://${token}@github.com\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(credFile, 0o600); } catch { /* Windows */ }
  execFileSync('git', ['config', '--global', 'credential.helper', 'store'], { stdio: 'ignore' });

  await ctx.close();

  // 7) 推送（直连，绕过代理）
  say('执行 git push（直连）...');
  try {
    const env = { ...process.env };
    delete env.HTTPS_PROXY; delete env.HTTP_PROXY;
    delete env.https_proxy; delete env.http_proxy;
    const out = execFileSync('git', ['push', '-u', 'origin', 'main'], {
      cwd: PROJ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    say('✓ 推送成功: ' + (out || '').trim());
    // 推 tags 与其他分支
    execFileSync('git', ['push', 'origin', '--all'], { cwd: PROJ, stdio: 'ignore', env });
    execFileSync('git', ['push', 'origin', '--tags'], { cwd: PROJ, stdio: 'ignore', env });
    process.exit(0);
  } catch (e) {
    const msg = ((e.stderr || '') + (e.stdout || '') + e.message).toString();
    say('✗ 推送失败: ' + msg.split('\n').slice(0, 6).join(' | ').slice(0, 300));
    process.exit(1);
  }
})();
