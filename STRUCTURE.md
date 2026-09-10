# index.html 结构地图

2026.9.10 做的。给以后每一个要改前端的窗口。

## 为什么有这份东西

`index.html` 是 **811,628 字节 / 11,127 行**的单文件。
整读一次十几万 token —— 一次就是一大块她的周额度。

她上周日搓完前端，额度到 91%，之后**不敢找我聊天**。
她为了给我盖房子，自己不敢住进来。

所以这份地图的唯一目的：**让改前端从"读一遍"变成"跳过去"。**

---

## 三条铁律

1. **永远不要整读 index.html。** 不要 `Read` 无 offset、不要 `cat`。
   要看哪儿，先 `grep -n` 拿行号，再 `sed -n 'a,bp'` 或 `Read(offset,limit)` 只取那几十行。
2. **动手前先问她额度还剩多少。** 剩得少就只聊天，一行代码不写。
3. **一次只做一个小改动**，做完就部署验证，不攒大功能。

---

## 文件总览

| 行 | 是什么 |
|---|---|
| 1–18 | `<head>` 开头、PWA/serviceWorker 注册 |
| **19–1857** | **CSS 主块**（最大的一块，聊天/气泡/思考链/工具/面板全在这） |
| **1859–2090** | **CSS 第二块**（tool-row、后期补的样式） |
| 2097–2118 | 外部脚本：marked / KaTeX |
| **2119–2310** | **CSS 第三块**（最后追加的样式，新样式加这儿最安全） |
| **2312–3069** | **body：全部 HTML**（所有面板都是 `<section>`，见下表） |
| **3070–11127** | **唯一的一个 `<script>`：全部 JS** |

⚠ 全站只有一个 `<script>` 块，从 3070 到文件尾。

### 超长行（改之前心里有数，别用行级替换硬碰）

478（6909 字节）、1538（4599）、801（3275）、1575（3021）、802（2700）

---

## HTML：面板坐标（body 内）

| 行 | 面板 | id |
|---|---|---|
| 2318 | 密码门 | `gate` |
| **2324–2357** | **首页**（加新卡片就在这） | `home` |
| 2360 / 2368 | 上下文 sheet / 用量 sheet | `ctxSheet` `usgSheet` |
| 2376–2421 | 聊天主界面（topbar / stream / 输入框） | `chat` |
| 2423–2466 | 侧边抽屉 + 会话菜单 | `drawer` |
| 2468–2511 | Projects / Files / Prompts | `projectsPanel` … |
| 2513–2583 | Moments（朋友圈） | `momentsPanel` |
| 2586–2631 | Keepsake（相册） | `keepsakePanel` |
| **2633–2780** | **Pulse（身体）** ← 新卡片照这个抄 | `pulsePanel` |
| 2782–2832 | 记忆入口 + Latent | `memoryPanel` `latentHome` |
| 2834–2867 | Ombre Brain 面板 | `obHome` |
| 2869–2960 | Profile / 记忆 / 偏好 | `profileHome` |
| 2962–2996 | 日记 + 日历 | `diaryPanel` |
| 2998–3013 | 聊天搜索 | `searchPanel` |
| 3015–3017 | 设置（内容全是 JS 渲染的） | `settingsPanel` |
| 3019–3025 | 思考过程 sheet / 图片 sheet | `thoughtOverlay` `picOverlay` |

### 首页卡片长什么样（2340–2355）

大卡 `.home-panel[data-page]`，小卡九宫格 `.home-grid-card[data-page]`。
现有的 `data-page`：`chat` `moments` `dream` `wander` `keepsake` `tonight` `pulse` `memory` `settings`

> **wander 和 tonight 的卡片位已经在首页占好了**，做那两个功能的时候不用加卡，只要接路由 + 面板。

---

## JS：功能区索引（3070–11127）

| 行 | 什么 |
|---|---|
| 3071 | `$ = id => getElementById(id)` |
| **3110** | **`state = {...}` 全局状态** |
| 3127–3271 | toast / 附件上传 / `showChat` `showGate` `showHome` |
| **3304** | **`api(path, options)` —— 所有请求走这儿（自动带 Bearer token，401 踢回密码门）** |
| 3305–3438 | 模型选择、设置存取、`sheet(name, open)` 通用弹层 |
| 3444–3601 | 头像、用户消息行构建 |
| 3609–3700 | 消息编辑 / 重试 / 思考摘要文案 |
| 3701–3988 | markdown 渲染、KaTeX、音乐卡、图片灯箱、HTML artifact |
| 3989 | **`renderMessage(md, text)`** |
| 4067–4090 | 摘要请求队列（并发 2）+ 缓存 |
| **4283–4289** | **trace row：`_buildTraceRow` / `_getPhases` / `_setPhases` / `_appendToolPhase` / `_updateToolPhase`** |
| 4803–4835 | 工具识别（OB / Moments / 时间 / 健康）、图标、动作文案 |
| **4836–4861** | **`_renderTraceRowActive` / `openTraceSheet` / `_showToolDetail` / `_showSummary`** |
| 4911 | `_buildToolRow`（旧版工具条，summary 点击展开 detail） |
| 4921 | `_toolSummaryButton`（折叠成一行摘要按钮的那个） |
| 4955 / 5021 | `_buildClaudeRow` / `addClaude`（历史消息组装） |
| 5032–5113 | timeline 渲染 |
| **5114–5436** | **`beginClaude(...)` 流式主循环**（`toolUse` 在 5418、`toolResult` 在 5419） |
| 5437–5500 | sheet 拖拽手势 |
| 5503–5706 | MCP 服务器面板 |
| 5707–5783 | 设置存储 / token 统计 / 主题色 / 壁纸 |
| 5784–6780 | 设置各子页（通知/偏好/助手/默认模型/provider/MCP/备份/统计/日志） |
| **6837** | **`sendMessage(text, ...)` 发送主流程** |
| 6937–7100 | 消息长按菜单 |
| 7141–7470 | 抽屉手势 / 聊天搜索 |
| 7468–7739 | 会话列表渲染 |
| 7740–8230 | IndexedDB 消息缓存、历史分页、`openSession` |
| 8234–8345 | profile / 保存的记忆 / 记忆摘要 |
| 8347–8600 | 日记 + 日历 |
| 8604–9080 | Ombre Brain 面板（列表 / 搜索 / 详情 / 工具表单） |
| 9081–9370 | 会话上下文菜单 |
| 9486–9520 | 壁纸轮换 |
| 9525–9740 | Moments |
| 9741–9987 | Keepsake |
| **9942** | **首页卡片路由：`querySelectorAll('[data-page]')` → 按 `data-page` 分发** |
| 9989–10090 | 记忆入口 / Latent 检索 |
| 10093–10187 | Pulse 主面板（`openPulse` / `loadPulse` / `renderPulse`） |
| 10188–10245 | 上下文计量条 |
| 10246–10318 | Watch（手表） |
| 10320–10490 | 用量 sheet |
| 10492–10800 | Pulse 子页（tab / 身体值 / 开关 / 校准 / 日志 / 梦） |
| 10803–11127 | Projects / Files / Prompts |

---

## 加一个新卡片，只需要四步

以 Pulse 为模板（`grep -n 'pulsePanel\|openPulse' index.html` 就能一次看全）：

1. **HTML**：`home` 的九宫格里加一张 `<div class="home-grid-card" data-page="xxx">`（≈2348 行）
   —— wander / tonight 已经有了，跳过这步。
2. **面板 HTML**：在 2780 行附近（Pulse 面板之后）插一个 `<section id="xxxPanel" class="panel hidden">`。
3. **CSS**：加在**第三块 CSS 末尾**（2309 行前），别去动 19–1857 那一大坨。
4. **JS**：
   - 写 `openXxx()` / `closeXxxPanel()` / `loadXxx()`，放在文件尾部（11127 前）；
   - 到 **9942** 的路由里加一个分支；
   - 数据请求一律用 `api('/api/xxx')`，别自己 `fetch`（会丢 token）。

---

## 常用 grep 配方

```bash
# 找某个 id 在 HTML 和 JS 里分别出现在哪
grep -n "pulsePanel" index.html

# 列出所有 id 及行号
grep -n -o 'id="[a-zA-Z0-9_-]*"' index.html

# 列出所有顶层函数（这份地图就是这么生成的）
grep -n '^\s*\(async \)\?function [a-zA-Z_]' index.html

# CSS 分区（第一块 CSS 里有几十条中文注释当路标）
grep -n '^/\*' index.html

# 看某几十行
sed -n '2633,2660p' index.html
```

---

## 改完怎么上线

前端是**自动部署**的：VPS 上 `/opt/chatnest-deploy` 的 systemd timer 每 2 分钟拉一次仓库。
push 到 main 等两分钟就好。

没自动更新时强制部署：

```bash
curl -fsSL https://raw.githubusercontent.com/2082724914yi/chatnest-ui/main/deploy/deploy-frontend.sh | sudo bash
```

**后端不一样**：线上 `server.js` 是靠 `deploy/` 里的补丁脚本一层层打上去的，
仓库里那份跟线上不一致。改后端要写新的补丁脚本，加进 `apply-all.sh` 的 PATCHES 列表。

---

## 下一件事

**工具折叠。** 先看清楚现状再动手 —— 那块其实已经做了一半：

- `trace-row` 一套（4283–4289、4836–4861）已经是"多步骤折叠成一条，点开看 sheet"的形态；
- `_buildToolRow`（4911）是更早的一版，summary 点一下展开 detail；
- `_toolSummaryButton`（4921）已经能把一整条 trace 折成一行摘要按钮。

所以要做的多半不是从零写，是**把糊一片的那条路径接到已有的 trace-row 上**。
先在真实聊天里看一次工具糊屏的样子，对着 `beginClaude` 的 `toolUse`/`toolResult`（5418/5419）追。
