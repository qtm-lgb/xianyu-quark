'use strict';
/**
 * 网络与代理健康检查
 *
 * X 必须走代理才能访问（国内直连不通）。
 * 本项目用 channel:'chrome' 启动系统 Chrome，让浏览器继承 Windows 系统代理设置。
 * 如果代理软件退出或节点失效，采集会报 ERR_CONNECTION_CLOSED —— 这里负责提前诊断。
 *
 * 用法: node src/check_net.js
 */
const { execFileSync } = require('child_process');
const net = require('net');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 常见本地代理端口 */
const PROXY_PORTS = [7890, 7891, 7897, 10808, 10809, 1080, 1087, 2080, 8888, 10810];

function portOpen(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(800);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, '127.0.0.1');
  });
}

async function testUrl(url, { proxy = null, timeout = 12000 } = {}) {
  const started = Date.now();
  try {
    const opt = {
      method: 'GET',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(timeout),
    };
    if (proxy) {
      // 用 undici 的 ProxyAgent 走本地代理
      const { ProxyAgent, request } = require('undici');
      const agent = new ProxyAgent(proxy);
      const r = await request(url, { ...opt, dispatcher: agent });
      await r.body.dump();
      await agent.close();
      return { ok: r.statusCode < 500, status: r.statusCode, ms: Date.now() - started };
    }
    const r = await fetch(url, opt);
    return { ok: r.statusCode < 500, status: r.statusCode, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: e.message.split('\n')[0].slice(0, 70) };
  }
}

async function main() {
  console.log('=== 代理端口扫描 ===');
  const openPorts = [];
  for (const p of PROXY_PORTS) {
    if (await portOpen(p)) {
      openPorts.push(p);
      console.log(`  ✓ ${p} 开放`);
    }
  }
  if (!openPorts.length) {
    console.log('  (没有发现开放的本地代理端口)');
  }

  console.log('\n=== 直连测试 ===');
  for (const [name, url] of [['X', 'https://x.com'], ['闲鱼', 'https://www.goofish.com'], ['夸克', 'https://pan.quark.cn']]) {
    const r = await testUrl(url);
    const detail = r.ok ? `✓ ${r.status}` : `✗ ${r.error || ('HTTP ' + r.status)}`;
    console.log(`  ${name.padEnd(4)} ${url.padEnd(28)} ${detail}  ${r.ms}ms`);
  }

  if (openPorts.length) {
    console.log('\n=== 经代理测试 X ===');
    for (const p of openPorts) {
      const r = await testUrl('https://x.com', { proxy: `http://127.0.0.1:${p}` });
      const detail = r.ok ? `✓ ${r.status}` : `✗ ${r.error || ('HTTP ' + r.status)}`;
      console.log(`  端口 ${p}: ${detail}  ${r.ms}ms`);
    }
  }

  console.log('\n结论：');
  console.log('  · 闲鱼 / 夸克 直连可用（国内站点，不依赖代理）');
  console.log('  · X 需要代理。请确保代理客户端在运行、系统代理已开启，');
  console.log('    然后重跑: node src/scrape_x.js --mode intercept');
}

module.exports = { portOpen, testUrl, PROXY_PORTS };

if (require.main === module) main();
