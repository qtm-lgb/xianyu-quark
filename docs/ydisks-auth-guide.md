# Ydisks 授权过期问题 —— 诊断与治理

> 实测环境：Ydisks 闲鱼助手（闭源，Go 编译）  
> 服务：`YdisksXianyuHelper`（LocalSystem），`127.0.0.1:59188`  
> 数据：`C:\ProgramData\YdisksXianyuHelper\data\xianyu_data.db`（SQLite，47 表）

---

## 一、先分清：两个完全不同的「授权」

用户反馈的「ydisk 总是授权过期」，实际混着两件事。**只有第二件影响业务。**

| | ① 控制台会话 | ② 闲鱼账号 Cookie |
|---|---|---|
| 存在位置 | `sessions` 表 | `cookies` 表 + 浏览器 cookie |
| 有效期 | **硬编码 24 小时** | 由闲鱼服务端决定（通常 24~72h） |
| 过期表现 | Web 面板打不开，API 返回 401 | 自动发货停摆、收不到消息、买家订单无人处理 |
| 影响业务？ | ❌ 不影响 | ✅ **直接影响** |
| 能否自动续 | ✅ 靠密码重新登录 | ⚠️ 依赖续期通路，见下 |

**验证方式**：看 `runtime-status`。
```bash
curl -b "session=$(cat ~/.workbuddy/yd_session.txt)" \
  http://127.0.0.1:59188/api/v1/accounts/runtime-status
```
返回 `"state":"online"` 说明业务侧没问题，只是控制台会话过期了。

---

## 二、① 控制台会话：24 小时硬过期

### 事实

`sessions` 表全部 26 条历史记录的 `(expires_at - created_at)` **恒为 24.00 小时**，
无任何配置项、无命令行开关可调。二进制里搜不到 `session_ttl` 之类的键。

### 为什么会踩坑

我们的 API 脚本都从 `~/.workbuddy/yd_session.txt` 读缓存 token。
缓存过期后所有脚本全线 401 —— 这就是「授权过期」最直观的体感。

### 处置

**在项目目录下执行**（`cd /c/Users/mailw/WorkBuddy/2026-10-26-11-39-15/xianyu-quark`）：

```bash
node tools/yd_keepalive.js --status    # 看当前会话状态
node tools/yd_keepalive.js --once     # 检查一次，必要时自动重新登录
node tools/yd_keepalive.js            # 前台守护，每 30 分钟检查
```

守护脚本做两件事：

1. **自动同步缓存** —— 从数据库取最新有效 session 覆盖过期缓存。
   这一步不需要任何密码，立刻解决 401。
2. **剩余不足 6 小时时自动重新登录** —— 需要控制台管理员密码。

密码来源（任选其一）：
- 环境变量 `YDISKS_PASSWORD`
- 文件 `~/.workbuddy/yd_password.txt`（内容就是密码明文）

> 建议放进 Windows 任务计划，每 30 分钟跑一次 `--once`：
> ```powershell
> Register-ScheduledTask -TaskName "YdisksKeepalive" -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)) `
>   -Action (New-ScheduledTaskAction -Execute "node" -Argument "C:\...\xianyu-quark\tools\yd_keepalive.js --once")
> ```

---

## 三、② 闲鱼账号授权：真问题在这里

### 症状

日志里每 4 小时一次的续期任务，**连续全部被跳过**：

```
21:19:22 接口续期任务已跳过 account=2419336374 reason=fatigue
                message="sdkSilent 疲劳窗口内，跳过静默续期"
01:19:22 接口续期任务已跳过 reason=fatigue
05:19:22 接口续期任务已跳过 reason=fatigue
09:19:22 接口续期任务已跳过 reason=fatigue
```

### 根因链

```
滑块风控 30 次全败 → 静默续期(sdkSilent)断掉
        ↓
闲鱼对同一账号的静默续期有「疲劳窗口」→ 后续 8 次全部跳过
        ↓
免扫码只剩「Go 协议续期」一条（11-07 成功过 1 次）
        ↓
它失败时兜底仍是人工扫码（account_login_logs: qr_scan 14 次 / protocol 1 次）
```

**证据 1 —— 滑块风控全败**（`risk_control_logs` 表）：

| 日期 | 次数 | 结果 |
|---|---|---|
| 09-09 ~ 09-25 | 9 | 全部 failed |
| 10-07 ~ 10-19 | 6 | 全部 failed |
| 10-20 ~ 10-28 | 15 | 全部 failed |

累计 **30 次，失败 30 次**，近 30 天 18 次。
典型错误：`Playwright 主引擎失败: 滑块验证 3 次均失败`。

**证据 2 —— 密码登录接口被禁用**（实测，2026-11-10）：

```
POST /api/v1/password-login
  -> {"code":"password_login_disabled","message":"Go 客户端仅支持扫码登录，密码登录已禁用"}
  -> HTTP 501（对任何参数组合都一样）
```

```
cookies 表: id=2419336374  username='jonnyprince'  password='enc:v1:...'  login_method='qr_scan'
```

密码确实存进去了（AES 加密），但**存着不等于能用** ——
本版 Go 客户端不开放这条路径。

**证据 3 —— 官方留了后门但没启用**。二进制符号表里：

```
xianyu-go/internal/xianyu/renew.Service.RenewAPIFirst   ← 续期公开入口
xianyu-go/internal/xianyu/renew.Service.renewAPIFirst   ← 内部实现
  ├─ renewAPIFirst.func1 → renew.autoLoginMode              (常规模式，受疲劳限制)
  └─ renewAPIFirst.func2 → renew.autoLoginModeWithoutFatigue (无疲劳模式，兜底)
renew.Result{ authoritative }  /  (*Result).AwaitPending
renew.Service.callAutoLogin
internal/.../passwordLoginByCookie
internal/.../passwordRenewalResult
```

这是**两级续期架构**：先试常规模式（sdkSilent 静默续期），失败/被拦截就切
无疲劳模式。`authoritative` 字段标记哪次结果算数，`AwaitPending` 处理异步结果。

`autoLoginModeWithoutFatigue` 这个名字直接说明：**填了账号密码，续期才会走
不受疲劳窗口限制的通路**。而日志里 `password_login` 相关记录是**零** ——
这条通路从未启用过。

> 补充：`fatigue` 在二进制里只出现一次，是**闲鱼响应头的 key**
> （服务端返回该头 = 告诉你「请求过频」），不是本地计时器。
> 所以疲劳窗口的判定权在闲鱼服务器，**本地改不了，只能绕开**——
> 绕开的方式就是启用不走 sdkSilent 的路径。

### 处置：填账号密码（**重要修正**）

> ⚠ **2026-11-10 实测更正**
>
> 我最初判断「填账号密码能开通第二条不受疲劳限制的续期通路」——
> **这个结论是错的**。实测 `POST /api/v1/password-login` 对**任何**参数组合
> （带/不带 `cookie_id`、带/不带 `password`、带/不带 `username`）
> 一律返回：
>
> ```json
> {"code":"password_login_disabled","message":"Go 客户端仅支持扫码登录，密码登录已禁用"}
> ```
> HTTP 501。**本版 Ydisks 的 Go 客户端整体禁用了密码登录接口。**
>
> 二进制里那些 `passwordLoginByCookie` / `passwordRenewalResult` /
> `autoLoginModeWithoutFatigue` 符号确实存在，但**对应代码路径没有开放**。
> 符号存在 ≠ 功能可用 —— 这是我这次犯的错。
>
> 所以：填账号密码**不能**替代扫码。它唯一的实际作用是
> 把凭据存下来（面板上「立即执行账号密码登录」按钮会用到），
> 以及减少你每次重新输入的负担。

#### 免扫码续期到底靠什么

真实存在的免扫码续期通路只有一条：**「Go 协议续期」**（日志里的 `protocol` 方法）。

`account_login_logs` 全量统计（15 条记录）：

| 方式 | 次数 | 说明 |
|---|---|---|
| `qr_scan` | 14 | 人工扫码 |
| `protocol` | **1** | Go 协议续期（11-07 成功过一次，免扫码） |

相关文案：

```
登录凭证已失效，正在立即续期
Go 协议续期成功
Go 协议续期未恢复登录凭证，请重新扫码登录   ← 失败兜底还是扫码
协议续期冷却中，还需等待 %s
```

**结论**：扫码是最终兜底，无法自动化。真正要做的是**降低触发扫码的概率**。

#### 填密码（仍然建议做）

**在 Git Bash（或任何终端）里，先 `cd` 到项目目录，再跑脚本：**

```bash
cd /c/Users/mailw/WorkBuddy/2026-10-26-11-39-15/xianyu-quark
node tools/yd_setup_password.js
```

交互模式，密码不回显、不进 shell 历史：

```
════════ 配置闲鱼账号密码登录 ════════

  当前账号: 爱看不看吧 (2419336374)

  闲鱼账号（手机号或淘宝账号）: 13800138000
  闲鱼密码: ★★★★★★★★        <- 输入时屏幕上什么都不显示，这是正常的
  确认提交？(输入 y 确认): y
```

其他方式：

```bash
# 从文件读（适合脚本化）
# ~/.workbuddy/yd_xianyu_pwd.txt  内容: {"username":"xxx","password":"yyy"}
node tools/yd_setup_password.js --from-file

# 查看当前状态
node tools/yd_setup_password.js --status

# 清除密码
node tools/yd_setup_password.js --clear
```

**也可以在图形面板里填**：
账号列表 → 编辑 → 「登录信息」区域 → 「登录密码」（标注"用于自动登录"）→ 保存。

密码由 Ydisks 服务端用 AES 加密后存库（密钥在 `data-key`），**明文不落盘**。

---

### 减少扫码次数（这才是有效的方向）

既然扫码无法自动化，就让它**尽量少发生**。

#### ① 解决滑块风控（真正的触发器）

`risk_control_logs` 里 **30 次滑块全部 failed**，近 30 天 18 次。
每次风控失败 → 凭证失效 → 必须扫码。二进制里的相关文案：

```
远程过滑块不可用，回退本机逻辑
Playwright 主引擎失败: %v；备用滑块引擎失败: %w
```

**主引擎 + 备用引擎都失败**，说明本机滑块识别能力不足。
可行的改善方向（按性价比排序）：

1. **用有头模式跑** —— 账号设置里把 `show_browser` 打开，
   让滑块在可见窗口里出现。盲跑识别率低，人眼看一眼就能过。
2. **提高代理质量** —— 二进制里有 `CAPTCHA_BROWSER_PROXY`，
   说明支持走代理过滑块。当前 IP 段可能已被标记。
3. **错峰操作** —— 续期任务每 4 小时一次偏密，
   闲鱼「疲劳窗口」本身可能就是这个频率触发出来的。

#### ② 长登录要真正生效

`GET /api/v1/accounts/{cid}/long-login` 返回 `enabled: true`，
但服务端日志里**从没有任何长登录相关记录** —— 说明它只是本地标记开了，实际没建立。

二进制里的关键逻辑：

```
长登录凭证已过期，静默续期不应发起请求
```

**长登录有效时，静默续期根本不该发起请求**。
但日志里静默续期一直在发（还被疲劳窗口拦）——
说明状态判断有问题：服务端认为长登录凭证已过期，本地却还标记着 enabled。

**建议**：到面板里把「保存登录信息」（长登录）**关掉再打开**，
让它重新走一次官方接口建立，而不是沿用旧的过期状态。

#### ③ 主动告警（已实现的兜底）

不管怎样，扫码这步省不掉。那就**别等它出问题才发现**：

```bash
node tools/yd_setup_alert.js --wechat "<企业微信 webhook>"
node tools/yd_auth_health.js    # 每天看一眼
```

`account_offline` 事件会在账号掉线时立刻推送，
你扫码的时机就从「买家投诉后」提前到了「掉线时」。


## 四、闲鱼长登录：本地标记开着，但实际没生效

`GET /api/v1/accounts/{cid}/long-login` →

```json
{ "can_open_long_login": true, "enabled": true }
```

接口说开着，**但服务端日志里从没有任何长登录相关记录** ——
说明这只是本地标记，实际的官方长登录凭证并未建立或已过期。

二进制里的关键逻辑：

```
长登录凭证已过期，静默续期不应发起请求
```

长登录有效时，静默续期**根本不该发起请求**。但你的日志里静默续期一直在发
（还被疲劳窗口拦）—— 这正是状态判断出错的证据。

**处理**：到面板里把「保存登录信息」（长登录）**关掉再打开**，
让它重新走一次官方接口建立，别沿用旧的过期状态。
这一步可能直接消掉「每 4 小时疲劳一次」的循环。

---

## 五、加一层主动告警（别等买家来投诉）

之前 11-05 有买家下单没人发货、11-07 有 3 个商品被判违规，
两次都是「等买家反馈」才发现的被动局面。

**在项目目录下执行**：

```bash
# 企业微信群机器人（最简单，不用 secret）
node tools/yd_setup_alert.js --wechat "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的真实key"

# 飞书机器人（带签名校验）
node tools/yd_setup_alert.js --feishu "https://open.feishu.cn/open-apis/bot/v2/hook/你的真实token" --secret "sec-xxx"

# 钉钉机器人
node tools/yd_setup_alert.js --dingtalk "https://oapi.dingtalk.com/robot/send?access_token=xxx" --secret "SECxxx"

# Bark（iOS）
node tools/yd_setup_alert.js --bark "https://api.day.app/你的key"

node tools/yd_setup_alert.js --list     # 查看现有渠道
node tools/yd_setup_alert.js --guide    # 各平台获取 webhook 的步骤
```

脚本会先测 webhook 通不通再建渠道，然后绑到账号并发测试消息。
**获取 webhook 的详细步骤见 [alert-channel-guide.md](alert-channel-guide.md)**。

---

## 六、日常巡检

```bash
node tools/yd_auth_health.js          # 人读报告（6 项体检）
node tools/yd_auth_health.js --json   # 机器读，退出码 1 = 有异常
```

体检项与判据：

| 检查项 | 异常判据 |
|---|---|
| ① 账号运行状态 | `state != online` 或 `failures > 0` |
| ② 闲鱼长登录 | `can_open=true` 但 `enabled=false` |
| ③ 续期记录 | 连续 ≥3 次 `status=skipped`（疲劳窗口） |
| ④ 滑块风控 | 近 30 天 > 0 次 |
| ⑤ 登录方式 | `login_method=qr_scan` 且 `username` 为空 |
| ⑥ 控制台会话 | 无有效会话（**不影响业务**，仅提示） |

配合计划任务，每 30 分钟跑一次，异常时把 JSON 喂给告警脚本。

---

## 七、避坑清单

1. **别把控制台会话过期当成账号掉线** —— 前者只是面板打不开，
   后者才是业务停摆。用 `runtime-status` 一秒区分。
2. **别清空 `~/.workbuddy/yd_session.txt` 里的缓存就完事** ——
   数据库里始终有最新有效 session，`yd_keepalive.js --status` 会自动同步。
3. **读数据库必须复制 db + wal + shm 三个文件** —— 服务独占锁，
   只复制 db 会丢 WAL 里的最新数据（session、订单都可能在 WAL 里）。
4. **数据库是只读的** —— 服务以 LocalSystem 运行，文件归 Administrators，
   普通用户进程写不进去。要改库得用管理员权限，或走 API。
5. **Ydisks 分页参数是 `page_size` 不是 `pageSize`** —— 用错只返回 10 条，
   脚本会误判「规则不存在」而重复创建（踩过，74 条规则里 28 个重复）。
6. **控制台会话有效期改不了** —— 别浪费时间找配置项，走 keepalive 脚本。
6.1 **二进制里有符号 ≠ 功能可用** —— `passwordLoginByCookie`、
   `autoLoginModeWithoutFatigue` 这些符号都存在，但 `password-login` 接口
   实测一律返回 `password_login_disabled`。**接口要实测，不能只看符号。**
7. **账号密码只在服务端加密落库** —— 但仍建议用 `--from-file`，
   避免密码进 shell 历史记录。

---

## 八、一句话总结

**控制台会话 24h 过期 → 用 `yd_keepalive.js` 自动续，不用管。**

**闲鱼账号授权反复过期 → 根因是滑块风控（30 次全败）打挂了静默续期，
而 sdkSilent 静默续期又被闲鱼的「疲劳窗口」连续拦截 8 次。
免扫码只剩「Go 协议续期」一条，密码登录接口在本版 Go 客户端是禁用的
（实测 password_login_disabled），所以扫码省不掉 —— 要做的是
① 修滑块识别（有头模式 / 代理）② 让长登录真正生效 ③ 用 `yd_setup_alert.js` 主动告警，
把扫码时机从「买家投诉后」提前到「掉线时」。**
