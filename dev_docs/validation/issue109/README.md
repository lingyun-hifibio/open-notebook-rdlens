> **PR 证据副本说明**：本目录随 PR 提交 fork #109 的 Before/After 截图、采集说明与关键原始日志。**gateway 请求日志以 `.txt` 提交**（仓库 `.gitignore` 忽略 `*.log`，故按内容扩展名改名；与本地采集工作区内容逐字节相同）；`logs/capture-*-summary.json` 含本机绝对路径（`/home/lchen/...`、`/tmp/...`，非凭证/非私有内容），仅用于本次采集溯源。采集 harness（fixtures / gateway mock / host / capture）、worktrees 与完整运行日志保留在本地采集工作区 `visual-evidence/`（不随 PR 提交，避免把 harness/依赖带入产品树）；复现步骤、方法与限制见下方 README 原文。截图 SHA-256 清单见 `logs/sha256-manifest.txt`（本目录 16/16 已逐项核验一致）。

# Fork #109 视觉证据：shared 模式 Research 本地模型禁用提示（Before / After）

- **任务**：fork issue #109（`lingyun-hifibio/open-notebook-rdlens`）——shared 模式（GPU 共用）下 Research 的本地模型生成入口禁用，并在 Search / Chat / Compare / Insights 四个既有提示通道渲染**后端下发**的 `capabilities.local_model.message`；exclusive 模式零回归。
- **Before revision（PR base）**：fork `39b456f5f187525289168384ce4a57c224e1c944`（= `origin/main`；独立 detached worktree `visual-evidence/worktrees/before`）。
- **After revision（PR head）**：fork `0fed575cb08ef3d0e008035fbd908ae5d6c96bf2`（分支 `agent/fork-shared-gpu-cd906bb85363`；round-1 评审修复后的 head；独立 detached worktree `visual-evidence/worktrees/after`）。
- **视口**：1440×900（主）与 1024×768（Search 主对覆盖）；**主题 light**（host 页在认证后经 postMessage 下发 `theme=light`，每次采集使用全新浏览器上下文，无持久化主题）。
- **场景**：同一合成项目 `p1` / owner `u1`、同一资料范围（fixture 预置 selected = `src_1`,`src_2`）、同一模型 fixture（本地模型 `m-local-qwen`, `data_egress=false`）与同一查询文本。Before 与 After 使用**完全相同的 gateway-mock fixture 与 mock 版本**，同一台机器、同一 headless Chromium、`deviceScaleFactor=1`、`--force-color-profile=srgb`；唯一预期差异是本功能引入的提示与禁用态。

## 采集方法（真实应用渲染 + 合成网络）

真实 Next.js 应用（本仓库 `frontend/`，`next dev --webpack`，embedded 模式）运行在合成 host 页的 iframe 中；host 页执行文档化的 `research-v0` ready→token 握手，下发**合成的、未签名的** Research Token（claims `sub=1`/`project_id=p1`/`role=owner`/`scopes=[...]`；签名校验属真实 Gateway，本次未涉及）。截图由 headless Chromium（`chromium-1243`，Playwright-core 1.62.1）截取。

Research Gateway 由本地合成 mock server（`harness/gateway_mock.js`）提供**确定性模拟响应**：`/models`、`/execution-preferences`、`/external-egress-consent`、`/sources`、`/notes`、`/jobs`、`/insights`、`/transformations`、`/chat/sessions`（列表 + 创建 + editor-state）、`/context-preview`、`/search`。**所有网络响应均为模拟**：

- 无真实后端、PostgreSQL、SurrealDB、模型调用或外部外发；无凭据、无私有数据；fixtures 中正文均带 `[synthetic]` 标记，模型名显示为 `Local Qwen (synthetic)`。
- 模式由文件切换：`/tmp/issue109-local-model-mode` = `shared` | `exclusive`。`shared` 下 `/models` 返回
  `capabilities.local_model = {available:false, reason:"shared_gpu", message:"当前 GPU 正与其他任务共用，可用显存不足以支撑 Research 使用本地模型，请改用外部 AI 模型。"}`；
  `exclusive` 下返回 `{available:true, reason:null, message:null}`。同一份响应里 `preferred_model_id` 恒为本地模型 `m-local-qwen`。
- `POST /search`：`shared` 下返回 **409** `detail = {code:"local_model_unavailable_shared_gpu", message:"<同上>"}`（用于 Before 点击证据）；`exclusive` 下返回 200 合成检索结果。
- **每个请求**（含状态、方法、路径、模式）同步追加到本地采集工作区的 `logs/gateway-requests.log`；采集脚本在每个场景边界写入 `kind:"mark"` 行，因此「After shared 无 POST /search」可按窗口切片逐字节核对（本 PR 提交的 per-phase `.txt` 副本见下）。
- Chat 场景需要可达的 composer：mock 提供一次性的全局会话创建（`POST /chat/sessions`）与 `PUT/GET .../editor-state` 合成响应（草稿保存成功）；Before/After 使用同一 mock 与同一流程，差异只在 blocked hint 与 send 禁用。

**harness-only 本地改动（不进入 PR diff）**：Next.js 只对静态成员访问的 `NEXT_PUBLIC_*` 做构建期内联，而 `frontend/src/lib/embedded/config.ts` 使用 `process.env[常量]` 动态访问，浏览器端读不到 dev server 环境变量。采集时在两个 worktree 中**临时**把三处访问改为静态成员写法（`frontend/src/lib/embedded/config.ts`，各 3 行、uncommitted，仅本地）：该改动不改变任何产品语义；After worktree 仍在 `0fed575` 之上只多了这 3 行本地 hack（`git status` 仅 `M config.ts`），Before worktree 同理。复现时需重新应用（见下）。Dev server 另需 `NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1`。

## 场景、断言与逐图标签（16 张）

所有断言由 `harness/capture.js` 在浏览器内实时校验，并写入 `logs/capture-<phase>-summary.json`。**8 个场景 × 2 phase 全部 PASS（0 fail / 0 not-run）。**

| # | 场景 | Before（39b456f）| After（0fed575）| 文件 |
|---|---|---|---|---|
| A | shared + Search 面板（1440×900）| 无 `model-blocked-hint`；`search-run` **enabled** | hint 文本**逐字等于**后端 `capabilities.local_model.message`；`search-run` **disabled** | `before_shared_search_1440.png` / `after_shared_search_1440.png` |
| A | 同上（1024×768）| 同上 | 同上 | `before_shared_search_1024.png` / `after_shared_search_1024.png` |
| B | shared + 点击 Search（1440）| 点击 → `POST /search` **409** → 通用错误 Alert（`Something went wrong…` / `Request failed with status code 409` / 重试提示），**后端 message 不出现** | 点击 disabled 控件 → Playwright 拒绝/超时，`dispatchEvent('click')` 亦无效；**0 次 POST /search**、无错误 Alert | `before_shared_search_click_error_1440.png` / `after_shared_search_click_noop_1440.png` |
| C | exclusive + Search（1440×900）| 无 hint；`search-run` enabled | 无 hint；`search-run` enabled；与 Before **逐字节相同**（SHA-256 相等）| `before_exclusive_search_1440.png` / `after_exclusive_search_1440.png` |
| C | 同上（1024×768）| 同上 | 同上；**逐字节相同** | `before_exclusive_search_1024.png` / `after_exclusive_search_1024.png` |
| D | shared + Chat 面板（1440）| 无 `chat-model-blocked-hint`；`chat-send` **enabled**（草稿 `All changes saved`）| `chat-model-blocked-hint` 显示**同一条**后端 message；`chat-send` **disabled** | `before_shared_chat_1440.png` / `after_shared_chat_1440.png` |
| E | shared + Compare 面板（1440）| 无 `compare-model-blocked-hint`；`compare-create` **enabled**（scope 预置 selected，2/30）| `compare-model-blocked-hint` Alert 显示**同一条**后端 message；`compare-create` **disabled** | `before_shared_compare_1440.png` / `after_shared_compare_1440.png` |
| F | shared + Insights AI 表单（1440）| 选 AI 类型后**无** `insight-model-blocked`；AI Save 可用 | `insight-model-blocked` 显示**同一条**后端 message；AI Save **disabled**（`insight-submit` 既有 `!canExecute` 门禁）| `before_shared_insights_ai_1440.png` / `after_shared_insights_ai_1440.png` |

逐图说明：

- `before_shared_search_1440.png`：shared 下基线的 Evidence Search 面板——模型 pill 显示 `Local Qwen (synthetic) · Local`，Context preview 正常，**无提示行**，底部 Search 按钮为可点击主色。
- `before_shared_search_1024.png`：同场景 1024×768；标签栏在 1024 下出现既有横向滚动（`Custom` 被截断），与 After 完全一致，非本单引入。
- `before_shared_search_click_error_1440.png`：Before 点击 Search 后：`POST /search` 409，面板只显示通用错误（稳定码 `local_model_unavailable_shared_gpu` 未收录于错误文案映射 → generic；后端 message 被丢弃）——本单要修的体验缺口。
- `before_exclusive_search_1440.png` / `before_exclusive_search_1024.png`：exclusive 下基线；与 shared 基线渲染相同（基线代码不读 `capabilities.local_model`）。
- `before_shared_chat_1440.png`：shared 下 Chat 面板；已创建合成会话并输入草稿，Save 状态 `All changes saved`，Send 可点，无 hint。
- `before_shared_compare_1440.png`：shared 下 Compare 面板；selected=2 份文档，`Start compare` 可点，无 hint。
- `before_shared_insights_ai_1440.png`：shared 下 Insights 新建表单，Type=AI；无 `insight-model-blocked`，Save 为主色可用。
- `after_shared_search_1440.png`：After——Context 选择器下方出现 hint，文案与后端 message **逐字一致**；Search 按钮转为 disabled（浅色）。
- `after_shared_search_1024.png`：同场景 1024×768；hint 换行但文本一致，Search disabled。
- `after_shared_search_click_noop_1440.png`：After 对 disabled Search 的点击尝试之后：仍无错误 Alert、按钮仍 disabled、输入框静置（仅有焦点环变化）；mock 日志该窗口 0 次 `POST /search`。
- `after_exclusive_search_1440.png` / `after_exclusive_search_1024.png`：exclusive 下 After；无 hint、Search enabled；**与 Before 同名文件 SHA-256 完全相同**（逐字节零回归）。
- `after_shared_chat_1440.png`：After Chat——`chat-model-blocked-hint` 在输入区上方显示后端 message；composer 底部同时以既有 gate-reason 行（橙色）显示**同一字符串**（两处均来自同一 `blockedHint` 映射，不是第二份硬编码文案；该双呈现为既有 composer 门禁的渲染位置叠加，见「观察」）；Send disabled。
- `after_shared_compare_1440.png`：After Compare——Alert 框显示后端 message；`Start compare` disabled。
- `after_shared_insights_ai_1440.png`：After Insights——Type 下方 `insight-model-blocked` 显示后端 message（两行换行），AI Save disabled；类型可切回 Manual（Manual 分支不显示该 hint、Save 不受影响——设计上 AI 专属门禁）。

## SHA-256（按文件名排序；完整清单见 `logs/sha256-manifest.txt`）

```text
8b0fffde574fde08635b2ac21ab7f051ebfd255923c31f208cfdf5e14616ebb6  after_exclusive_search_1024.png
c9cb0e348af73fd2a9a79dd29c47a19c248d1fb2b50e686d0d98c43d689b53a4  after_exclusive_search_1440.png
33aff77f6fe9c8d811ecb96508b9cdfc7d32fe1d9e959e3f958bc1931c661fa0  after_shared_chat_1440.png
19d36c6fe66d3d0726eac8e5286f944510062df608dc2e1c4bb2fe4a52486b7c  after_shared_compare_1440.png
c9a27a476177f063a112ca7245bdeddcb2703adee01b3a0d92f8a20e9bb263d5  after_shared_insights_ai_1440.png
61df704ea42271c2b8788d39352816e9756e7e2d63dfb36303156d710c4399e2  after_shared_search_1024.png
e8d13195580337251778ec9ededd18cc4d46151106927a6eb1cae6d90b15e7c9  after_shared_search_1440.png
e2b2af9466eef3190e716b1e3e17583d8b3452ad1eb40f03430b449ed1afb02d  after_shared_search_click_noop_1440.png
8b0fffde574fde08635b2ac21ab7f051ebfd255923c31f208cfdf5e14616ebb6  before_exclusive_search_1024.png
c9cb0e348af73fd2a9a79dd29c47a19c248d1fb2b50e686d0d98c43d689b53a4  before_exclusive_search_1440.png
b496a5460c393f01c8cc9dc64f6ab2639ed290ccc59b50fb9a9a4ffacde443be  before_shared_chat_1440.png
6425587a1b0338ecffb43eae98c559511542d2c10485afced3db3ad3eb9814a4  before_shared_compare_1440.png
95c4196f51d0a1b9ab4362a0a1be86b540af64d2f028417ae084a18716db151a  before_shared_insights_ai_1440.png
8b0fffde574fde08635b2ac21ab7f051ebfd255923c31f208cfdf5e14616ebb6  before_shared_search_1024.png
c9cb0e348af73fd2a9a79dd29c47a19c248d1fb2b50e686d0d98c43d689b53a4  before_shared_search_1440.png
e4f246dfd4b40583366415d370bebacbcaf6a7de72200f1e3300b54c7eff919a  before_shared_search_click_error_1440.png
```

零回归强证据：`{before,after}_exclusive_search_1440.png` 与 `{before,after}_exclusive_search_1024.png` 两组 SHA-256 **分别相等**（跨 revision 逐字节一致）。

## Mock 请求日志证据（After shared 无 POST /search）

本 PR 提交：`logs/gateway-requests-before.txt`（Before 整轮，103 请求）、`logs/gateway-requests-after.txt`（After 整轮，102 请求）。本地采集工作区另有 `logs/gateway-requests.log`（两轮拼接）与 `logs/archive-gateway-requests-before-and-after-1338ec8.log`（早期 After 修订存档），不随 PR 提交（`.gitignore` 忽略 `*.log`；`.txt` 为同一内容的提交副本）。

- **Before 轮**：`GET 200 ×92`，`POST 200 ×9`（context-preview / chat-sessions 创建等），`PUT 200 ×1`（草稿保存），**`POST /search → 409 ×1`**。该 409 位于 `scenario=before_shared_search_click_1440` 的 `click_start..click_end` 窗口内（窗口内唯一请求）。
- **After 轮**：`GET 200 ×92`，`POST 200 ×9`，`PUT 200 ×1`，**`POST /search` 0 次（整轮）**。在 `after_shared_search_click_1440` 的 `click_start..click_end` 窗口内请求数 = **0**（对 disabled 控件的点击不产生任何网络请求）。两轮除 Before 那 1 个 409 外，请求分项计数一致（GET 92 / POST 200 9 / PUT 200 1；同一 mock、同一 fixture、同一页面流程）。
- 该窗口切片由 `harness/capture.js` 在采集时即时断言（`logs/capture-after-summary.json` 中 `disabled search-run click issued zero POST /search :: count=0`），日志仅作事后复核。

## 一键复现

> 下面第 2–4 组为常驻进程，需在各自终端/后台运行后再执行第 5 步采集。

先决条件：Node 22 / npm 10；两个 worktree 各自有 `frontend/node_modules`（可用 `cp -al <repo>/frontend/node_modules <worktree>/frontend/node_modules` 硬链接）；Chromium `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`；`playwright-core` 用本机既有安装（`harness/capture.js` 默认 `/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core`，可改常量）。

```bash
WS=/home/lchen/.dsh/state/superagent/work/fork-shared-gpu-cd906bb85363
VE=$WS/visual-evidence

# 0) worktrees + 依赖
git -C $WS/repo worktree add --detach $VE/worktrees/before 39b456f
git -C $WS/repo worktree add --detach $VE/worktrees/after  0fed575
cp -al $WS/repo/frontend/node_modules $VE/worktrees/before/frontend/node_modules
cp -al $WS/repo/frontend/node_modules $VE/worktrees/after/frontend/node_modules

# 1) harness-only hack（不提交）：两个 worktree 的 frontend/src/lib/embedded/config.ts 中
#    process.env[EMBEDDED_MODE_ENV]/[GATEWAY_URL_ENV]/[PARENT_ORIGIN_ENV]
#    改为 process.env.NEXT_PUBLIC_RD_EMBEDDED_MODE / _RD_GATEWAY_URL / _RD_PARENT_ORIGIN

# 2) 合成 gateway mock（模式文件 /tmp/issue109-local-model-mode；请求日志 logs/gateway-requests.log）
GW_LOG=$VE/logs/gateway-requests.log node $VE/harness/gateway_mock.js 8731

# 3) Before dev server + host
(cd $VE/worktrees/before/frontend && \
  NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 NEXT_PUBLIC_RD_EMBEDDED_MODE=1 \
  NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:8731 \
  NEXT_PUBLIC_RD_PARENT_ORIGIN=http://127.0.0.1:8601 \
  ./node_modules/.bin/next dev --webpack -p 8600)
node $VE/harness/host_server.js 8601 http://127.0.0.1:8601 http://127.0.0.1:8600/research

# 4) After dev server + host
(cd $VE/worktrees/after/frontend && \
  NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 NEXT_PUBLIC_RD_EMBEDDED_MODE=1 \
  NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:8731 \
  NEXT_PUBLIC_RD_PARENT_ORIGIN=http://127.0.0.1:8621 \
  ./node_modules/.bin/next dev --webpack -p 8620)
node $VE/harness/host_server.js 8621 http://127.0.0.1:8621 http://127.0.0.1:8620/research

# 5) 采集（脚本按场景自动切换 shared/exclusive 模式；输出 screenshots/ 与 logs/）
node $VE/harness/capture.js before http://127.0.0.1:8601/
node $VE/harness/capture.js after  http://127.0.0.1:8621/
```

`harness/` 文件：`fixtures.js`（全部合成数据）、`gateway_mock.js`（确定性 mock + 模式文件 + 请求日志）、`host_server.js`（合成 host 页 + 未签名 token 握手）、`capture.js`（Playwright 采集 + 实时断言 + 日志窗口标记）、`debug_chat.js`（采集脚本的调试辅助，非交付证据）。

## 限制 / NOT RUN（如实登记）

- **非生产、非真实入口验收**：无真实 RDLens Gateway/PostgreSQL/SurrealDB/本地或外部模型；所有 API 响应为模拟，`capabilities.local_model` 与 409 均为按文档契约合成的 fixture。本证据只证明 **fork 前端** 按契约消费能力位/文案/禁用入口，不证明真实后端行为（后端已在 RDLens #820 交付）。
- **真实 409 往返**：After 证据是「不发请求」（mock 日志 0 次 `POST /search`），未在真实 Gateway 上验证 409；真实外发/模型调用未执行（`NOT RUN`）。
- **Token 签名**：host 页下发未签名合成 Token；真实签名校验属 Gateway，未涉及（`limited`）。
- **Chat 会话**：合成 `POST /chat/sessions` + editor-state fixture（草稿保存成功）使 composer 可达；未验证真实会话/历史/流式链路（`limited`）。
- **TransformationRunDetail 的 blockedHint 通道**：本单消费方之一，但需要「可 rerun 的 transformation run 详情」状态，本证据集未覆盖（`NOT RUN`；由单测覆盖，不在视觉证据范围）。
- **ActivityCenter coverage `outcome_unknown` 重试入口**（`0fed575` 新增的 `canExecute` 门禁）：需要 outcome_unknown coverage job fixture，本证据集未覆盖（`NOT RUN`；该状态的变化在 round-1 修复 1338ec8→0fed575 中引入，见修订记录）。
- **暗色主题 / 其他视口**：未采集（证据固定 light，1440×900 + 1024×768）。
- **截图非像素级稳定基线**：headless Chromium 字体栅格化与焦点环等会造成字节级差异；SHA-256 仅用于本次交付溯源，不作为跨环境可复现的像素基线。exclusive 两组跨 revision 逐字节一致是本次同机同浏览器采集的事实，不作为通用保证。
- 未把 `limited` / `NOT RUN` 记成 pass；本证据不构成 #109 完成声明。

## 观察（不作为缺陷结论）

- After shared Chat 中同一条后端 message 出现两次：`chat-model-blocked-hint`（输入区上方）与 composer 底部既有 gate-reason 行（橙色）。两者都来自同一个 `blockedHint` 映射（`generationBlocked` 时 composer 以 `blockedHint ?? generationInProgress` 作为 gateReasonText），不是第二份硬编码文案；该双呈现是既有 composer 门禁渲染位置与本单新增 disabled 原因叠加的结果。若产品希望去重，可在 composer gate 文案中回退到通用文案——属实现取舍，本证据只如实记录画面。
- Before 的 shared 与 exclusive Search 画面完全一致（基线不读 `capabilities.local_model`），这正是本单修复对象；After 的 exclusive 与 Before 逐字节一致，佐证零回归。

## 修订记录

- **2026-11-05**：After 首次采集于实现 head `1338ec8ac7a6b8bb80fed911c27ef28ee6e62ace`（8/8 场景 PASS）。Lead round-1 评审后 head 更新为 `0fed575cb08ef3d0e008035fbd908ae5d6c96bf2`，变更仅涉及 coverage `outcome_unknown` 重试入口的 `canExecute` 门禁（未捕获状态）+ 测试；**After 的 8 张截图按 `0fed575` 重新采集并替换**（本 README/SHA 清单均为 0fed575），早期 1338ec8 轮请求日志存档于 `logs/archive-gateway-requests-before-and-after-1338ec8.log`。Before 的 8 张截图始终为 `39b456f`。
- 采集日期：2026-11-05（Asia/Shanghai）；采集机器即本 ticket workspace 所在主机。

## 交付去向与文件

- 本目录 `visual-evidence/` 为采集工作区（含 worktrees、harness、logs、screenshots、本 README）。
- 截图仅供本次 PR 数量核对与视觉审查；按 Lead 安排复制到 PR 分支 `dev_docs/validation/issue109/`（fork PR 不提交 `visual-evidence/` 工作区本身）。
- 采集期间服务器仍在运行（供复核）：mock `127.0.0.1:8731`、Before dev `127.0.0.1:8600` + host `:8601`、After dev `127.0.0.1:8620` + host `:8621`；模式文件 `/tmp/issue109-local-model-mode`。
