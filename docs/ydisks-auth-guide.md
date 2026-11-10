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
闲鱼服务端对同一账号的 sdkSilent 静默续期有「疲劳窗口」限制
        ↓
某次续期因滑块风控失败 → 疲劳窗口卡住 → 后续全部跳过
        ↓
账号是 qr_scan + username/password 为空 → 只有这一条路
        ↓
只能人工扫码
```

**证据 1 —— 滑块风控全败**（`risk_control_logs` 表）：

| 日期 | 次数 | 结果 |
|---|---|---|
| 09-09 ~ 09-25 | 9 | 全部 failed |
| 10-07 ~ 10-19 | 6 | 全部 failed |
| 10-20 ~ 10-28 | 15 | 全部 failed |

累计 **30 次，失败 30 次**，近 30 天 18 次。
典型错误：`Playwright 主引擎失败: 滑块验证 3 次均失败`。

**证据 2 —— 账号没有密码通路**：

```
cookies 表: id=2419336374  username=''  password=''  login_method='qr_scan'
```

**证据 3 —— 官方留了后门但没启用**。二进制符号表里：

```
xianyu-go/internal/xianyu/renew.Service.callAutoLogin
xianyu-go/internal/xianyu/renew.autoLoginModeWithoutFatigue   ← 无疲劳的自动登录模式
xianyu-go/internal/xianyu/renew.Service.renewAPIFirst
internal/.../passwordLoginByCookie
internal/.../passwordRenewalResult
```

`autoLoginModeWithoutFatigue` 这个名字直接说明：**填了账号密码，续期才会走
不受疲劳窗口限制的通路**。而日志里 `password_login` 相关记录是**零** ——
这条通路从未启用过。

### 处置：开通密码续期通路

```bash
# 方式 A：命令行（密码只发给本机 127.0.0.1，不落盘）
node tools/yd_setup_password.js --username <闲鱼账号> --password <密码>

# 方式 B：从文件读（省得密码进 shell 历史）
# ~/.workbuddy/yd_xianyu_pwd.txt  内容: {"username":"xxx","password":"yyy"}
node tools/yd_setup_password.js --from-file

# 查看状态
node tools/yd_setup_password.js --status

# 清除（退回扫码）
node tools/yd_setup_password.js --clear
```

闲鱼账号 = 手机号或淘宝账号；密码 = 闲鱼/淘宝登录密码。
密码由 Ydisks 服务端用 AES 加密后存库（密钥在 `data-key`），**明文不落盘**。

配好后重启账号（面板点「重启账号」），助手就会用新凭据建立密码续期通路。

> 面板路径：账号列表 → 编辑 → 「登录信息」区域 → 「登录密码」→ 「用于自动登录」

---

## 四、闲鱼长登录：已经开着，别重复折腾

`GET /api/v1/accounts/{cid}/long-login` →

```json
{ "can_open_long_login": true, "enabled": true }
```

**已经开启了**，而且是闲鱼官方能力（二进制里 `longLoginSetBusinessOK`、
`newLongLoginCookieState`）。它的作用是让闲鱼侧记住你的设备，
**不能替代**密码续期通路 —— 两者解决的是不同环节。

---

## 五、加一层主动告警（别等买家来投诉）

之前 11-05 有买家下单没人发货、11-07 有 3 个商品被判违规，
两次都是「等买家反馈」才发现的被动局面。

```bash
# 飞书机器人（推荐）
node tools/yd_setup_alert.js --feishu https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx

# 钉钉机器人
node tools/yd_setup_alert.js --dingtalk https://oapi.dingtalk.com/robot/send?access_token=xxx

# Bark（iOS）
node tools/yd_setup_alert.js --bark https://api.day.app/你的key

node tools/yd_setup_alert.js --list     # 查看现有渠道
node tools/yd_setup_alert.js --unbind   # 解绑
```

脚本会先测 webhook 通不通再建渠道，然后绑到账号并发测试消息。

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
7. **账号密码只在服务端加密落库** —— 但仍建议用 `--from-file`，
   避免密码进 shell 历史记录。

---

## 八、一句话总结

**控制台会话 24h 过期 → 用 `yd_keepalive.js` 自动续，不用管。**

**闲鱼账号授权反复过期 → 根因是没填账号密码，只有 sdkSilent 一条路且被疲劳窗口卡死。
填上密码（`yd_setup_password.js`）就会多一条不受疲劳限制的续期通路，
配合 `yd_setup_alert.js` 主动告警，就能彻底摆脱「总是要扫码」。**
