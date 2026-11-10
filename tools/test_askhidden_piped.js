'use strict';
/**
 * 密码输入安全性测试 —— 管道模式（可自动运行）
 *
 * 覆盖能自动验证的性质：
 *   1. 密码不出现在 stdout（不泄露、不进 shell 历史）
 *   2. 密码被完整接收（不截断、不丢字符）
 *   3. 中文 / 特殊字符 / 空输入正确
 *
 * 注意：管道下 stdin.isTTY 非真，走的是 readline 分支（按行读），
 * 该分支不处理退格 —— 退格属于 raw mode 的行为，
 * 需要在真实终端里跑 `node tools/test_askhidden.js` 手动验证。
 *
 * 用法: node tools/test_askhidden_piped.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(__dirname, '_askhidden_probe.js');

fs.writeFileSync(PROBE, `
const { askHidden } = require('./yd_setup_password.js');
askHidden('PWD: ').then((v) => {
  require('fs').writeFileSync(process.env.PROBE_OUT, JSON.stringify({ len: v.length, val: v }));
  process.exit(0);
});
`, 'utf8');

function run(inputBytes) {
  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), `probe_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    const p = spawn('node', [PROBE], {
      cwd: ROOT,
      env: { ...process.env, PROBE_OUT: outFile },
    });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', () => { /* ignore */ });

    setTimeout(() => p.stdin.write(inputBytes), 400);

    p.on('close', () => {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* ignore */ }
      try { fs.unlinkSync(outFile); } catch { /* ignore */ }
      resolve({ stdout, parsed });
    });
  });
}

(async () => {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${name.padEnd(24)}: ${ok ? '✓' : '❌'} ${detail}`);
  };

  console.log('════ 密码输入安全性测试（管道模式）════');
  console.log('（调用 yd_setup_password.js 的真实实现）\n');

  const secret = 'mypassword123';
  const r1 = await run(Buffer.from(secret + '\r'));
  check('密码是否泄露到终端', !r1.stdout.includes(secret),
    r1.stdout.includes(secret) ? '❗ 出现在输出里' : '');
  check('密码是否完整接收', !!(r1.parsed && r1.parsed.val === secret),
    r1.parsed ? `${r1.parsed.len} 字符` : '无结果');
  check('提示符是否显示', r1.stdout.includes('PWD:'));

  const cn = '密码测试';
  const r2 = await run(Buffer.from(cn + '\r'));
  check('中文', !!(r2.parsed && r2.parsed.val === cn),
    r2.parsed ? JSON.stringify(r2.parsed.val) : '无结果');

  const sp = 'abc@#$%^&*()_+-=[]{}';
  const r3 = await run(Buffer.from(sp + '\r'));
  check('特殊字符', !!(r3.parsed && r3.parsed.val === sp),
    r3.parsed ? `${r3.parsed.len} 字符` : '无结果');

  const r4 = await run(Buffer.from('\r'));
  check('空输入', !!(r4.parsed && r4.parsed.len === 0),
    r4.parsed ? `${r4.parsed.len} 字符` : '无结果');

  try { fs.unlinkSync(PROBE); } catch { /* ignore */ }

  const ok = results.every(Boolean);
  console.log(`\n${ok ? '✓ 全部通过' : `✗ ${results.filter((x) => !x).length} 项失败`}`);
  console.log('（退格等 raw mode 行为请在真实终端跑 node tools/test_askhidden.js 验证）');
  process.exit(ok ? 0 : 1);
})();
