'use strict';
/**
 * 发布前合规拦截
 *
 * 平台实测会判违规删商品的情况（2026-11-07）：
 *   · 「最全Codex入门教程」-> 违规编号 197285535124（绝对化用语「最全」）
 *   · 「Ai换脸免费模板」-> 被处罚（AI换脸属深度伪造，平台重点管控）
 *
 * 所以**所有发布入口都必须过这道闸**，避免又漏出去。
 */
const { HIGH_RISK, ABSOLUTE } = require('./listing');

/** 标题里绝不能出现的词（命中即拒绝发布） */
const FORBIDDEN = [
  // 已被平台实际处罚过的
  '换脸', '深度伪造', 'face swap', 'faceswap',
  '破解', '破解版', '激活', '解锁', '会员版', 'vip破解',
  '暴力破解', '实名释放', '解封',
  '电子印章', '印章制作', '公章',
  '盗版', '磁力', 'torrent',
  '敏感词', '刷单', '代练', '身份证', '银行卡',
  // 绝对化用语（广告法第九条）
  '最全', '最新', '第一', '唯一', '100%', '彻底', '顶级', '最强', '最好', '最佳',
  '国家级', '世界级', '史上最',
];

/**
 * 检查一个商品是否可以发布
 * @returns {{ok:boolean, reasons:string[], fixedTitle?:string}}
 */
function checkListing(item) {
  const reasons = [];
  const title = String(item.xyTitle || item.title || '');

  if (item.skipPublish) {
    reasons.push(item.note ? `已标记不发：${item.note}` : '已标记不发');
  }
  // 被平台处罚过的，一律不发、也不配自动发货规则
  if (item.penalized) {
    reasons.push(`被平台处罚过，禁止上架：${item.note || ''}`);
  }
  for (const w of FORBIDDEN) {
    if (title.includes(w)) reasons.push(`标题含禁用词「${w}」`);
  }
  // 标题超长
  if (title.length > 30) reasons.push(`标题超长（${title.length}字 > 30）`);
  // 必须有链接
  if (!item.sourceLink || !/pan\.quark\.cn\/s\//.test(item.sourceLink)) {
    reasons.push('缺少有效的夸克分享链接');
  }

  return { ok: reasons.length === 0, reasons };
}

/** 批量筛出可发布的 */
function filterPublishable(listings) {
  const ok = [];
  const blocked = [];
  for (const it of listings) {
    const r = checkListing(it);
    if (r.ok) ok.push(it);
    else blocked.push({ item: it, reasons: r.reasons });
  }
  return { ok, blocked };
}

/** 生成被拦截的清单报告 */
function reportBlocked(blocked) {
  return blocked
    .map((b) => `  ✗ ${b.item.xyTitle || b.item.title}\n      ${b.reasons.join('; ')}`)
    .join('\n');
}

module.exports = { FORBIDDEN, checkListing, filterPublishable, reportBlocked, HIGH_RISK, ABSOLUTE };
