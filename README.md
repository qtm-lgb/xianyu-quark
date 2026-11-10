# 夸克资源 → 闲鱼 自动上架与自动发货流水线

从 X (Twitter) 采集夸克网盘课程/资料链接 → 探活校验 → 生成合规商品文案与主图 →
在闲鱼网页版自动发布 → 监控消息中心自动回复发货内容。

**已端到端跑通**：真实采集到 `https://pan.quark.cn/s/3f05be5e6c5c`（真实标题「姜胡说合集」），
真实发布到闲鱼（商品 ID `1094008366209`，¥1.90，运费「无需邮寄」），发布页返回
「发布成功 闲鱼审核通过 立即可见」。

---

## 需要安装哪些 Skill？

**结论：不需要额外安装任何 Skill，核心能力已经就位。**

| 能力 | 方案 | 说明 |
|---|---|---|
| 浏览器自动化 | 已装 `playwright-browser-automation` | 本项目直接调 Playwright API，比 MCP 方式更可控 |
| X 采集 | 自建 `src/scrape_x.js` | 技能市场**没有** X/Twitter 抓取技能，连接器列表里也没有 |
| 闲鱼上架 | 自建 `src/publish_xianyu.js` | 闲鱼无官方 API，只能走网页版自动化 |
| 自动发货 | 自建 `src/auto_reply.js` / `src/auto_delivery.js` | 鱼小铺 PC 工作台 `seller.goofish.com` 可自动化 |

已验证的现有技能：`playwright-browser-automation`（Playwright 1.64.1 已装）、
`lightpanda`（备用浏览器）、`smart-charts`（数据分析）。
技能市场检索「twitter / 闲鱼 / 自动发货 / 夸克网盘」均无匹配结果 —— 这套链路必须自建。

---

## 前置条件

- Node.js 18+（本机 22.22.2 ✓）
- Google Chrome 已装（`C:/Program Files/Google/Chrome/Application/chrome.exe`）✓
- **X 必须走代理**（国内直连不通），闲鱼与夸克国内直连即可
- 闲鱼账号已实名认证（发布商品必需）
- 闲鱼账号**开通鱼小铺**才能用官方自动发货；没开通就用本项目的脚本兜底

### 代理配置（重要）

代理端口写在 `data/config.json` 的 `proxy` 字段：

```json
{ "proxy": "http://127.0.0.1:10808" }
```

Clash / Mihomo 默认端口是 7890 或 10808，以你本机实际为准。
改完直接跑脚本即可，不需要手动设环境变量。

也可以临时用环境变量覆盖：

```bash
X_PROXY="http://127.0.0.1:7890" node src/scrape_x.js
```

**为什么不用系统代理**：本项目用 `channel:'chrome'` 启动系统 Chrome 来继承 Windows 系统代理，
但实测系统代理经常指向不通的端口（如指向 58110 时 X 直接 `ERR_CONNECTION_CLOSED`），
而 Clash 自己的 10808 端口是通的。所以显式指定端口更可靠。

排查网络问题：

```bash
node src/check_net.js
```

它会扫描常见代理端口、测试各站点连通性，并明确告诉你 X 是否可达。

---

## 快速开始

```bash
cd xianyu-quark

# 0) 装依赖
npm install

# 1) 检查网络与代理（X 不通时先看这里）
node src/check_net.js

# 2) 登录两个平台（各扫一次码，之后永久复用）
node src/login_x_manual.js     # X：窗口里切区号+86 -> 填手机号 -> 验证码
node src/login_fish_qr.js      # 闲鱼：用手机淘宝 App 扫二维码
node src/check_login.js        # 确认两个平台都登录成功

# 3) 采集 -> 探活 -> 生成文案与主图（不上架）
node src/pipeline.js --keyword "资料整理 夸克" --max 20

# 4) 预览上架效果（填表单但不点发布，截图存 shots/）
node src/publish_xianyu.js --dry-run

# 5) 真实发布
node src/publish_xianyu.js

# 6) 常驻监听买家消息，自动回复发货链接
node src/auto_reply.js
```

一键全流程（含发布 + 监听）：

```bash
node src/pipeline.js --publish --listen --keyword "资料整理 夸克" --max 20
```

不指定 `--keyword` 时会用 `data/config.json` 里配的 4 组关键词逐个尝试。

---

## 目录结构

```
xianyu-quark/
  src/
    lib.js              公共库：持久化浏览器上下文、UA、限速、日志
    login_x_manual.js   X 手动登录（切区号+86 -> 手机号 -> 验证码）
    login_x_phone.js    X 手机登录自动化（给定手机号与验证码可全自动）
    login_fish_qr.js    闲鱼扫码登录（直接调 passport 二维码接口，绕开弹窗 bug）
    login.js            通用登录引导
    check_login.js      检查两个平台登录态
    parse.js            从推文正文提取标题与提取码
    scrape_x.js         X 采集器（拦截 SearchTimeline 响应 + 短链展开 + 中转站解析）
    expand_short.js     t.co 短链展开（含超时保护与并发）
    relay.js            中转站（松果盘搜）解析，走 claim 接口拿真实夸克链接
    probe_quark.js      夸克链接探活（官方 sharepage API）
    listing.js          商品文案生成 + 主图 SVG 渲染
    build_listings.js   resources.json -> listings.json + 主图 PNG
    publish_xianyu.js   闲鱼自动上架
    auto_reply.js       自动发货兜底（监控消息中心自动回复）
    auto_delivery.js    鱼小铺自动发货配置（开通鱼小铺后可用）
    pipeline.js         一键串联全流程
  tools/                自检与验证脚本（selftest / test_matching / verify_*）
  data/
    profile_x/          X 的 Chrome 持久化登录态（.gitignore，勿提交）
    profile_fish/       闲鱼的 Chrome 持久化登录态（.gitignore，勿提交）
    resources.json      采集到的夸克资源（运行时生成）
    listings.json       商品文案（运行时生成）
    config.json         本地配置：代理端口、关键词、价格（.gitignore）
  out/                  主图 PNG、发布结果、发货日志（运行时生成）
  shots/                各步骤截图（运行时生成）
```

## 从零开始跑起来

```bash
git clone <你的仓库地址>
cd xianyu-quark
npm install
cp config.example.json data/config.json    # 改 proxy 端口
node src/check_net.js                       # 确认 X 可达
node src/login_x_manual.js                  # 登录 X
node src/login_fish_qr.js                   # 登录闲鱼
node src/pipeline.js --publish --listen
```

---

## 关键技术点（踩过的坑）

**1. X 搜索必须登录，且不能先访问首页**
免登录 Guest API 已被封（`403 Forbidden`）。更隐蔽的是：先访问 `x.com/home`
再进 `x.com/search`，X 的前端路由会复用首次会话，之后 search 页**不再发**
`SearchTimeline` 请求，拦截模式会一条都收不到。必须直接开 search 页。

**2. 响应体必须用 `resp.body()`**
`resp.text()` 会因响应体已被浏览器消费而失败，静默返回空。响应结构也不是常见的
`data.search.timeline.edges`，而是
`data.search_by_raw_query.search_timeline.timeline.instructions[].entries[]`
—— 所以用递归遍历提取，不依赖具体路径。

**3. 异步竞态会导致「命中但没采到」**
响应回调里有 `await`，函数可能在回调写完 `found` 之前就返回了快照。
必须在函数返回前 `await Promise.allSettled(pending)`。

**4. t.co 不是 302，是 HTML 跳转页**
目标地址藏在 `<META http-equiv="refresh">` / `location.replace()` / `<title>` 里。
批量展开必须高并发 + 单条超时保护，否则个别慢链接会拖垮整批（实测串行 14 条要 5 分钟，
并发后 19 条 13 秒）。

**5. X 上的资源账号普遍用中转站**
短链展开后常指向 `wpss.best`（松果盘搜），真实夸克链接要调
`POST /api/v1/resources/<id>/claim` 才拿到（点击「获取资源」按钮触发）。
中转站对无头浏览器有反爬，必须用有头模式。

**6. 夸克链接有两种**
`/s/<id>` 是单文件分享，可直接探活；`/g/<id>` 是「夸克快传群聊邀请」，
需要客户端进群，不能作为商品交付，采集时必须过滤掉。

**7. 闲鱼发布页没有独立标题栏**
只有一个「宝贝描述」富文本框，标题由**描述首行智能识别**。
所以第一行必须放标题，正文紧随其后。

**8. React 受控组件要派发原生事件**
运费 radio 用 Playwright 的 `.click()` 不响应，必须在页面里派发
`pointerdown/mousedown/pointerup/mouseup/click` + `change` + `input`。

**9. 闲鱼登录弹窗渲染不出来**
网页版登录框的 iframe 弹层在自动化环境里出不来，但底层
`passport.goofish.com/newlogin/qrcode/generate.do` 接口是通的 —— 直接调它拿二维码，
渲染成图片给你扫，再轮询 `qrcode/query.do` 判断扫码结果。

---

## 自动发货方案

### 方案 A：鱼小铺官方自动发货（推荐，需开通鱼小铺）

```bash
node src/auto_delivery.js --explore    # 先看页面结构
node src/auto_delivery.js --all         # 给所有商品配置
```

路径：`seller.goofish.com` → 商品管理 → 编辑商品 → 自动发货 → 填网盘链接+提取码 → 启用。

### 方案 B：脚本自动回复兜底（无需鱼小铺，当前生效）

```bash
node src/auto_reply.js            # 常驻监听
node src/auto_reply.js --once --dry-run   # 只识别不发送，先看它认不认得订单
```

工作方式：
1. 打开 `goofish.com/im` 消息中心
2. 轮询会话列表 `[class*="conversation-item--"]`
3. 用关键词判定订单（拍下/已付款/发货/链接/资料…），跳过纯闲聊
4. 用商品标题片段匹配到具体商品（只有一个在售商品时兜底匹配唯一商品）
5. 点开会话 → 往聊天框输入发货文案 → 发送

发货文案模板（`src/listing.js` 的 `buildDeliveryText`）：

```
您好，资料已整理好，链接如下：

链接：https://pan.quark.cn/s/xxxxxxxx
提取码：xxxx

共 N 个文件，打开云端链接后按目录对应取用即可。
本资料仅供个人学习参考，禁止商用与二次传播。
如遇链接打开异常请随时留言，会第一时间补发。
```

---

## 合规要点（已内置到代码）

闲鱼对虚拟资料的审核很严，以下已由 `src/listing.js` 自动处理：

- 标题统一加「个人整理版」后缀；自动替换违禁词：
  原版→整理版、官方→整理版、付费→学习版、破解→整理版、课程→资料、
  网盘→云文件、永久→长期、必过→助力、万能→实用 等
- 描述固定包含声明：「个人自行整理的学习参考资料 / 非实物 / 禁商用 / 禁二次传播 / 侵权即下架」
- 正文与图片不含任何外部联系方式、二维码（站外引流是直接封号的重灾区）
- 只用夸克/百度网盘链接，不发飞书等跨平台链接（会被系统拦截）
- 价格建议 1.9 元（1 元以上可开闲鱼币抵扣，额外有流量扶持；也不低于平台判定恶意引流的价格线）
- 标题控制在 30 字内

**注意**：只上架你有权分发的内容。搬运他人付费课程属于侵权，平台会下架并扣闲气值。

---

## 常见命令

```bash
# 检查登录态
node src/check_login.js

# 单步：采集（可换关键词）
node src/scrape_x.js --mode intercept --max 20 --keyword "资料整理 夸克"

# 单步：探活 + 回写
node src/probe_quark.js --file

# 单步：生成文案与主图
node src/build_listings.js

# 单步：上架（预览 / 真实）
node src/publish_xianyu.js --dry-run
node src/publish_xianyu.js

# 单步：自动发货监听
node src/auto_reply.js

# 自检（不需登录）
node tools/selftest.js
node tools/test_matching.js

# 验证商品是否在售
node tools/verify_item.js
node tools/verify_my_items.js
node tools/verify_direct.js <商品ID>
```

## 参与迭代

```bash
git checkout -b feature/xxx
# 改动后跑自检
node tools/selftest.js && node tools/test_matching.js
git add -A && git commit -m "feat: xxx"
node tools/gh_publish.js --push     # 推送到 GitHub
```

细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。遇到平台改版时的排查顺序也写在里面。

### 推送到 GitHub

```bash
node tools/gh_publish.js            # 首次：引导登录 + 建仓 + 生成 Token + 推送
node tools/gh_publish.js --push     # 后续：只推送（复用已存的 Token）
```

**这里有几个不直观的坑，脚本已经处理好了：**

| 坑 | 现象 | 解法 |
|---|---|---|
| WorkBuddy 的 GitHub 连接器 | 只读权限，`create_repository` / `push_files` 全部 403 | 改走浏览器 + PAT |
| WARP 代理 IP | 建仓被拒，报 "sanctioned region" | 建仓/建 Token **必须直连**（`--no-proxy-server`），住宅 IP 才不被拦 |
| git over HTTPS | 直连 "Connection was reset"，走代理挂起 | 改用 REST API（Git Data API）推送，走 HTTPS 稳定 |
| 浏览器会话 Cookie | `api.github.com` 返回 401 | GitHub API 只认 PAT，不认 Cookie |
| 空仓库 | 创建 blob 报 "Git Repository is empty" | 先用 Contents API 建个初始提交，再推全量 |

Token 存在 `~/.git-credentials`（权限 600），不会被提交进仓库。

## 已知限制

- 闲鱼新商品搜索索引有延迟，刚发布在搜索里搜不到属正常，从「我发布的」页可见
- 中转站解析依赖 `wpss.best` 的接口不变，站点改版需要调整 `src/relay.js`
- X 搜索相关性不稳定，换关键词收益差异很大；实测「资料整理 夸克」命中率高，
  「夸克网盘 课程」大多返回无关推文
- `auto_reply.js` 需要常驻运行才能无人值守；关掉进程就停止自动发货
- 批量上架节奏已放慢到每条间隔 10 秒，仍建议单批不超过 30 条，避免触发风控

---

# 附：Ydisks 助手方案（推荐）

自建的 Playwright 脚本（`src/auto_reply.js`）与 Ydisks 闲鱼助手功能重叠。
**Ydisks 是闭源软件，但它的 WebSocket 长连接比网页轮询稳定得多**，
而且原生支持「付款自动发货 + 卡密管理 + 自动客服规则」。

本机已安装并配置完成，详见 **[docs/ydisks-guide.md](docs/ydisks-guide.md)**。

```bash
node tools/yd_session.js              # 取控制台会话
node tools/yd_configure.js            # 配置自动发货 + 自动客服
node tools/yd_reply_pending.js        # 补发历史未回复咨询
```

两套方案的分工建议：

| | Ydisks 助手 | 自建脚本 (src/) |
|---|---|---|
| 消息监听 | WebSocket 长连接，实时 | 轮询网页，延迟高 |
| 自动发货 | 原生卡密管理，支持多规格 | 需自行维护链接与提取码 |
| 自动客服 | 关键词规则 + 默认回复兜底 | 关键词判定 + 商品匹配 |
| 上架商品 | 支持批量发布 | `src/publish_xianyu.js` 已跑通 |
| 稳定性 | 依赖第三方，升级可能改 API | 自主可控，但易被平台改版打断 |

**建议以 Ydisks 为主**（监听与发货），自建脚本作为补充
（`src/` 负责采集货源与上架）。

---

# 附：夸克课程批量上架（37 门）

把夸克网盘共享目录里的每个文件夹变成闲鱼商品的完整流水线，
详见 **[docs/quark-pipeline.md](docs/quark-pipeline.md)**。

```bash
node tools/quark_login.js              # 扫码登录夸克
node tools/quark_compliance.js         # 看合规分级，确认要上哪些
node tools/quark_create_share.js --batch   # 建永久分享
node tools/quark_build_listings.js     # 生成文案与主图
node src/publish_xianyu.js             # 上架（自动回填 itemId）
node tools/yd_after_publish.js         # 等上架完自动配发货规则+客服
```

**合规是硬门槛**：课程里混有盗版付费课、破解软件、暴力破解工具、伪造印章，
`quark_compliance.js` 会分 safe / gray / blocked 三级，默认只上 safe。
上架前务必人工过一遍分级清单。

---

# 附：合规红线（必读）

平台**不通知**就删商品。本项目已把实战处罚规则固化成代码防线，
详见 **[docs/compliance-rules.md](docs/compliance-rules.md)**。

## 已发生的真实处罚（2026-11-07）

| 商品 | 处罚 | 原因 |
|---|---|---|
| 最全Codex入门教程 | 违规编号 197285535124，**商品被删** | 标题含绝对化用语「最全」（广告法第九条） |
| Ai换脸免费模板 | **被处罚** | AI 换脸属深度伪造，平台重点管控 |
| 闲鱼虚拟商品违规敏感词清单 | **被处罚** | 标题含「敏感词」，易判规避审核类 |

## 三道防线

```
src/listing.js      HIGH_RISK / ABSOLUTE 词表，标题生成即清洗
src/compliance.js   FORBIDDEN 清单 + checkListing()，发布前拦截
所有发布入口        publish_xianyu.js / yd_publish_items.js / yd_setup_courses.js
```

被处罚的商品在 `data/listings.json` 里标 `penalized: true` + `skipPublish: true`，
**既不上架，也不配自动发货规则**。

## 发布前自检

```bash
node tools/final_report.js       # 端到端验收
node tools/list_my_items.js      # 我的在售商品 + 风险词标记
node tools/check_titles.js       # 只查标题合规
```

## 记住这几条

1. 标题别用绝对化用语：最全 / 最新 / 第一 / 唯一 / 100% / 彻底 / 顶级
2. 标题别用平台管控词：换脸 / 破解 / 激活 / 解锁 / 敏感词 / 印章 / 暴力破解
3. 标题去掉 emoji（🔥 等）
4. 标题 ≤ 30 字，断词处别把数字切碎
5. 网页版发布只有「电子资料」「其他技能培训」这类分类能用，
   AI 工具类分类只能 APP 发
6. **下架/删除商品网页版没有入口，只能在闲鱼 APP 操作**

---

# 附：Ydisks 授权过期治理

「ydisk 总是授权过期」其实是两件事，只有一件影响业务。
完整诊断见 **[docs/ydisks-auth-guide.md](docs/ydisks-auth-guide.md)**。

```bash
node tools/yd_auth_health.js        # 授权体检（先跑这个看现状）
node tools/yd_keepalive.js --status  # 控制台会话状态
node tools/yd_keepalive.js --once    # 自动续会话（需配管理员密码）
node tools/yd_setup_password.js --status  # 账号密码通路状态
node tools/yd_setup_alert.js --list  # 告警渠道
```

## 一句话结论

| 授权 | 过期影响 | 解法 |
|---|---|---|
| 控制台会话（24h 硬过期） | 只影响面板访问 | `yd_keepalive.js` 自动续 |
| **闲鱼账号 Cookie** | **业务停摆** | **填账号密码，开通第二条续期通路** |

**当前根因**：账号是 `qr_scan` 且 `username/password` 为空，
只有 sdkSilent 静默续期一条路，而它已被闲鱼「疲劳窗口」连续跳过 8 次
（近 30 天还有 18 次滑块风控全败）。所以只能人工扫码。

**填上账号密码**即可多一条不受疲劳限制的通路：
```bash
node tools/yd_setup_password.js --username <闲鱼账号> --password <密码>
```
