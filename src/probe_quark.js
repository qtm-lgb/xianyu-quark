'use strict';
/**
 * 夸克分享链接探活 + 元数据提取（基于官方 sharepage API，比 DOM 可靠）
 *
 * 分享页是 SPA，DOM 选择器易碎；这里直接调 drive-pc.quark.cn 的公开接口：
 *   1) POST .../sharepage/token  -> 拿 stoken + 标题 + 作者；链接失效时返回"分享不存在"
 *   2) GET  .../sharepage/detail -> 拿文件列表、总数
 *
 * 用法:
 *   node src/probe_quark.js <夸克链接> [更多链接...]
 *   node src/probe_quark.js --file data/resources.json   批量探测已采集的链接
 */
const fs = require('fs');
const path = require('path');
const { log, writeJSON, readJSON, DATA } = require('./lib');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// 夸克分享链接格式：
//   /s/<id>  单文件分享（token 接口可直接解析）
//   /g/<id>  群组分享
//   /f/<id>  文件夹分享
const QUARK_RE = /https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/g;
const QUARK_S_RE = /https?:\/\/pan\.quark\.cn\/s\/[A-Za-z0-9]+/g;

function extractQuarkLinks(text) {
  if (!text) return [];
  const m = text.match(QUARK_RE) || [];
  return [...new Set(m)];
}

/** 只取可探活的 /s/ 单文件链接 */
function extractSingleLinks(text) {
  if (!text) return [];
  const m = text.match(QUARK_S_RE) || [];
  return [...new Set(m)];
}

function extractId(url) {
  const m = String(url).match(/pan\.quark\.cn\/s\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

async function getToken(pwdId, passcode = '') {
  const r = await fetch(
    'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': UA,
        referer: 'https://pan.quark.cn/',
        origin: 'https://pan.quark.cn',
      },
      body: JSON.stringify({ pwd_id: pwdId, passcode, source: 'share' }),
    }
  );
  return r.json().catch(() => null);
}

async function getDetail(pwdId, stoken, passcode = '') {
  const u =
    `https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail` +
    `?pr=ucpro&fr=pc&pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}` +
    `&pdir_fid=0&_page=1&_size=50&_fetch_banner=1&_fetch_share=1&_fetch_total=1` +
    `&_sort=file_type:asc,updated_at:desc`;
  const r = await fetch(u, {
    headers: { 'user-agent': UA, referer: 'https://pan.quark.cn/' },
  });
  return r.json().catch(() => null);
}

/**
 * 探测单个分享链接
 * @returns {valid, title, author, fileCount, files, totalSize, code, error}
 */
async function probeOne(url, passcode = '') {
  const out = {
    url, valid: false, title: '', author: '', fileCount: 0,
    files: [], totalSize: 0, code: passcode || '', error: '',
  };
  const id = extractId(url);
  if (!id) { out.error = '不是有效的夸克分享链接'; return out; }

  try {
    const tok = await getToken(id, passcode);
    if (!tok) { out.error = '接口无响应'; return out; }
    // 成功: status=200 且 code=0；失败: status=404(分享不存在) 等
    if (tok.status !== 200 || !tok.data) {
      out.error = tok.message || `接口返回 status=${tok.status} code=${tok.code}`;
      return out;
    }
    const d = tok.data || {};
    out.title = (d.title || '').trim();
    out.author = (d.author && d.author.nick_name) || '';
    out.needCode = !!(tok.metadata && tok.metadata.need_password);

    if (d.stoken) {
      const det = await getDetail(id, d.stoken, passcode);
      const list = (det && det.data && det.data.list) || [];
      out.files = list.map((f) => ({
        name: f.file_name,
        size: f.size || 0,
        type: f.file_type,
      }));
      out.fileCount = det && det.data && det.data.total ? det.data.total : out.files.length;
      out.totalSize = out.files.reduce((a, f) => a + (f.size || 0), 0);
    }
    out.valid = !!out.title;
    if (!out.valid) out.error = '无标题，可能已失效';
  } catch (e) {
    out.error = e.message.split('\n')[0].slice(0, 120);
  }
  return out;
}

/** 批量探测（并发受限，避免被限流）。返回顺序与输入一致。 */
async function probeAll(items, { concurrency = 3 } = {}) {
  const results = new Array(items.length);
  const queue = items.map((it, i) => ({ it, i }));
  async function worker() {
    while (queue.length) {
      const { it, i } = queue.shift();
      const url = typeof it === 'string' ? it : it.link;
      const code = typeof it === 'string' ? '' : it.code || '';
      const r = await probeOne(url, code);
      results[i] = { ...r, source: typeof it === 'string' ? {} : it };
      log(r.valid ? 'ok' : 'warn',
        `${r.valid ? '✓' : '✗'} ${url}\n     标题="${r.title}" 文件数=${r.fileCount}` +
        `${r.code ? ' 提取码=' + r.code : ''}${r.error ? '  原因=' + r.error : ''}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

module.exports = { extractQuarkLinks, extractId, probeOne, probeAll, QUARK_RE };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    let items = [];
    if (args[0] === '--file') {
      const f = path.join(DATA, 'resources.json');
      const data = readJSON(f, []);
      items = data.map((d) => ({ link: d.link, code: d.code, ...d }));
    } else {
      items = args;
    }
    if (!items.length) {
      console.log('用法: node src/probe_quark.js <夸克链接>... | --file data/resources.json');
      process.exit(1);
    }
    const res = await probeAll(items);
    const valid = res.filter((r) => r.valid);
    console.log(`\n=== 汇总 === 总 ${res.length}，有效 ${valid.length}`);
    valid.forEach((r) => console.log(`  ✓ ${r.title} (${r.fileCount}个文件) ${r.url}`));
    if (args[0] === '--file') {
      const f = path.join(DATA, 'resources.json');
      const data = readJSON(f, []);
      data.forEach((d) => {
        const hit = res.find((r) => r.url === d.link);
        if (hit) d.probed = { valid: hit.valid, title: hit.title, author: hit.author, fileCount: hit.fileCount, files: hit.files, totalSize: hit.totalSize, error: hit.error };
      });
      writeJSON(f, data);
      console.log(`\n探测结果已回写 ${f}`);
    }
    process.exit(0);
  })();
}
