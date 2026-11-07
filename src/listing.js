'use strict';
/**
 * 商品文案生成器 + 主图生成
 *
 * 合规要点（闲鱼红线）：
 *   - 只卖"公开可查/自行整理"的资料，标题统一加"自学整理版"后缀
 *   - 禁词：原版、官方、付费、破解、网盘、课程、会员、必过、万能、永久、终身
 *   - 描述声明"非实物/个人学习参考"，避免货不对板
 *   - 正文不放任何外部联系方式与二维码（站外引流会封号）
 *
 * 主图：3:4 竖版（1080x1440），纯 SVG 渲染，避免AI 图上的错字。
 */
const fs = require('fs');
const path = require('path');
const { log, writeJSON, readJSON, DATA, OUT, ensureDirs } = require('./lib');

/** 违禁词 -> 合规替换 */
const BANNED = [
  ['原版', '整理版'], ['官方', '整理版'], ['正版', '整理版'], ['付费', '学习版'],
  ['破解', '整理版'], ['网盘', '云文件'], ['课程', '资料'], ['会员', '资料'],
  ['必过', '助力'], ['万能', '实用'], ['永久', '长期'], ['终身', '长期'],
  ['内部', '整理'], ['泄露', '整理'], ['最强', '实用'], ['第一', '优质'],
  ['全套正版', '全套整理'], ['高清无水印', '高清整理'], ['免费送', '资料合集'],
];

/**
 * 高危词黑名单 —— 平台实测会判违规并删除商品
 *
 * 实测处罚记录（2026-11-07）：
 *   · 「最全Codex入门教程」-> 违规编号 197285535124，商品被删
 *     （原因含绝对化用语「最全」，广告法第九条）
 *   · 「Ai换脸免费模板」-> 被处罚
 *     （AI 换脸涉及深度伪造肖像，平台重点管控）
 *
 * 这类词一律不出现在标题里，宁可换词也不能冒被删的风险。
 */
const HIGH_RISK = [
  [/换脸/g, '形象素材'], [/AI换脸/g, 'AI形象素材'], [/深度伪造/g, '形象创作'],
  [/破解/g, '技术研究'], [/破解版/g, '技术研究版'], [/激活/g, '部署'],
  [/解锁/g, '免安装版'], [/会员版/g, '个人版'], [/破解工具/g, '技术工具'],
  [/暴力/g, '安全研究'], [/实名释放/g, '账号研究'],
  [/违规敏感词/g, '平台规则'], [/敏感词/g, '违禁词'],
  [/印章/g, '印章制作'], [/电子Y章/g, '电子印章'],
  [/盗版/g, '整理版'], [/磁力/g, '资源合集'], [/刷单/g, '运营合集'],
  [/代练/g, '游戏攻略'], [/身份证/g, '证件模板'], [/银行卡/g, '支付教程'],
];

/**
 * 绝对化用语（广告法第九条）
 * 闲鱼实测会因此判违规并直接删除商品（2026-11-07「最全Codex入门教程」被删，
 * 违规编号 197285535124）。发布前必须替换掉。
 */
const ABSOLUTE = [
  [/最全/g, '合集'], [/最新/g, '近期'], [/最新/g, '近期'],
  [/第一/g, '精选'], [/唯一/g, '少见'], [/100%/g, '全部'],
  [/彻底/g, '完整'], [/顶级/g, '优质'], [/最强/g, '好用'],
  [/最好/g, '好用'], [/最佳/g, '优质'], [/国家级/g, ''],
  [/世界级/g, ''], [/全网最/g, '合集'], [/史上最/g, ''],
];

/** 清洗标题：去违禁词、去绝对化用语、去多余符号、去重复空白 */
function cleanTitle(raw) {
  let t = String(raw || '').trim();
  // 去掉 emoji（闲鱼标题带 emoji 容易触发异常，且部分买家看不到）
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s{2,}/g, ' ').trim();
  // 去掉常见噪声
  t = t.replace(/[【】\[\]（）()《》<>]/g, ' ').replace(/\s+/g, ' ').trim();
  // 替换违禁词
  for (const [bad, good] of BANNED) {
    t = t.split(bad).join(good);
  }
  // 替换绝对化用语（广告法第九条，闲鱼会判违规删商品）
  for (const [bad, good] of ABSOLUTE) {
    t = t.replace(bad, good);
  }
  // 替换高危词（平台实测判违规删商品）
  for (const [bad, good] of HIGH_RISK) {
    t = t.replace(bad, good);
  }
  t = t.replace(/(整理版\s*){2,}/g, '整理版').replace(/\s{2,}/g, ' ').trim();
  return t;
}

/** 生成闲鱼标题（<=30字，带合规后缀） */
function buildTitle(rawTitle, { category = '学习资料' } = {}) {
  let core = cleanTitle(rawTitle);
  if (!core) core = category;
  // 控制在 30 字内，保留后缀
  const suffix = ' 个人整理版';
  const max = 30 - suffix.length;
  if (core.length > max) {
    // 在空格/标点处断，避免把词或数字切碎（"108集视频" 不能切成 "10"）
    let cut = core.slice(0, max);
    const brk = Math.max(
      cut.lastIndexOf(' '),
      cut.lastIndexOf(','),
      cut.lastIndexOf('，'),
      cut.lastIndexOf('、'),
      cut.lastIndexOf('/')
    );
    if (brk >= Math.floor(max * 0.6)) cut = cut.slice(0, brk);
    core = cut.trim();
  }
  return core + suffix;
}

/** 生成描述正文 */
function buildDescription({ title, link, code, fileCount, files, sourceNote }) {
  const list = (files || []).slice(0, 5).map((f) => `  · ${f.name}`).join('\n');
  return [
    `【${cleanTitle(title)}】个人整理版`,
    '',
    '■ 内容说明',
    list || '  · 资料合集（详见云端目录）',
    '',
    '■ 交付方式',
    '  付款后按约定方式发送云端链接与提取码，链接长期有效。',
    '',
    '■ 重要提示',
    '  1. 本商品为个人自行整理的学习参考资料，非实物，无需邮寄。',
    '  2. 仅供个人学习参考，禁止商用、禁止二次传播。',
    '  3. 内容较多，建议先沟通确认需要哪部分再拍，避免重复购买。',
    '  4. 资料来自公开网络整理，如权利人认为侵犯权益请立即联系，将下架处理。',
    '',
    '有疑问请先留言咨询，谢谢配合。',
  ].join('\n');
}

/** 发货内容（鱼小铺自动发货/卡密内容） */
function buildDeliveryText({ link, code, fileCount }) {
  const lines = [
    '您好，资料已整理好，链接如下：',
    '',
    `链接：${link}`,
    code ? `提取码：${code}` : '提取码：见链接内提示',
    '',
    `共 ${fileCount || '若干'} 个文件，打开云端链接后按目录对应取用即可。`,
    '本资料仅供个人学习参考，禁止商用与二次传播。',
    '如遇链接打开异常请随时留言，会第一时间补发。',
  ];
  return lines.join('\n');
}

/** 主图 SVG（3:4） */
function buildCoverSVG({ title, subtitle, badges = [], fileCount }) {
  const esc = (s) => String(s || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = esc(title).trim();

  // 按行宽切分。
  // 要点：
  //   1) 优先在空格/标点处断行，避免把英文单词切碎（"Shorts" 不能断成 "S"+"horts"）
  //   2) 最多 4 行；超出部分缩略成省略号，不能直接丢弃（丢了信息，主图就与标题不符）
  const MAX_PER_LINE = 12;
  const MAX_LINES = 4;
  const lines = [];
  let cur = '';
  for (const token of t.split(/(\s+)/)) {
    if (!token) continue;
    if (/^\s+$/.test(token)) {
      // 空白：若当前行为空则丢弃，否则保留为分隔
      if (cur) cur += ' ';
      continue;
    }
    if (cur.length + token.length <= MAX_PER_LINE) {
      cur += token;
      continue;
    }
    // 放不下：先收尾当前行，再处理 token
    if (cur.trim()) lines.push(cur.trim());
    // token 自己就超长（如超长英文串），按字符硬切
    if (token.length > MAX_PER_LINE) {
      let rest = token;
      while (rest.length > MAX_PER_LINE) {
        lines.push(rest.slice(0, MAX_PER_LINE));
        rest = rest.slice(MAX_PER_LINE);
      }
      cur = rest;
    } else {
      cur = token;
    }
  }
  if (cur.trim()) lines.push(cur.trim());

  // 超过 4 行则截断并加省略号
  let shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) {
    shown = shown.slice(0, MAX_LINES);
    shown[MAX_LINES - 1] = shown[MAX_LINES - 1].slice(0, MAX_PER_LINE - 1) + '…';
  }

  // 标题字号随行数自适应，单行大字号、多行小字号
  const fontSize = shown.length === 1 ? 92 : shown.length === 2 ? 72 : shown.length === 3 ? 58 : 48;
  const lineH = fontSize * 1.28;
  const titleTop = 300;                       // 标题区顶部（避开上方标签）
  const titleBaseline0 = titleTop + fontSize; // 第一行基线
  const titleBottom = titleBaseline0 + (shown.length - 1) * lineH;

  const titleSvg = shown.map((l, i) =>
    `<text x="70" y="${titleBaseline0 + i * lineH}" font-size="${fontSize}" font-weight="700" fill="#ffffff" font-family="Microsoft YaHei, sans-serif">${l}</text>`
  ).join('\n  ');

  // 副标题（标题下方，动态位置）
  const subY = Math.min(titleBottom + 66, 560);
  const subSvg = subtitle
    ? `<text x="70" y="${subY}" font-size="36" fill="rgba(255,255,255,0.82)" font-family="Microsoft YaHei, sans-serif">${esc(subtitle)}</text>`
    : '';

  // 徽章行（副标题下方）
  const badgeY = subY + 56;
  const bw = 280, bgap = 24, bstartX = 70;
  const badgeSvg = badges.slice(0, 3).map((b, i) =>
    `<g transform="translate(${bstartX + i * (bw + bgap)}, ${badgeY})">
       <rect width="${bw}" height="78" rx="39" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/>
       <text x="${bw / 2}" y="51" font-size="30" fill="#ffffff" text-anchor="middle" font-family="Microsoft YaHei, sans-serif">${esc(b)}</text>
     </g>`).join('\n  ');

  const infoY = badgeY + 190;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f3a5f"/>
      <stop offset="55%" stop-color="#2c5a8a"/>
      <stop offset="100%" stop-color="#3d7ea6"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#bg)"/>
  <circle cx="920" cy="150" r="380" fill="url(#glow)"/>
  <circle cx="100" cy="1320" r="340" fill="url(#glow)"/>

  <text x="70" y="128" font-size="44" fill="rgba(255,255,255,0.7)" font-family="Microsoft YaHei, sans-serif" letter-spacing="5">个人整理 · 学习资料</text>
  <rect x="70" y="164" width="120" height="6" rx="3" fill="#ffd166"/>

  ${titleSvg}
  ${subSvg}
  ${badgeSvg}

  <rect x="70" y="${infoY - 60}" width="940" height="3" fill="rgba(255,255,255,0.25)"/>
  <text x="70" y="${infoY}" font-size="34" fill="rgba(255,255,255,0.82)" font-family="Microsoft YaHei, sans-serif">文件数：${fileCount || '若干'}</text>
  <text x="70" y="${infoY + 58}" font-size="34" fill="rgba(255,255,255,0.82)" font-family="Microsoft YaHei, sans-serif">交付：云端链接 + 提取码</text>
  <text x="70" y="${infoY + 116}" font-size="34" fill="rgba(255,255,255,0.82)" font-family="Microsoft YaHei, sans-serif">用途：个人学习参考</text>

  <g transform="translate(70, 1140)">
    <rect width="940" height="180" rx="24" fill="rgba(0,0,0,0.2)" stroke="rgba(255,255,255,0.24)" stroke-width="1.5"/>
    <text x="40" y="66" font-size="30" fill="rgba(255,255,255,0.9)" font-family="Microsoft YaHei, sans-serif">本商品为个人自行整理的学习参考资料</text>
    <text x="40" y="124" font-size="30" fill="rgba(255,255,255,0.9)" font-family="Microsoft YaHei, sans-serif">非实物 · 禁商用 · 禁二次传播 · 侵权即下架</text>
  </g>

  <text x="70" y="1385" font-size="26" fill="rgba(255,255,255,0.5)" font-family="Microsoft YaHei, sans-serif">学习资料整理 · 仅供个人参考</text>
</svg>`;
}

/** 生成主图 PNG（用 Playwright 把 SVG 渲染成图，避免装 sharp） */
async function renderCovers(items) {
  ensureDirs();
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 1 });
  const out = [];
  for (const it of items) {
    const svg = buildCoverSVG(it);
    const file = path.join(OUT, `cover_${it.slug}.png`);
    await page.setContent(
      `<body style="margin:0;width:1080px;height:1440px;overflow:hidden">${svg}</body>`,
      { waitUntil: 'load' }
    );
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1080, height: 1440 } });
    out.push(file);
    log('ok', `主图已生成: ${path.basename(file)}`);
  }
  await browser.close();
  return out;
}

/** 从 resources.json 生成待上架商品清单 */
function buildListings(resources, opts = {}) {
  const price = opts.price ?? 1.9;
  return resources
    .filter((r) => r.probed && r.probed.valid)
    .map((r) => {
      const title = r.probed.title || r.title;
      const slug = String(r.link).split('/').pop();
      const link = r.link;
      const code = r.code || '';
      const fileCount = r.probed.fileCount || 0;
      const files = r.probed.files || [];
      return {
        slug,
        sourceLink: link,
        code,
        title,
        xyTitle: buildTitle(title),
        price,
        description: buildDescription({ title, link, code, fileCount, files }),
        deliveryText: buildDeliveryText({ link, code, fileCount }),
        fileCount,
        files,
        coverSvg: buildCoverSVG({
          title: cleanTitle(title),
          subtitle: '云端交付 · 长期可用',
          badges: ['个人整理版', '学习参考', '长期可用'],
          fileCount,
        }),
      };
    });
}

module.exports = {
  HIGH_RISK,
  ABSOLUTE,
  cleanTitle, buildTitle, buildDescription, buildDeliveryText,
  buildCoverSVG, renderCovers, buildListings, BANNED,
};

if (require.main === module) {
  const resFile = path.join(DATA, 'resources.json');
  const resources = readJSON(resFile, []);
  const listings = buildListings(resources);
  log('ok', `生成 ${listings.length} 条商品文案`);
  listings.forEach((l) => {
    console.log(`\n[${l.slug}] ¥${l.price}\n  标题: ${l.xyTitle}\n  描述: ${l.description.split('\n')[0]}\n  发货: ${l.deliveryText.split('\n').slice(0,4).join(' / ')}`);
  });
  writeJSON(path.join(DATA, 'listings.json'), listings);
  console.log(`\n-> ${path.join(DATA, 'listings.json')}`);
}
