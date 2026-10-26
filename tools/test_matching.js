// 单元测试：订单识别 + 商品匹配 + 发货文案
const { matchListing } = require('../src/auto_reply');
const { readJSON } = require('../src/lib');
const path = require('path');
const { DATA } = require('../src/lib');
const listings = readJSON(path.join(DATA, 'listings.json'), []);
console.log('商品数:', listings.length);
const cases = [
  '你好，在吗',
  '已拍下，什么时候发货？',
  '付款了，资料发我一下',
  '姜胡说合集 个人整理版 链接发我',
  '你这里有 姜胡说合集 个人整理版 的链接吗',
  '在的，哥/姐!直接拍就行哦，夸克网盘发货',
  '收到的，谢谢',
  '多少钱',
  '拍下了 姜胡说合集',
];
console.log('\n=== 识别与匹配结果 ===');
for (const c of cases) {
  const item = matchListing(c, listings);
  const isOrder = /拍下|已付款|付款了|发货|链接|资料|怎么下载|拍/.test(c);
  const isChat = /你好|在吗|谢谢|收到|好的|多少钱|还有吗|在的|嗯|ok|稍等/i.test(c) && !/链接|发货|拍下|付款|资料/.test(c);
  const verdict = isChat ? '闲聊(跳过)' : isOrder ? (item ? '✓ 发货 '+item.slug : '订单但未匹配') : '非订单(忽略)';
  console.log(`  "${c}"\n     -> ${verdict}`);
}
console.log('\n=== 发货文案示例 ===');
if (listings[0]) console.log(listings[0].deliveryText);
