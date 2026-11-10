# 告警渠道配置指南

> 用途：授权过期、账号掉线、发货异常时**主动推送**给你，  
> 而不是等买家投诉。  
> 场景回顾：11-05 有一笔买家下单没人发货、11-07 有 3 个商品被判违规，  
> 两次都是「等买家反馈」才发现的。

---

## 一、拿到 Webhook 地址（3 分钟）

### 企业微信群机器人（推荐，最简单）

1. 企业微信进入一个**内部群** → 右上角 `…` → 「群设置」
2. 找到「**群机器人**」（新版可能叫「消息推送」）
3. 点「添加」→ 选择「**自定义机器人**」
4. 起个名字（比如「Ydisks 告警」），安全设置选 **IP 白名单不用管 / 关键词不用设**
5. 完成后会显示一条 **Webhook 地址**（含 `?key=xxx`），完整复制

```
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> 不需要 secret，URL 里的 key 就是唯一凭证。

### 飞书自定义机器人

1. 飞书进入目标群 → 右上角「更多」→「设置」
2. 「群机器人」→「添加机器人」→「自定义机器人」
3. 安全设置**建议选「签名校验」**，复制生成的密钥（`sec-` 开头）
4. 完成页会给出 **Webhook 地址**，完整复制

```
https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 钉钉自定义机器人

1. 钉钉进入一个群（可建单人群）→ 右上角「群设置」
2. 「机器人」→「添加机器人」→「自定义机器人」
3. 安全设置勾选「**加签**」，复制 `SEC` 开头的 Secret
4. 完成页同时展示 **Webhook 地址**和 **Secret**，两个都要复制

```
https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx
SECxxxxxxxxxxxxxxxx
```

### Bark（iOS）

从 Bark App 里复制设备 Key：

```
https://api.day.app/你的设备Key
```

---

## 二、执行配置

**在项目目录下执行**：

```bash
cd /c/Users/mailw/WorkBuddy/2026-10-26-11-39-15/xianyu-quark
```

### 企业微信

```bash
node tools/yd_setup_alert.js --wechat "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的真实key"
```

### 飞书（带签名校验）

```bash
node tools/yd_setup_alert.js --feishu "https://open.feishu.cn/open-apis/bot/v2/hook/你的真实token" --secret "sec-你的密钥"
```

### 钉钉（带加签）

```bash
node tools/yd_setup_alert.js --dingtalk "https://oapi.dingtalk.com/robot/send?access_token=你的token" --secret "SEC你的密钥"
```

### Bark

```bash
node tools/yd_setup_alert.js --bark "https://api.day.app/你的设备Key"
```

脚本会依次做四件事：

```
① 测试 webhook 是否真能发出去   <- 不通就中止，不会创建垃圾渠道
② 创建通知渠道
③ 绑定到闲鱼账号
④ 通过 Ydisks 发一条测试消息   <- 你应该真的收到一条消息
```

---

## 三、常用命令

```bash
node tools/yd_setup_alert.js --list        # 查看现有渠道 + 绑定的账号
node tools/yd_setup_alert.js --test <id>   # 单独测试某个渠道
node tools/yd_setup_alert.js --delete <id> # 删除渠道
node tools/yd_setup_alert.js --unbind      # 解绑账号（保留渠道）
node tools/yd_setup_alert.js --guide       # 各平台获取 webhook 的步骤
```

---

## 四、订阅的事件

配置时默认订阅这 6 类：

| 事件 | 含义 |
|---|---|
| `account_offline` | 账号掉线（消息服务断开） |
| `account_disabled` | 账号被停用 |
| `account_recovered` | 账号恢复连接 |
| `token_renewal` | 令牌续期 |
| `error` | 一般错误 |
| `system_error` | 系统级错误 |

其他可用事件：`message`（收到消息）、`delivery_result`（发货结果）、
`order_created`（新订单）等。

---

## 五、两个容易踩的坑

### 1. 平台返回 HTTP 200 ≠ 成功

飞书/钉钉/企微在**凭据无效时也返回 HTTP 200**，真正的错误在 body 里：

| 平台 | 成功 | 失败 |
|---|---|---|
| 飞书 | `{"code":0,"msg":"success"}` | `{"code":19001,"msg":"...token invalid"}` |
| 钉钉/企微 | `{"errcode":0,"errmsg":"ok"}` | `{"errcode":93000,...}` |

脚本现在会**校验业务码**，不通就中止，不会创建无效渠道。

### 2. `event_types` 必须传字符串，不能传数组

这是 Ydisks 的接口坑（实测）：

```jsonc
// ❌ 传数组 -> 整个 body 解析失败，报「name 和 type 必填」（错误提示有误导性）
{ "name":"x", "type":"wechat", "event_types":["account_offline"] }

// ✅ 传逗号分隔的字符串
{ "name":"x", "type":"wechat", "event_types":"account_offline,token_renewal" }
```

同理 `enabled` 必须是**布尔** `true`，传字符串 `"true"` 也会失败。

### 3. `config` 必须是字符串化的 JSON

```jsonc
// ❌ 扁平字段，服务端收不到
{ "name":"x", "type":"feishu", "webhook":"https://..." }

// ✅ config 是 JSON 字符串
{ "name":"x", "type":"feishu", "config":"{\"webhook_url\":\"https://...\"}" }
```

各类型的 config 字段名：

| 类型 | 必填字段 | 可选字段 |
|---|---|---|
| 飞书 `feishu` | `webhook_url` | `secret` |
| 企业微信 `wechat` | `webhook_url` | — |
| 钉钉 `dingtalk` | `webhook` | `secret` |
| Bark `bark` | `url` | — |

---

## 六、频率限制

| 平台 | 限制 |
|---|---|
| 飞书 | 单机器人 100 次/分钟 |
| 企业微信 | 20 条/分钟 |
| 钉钉 | 20 条/分钟 |

告警本身是低频事件（账号掉线才发），不会撞限。
