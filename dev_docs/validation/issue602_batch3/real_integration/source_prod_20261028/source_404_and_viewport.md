# Source 404 不清指针 + 生产视口（1440 / 1024 / compact）实测（2026-10-28/29）

- **目标**：收口 `exit_checklist.md` 中剩余 3 项 `limited` 里可由生产实测收紧的两项——①「来源解析失败（404）只表示来源暂不可用，不清会话指针、不清本机草稿」（DESIGN §4.1/§7.2）；②`1024` / `compact` 生产视口。
- **环境**：生产 `http://192.168.5.82:7890`（host）→ iframe `http://192.168.5.82:7800/research`；后端 `5153e1c2` + `RDLENS_RESEARCH_SESSION_CONTRACT=true`；前端镜像 **`rdlens.32`**（`sha256:d564a1da…`，容器 `research-open-notebook-open_notebook-1` healthy）。
- **账号/项目**：`testuser@hifibio.com`（viewer user 1）；`usr_1_8976d1453a214062bfb82c45d3bea7a3`（DEMO-01）。
- **浏览器/驱动**：Chromium `chromium-1243/chrome-linux64/chrome`（headless）+ Playwright-core 1.64.1（`/tmp/pwtest/node_modules/playwright-core`）。
- **证据级别**：`real`（真实生产 + 真实 Chromium + 真实后端 404）。**注**：其中一条子断言（404 期间 UI 侧列表降级）用 Playwright 路由回放**与真实 404 逐字节相同**的响应（`404` + `{"detail":"Source not found"}` + 真实 CORS 头），单独标注为 `simulated-envelope`，不计入 `real`。
- **纪律**：未改产品代码；未启停任何服务/镜像；密码与 token 只以「是否存在 / 长度」记录，从不打印明文（本文件不含任何凭据）。

## 结论总表

| # | 项 | 结论 | 关键断言（实测值） | 截图 |
|---|---|---|---|---|
| 1 | 来源解析 404 → 不清 `display` 指针 | **pass（real）** | 6 个来源域请求全部 **404**；`display.sourceId` 仍为被解析失败的来源 id | `source_404_ui.png`、`source_404_leg2_reload.png` |
| 2 | 来源解析 404 → 不清本机草稿 | **pass（real）** | 草稿记录文本与写入值逐字相同；恢复指针后 `inputValue` **完全相同**；404 窗口内点 `Restore draft` 亦逐字恢复 | `source_404_leg2_before.png`、`source_404_restore_draft.png`、`source_404_after.png` |
| 3 | 来源解析 404 → 不出现「会话不存在」致命清空 | **pass（real）** | `会话已不存在` / `Session no longer exists` / `session not found` / `Chat session not found` 命中数 **0** | `source_404_ui.png` |
| 4 | 404 的用户可见语义 = 「来源暂不可用 + 本机稿保留」 | **pass（real 直调 + simulated 回放）** | 文案 `This source is temporarily unavailable. Your local draft is kept.` + `Retry` 按钮 | `source_404_ui.png` |
| 5 | 1440×900 视口 | **pass** | 见 ② 数值表 | `view_1440.png` / `source_panel_1440.png` |
| 6 | 1024×768 视口（`lg` 断点，桌面双栏） | **pass** | 见 ② 数值表 | `view_1024.png` / `source_panel_1024.png` |
| 7 | compact（1023×768，`<lg` 分栏折叠态） | **pass** | 见 ② 数值表 | `view_1023.png` / `source_panel_1023.png` |

**没有 fail 项。** 第 7 项 compact 有 1 条**观察项**（非缺陷，口径）见 O-1；② 另有 2 条新发现观察项 O-2 / O-3（不阻塞出口，建议另开 PR/issue）。

---

## ① 来源 404 不清指针、不清本机草稿

### 为什么这一轮可以做成 `real`（不再 limited）

上一轮（`README.md` 第 9 腿）判 `limited` 的理由是「生产不宜构造撤权/镜像缺失 fixture」。本轮改用**不需要撤权、不需要改服务端数据**的手段，分两条互相独立的腿：

**腿 A（real，改指针 → 真实 404）**：先在真实来源上建立 `display` 指针与草稿，再只改浏览器 `localStorage` 里指针的 `sourceId` 为「格式合法但不存在」的 `source:rdlens_doesnotexist_<rand>`（= 该来源在服务端已解析不到），然后 reload。页面仍走真实代码路径，**生产后端对来源域 6 个请求真实返回 404**；全程无 `page.route`。

**腿 B（real 主 + simulated 回放）**：保持**同一真实来源与会话**，把该来源的读请求用 Playwright 路由回放成 **与腿 A 真实 404 逐字节相同**的响应（status `404`、body `{"detail":"Source not found"}`、CORS 头取自该会话真实 200 响应的 `access-control-allow-origin: http://192.168.5.82:7800` / `vary: Origin`）。这条腿回答的是「**同一个来源**被解析失败时，屏幕上已有的草稿会不会被清」——腿 A 换了来源身份，回答不了这点。

两条腿的结论方向一致；所有「真实 404」数值来自腿 A，UI 降级文案那条在腿 B 标注 `simulated-envelope`。

### 实测步骤与数值

#### 腿 A：真实 404（改指针）

| 步骤 | 操作 | 实测结果 |
|---|---|---|
| A1 | 打开第一个来源 → `New session` → 输入草稿 | `POST …/sources/{real}/chat/sessions` **201**；composer 出现；`research-draft-save-state` = `All changes saved` |
| A2 | 记录指针 | `display` = `{"surface":"source","sourceId":"source:rdlens_563809cf…","ref":{…"sessionId":"sess_97853a1c…"}}`；`data-active-source-session` = `sess_97853a1c…`（global = `null`）；`inputValue` 与写入值一致 |
| A3 | 把 `display.sourceId` 改为 `source:rdlens_doesnotexist_s50yvlcb`，reload | 来源域请求状态码 = `[404, 404, 404, 404, 404, 404]`（`GET /sources/{bogus}`、`…/chat/sessions`、`…/chat/sessions/{sid}`、`…/editor-state` 等）；opening 抽屉的列表请求 = `[404, 404, 404]` |
| A4 | 断言指针 | `display.sourceId` **仍是 `source:rdlens_doesnotexist_s50yvlcb`**——未被清空、未被改写成 global（`pointerKept=true`） |
| A5 | 断言草稿记录 | 记录键仍在；`JSON.parse(...).text` = `RDLens #602 source-404 草稿 mvsb9b1a`，与写入值**逐字相同** |
| A6 | 断言无致命清空 | `['会话已不存在','Session no longer exists','session not found','Chat session not found']` 命中 **0** |
| A7 | 断言可见文案 | 抽屉 = `This source is temporarily unavailable. Your local draft is kept.` + `Retry`（`session-list-source-unavailable` / `session-list-retry`） |
| A8 | 恢复原指针 + reload | 列表 `[200×7]`；composer 出现；`inputValue` = `RDLens #602 source-404 草稿 mvsb9b1a`（`matchesWrittenDraft=true`）；`All changes saved`；`data-active-source-session` 复位为 `sess_97853a1c…` |

#### 腿 B：同身份 404（回放真实 envelope）

| 步骤 | 操作 | 实测结果 |
|---|---|---|
| B1 | 真实来源 + 新会话 + 草稿 | `All changes saved`；`inputValue` = `Leg2 本机稿保留校验 mvsbi8vp`；`display.sourceId` = `source:rdlens_563809cf…` |
| B2 | 该来源读路径 404 回放，开抽屉触发刷新 | `session-list-source-unavailable` 出现，文案 `This source is temporarily unavailable. Your local draft is kept.`，`Retry` 在 |
| B3 | 断言（404 展示期间） | `inputValue` **仍是** `Leg2 本机稿保留校验 mvsbi8vp`；`All changes saved`；`data-active-source-session` 不变；`display` 不变；致命文案 **0** |
| B4 | 在 404 下 reload | `data-active-source-session` 不变；`display` 不变；本机草稿记录存在且 `text` = `Leg2 本机稿保留校验 mvsbi8vp`；致命文案 **0**；composer 显示 `Saving is blocked — retry before sending` + `Retry` + **`Restore draft`** |
| B5 | 撤掉回放 + reload | `inputValue` = `Leg2 本机稿保留校验 mvsbi8vp`（`recoveredDraftMatches=true`）；`All changes saved` |

#### 腿 C：404 窗口内直接点 `Restore draft`

| 步骤 | 操作 | 实测结果 |
|---|---|---|
| C1 | 同 B 构造，404 下 reload | composer 值 `""`；`Saving is blocked — retry before sending`；`research-draft-restore` 可见（`restoreBtn=1`） |
| C2 | 点 `Restore draft` | `inputValue` = `Leg3 404 窗口内恢复校验 mvsbkh7k`（**逐字恢复**，`restoredMatches=true`）；保存仍 blocked（因来源仍 404，符合预期） |

### 判定与边界

- **pass**。DESIGN §4.1「只有 `session_not_found` 才清指针」与「来源解析失败 ≠ 会话不存在」两条语义在生产成立：
  - 前端分类 `use-research-sessions.ts::classifyListError`：`status===404 && surface==='source' → 'source_unavailable'`（只有 global 的 404 才是 `not_found`）；
  - 页面级清指针 effect 只在 `globalSessions.error === 'not_found'` 时执行，因此 source 404 不触发任何 `activate(surface, null)` / `setDisplayPointer({ref:null})`；
  - 草稿侧 `editor-machine.ts` 的 `loadInternal` 失败分支在 `state.draftText === loadBaselineText` 时调用 `recoverLocalDraft()`，即**失败时把本机分支读回**并刷新恢复候选，而不是删稿。
- **诚实边界（不夸大为更强结论）**：
  1. 「来源不可解析」在腿 A 是由**本机指针指向不存在来源 id** 构造、在腿 B 是由**相同 envelope 回放**构造，**都不是**真实撤权 / 对象存储删除 / mirror 缺失。前端看到的输入相同（404），但**未**验证撤权路径下的权限缓存与跨用户隔离。
  2. 404 窗口内 composer 初始值为空、需点 `Restore draft` 才回填；这是 DESIGN §3.5「恢复候选不自动覆盖当前分支」的**设计行为**（`restoreDraft` 只复制到当前 writer 分支，且需用户确认），**不是丢稿**——记录与文本全程在 `localStorage` 中，A5/B4/C2 三处均有逐字比对。
  3. 腿 A 的 404 期间列表降级文案本身来自腿 B 的同路径（腿 A 未在 404 下开抽屉断言文案），故第 4 项标注 `real + simulated-envelope`。
  4. 「切 source 不 cancel」不在本文件范围，沿用 `README.md` 第 8 腿（0 个 `DELETE`/`cancel`）。
  5. 未覆盖：404 期间发送（本就应被保存门禁阻断，观测到 `Saving is blocked`，未做发送尝试）。

---

## ② 生产视口：1440×900 / 1024×768 / compact 1023×768

### 断言口径

- 只测**当前可见实例**（`[data-testid="X"]:visible`）：source 与 global 两个 composer 按设计**同时挂载**（切换保活），直接按 `data-testid` 取首个会命中 0×0 的隐藏兄弟节点，产生假阴性。`mountedCount` 一并记录以便区分。
- `clipped`/`insideViewport` = `boundingBox()` 完整落在 iframe 视口内（`x≥-0.5 && y≥-0.5 && right≤innerW+0.5 && bottom≤innerH+0.5`）。
- 横向溢出 = `document.documentElement.scrollWidth - clientWidth`，要求 ≤ 2。
- 每个视口独立 browser context；进入研究页后等 iframe + 14s，再分别取 A / A2 / B 三个状态。

### 数值表（一次运行，3 个视口 × 3 个状态）

**host 页**：`scrollWidth == clientWidth == innerWidth`（1440/1024/1023 三档均成立）；iframe 顶部偏移 `y=53`，高度 = `innerHeight-53`（1440×900 → iframe `1440×847`；1024×768、1023×768 → `1024×715` / `1023×715`）。

| 视口 | 状态 | `workspace-tabs-row` | `session-switcher-global` | `research-draft-composer` | `chat-send` | 横向溢出 |
|---|---|---|---|---|---|---|
| **1440×900** | A 默认（Evidence Search） | 可见 `1/1`，`(510.2,97) 929.8×44`，未裁切 | 可见 `1/1`，`(16,57) 238.5×30` | 未渲染（该 tab 无 composer，符合预期） | 未渲染 | `1440-1440 = 0` |
| 1440×900 | A2 全局 Chat + New session + 输入 | 可见 `1/1`，未裁切 | 可见 `1/1`，`238.5×30` | 可见 `1/1`，`(522.2,738) 905.8×97` | 可见 `1/1`，`(1354.3,795) 57.7×32`，`disabled=false` | `0` |
| 1440×900 | B Source 面板 + 新会话 + 输入 | `0`（**已挂载被隐藏**，`hidden` 祖先，source focus 设计） | 可见 `1/1`，`181.6×30` | 可见 `1/2`（另一为隐藏的全局 composer），`(808.6,738) 619.4×97` | 可见 `1/2`，`(1354.3,795) 57.7×32`，`disabled=false`；`All changes saved` | `0` |
| **1024×768** | A 默认 | 可见 `1/1`，`(364.6,97) 659.4×44` | 可见 `1/1`，`238.5×30` | 未渲染 | 未渲染 | `1024-1024 = 0` |
| 1024×768 | A2 全局 Chat + New session + 输入 | 可见 `1/1`，未裁切 | 可见 `1/1`，`238.5×30` | 可见 `1/1`，`(376.6,606) 635.4×97` | 可见 `1/1`，`(938.3,663) 57.7×32`，`disabled=false` | `0` |
| 1024×768 | B Source 面板 + 新会话 + 输入 | `0`（已挂载被隐藏，同上） | 可见 `1/1`，`177.2×30` | 可见 `1/2`，`(579.8,606) 432.2×97` | 可见 `1/2`，`(938.3,663) 57.7×32`，`disabled=false`；`All changes saved` | `0` |
| **1023×768（compact）** | A 默认（**折叠为 pane tab**：`Research artifacts` / `Workspace`） | 可见 `1/1`，`(0,138) 1023×44` | 可见 `1/1`，`238.5×30` | 未渲染 | 未渲染 | `1023-1023 = 0` |
| 1023×768 | A2 全局 Chat + New session + 输入 | 可见 `1/1`，`1023×44` | 可见 `1/1`，`238.5×30` | 可见 `1/1`，`(12,606) 999×97` | 可见 `1/1`，`(937.3,663) 57.7×32`，`disabled=false` | `0` |
| 1023×768 | B Source 面板（pane tab 切 `Chat`）+ 新会话 + 输入 | `0`（已挂载被隐藏，同上） | 可见 `1/1`，`182.6×30` | 可见 `1/2`，`(12,606) 999×97` | 可见 `1/2`，`(937.3,663) 57.7×32`，`disabled=false`；`All changes saved` | `0` |

9 组 `document.documentElement.scrollWidth - clientWidth` 全部为 **0**（门限 ≤2 通过）。最贴近右边缘的 `chat-send` 是 1024 的 `right=995`（视口 1024）与 1023 的 `right=995`（视口 1023），均完整在视口内、无裁切。

### 判定

- **pass**：任务要求的 4 个控件在 3 个视口 × 2 个状态（全局 chat / source 面板）下均**可见且完整落在视口内**；`chat-send` 在草稿非空后 `disabled=false` 且 `boundingBox` 完整；无横向滚动溢出。
- **`workspace-tabs-row` 在 source 面板态为 0×0 是设计行为，不是缺陷**：`page.tsx` 的 `<div className="h-full" hidden={sourceMode}>` 在 Source focus 时整体隐藏全局工作区（保活、不卸载），tabs row 属于其中。任务原句「打开 source 面板后断言 `workspace-tabs-row` 可见」在 Source focus 语义下不成立，本文件按**实际归属**记录为「A/A2 可见、B 隐藏（设计）」，不伪造成可见。

### 观察项

**O-1（口径，非缺陷）**：`1024×768` 恰好命中 Tailwind `lg`（`useIsDesktop` = `min-width:1024px`），所以 **1024 是桌面双栏、不是 compact**；compact（折叠 pane tab）从 `1023px` 起。本文件因此补测 `1023×768`，避免「1024 = compact」的口径错误——这也正是上一轮把 compact 判为 `limited` 的根因之一。

**O-2（本轮新发现，未修，建议另开 PR）**：全局 Chat 的**会话范围条**在 1023/1024 下渲染出**未插值的 i18n 模板**：`SELECTED: {{SOURCES}} SOURCES, {{NOTES}} NOTES`。位置 `frontend/src/components/research/ResearchSessionScopeBar.tsx:251`：

```tsx
{t('research.layout.scope.selectedSummary', { count: noteIds.length })}
```

而 key `research.layout.scope.selectedSummary` 需要的是 `sources` 与 `notes` 两个参数（`"Selected: {{sources}} sources, {{notes}} notes"`），只传 `count` 时其余占位符被原样保留。1440 下该区域不渲染这条串（pane 布局不同），因此是**窄视口才暴露的文案缺陷**。影响：仅文案，不影响门禁与发送（同视口下草稿非空后 `chat-send` 仍 `disabled=false`）。截图：`view_1023.png`、`view_1024.png`。

**O-3（首屏竞态，建议另开 issue）**：首次进入 `/research` 后**直接**切到全局 `Research Chat`（不点 `New session`）时，`research-draft-save-state` 停在 `Loading research workspace…`、门禁提示为 `An unexpected error occurred. Retry, or contact an administrator if it persists.`，此时草稿可输入但 `chat-send` 恒 `disabled=true`、按 Enter 零请求。**6/6 次独立探针稳定复现**（`goto` 与 SPA 内跳转都复现）；同轮均观测到 `POST …/bootstrap` 出现 `net::ERR_ABORTED`（随后有一次 200，`bootstrap=200` 本身成功）。点一次 `New session` 即恢复（`All changes saved`；输入后 `disabled=false`；`POST …/chat/sessions` **201**）。本文件所有视口断言都在 **New session 之后**取值，故不影响结论；该竞态本身未修、未深挖。

---

## 复现

脚本（临时，不随证据提交）：`/tmp/final3/notfound_final.cjs`（腿 A）、`/tmp/final3/leg2.cjs`（腿 B）、`/tmp/final3/leg3.cjs`（腿 C）、`/tmp/final3/final2.cjs`（视口），原始 JSON 同名 `.json`。

固定前置（每个运行）：

```text
登录 testuser@hifibio.com（密码仅从 /tmp/pr15/prod_env.sh 的 $PROD_PW 读取，不打印）
→ goto http://192.168.5.82:7890/#/research/usr_1_8976d1453a214062bfb82c45d3bea7a3
→ 等 iframe http://192.168.5.82:7800/research 出现 + 14s
→ [1440/1024/1023] 三个独立 browser context，viewport 对应设置
```

腿 A 的「来源不可解析」构造（唯一非只读动作，只改浏览器 localStorage）：

```js
const k = 'rdlens.research.session.v1.display.1.usr_1_8976d1453a214062bfb82c45d3bea7a3'
const v = JSON.parse(localStorage.getItem(k))
v.sourceId = 'source:rdlens_doesnotexist_' + rand   // 格式合法、服务端不存在
if (v.ref) v.ref.sourceId = v.sourceId
localStorage.setItem(k, JSON.stringify(v))
// 然后 location.reload()：后续来源域请求全部真实打到生产后端并真实返回 404
```

腿 B / C 的 404 回放只覆盖 `GET /sources/<同真实来源>/…` 的读路径，响应体与腿 A 真实 404 逐字节相同、CORS 头抄自该会话真实 200 响应；**不触碰**其它来源、其它 surface 或写入路径。

## 文件

- 本文件：`dev_docs/validation/issue602_batch3/real_integration/source_prod_20261028/source_404_and_viewport.md`
- 截图（同目录）：`view_1440.png`、`view_1024.png`、`view_1023.png`、`source_panel_1440.png`、`source_panel_1024.png`、`source_panel_1023.png`、`source_404_before.png`、`source_404_ui.png`、`source_404_after.png`、`source_404_leg2_before.png`、`source_404_leg2_drawer.png`、`source_404_leg2_reload.png`、`source_404_leg2_after.png`、`source_404_restore_draft.png`
- 姊妹证据：同目录 `README.md`（Source 主链 8 腿 + 2 个 P0）
