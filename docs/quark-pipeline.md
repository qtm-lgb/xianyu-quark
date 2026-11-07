# 夸克网盘 → 闲鱼 批量上架流水线

把夸克网盘共享目录里的每个文件夹（= 一门课程）变成闲鱼商品：
**建永久分享链接 → 生成文案与主图 → 上架 → 配自动发货与客服**。

---

## 一、整体架构

```
夸克网盘 (drive-pc.quark.cn)
   │  1) 读取共享目录 → 67 个课程文件夹（fid）
   │  2) 合规分级 → 只留可上架的
   │  3) 为每个文件夹建永久分享（expired_type=1）
   ▼
闲鱼 (goofish.com) —— src/publish_xianyu.js
   │  4) 填表：主图 / 描述(首行=标题) / 分类 / 价格 / 运费
   │  5) 发布，回填 itemId
   ▼
Ydisks 助手 (127.0.0.1:59188) —— tools/yd_setup_courses.js
      6) 建卡密（网盘链接+提取码）+ 付款自动发货规则
      7) 关键词客服规则 + 默认回复兜底
```

---

## 二、脚本清单

| 脚本 | 作用 |
|---|---|
| `tools/quark_login.js` | 扫码登录夸克，登录态存 `~/.workbuddy/quark-profile` |
| `tools/quark_api.js` | 夸克 API 封装（`openQuark` / `qApi` / `listDir`） |
| `tools/quark_list_all.js` | 列出共享目录全部条目 |
| `tools/quark_scan_courses.js` | 逐个扫文件夹的文件数与大小 |
| `tools/quark_compliance.js` | 合规分级（safe / gray / blocked） |
| `tools/quark_create_share.js` | 批量建永久分享（复用已有的 + 新建） |
| `tools/quark_fix_permanent.js` | 把限时分享重建为永久 |
| `tools/quark_build_listings.js` | 生成商品文案与主图 |
| `tools/yd_setup_courses.js` | Ydisks 建卡密 + 发货规则 + 客服规则 |
| `tools/quark_pipeline.js` | 一键串联全流程 |
| `tools/fetch_item_ids.js` | 从「我发布的」抓 itemId 回填 |

---

## 三、夸克网盘 API（实测）

所有接口都在 `https://drive-pc.quark.cn`，**必须在已登录页面的上下文里调**
（`page.evaluate` 里 `fetch` + `credentials:'include'`），这样自动带 cookie。

| 用途 | 接口 |
|---|---|
| 列目录 | `GET /1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=<fid>&_page=1&_size=200&_fetch_total=1&_sort=file_type:asc,updated_at:desc` |
| 我的分享列表 | `GET /1/clouddrive/share/mypage/detail?...&_page=1&_size=200&_filter=all&_share_type=0,1` |
| **创建分享** | `POST /1/clouddrive/share?pr=ucpro&fr=pc` body: `{fid_list:[fid], title, url_type:1, expired_type:1, password:''}` |
| 查异步任务 | `GET /1/clouddrive/task?pr=ucpro&fr=pc&task_id=<id>` |

### 关键点：创建分享是异步的

`POST /1/clouddrive/share` **不直接返回链接**，只返回 `task_id`：

```json
{ "data": { "task_id": "615efd3aff9d47c1a5f62afcf7f5060a", "task_sync": false } }
```

要轮询 `GET /1/clouddrive/task?task_id=xxx`，等 `status===2`（完成），
再从「我的分享」列表里按 `share_id` 或 `title` 找到对应的 `pwd_id`，
拼成 `https://pan.quark.cn/s/<pwd_id>`。

### 参数含义

| 参数 | 值 | 含义 |
|---|---|---|
| `expired_type` | `1` | **永久有效**（`3` = 限时，要避开） |
| `url_type` | `1` | 通过链接分享 |
| `password` | `''` | 不设提取码（设了要另外调 `share/password/update`） |

### 判断链接是否会被抢光

夸克分享可开启「1 人转存即失效」。检查分享页 HTML 里的
`window.globalConfig.share_config`，若没有 `saveLimit` 类配置即未开启。
批量给不同买家发同一个链接前**务必确认这一点**。

---

## 四、闲鱼发布页的两个坑

### 坑 1：没有独立标题栏

发布页只有一个「宝贝描述」富文本框（`[contenteditable="true"]`），
**标题由描述首行智能识别**。所以第一行必须放标题，正文紧随其后。

### 坑 2：分类是懒渲染的，且不选会被拦截

分类控件要**填完标题后**才出现（Ant Design Select）。
不选分类时点发布，闲鱼提示「网页版暂不支持发布此分类」并拦截。

```js
// src/publish_xianyu.js 的 selectCategory()
const sel = page.locator('.ant-select-selector').first();
await sel.click({ force: true });
await sleep(1800);
const opt = page.locator('.ant-select-item-option[title="电子资料"]').first();
await opt.click({ force: true });
```

可选分类：其他服务 / **电子资料** / 其他技能服务 / AI数据标注训练 /
论文检测与查询服务 / 其他在线咨询服务 / AI办公提效工具 / 笔记资料 /
帮填问卷 / 软件系统安装指导

「电子资料」最适合虚拟资料商品。

### 发布成功的判定

有 4 种形态，**任一命中即算成功**：

| 判据 | 表现 |
|---|---|
| 横幅 | 顶部出现「闲鱼发布成功物品及并推荐！」 |
| URL | 跳转到 `/item?id=xxx` |
| 文案 | 出现「已发布 / 审核通过 / 立即可见」 |
| 管理态 | 按钮从「发布」变成「下架 / 删除」 |

> 只判「发布成功 / 审核通过立即可见」会漏判 —— 页面顶部横幅才是最早、最可靠的信号。

---

## 五、合规分级

`tools/quark_compliance.js` 把课程分三级：

| 级别 | 处理 | 判定依据 |
|---|---|---|
| `safe` | 上架 | AI/技能/教程/副业玩法类；正经工具类（自动发货、违规检测、文案提取） |
| `gray` | 跳过 | 搬运、批量剪辑、防限流、扩容 |
| `blocked` | 跳过 | 破解/解锁/激活、付费课程、暴力破解、伪造印章、票务 |

红线关键词（部分）：

```
暴力破解 / 破解工具 / 实名释放 / 电子印章 / 付费课程 / 正价课程 /
绝版.*书 / 影视解说搬运 / 破解版 / VIP破解 / 会员版 / 解锁版 / 解锁高级版 /
激活 / 电影票
```

分级结果会打印完整清单，**上架前务必人工过一遍**。
平台审核的是「商品标题 + 描述 + 主图」，标题里出现「破解版」「官方正版」
这类词基本必被驳回。

---

## 六、完整流程

```bash
# 1. 登录夸克（扫码，登录态存 ~/.workbuddy/quark-profile）
node tools/quark_login.js

# 2. 读目录 + 扫文件数
node tools/quark_list_all.js
node tools/quark_scan_courses.js

# 3. 看合规分级，确认要上哪些
node tools/quark_compliance.js

# 4. 建永久分享（自动复用已有的）
node tools/quark_create_share.js --batch
node tools/quark_fix_permanent.js   # 把限时的重建为永久

# 5. 生成文案与主图
node tools/quark_build_listings.js

# 6. 上架（每条间隔 12 秒，itemId 自动回填）
node src/publish_xianyu.js

# 7. 配卡密 + 自动发货规则 + 客服规则
node tools/yd_setup_courses.js
```

一键：`node tools/quark_pipeline.js`

---

## 七、批量上架的节奏与风险

- 发布间隔 **12 秒**（`src/publish_xianyu.js` 的 `makeThrottle(12000)`）
- 单批建议 **不超过 30 条**，分批发更安全
- 一天内大量发布同类虚拟资料容易触发「批量违规商品」审核，
  严重会连带影响账号已有商品
- 每条发布后会自动回填 `itemId` 到 `data/listings.json`，
  这是配自动发货规则的必要数据

---

## 八、排查手册

| 现象 | 原因与处理 |
|---|---|
| 建分享返回 task_id 没链接 | 正常，是异步任务，轮询 `/1/clouddrive/task` |
| 分享链接显示失效 | `expired_type` 不是 1，用 `quark_fix_permanent.js` 重建 |
| 列表页读不到文件 | DOM 是虚拟列表读不到，改用 API（`quark_api.js`） |
| 页面显示登录墙 | 跑 `quark_login.js` 重新扫码；profile 在 `~/.workbuddy/quark-profile` |
| 闲鱼点发布没反应 | 分类没选，见上文「坑 2」 |
| 闲鱼提示"暂不支持发布此分类" | 同上，或该分类只能 APP 发布 |
| 链接发出去被别人转存后失效 | 该分享开了「1 人转存即失效」，需换链接或改分享设置 |
| itemId 没回填 | 发布成功检测漏判，用 `tools/fetch_item_ids.js` 补抓 |
