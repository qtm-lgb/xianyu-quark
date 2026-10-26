'use strict';
/**
 * 文本解析工具：从推文正文里提取资源标题与提取码
 */

/** 从一段文本里找出「标题线索」 */
function guessTitle(text, link) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';

  // 1) 先把正文里所有链接（含 t.co）剥掉，剩下的就是标题线索
  let rest = t
    .replace(/https?:\/\/pan\.quark\.cn\/[sgf]\/[A-Za-z0-9]+/g, ' ')
    .replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, ' ')
    .replace(/https?:\/\/[^\s，。！？]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 2) 引号内容优先（「xxx」「xxx」）
  const q = rest.match(/[「『【]([^」』】]{3,60})[」』】]/);
  if (q) return q[1].trim();

  // 3) 结尾的「链接:」模式（去掉网址后残留）
  rest = rest.replace(/链接?\s*[:：]?\s*$/, '').trim();

  // 4) 取开头的标题句（多数账号格式是「标题正文，资源在...」）
  const head = rest.split(/[。！？!?，,]/)[0].trim();
  if (head && head.length >= 3 && head.length <= 45) return head;

  // 5) 兜底
  if (rest.length > 30) rest = rest.slice(0, 30);
  return rest.replace(/[，,。.、:：\s]+$/, '').trim();
}

/** 提取提取码 */
function guessCode(text) {
  const m = (text || '').match(/提取码[:：\s]*([A-Za-z0-9]{4})/);
  if (m) return m[1];
  const m2 = (text || '').match(/[:：\s]([A-Za-z0-9]{4})(?=\s|$|[，。,])/);
  return m2 ? m2[1] : '';
}

module.exports = { guessTitle, guessCode };
