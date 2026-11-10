'use strict';
/**
 * 密码输入安全性测试 —— 真实终端模式（手动）
 *
 * 管道模式跑不了退格验证（管道下 stdin.isTTY 非真，走 readline 按行读，
 * 该分支本就不处理退格）。要在真实终端里验证 raw mode 的交互行为，
 * 请直接运行本脚本，按提示输入。
 *
 * 用法: node tools/test_askhidden.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(__dirname, '_askhidden_probe.js');

if (!process.stdin.isTTY) {
  console.error('本测试需要在真实终端里直接运行：');
  console.error('  node tools/test_askhidden.js');
  console.error('');
  console.error('（管道环境下的「不泄露 / 完整接收」已由 test_askhidden_piped.js 自动覆盖）');
  process.exit(2);
}

fs.writeFileSync(PROBE, `
const { askHidden } = require('./yd_setup_password.js');
askHidden('PWD: ').then((v) => {
  require('fs').writeFileSync(process.env.PROBE_OUT, JSON.stringify({ len: v.length, val: v }));
  process.exit(0);
});
`, 'utf8');

function run(inputBytes) {
  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), `tty_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    const p = spawn('node', [PROBE], {
      cwd: ROOT,
      env: { ...process.env, PROBE_OUT: outFile },
      stdio: 'inherit', // 继承真实终端 -> isTTY 为真
    });
    p.on('close', () => {
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* ignore */ }
      try { fs.unlinkSync(outFile); } catch { /* ignore */ }
      resolve(parsed);
    });
    // 延迟发送输入（给子进程时间启动并设置 raw mode）
    setTimeout(() => { try { p.stdin.write(inputBytes); } catch { /* ignore */ } }, 600);
  });
}

(async () => {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${name.padEnd(24)}: ${ok ? '✓' : '❌'} ${detail}`);
  };

  console.log('════ 密码输入安全性测试（真实终端）════');
  console.log('接下来会弹出几个密码输入提示，请照着输入。');
  console.log('输入时屏幕上不会有任何字符显示（这是正确的）。\n');

  console.log('▶ 第1次：输入 abc 然后按退格键，再输入 xyz，最后回车');
  const r1 = await run(Buffer.from('abc\x7fxyz\r'));
  check('退格 DEL(0x7f)', !!(r1 && r1.val === 'abxyz'),
    r1 ? JSON.stringify(r1.val) : '无结果');

  console.log('\n▶ 第2次：输入 abc 然后按退格键，再输入 xyz，最后回车');
  const r2 = await run(Buffer.from('abc\x08xyz\r'));
  check('退格 BS(0x08)', !!(r2 && r2.val === 'abxyz'),
    r2 ? JSON.stringify(r2.val) : '无结果');

  console.log('\n▶ 第3次：输入 abcdef 连按3次退格，再输入 xyz，最后回车');
  const r3 = await run(Buffer.from('abcdef\x7f\x7f\x7fxyz\r'));
  check('连续退格 x3', !!(r3 && r3.val === 'abcxyz'),
    r3 ? JSON.stringify(r3.val) : '无结果');

  console.log('\n▶ 第4次：输入 abc 然后回车');
  const r4 = await run(Buffer.from('abc\r'));
  check('普通输入', !!(r4 && r4.val === 'abc'),
    r4 ? JSON.stringify(r4.val) : '无结果');

  try { fs.unlinkSync(PROBE); } catch { /* ignore */ }

  const ok = results.every(Boolean);
  console.log(`\n${ok ? '✓ 全部通过' : `✗ ${results.filter((x) => !x).length} 项失败`}`);
  process.exit(ok ? 0 : 1);
})();
