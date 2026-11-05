# Fork #109 视觉证据：shared 模式 Research 本地模型禁用提示（Before / After）

- **任务**：fork issue #109（`lingyun-hifibio/open-notebook-rdlens`）——shared 模式（GPU 共用）下 Research 的本地模型生成入口禁用，并在既有提示通道渲染**后端下发**的 `capabilities.local_model.message`；exclusive 模式零回归。round-3 收敛后覆盖 **7 个生成入口**：Search、Chat、Compare、Insights AI、Source Chat、Transformations Run 确认框、Activity Center 的 coverage `outcome_unknown` 重试。
- **Before revision（PR base）**：fork `39b456f5f187525289168384ce4a57c224e1c944`（= `origin/main`；detached worktree `visual-evidence/worktrees/before`）。
- **After revision（采集时产品 head）**：fork `7b722cc1f2c49906545b7a053c5fb62ce12eac7a`（分支 `agent/fork-shared-gpu-cd906bb85363`；detached worktree `visual-evidence/worktrees/after`）。采集后仅追加**测试/证据**提交（产品代码未变）；最终 PR head 见 PR body「配对与锚点」。
- **视口**：1440×900（主；全部 11 个场景）；Search 主对另加 1024×768。**主题 light**（host 页认证后经 postMessage 下发 `theme=light`；每次采集全新浏览器上下文）。
- **场景一致性**：同一合成项目 `p1` / owner `u1`、同一资料范围（fixture 预置 selected = `src_1`,`src_2`）、同一模型 fixture（本地模型 `m-local-qwen`, `data_egress=false`）与同一查询文本；Before/After 使用**完全相同的 mock fixture 与 mock 版本**、同一台机器、同一 headless Chromium、`deviceScaleFactor=1`、`--force-color-profile=srgb`。Chat / Source Chat 场景通过 mock 合成会话（`POST /chat/sessions`、`POST /sources/src_1/chat/sessions` + `editor-state` 草稿保存成功）使 composer 可达——Before/After 用同一流程。

## 采集方法（真实应用渲染 + 合成网络）

真实 Next.js 应用（本仓库 `frontend/`，`next dev --webpack`，embedded 模式）运行在合成 host 页的 iframe 中；host 页执行文档化的 `research-v0` ready→token 握手，下发**合成的、未签名的** Research Token（claims `sub=1`/`project_id=p1`/`role=owner`/`scopes=[...]`；签名校验属真实 Gateway，本次未涉及）。截图由 headless Chromium（`chromium-1243`，Playwright-core 1.62.1）截取。

Research Gateway 由本地合成 mock server（`harness/gateway_mock.js`）提供**确定性模拟响应**：`/models`、`/execution-preferences`、`/external-egress-consent`、`/sources`（列表 + `src_1` 详情）、`/notes`、`/jobs`（含一个 `research_coverage` + `outcome_unknown` 合成 Job）、`/insights`、`/transformations`（含一个 admin 模板）、`/chat/sessions`（全局/来源会话列表、创建、会话详情、editor-state GET/PUT）、`/context-preview`、`/search`。**所有网络响应均为模拟**：

- 无真实后端、PostgreSQL、SurrealDB、模型调用或外部外发；无凭据、无私有数据；fixtures 正文均带 `[synthetic]` 标记，模型名显示为 `Local Qwen (synthetic)`。
- 模式由文件切换：`/tmp/issue109-local-model-mode` = `shared` | `exclusive`。`shared` 下 `/models` 返回
  `capabilities.local_model = {available:false, reason:"shared_gpu", message:"当前 GPU 正与其他任务共用，可用显存不足以支撑 Research 使用本地模型，请改用外部 AI 模型。"}`；
  `exclusive` 下返回 `{available:true, reason:null, message:null}`；`preferred_model_id` 恒为本地模型 `m-local-qwen`。
- `POST /search`：`shared` → **409** `detail = {code:"local_model_unavailable_shared_gpu", message:"<同上>"}`（Before 点击证据）；`exclusive` → 200 合成检索结果。
- **每个请求**（时间、方法、路径、状态、模式）同步追加到 `logs/gateway-requests.log`；采集脚本在每个场景边界写入 `kind:"mark"` 行，可按窗口切片核对「After shared 无 POST /search」等断言。
- 场景内实时断言由 `harness/capture.js` 在浏览器中执行（hint 文案逐字比对、按钮 disabled、触发/不触发请求），结果写入 `logs/capture-<phase>-summary.json`。

**harness-only 本地改动（不进入 PR diff）**：Next.js 仅对静态成员访问的 `NEXT_PUBLIC_*` 做构建期内联，而 `frontend/src/lib/embedded/config.ts` 使用 `process.env[常量]` 动态访问。采集时在两个 worktree 中**临时**把三处访问改为静态成员写法（各 3 行、uncommitted，仅本地）：不改变产品语义；After worktree 在 `7b722cc` 之上仅多这 3 行本地 hack，Before 同理。复现时需重新应用。Dev server 另需 `NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1`。

## 场景、断言与逐图标签（22 张）

**11 个场景 × Before/After = 22 张；两轮采集各 11/11 PASS（0 fail / 0 not-run）。**

| # | 场景 | Before（39b456f）| After（7b722cc）| 文件 |
|---|---|---|---|---|
| A | shared + Search（1440×900）| 无 `model-blocked-hint`；`search-run` **enabled** | hint **逐字等于**后端 message；`search-run` **disabled** | `before_shared_search_1440.png` / `after_shared_search_1440.png` |
| A | 同上（1024×768）| 同上 | 同上 | `before_shared_search_1024.png` / `after_shared_search_1024.png` |
| B | shared + 点击 Search（1440）| 点击 → `POST /search` **409** → 通用错误 Alert（`Something went wrong…` / `Request failed with status code 409`），**后端 message 不出现** | disabled 控件点击被 Playwright 拒绝 + `dispatchEvent` 无效；**0 次 POST /search**、无错误 Alert | `before_shared_search_click_error_1440.png` / `after_shared_search_click_noop_1440.png` |
| C | exclusive + Search（1440×900 与 1024×768）| 无 hint；`search-run` enabled | 无 hint；`search-run` enabled；与 Before **视觉一致**（见零回归说明）| `before_exclusive_search_{1440,1024}.png` / `after_exclusive_search_{1440,1024}.png` |
| D | shared + Chat（1440）| wired composer：无提示（gate/panel 均无）；`chat-send` **enabled** | 单条提示在 composer 门禁行（`research-draft-gate-hint`）= 后端 message（**无重复 panel 提示**）；`chat-send` **disabled** | `before_shared_chat_1440.png` / `after_shared_chat_1440.png` |
| E | shared + Compare（1440）| 无 `compare-model-blocked-hint`；`compare-create` **enabled**（scope 预置 selected 2/30）| `compare-model-blocked-hint` = 后端 message；`compare-create` **disabled** | `before_shared_compare_1440.png` / `after_shared_compare_1440.png` |
| F | shared + Insights AI 表单（1440）| 选 AI 类型后无 `insight-model-blocked`；AI Save 可用 | `insight-model-blocked` = 后端 message；AI Save **disabled** | `before_shared_insights_ai_1440.png` / `after_shared_insights_ai_1440.png` |
| G | shared + Source Chat（1440；**wired 生产路径**）| 已创建 source 会话 + 草稿保存成功：无提示；`chat-send` **enabled** | composer 门禁行（`research-draft-gate-hint`）= 后端 message；`chat-send` **disabled**；`srcchat-model-blocked-hint` 仅 legacy 路径（本对未触发）| `before_shared_source_chat_1440.png` / `after_shared_source_chat_1440.png` |
| H | shared + Transformations Run 确认框（1440）| 打开模板 Run 对话框：无提示；`transformation-run-confirm` **enabled** | `transformation-run-blocked-hint` = 后端 message；confirm **disabled** | `before_shared_transformations_run_1440.png` / `after_shared_transformations_run_1440.png` |
| I | shared + Activity Center（1440；合成 `outcome_unknown` coverage Job）| 无 `activity-model-blocked-hint`；`coverage-retry-trigger` **可见** | 无 retry 入口（`count=0`）；`activity-model-blocked-hint` = 后端 message | `before_shared_activity_1440.png` / `after_shared_activity_1440.png` |

逐图说明：

- `before_shared_search_1440/1024.png`：shared 下基线 Search 面板——模型 pill `Local Qwen (synthetic) · Local`，Context preview 正常，**无提示**，Search 按钮可点。1024 下标签栏出现既有横向滚动（`Custom` 截断），与 After 一致，非本单引入。
- `before_shared_search_click_error_1440.png`：Before 点击 Search 后 `POST /search` 409，仅通用错误（稳定码未收录 → generic；后端 message 被丢弃）——本单修的体验缺口。
- `before_exclusive_search_1440/1024.png` 与 `after_exclusive_search_1440/1024.png`：exclusive 下无 hint、入口可用；Before/After 画面一致（见零回归说明）。
- `before_shared_chat_1440.png`：wired 会话已建、草稿 `All changes saved`，无提示、Send 可点。
- `after_shared_chat_1440.png`：composer 门禁行显示后端 message（单条；round-3 F-5 修复后 wired 路径不再重复渲染 panel 级提示），Send disabled。
- `before_shared_compare_1440.png` / `after_shared_compare_1440.png`：Compare 面板；After 的 Alert 显示后端 message、`Start compare` disabled。
- `before_shared_insights_ai_1440.png` / `after_shared_insights_ai_1440.png`：Insights 新建表单 Type=AI；After 在 Type 下方显示 `insight-model-blocked` 后端 message，AI Save disabled。
- `before_shared_source_chat_1440.png`：进入 source focus（doc_a），用 `New session` 建立合成 source 会话，草稿 `All changes saved`，Send 可点、无提示。
- `after_shared_source_chat_1440.png`：同一 wired source 会话；composer 下方显示后端 message，Send disabled。
- `before_shared_transformations_run_1440.png`：Custom Analysis → 模板 Run 对话框；无提示，`Run` 确认按钮可点（Before 基线不读能力位 ⇒ 该入口在 shared 下仍可点，正是本单要修的行为）。
- `after_shared_transformations_run_1440.png`：同一对话框显示 `transformation-run-blocked-hint` 后端 message，确认按钮 disabled。
- `before_shared_activity_1440.png`：Activity Center，合成 `research_coverage` Job（`outcome_unknown`）：`Retry coverage` 入口可见（旧代码只按 admin 只读判断）。
- `after_shared_activity_1440.png`：同一 Job：**无 Retry 入口**，对话框顶部 `activity-model-blocked-hint` 显示后端 message。

## 零回归说明（exclusive）

- 本轮 shared/exclusive 的 **Before** Search 对（1440 与 1024）各自 **SHA-256 相同、逐字节一致**（`before_shared_search_1440.png` == `before_exclusive_search_1440.png`；1024 同理）——基线不读能力位，符合预期。
- Before vs After 的 exclusive 对**画面一致**，但不是逐字节相同：像素差异仅 14 px（1440）与 28 px（1024），全部落在顶部操作栏 y=8–10 的 3 行条带（模型 pill/操作按钮的字体抗锯齿），肉眼不可见；同量级噪声在**同一 Before 修订**的不同采集会话之间也会出现，故不判为回归。本轮不声称 exclusive 跨 revision 字节一致。

## SHA-256（按文件名排序；完整清单见 `logs/sha256-manifest.txt`，与写入 `dev_docs/validation/issue109/logs/sha256-manifest.txt` 的内容一致）

```text
8a3d6ab9d8b44c6c501ba1ac3fb1ba3d375fcca3d2f55619ca5211ca272e3010  after_exclusive_search_1024.png
c80a671b5ff21d183bfe394e0b005bf8eac620327310472bbe6fe25d38529975  after_exclusive_search_1440.png
18ffb38c307da2f261e56b40c15a691129ec9edb4bc7f2718f24484903215c01  after_shared_activity_1440.png
6dcb06e659b3f7bd62580c061d0f88e64bb27458ae9780f8dacdaf473a061ae5  after_shared_chat_1440.png
692775ec0fb88fa9bc9c81e016dc52de933d374db8dc05c4dcff88832e731786  after_shared_compare_1440.png
6fb556f2f64d0e6ddb9a994b73e212284bc5215c28f63135282e03c0222e62d6  after_shared_insights_ai_1440.png
a76a2ba0f5bd54223476e49837fe04f7ecb7abf152a7d179aeccc13a4d1d0317  after_shared_search_1024.png
895f46c03628aa745b426d13601f71da85774b1d7cdfad1857d793c378c593b8  after_shared_search_1440.png
2734ee00dc9809de3c292771595293f310ce8aa115a2abeb6b7fa0b1f98c797e  after_shared_search_click_noop_1440.png
ec8fce33ce5019cf72953612d579ce1184d64c27f8f786d141f94cc5397ad869  after_shared_source_chat_1440.png
6ab13b1c16c19db056c8c75522586526895b351edcb34c78b031d5cd13ae680b  after_shared_transformations_run_1440.png
e71a5b1981fde2ccaecad08cffe55b2ba37e38b51b8f1f6d2c42002c12611399  before_exclusive_search_1024.png
fe428e6e64dc26d444945f4a3421c9e1536d0801c4d832664fcc40916653a856  before_exclusive_search_1440.png
99cfc32c40a39e1b0913af8304d12f65b785128682fc0d6e9094743dc6d52519  before_shared_activity_1440.png
83059e4e22b01823803f4e21492a17e6bbb03043e47c7b96b823ded2a3d9430f  before_shared_chat_1440.png
0955caf4cb4818be27c4a346a0c48fbb3e466f8b38f527e75b237726ec31c68d  before_shared_compare_1440.png
966a19d6b3cff780f41adbe283c83b1bb68722c47f5f29e4a2edb2472d11005a  before_shared_insights_ai_1440.png
e71a5b1981fde2ccaecad08cffe55b2ba37e38b51b8f1f6d2c42002c12611399  before_shared_search_1024.png
fe428e6e64dc26d444945f4a3421c9e1536d0801c4d832664fcc40916653a856  before_shared_search_1440.png
fec5f1611e987cf647d940a21ca01cfbe152344c2c4ffc9eaed8b2275287d13f  before_shared_search_click_error_1440.png
e62cc948db31ec7fd99c8766a00c4361d0ab5ca1220873928b6b696f8f100459  before_shared_source_chat_1440.png
4a5d95feb77d86ec1ee8071fce2cd8e93b7191357a1de9a0022476d07a2cb52e  before_shared_transformations_run_1440.png
```

（22 张、20 个唯一摘要；两处重复即上文 Before 的 shared/exclusive Search 对。）

## Mock 请求日志证据（After shared 无 POST /search）

文件：`logs/gateway-requests-before.log`（Before 整轮 150 请求）、`logs/gateway-requests-after.log`（After 整轮 149 请求）、`logs/gateway-requests.log`（两轮拼接）。

- **Before 轮**：`POST /search → 409 ×1`（`before_shared_search_click_1440` 的 click_start..click_end 窗口）；其余为确定性 GET 与合成会话/草稿 PUT。
- **After 轮**：**`POST /search` 0 次（整轮）**；`after_shared_search_click_1440` 的 click_start..click_end 窗口内请求数 **0**（disabled 控件点击零网络往返）。日志同时可见 Source Chat / Chat 场景的合成会话创建与 `PUT .../editor-state` 草稿保存（证明这些场景的 mock 链路真实工作）。
- 该窗口切片由 `harness/capture.js` 在采集时即时断言并写入 `logs/capture-after-summary.json`（`disabled search-run click issued zero POST /search :: count=0`），日志仅作事后复核。

## 一键复现

先决条件：Node 22 / npm 10；两个 worktree 各自有 `frontend/node_modules`（可 `cp -al <repo>/frontend/node_modules <worktree>/frontend/node_modules` 硬链接）；Chromium `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`；`playwright-core` 用本机既有安装（`harness/capture.js` 默认 `/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core`，可改常量）。

> 第 2–4 组为常驻进程，需在各自终端/后台运行后再执行第 5 步采集。

```bash
WS=/home/lchen/.dsh/state/superagent/work/fork-shared-gpu-cd906bb85363
VE=$WS/visual-evidence

# 0) worktrees + 依赖
git -C $WS/repo worktree add --detach $VE/worktrees/before 39b456f
git -C $WS/repo worktree add --detach $VE/worktrees/after  7b722cc
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

# 5) 采集（脚本按场景自动切 shared/exclusive 模式；输出 screenshots/ 与 logs/）
node $VE/harness/capture.js before http://127.0.0.1:8601/
node $VE/harness/capture.js after  http://127.0.0.1:8621/
```

`harness/` 文件：`fixtures.js`（全部合成数据）、`gateway_mock.js`（确定性 mock + 模式文件 + 请求日志）、`host_server.js`（合成 host 页 + 未签名 token 握手）、`capture.js`（Playwright 采集 + 实时断言 + 日志窗口标记）；`debug_chat.js` / `debug_source_chat.js` 为调试辅助，非交付证据。

## 限制 / NOT RUN（如实登记）

- **非生产、非真实入口验收**：无真实 RDLens Gateway/PostgreSQL/SurrealDB/本地或外部模型；所有 API 响应为模拟，`capabilities.local_model`、409、coverage Job、模板与会话均为按契约合成的 fixture。本证据只证明 **fork 前端** 按契约消费能力位/文案/禁用入口，不证明真实后端行为（后端已在 RDLens #820 交付）。
- **真实 409 往返**：After 证据是「不发请求」（mock 日志 0 次 `POST /search`），未在真实 Gateway 上验证 409；真实外发/模型调用未执行（`NOT RUN`）。
- **Source Chat 仅录 wired 生产路径**：mock 会话 + editor-state 草稿保存使 wired composer 可达并已捕获；**legacy（未接线宿主）路径未捕获**（该路径在 After 才新增 `srcchat-model-blocked-hint`，本轮未构造无 runtime 宿主，`NOT RUN`，由单测覆盖）。
- **Source Chat error-card 的 Retry 隐藏**（round-3 F-4）：需要错误卡 + 可重试查询状态，本轮未构造（`NOT RUN`）。
- **Chat 的 persistent-job CTA 禁用**（round-3 F-2）：需要 `persistent_job_required` 失败卡/turn fixture，本轮未构造（`NOT RUN`）。
- **TransformationRunDetail 的 rerun（Rerun）入口**：本单 blockedHint 亦经 `TransformationRunDetail` 消费，但需要可 rerun 的 run 详情记录，本轮未构造（`NOT RUN`；Run 确认框已覆盖）。
- **Activity Center**：仅覆盖 `research_coverage` + `outcome_unknown` 一种 Job；取消/其它 Job 类型未采集（`limited`）。
- **Token 签名**：host 页下发未签名合成 Token；真实签名校验属 Gateway，未涉及（`limited`）。
- **暗色主题 / 其他视口**：未采集（证据固定 light，1440×900 + Search 1024×768）。
- **截图非像素级稳定基线**：headless Chromium 字体栅格化/焦点环/渲染时序会造成字节级差异；SHA-256 仅用于本次交付溯源，不作跨环境像素基线。跨 revision 的 exclusive 对存在 14–28 px 顶部条带噪声（见零回归说明）。
- 未把 `limited` / `NOT RUN` 记成 pass；本证据不构成 #109 完成声明。

## 观察（不作为缺陷结论）

- After shared Chat 的提示已收敛为**一条**（composer 门禁行），与 round-3 F-5 修复一致；`chat-model-blocked-hint` 现仅 legacy/unwired 路径渲染，本证据的 wired 场景中为 0。
- Before 的 Transformations Run 确认按钮在 shared 下**可点**（基线仅以 `canExecute` 判断，而基线不读 `capabilities.local_model`）；Source Chat / Search / Chat 同理可点——这正是本单要修的「共享 GPU 下入口仍可派发」行为。Lead 初版预期为「Before confirm disabled」，实际采集结果以本证据为准（Before=可点，无提示；After=disabled，有 hint）。
- Before 的 shared 与 exclusive Search 对逐字节一致，说明基线完全不感知能力位；After 的 exclusive 画面不变、shared 显示提示并禁用，符合验收。

## 修订记录

- **2026-11-05**（round-3 最终）：After 取证修订为 `7b722cc1f2c49906545b7a053c5fb62ce12eac7a`（此前本 ticket 证据轮次：`1338ec8` round-1 → `0fed575` round-2 → `c1e21da`（已被 squash/force-push，未用于交付）→ `7b722cc` 最终）。本目录 22 张截图**全部按 39b456f / 7b722cc 单轮重采**（Before 11 + After 11），不混用旧修订图片。新增覆盖：Source Chat（wired）、Transformations Run 确认框、Activity Center `outcome_unknown` 重试；同时按最终 head 重采既有 8 场景。早期轮次的请求日志存档保留为 `logs/archive-gateway-requests-before-and-after-1338ec8.log`（不再作为交付证据）。
- **2026-11-05**（round-2）：After=0fed575 的 16 张快照与 README 已提交到 PR 证据目录（`dev_docs/validation/issue109/`，提交 `8660a54`/`8aa4882`）；本 round-3 轮次已用最终 head 数据**覆盖**该目录内容（工作树未提交，见交付去向）。
- **2026-11-05**（round-1）：首个 After 采集 1338ec8 的 16 张快照（已被取代）。

## 交付去向

- 本目录 `visual-evidence/` 为采集工作区（worktrees、harness、logs、screenshots、README）。
- 已同步到仓库 PR 证据目录（**工作树，未提交**，由 Lead 复核后提交）：`dev_docs/validation/issue109/screenshots/`（22 张）、`README.md`、`logs/{capture-before-summary.json,capture-after-summary.json,gateway-requests-before.txt,gateway-requests-after.txt,sha256-manifest.txt}`；并按新摘要更新 `dev_docs/validation/secret-scan-allowlist.txt` 中 fork #109 截图摘要块。
- 采集期间服务器运行信息（供复核）：mock `127.0.0.1:8731`、Before dev `127.0.0.1:8600` + host `:8601`、After dev `127.0.0.1:8620` + host `:8621`；模式文件 `/tmp/issue109-local-model-mode`。
