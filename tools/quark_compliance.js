'use strict';
/**
 * 课程合规分级
 *
 * 分三级：
 *   safe     —— 可直接上架（AI/技能/教程/副业玩法类）
 *   gray     —— 灰区，涉破解/搬运/多账号，建议不上或改名后再上
 *   blocked  —— 红线，涉违法用途或明显盗版他人付费内容，不上
 *
 * 判定依据：闲鱼《虚拟商品管理规范》与「引流-盗版-破解」类目审核惯例，
 * 以及法律风险（伪造印章、破解他人付费内容、暴力破解）。
 */

const RED = [
  // 违法用途
  /暴力破解/, /破解.*密码/, /密码破解/, /撞库/, /爆破/,
  /实名.*释放/, /解除实名/, /绕过实名/, /解封/, /实名技术/,
  // 伪造
  /电子印章/, /电子Y章/, /印章制作/, /公章/, /合同章/,
  // 明显盗版他人付费内容
  /付费课程/, /正价课程/, /绝版.*书/, /影视解说搬运/, /搬运教程/,
  /B站付费/, /盗版/, /破解版/, /VIP破解/, /会员版/, /解锁版/, /解锁高级版/,
  /激活/, /破解工具/, /扩容.*破解/,
  // 票务
  /电影票/, /自动化售卖/,
];

const GRAY = [
  /搬运/, /批量剪辑/, /过审/, /防限流/, /无限扩容/, /扩容/,
  /一键转卖/, /擦边/, /起号/, /霸屏/, /批量发布/,
];

// 明确可上（AI/技能/学习类），命中即放行
const SAFE_HINT = [
  /AI/, /ai/, /大模型/, /提示词/, /Prompt/, /Codex/, /COZE/, /扣子/,
  /飞书/, /deepseek/, /DeepSeek/, /工作流/, /编程/, /开发教程/,
  /思维/, /创业/, /副业/, /变现/, /收益/, /玩法/, /实操/, /指南/,
  /攻略/, /教程/, /模板/, /素材/, /简历/, /PPT/, /excel/, /英语/,
  /易经/, /旅游/, /谈判/, /汇报/, /小说/, /写作/,
  // 正经工具类（非破解、非搬运）—— 明确放行
  /闲鱼自动发货/, /发货软件/, /违规检测/, /违规敏感词/, /文案提取/,
  /剧本杀/, /知乎/, /免费文案/,
];

// 灰区里明确属于「正经工具/合集」的白名单（用户只上合规内容，这些可放行）
const SAFE_OVERRIDE = [
  /闲鱼自动发货软件/, /^闲鱼自动发货$/, /闲鱼关键词违规检测工具/,
  /闲鱼虚拟商品违规敏感词清单/, /免费文案提取工具/, /沈阳剧本杀/, /知乎单篇回答合集/,
];

/**
 * @returns {{level:'safe'|'gray'|'blocked', reason:string}}
 */
function classify(name) {
  const t = String(name || '');

  for (const re of RED) {
    if (re.test(t)) return { level: 'blocked', reason: `命中红线: ${re}` };
  }
  // 正经工具白名单（放在灰区检查之前，避免「闲鱼自动发货」被搬运规则误伤）
  if (SAFE_OVERRIDE.some((re) => re.test(t))) {
    return { level: 'safe', reason: '正经工具/合集' };
  }
  for (const re of GRAY) {
    if (re.test(t)) return { level: 'gray', reason: `灰区: ${re}` };
  }
  if (SAFE_HINT.some((re) => re.test(t))) return { level: 'safe', reason: 'AI/技能/教程类' };
  return { level: 'gray', reason: '未命中明确安全特征，需人工确认' };
}

/** 生成最终可上架清单 */
function pickSafe(courses) {
  const out = [];
  const skipped = [];
  for (const c of courses) {
    const { level, reason } = classify(c.title);
    if (level === 'safe') out.push({ ...c, level, reason });
    else skipped.push({ ...c, level, reason });
  }
  return { safe: out, skipped };
}

module.exports = { classify, pickSafe, RED, GRAY, SAFE_HINT };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.resolve(__dirname, '..');
  const courses = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'quark_courses.json'), 'utf8'));
  const { safe, skipped } = pickSafe(courses);

  console.log(`\n════ 可上架 (${safe.length}) ════`);
  safe.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. [${c.fileCount}个/${c.sizeText}] ${c.title}`));

  console.log(`\n════ 跳过 (${skipped.length}) ════`);
  const byLevel = {};
  for (const s of skipped) (byLevel[s.level] ||= []).push(s);
  for (const lv of ['blocked', 'gray']) {
    const arr = byLevel[lv] || [];
    if (!arr.length) continue;
    console.log(`\n  【${lv === 'blocked' ? '红线' : '灰区'}】${arr.length} 个`);
    arr.forEach((s) => console.log(`    - ${s.title.slice(0, 46).padEnd(48)} ${s.reason}`));
  }
}
