# Ydisks 闲鱼助手 —— 自动客服与自动发货配置

用 Ydisks 闲鱼助手（本机已装，服务在 `127.0.0.1:59188`）接管闲鱼的
**自动客服**与**付款自动发货**，不再依赖自建的 Playwright 脚本。

---

## 一、先说结论：之前为什么没自动回复/发货

2026-11-07 全面排查后确认，**助手本身完全正常**，问题 100% 出在配置：

| 检查项 | 状态 | 说明 |
|---|---|---|
| WebSocket 通道 | ✓ 正常 | 56344 条消息，最新到当天 05:30 还在收发 |
| WS Token | ✓ 正常 | 每 4 小时自动续期，`ttl=24h` |
| 账号在线 | ✓ 正常 | 账号 `2419336374`（爱看不看吧）`enabled=true` |
| 买家消息入库 | ✓ 正常 | 咨询消息实时进 `chat_messages` 表 |
| 规则执行机制 | ✓ 正常 | 历史 5 次 `automation_runs` 全部 `success` |
| **「姜胡说合集」的发货规则** | ✗ **缺失** | 11-05 有人下单，无规则 → 无卡密可发 |
| **自动客服关键词规则** | ✗ **0 条** | `reply-rules` 表为空 → 咨询无人回 |
| **默认回复（兜底）** | ✗ **未启用** | `default_replies` 表为空 |
| 规则 2（写作陪跑营） | ⊘ 正确禁用 | 其商品 2026-09-14 已下架，不应启用 |

顺带澄清一点：日志里 79 次「WebSocket 握手失败」、30 次「安全验证拦截」**都是历史遗留**
（集中在 9 月至 10-28），11-07 当天连续 4 次握手成功，不是当前问题。

---

## 二、现在配好了什么

### 1. 自动发货（3 个在售虚拟商品全部覆盖）

| 规则 ID | 商品 | 卡密 | 状态 |
|---|---|---|---|
| 5 | 姜胡说合集 个人整理版 (1094008366209) | 卡密「姜胡说合集」 | ✓ 新建启用 |
| 4 | 即梦AI提示词视频课 (1085810020688) | 卡密「即梦AI」 | ✓ 原有 |
| 3 | Deepseek+飞书表格 AI办公 (1084343932261) | 卡密「DS飞书表格教程」 | ✓ 原有 |

每个规则 = `send_card`(发链接) + `confirm_shipment`(标记发货)，买家付款后自动发网盘链接。

### 2. 自动客服关键词规则（8 条）

| 关键词 | 触发场景 |
|---|---|
| 有哪些内容 / 啥内容 / 都有啥 | 「这资料有啥」类咨询 |
| 截图 | 想要目录截图 |
| 怎么下载 | 问使用方式 |
| 链接 | 直接要链接 |
| 多少钱 | 问价格 |
| 发货 | 问多久发货 |

### 3. 默认回复（兜底）

未命中关键词时自动回复：说明价格、发货方式、合规声明。`reply_once=false`（可重复发）。

### 4. 已补发 5 条历史未回复的咨询

配置前有 5 个买家问了「姜胡说合集」却无人回复，已用同一话术补发，
并在闲鱼网页侧独立验证送达（会话列表已置顶显示）。

---

## 三、工具脚本

```bash
# 取会话 token（从助手数据库读，缓存在 ~/.workbuddy/yd_session.txt）
node tools/yd_session.js

# 配置自动发货 + 自动客服（幂等，可重复跑）
node tools/yd_configure.js --dry-run   # 先看要做什么
node tools/yd_configure.js             # 实际执行

# 补发历史未回复的咨询
node tools/yd_reply_pending.js --dry-run
node tools/yd_reply_pending.js
```

---

## 四、助手 API 速查

所有接口在 `http://127.0.0.1:59188/api/v1`，认证用 **cookie**（不是 header）：

```
Cookie: session=<session_id>
```

`session_id` 存在助手的 `sessions` 表，有效期 1 天。

| 用途 | 接口 | 方法 |
|---|---|---|
| 校验会话 | `/session` | GET |
| 取账号列表 | `/accounts/details` | GET |
| 自动化（发货）规则 | `/automation-rules` | GET/POST/PUT |
| 规则动作（卡密绑定） | 随规则 body 的 `actions[]` | — |
| 卡密管理 | `/cards` | GET/POST |
| 自动客服关键词 | `/reply-rules/{cid}/typed` | GET |
| 新增关键词规则 | `/reply-rules/{cid}/items` | POST |
| 默认回复 | `/default-replies/{cid}` | GET/PUT |
| 会话列表 | `/chat/sessions?account_id=` | GET |
| 发消息 | `/chat/messages` | POST |

**发消息的 body 字段是 `text` 不是 `content`**（这是我踩过的坑）：

```json
{
  "account_id": "2419336374",
  "chat_id": "68775449901",
  "buyer_id": "51687404",
  "buyer_name": "轻松印记",
  "item_id": "1094008366209",
  "item_title": "姜胡说合集 个人整理版",
  "text": "您好，这是..."
}
```

---

## 五、排查手册

| 现象 | 排查顺序 |
|---|---|
| 没自动发货 | ① 商品有没有对应规则（`automation-rules` 按 `item_id` 查）→ ② 规则 `enabled` → ③ 规则的 `actions` 里 `send_card` 的 `card_id` 是否指向有效卡密 → ④ 卡密 `enabled` → ⑤ `automation_runs` 表看有无执行记录及 `error_message` |
| 没自动回复 | ① `reply-rules/{cid}/typed` 是否有规则 → ② 关键词是否匹配买家原文（是包含匹配，不是精确）→ ③ `default_replies` 是否启用 → ④ `chat_messages` 里对应消息的 `status` |
| 消息发不出去 | ① 账号 `enabled` 且未 `paused` → ② WS 是否在线（`server.log` 搜「WS 注册完成」）→ ③ 是否被安全验证拦截（搜「安全验证」）→ ④ `show_browser=true` 可让助手显示浏览器便于人工过滑块 |
| 订单状态 `unknown` | 调 `POST /orders/refresh` 重新同步闲鱼订单 |

### 日志位置

```
C:\ProgramData\YdisksXianyuHelper\logs\server.log     # 服务端主日志
C:\ProgramData\YdisksXianyuHelper\logs\tray.log       # 托盘日志
C:\ProgramData\YdisksXianyuHelper\data\xianyu_data.db # SQLite（47 张表）
```

数据库被服务独占锁定，读取时先复制 db + wal + shm 三个文件再打开
（只复制 db 会丢 WAL 里的最新数据）。

### 表结构速查

| 表 | 用途 |
|---|---|
| `cookies` | 闲鱼账号登录态（id 即 cookie_id） |
| `automation_rules` | 发货规则主表 |
| `automation_rule_actions` | 规则→卡密的绑定（send_card 的 card_id 在这） |
| `cards` | 发货内容（网盘链接+提取码） |
| `reply-rules` | 自动客服关键词规则 |
| `default_replies` | 默认回复兜底 |
| `orders` | 订单（`system_shipped` 标记是否已发货） |
| `automation_runs` | 规则执行记录（看 `status` 和 `error_message`） |
| `chat_messages` | 聊天记录 |
| `sessions` | 控制台登录会话（`session_id` + `expires_at`） |
| `risk_control_logs` | 风控/滑块拦截记录 |

---

## 六、新增商品后要做什么

新发布一个虚拟资料商品后，必须补两样，否则不会发货：

1. 在 Ydisks 里建**卡密**（填网盘链接+提取码）
2. 建**付款后自动发货规则**：`trigger_type=order_paid`，
   `item_id` 填新商品 ID，`actions` = `send_card`(card_id=新建的卡密) + `confirm_shipment`

或者直接改 `tools/yd_configure.js` 里的 `JIANG` 常量，跑一次脚本即可
（脚本按 `item_id` 判断，幂等）。

---

## 七、注意事项

- **虚拟资料的合规红线**：闲鱼对「网盘资料」类商品审核较严。商品标题建议带
  「个人整理版」，描述含「仅供个人学习参考、禁止商用与二次传播、侵权即下架」声明，
  正文与图片**不要放任何外部联系方式或二维码**（站外引流会直接封号）。
- **发货延迟**：`cards.delay_seconds` 默认 0（立即发）。若平台风控频繁，
  可调成 30-60 秒，模拟真人操作节奏。
- **助手是闭源软件**，本仓库只记录其 API 用法与表结构，不含其源码。
- **若将来升级 Ydisks 版本**，表结构可能变化，届时用
  `PRAGMA table_info(表名)` 重新确认字段。
