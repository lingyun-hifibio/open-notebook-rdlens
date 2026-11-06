# RDLens #1104 — W1 目标两栏骨架 Before/After 视觉证据（[synthetic]）

> **证据性质（先读）**：真实应用渲染（RDLens 宿主 Vite 应用 + fork Next.js 嵌入式工作台）＋ **本地合成 API**。
> 无真实后端 / 数据库 / Research Gateway / 模型调用 / 凭据 / 私有数据；所有自由文本与标识均标 `[synthetic]`。
> **这不是 L2 部署验收**：本证据只能作为 smoke，**synthetic 不单独关闭 L2**；真实 host + DB 的 L2 仍待部署验收
> （UI 规格 v1 §9.2；Issue #1104 要求）。Before/After 同场景 / 同视口 / 同主题 / 同语言（Before zh 行如实标注能力缺失）。

- **ticket**：[#1104](https://github.com/HiFiBiO-Therapeutics/RDLens/issues/1104)（W1 目标两栏骨架与按需右栏）
- **PR**：RDLens #1118（host，draft）；fork `agent/wave-one-shell-bddcfc523569`
- **规格依据**：`dev_docs/设计方案/Research/Research_UI规格_v1_20261106.md` §2–§9（1024×768 / 1440×900、light/dark token、zh-CN/en-US、Before/After 证据规则）；`Research_对齐实施计划_v2_20261106.md` §2 W1、§3（两栏骨架 + 按需右栏）
- **采集时间**：2026-11-06T18:55:47.838Z

## 1. 结论摘要

| 项 | 结果 |
|-|-|
| Before（fork main + host main）| 30 张：**18 PASS / 0 FAIL / 12 NOT_APPLICABLE / 0 NOT RUN** |
| After（fork 目标壳 + host 新页头）| 63 张：**63 PASS / 0 FAIL / 0 NOT_APPLICABLE / 0 NOT RUN** |
| 键盘走查（After）| **PASS**（9 项，Tab 序/Esc 回焦/skip link/焦点环/无横向滚动） |
| 预跑发现 F1 | 空 selected UI 清空路径不可达 → 已报 Lead → fork-shell 修复 `476b1b2` → 正式 After 断言 PASS（发现记录见 `logs/prerun-F1-empty-selected-finding.md`） |
| 证据层 | **synthetic**：真实应用 + 合成网络；**非 L2**，不单独关闭 L2；产品单测由实现 PR 负责，不在本证据范围 |

**Before → After 关键变化（视觉/交互断言）**：

- 宿主页头：Before=英文 `Research workspace` + 项目名 + 账户/`Sign out`，无语言切换/旧版入口；After=去项目名（D-UI-01）、zh-CN/en-US 语言 `<select>`、旧版/目标版次级入口（D-UI-05）、中英文案全量。
- 工作台 IA：Before=旧壳五主操作 Tab（Evidence Search / Research Chat / Compare / Mind Map / Custom Analysis）+ 35% 左控制栏、无右栏；After=目标两栏（282px 左资料栏 + 中央对话 + composer），按需 355px 右栏：1440 三栏、1024 右栏替代左栏并在关闭后恢复左栏。
- 资料范围：After 可达 all / selected / 空 selected（阻断块 `rdlens-target-scope-blocked` + 提交门禁），Before 旧壳为 all/selected 单选 + 单篇限定。
- 旧壳：After 仅经宿主页头「旧版工作台」以 `legacy=1` 进入，再切回目标壳（D-UI-05）。
- 语言切换：After 宿主页头切 zh-CN 后工作台文案即时中文、composer 草稿/范围保留（同一 iframe，不重建）。

## 2. Revisions（同场景/视口/主题/语言的 Before/After 基线）

| 侧 | 仓库 | ref | commit | worktree |
|-|-|-|-|-|
| Before fork | lingyun-hifibio/open-notebook-rdlens | `origin/main` | `2db87a8e2ccbed82acd321529f70a7b150c8d398` | `evidence/worktrees/fork-before (git worktree add --detach)` |
| Before host | HiFiBiO-Therapeutics/RDLens | `origin/main` | `53e9b87b73fb12b60bf01d7fd217b9c7e57c657e` | `evidence/worktrees/host-before (git worktree add --detach)` |
| After fork | lingyun-hifibio/open-notebook-rdlens | `agent/wave-one-shell-bddcfc523569` | `476b1b26a1312fd143662ec28001de3244963e87` | `evidence/worktrees/fork-after (git worktree add --detach)` |
| After host | HiFiBiO-Therapeutics/RDLens | `agent/wave-one-shell-bddcfc523569` | `d6da1a64b8ab8779e8a74b7c88fafc7bf6b87fdb` | `evidence/worktrees/host-after (git worktree add --detach)` |

## 3. 环境与依赖（Before/After 同一依赖集）

| 项 | Before | After |
|-|-|-|
| fork 仓库 commit | `2db87a8e2c…`（origin/main） | `476b1b26a1312fd143662ec28001de3244963e87`（分支 head，含 F1 修复） |
| host 仓库 commit | `53e9b87b7…`（origin/main） | `d6da1a64b8ab8779e8a74b7c88fafc7bf6b87fdb`（分支 head） |
| fork frontend 依赖 | ticket `fork/frontend/node_modules` 硬链接副本（lock sha1 `e802ac73…`，Next 16.3.2） | 同一目录硬链接副本（与 Before 字节一致） |
| host frontend 依赖 | 共享 RDLens checkout `frontend/node_modules`（lock 与 ticket host 一致） | `cp -al` 硬链接副本（同一依赖集） |
| 浏览器 | Playwright-core 1.62.1 / Chromium 151（`chromium-1243`），headless，`deviceScaleFactor=1`，`--force-color-profile=srgb` | 同左 |
| 端口 | mock `127.0.0.1:8099`、fork dev `:3010`、host dev `:5174` | mock `:8099`、fork dev `:3011`、host dev `:5175` |

> 说明：fork 主分支在正确 deps 下已有 25 个与本单无关的既有单测失败（NotesPanel 11 / SourceListPanel 14）；产品单测由实现 PR 负责，本证据只做真实浏览器视觉/交互断言，不把单测结果混入视觉证据。

## 4. 采集方法（真实应用渲染 + 合成网络）

```text
Playwright → host 页面（真实 RDLens Vite 应用，:5174/:5175）
  ├─ 真实登录表单 → POST /v1/auth/login（mock host API）
  ├─ 真实路由 #/research/p1 → ResearchWorkspacePage（真实宿主 Research 页头）
  ├─ GET /v1/research/workspace-status；GET /v1/projects；POST /v1/research/projects/p1/bootstrap
  │    （合成、未签名 Research Token：claims 仅含 subject/project/role/exp（未签名，签名校验属真实 Gateway）/ project_id=p1 / role=owner；After 契约还下发 project.name 与 language）
  └─ <iframe src=http://127.0.0.1:3010|3011/research>（真实 fork Next.js embedded 应用）
      └─ 真实 research-v0 ready→token→theme（Before）/ +project→language（After）postMessage 握手
         全部 Research Gateway 请求 → 本地合成 mock（/v1/research/projects/p1/...）
```

- **合成 mock**：`harness/mock_server.js`（同一进程提供 host API + Research Gateway）；确定性 fixtures：项目 `p1`、2 份 `[synthetic]` ready 资料（doc_a/doc_b）、模型 `Local Qwen (synthetic)`、coverage `outcome_unknown` Job、会话/编辑器、空 Insights/Notes。
- **请求日志**：`logs/mock-requests-before.log`、`logs/mock-requests.log`（逐请求 JSON 行；capture 在场景边界写 `kind:"mark"` 行）。
- **断言**：`harness/capture.js` 在浏览器内执行（页头/顶栏/断点/右栏宽高/左栏收起恢复/Esc 焦点返回/范围状态/阻断块/composer/主题/横向滚动），逐场景写 `logs/capture-before-summary.json` / `logs/capture-after-summary.json`。
- **键盘走查**：`harness/keyboard_walkthrough.js`（Tab 顺序、skip link、Esc 关闭右栏+焦点返回、焦点环、1024/1440 无横向滚动），输出 `keyboard-walkthrough.md|json`。
- **主题**：light 全矩阵；dark 冒烟 1440（`localStorage["rdlens-theme"]="dark"` → 真实宿主主题协议下发 fork）。

### 4.1 harness-only 本地改动（不提交、不进入实现分支）

采集在 `evidence/worktrees/` 的 detached worktree 内完成；为使真实应用在本地合成网络下可运行，只改 worktree 副本，补丁存档 `logs/harness-only-*.patch`：

1. **fork** `frontend/src/lib/embedded/config.ts`：三处动态 `process.env[CONST]` → 静态 `process.env.NEXT_PUBLIC_RD_*`（Next 仅内联静态成员；不改变产品语义，3 行）。
2. **host** `frontend/vite.config.ts`：dev proxy 目标改为 `process.env.RD_MOCK_API_URL || "http://localhost:7890"`（默认值不变）。
3. **host** `frontend/.env.local`（gitignored）：`VITE_RESEARCH_WORKSPACE_URL=http://127.0.0.1:3010|3011/research`。

> 这些改动只存在于证据 worktree，不是产品代码变更，也未提交到任何实现分支。

## 5. Before 场景清单与断言

| 截图文件 | 场景 | 视口 | 请求语言 | 主题 | 状态 | 关键断言 |
|-|-|-|-|-|-|-|
| `before_default_two_column_1440x900_en-US.png` | default two-column / host header + old shell workbench | 1440x900 | en-US | light | PASS | ✓ real host app header rendered ("Research workspace" + account) (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header repeats project identity (old host behaviour); ✓ no host language switch (Before limitation) (count=0); ✓ old shel… |
| `before_host_header_1440x900_en-US.png` | host Research page header (real host app) | 1440x900 | en-US | light | PASS | ✓ host header shows "Research workspace" label (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header shows project name (Before); ✓ host header shows account + Sign out (Research workspace [synthetic] D1 cohort evidence project sy); … |
| `before_sources_panel_1440x900_en-US.png` | left sources panel (old shell Materials/Sources) | 1440x900 | en-US | light | PASS | ✓ sources pane rows rendered (count=2); ✓ scope editor visible; ✓ no horizontal page scroll (1440/1440) |
| `before_chat_1440x900_en-US.png` | central conversation (old shell Evidence/Research Chat tab) | 1440x900 | en-US | light | PASS | ✓ Research Chat tab became active (Research Chat); ✓ synthetic global session created (composer reachable); ✓ chat composer rendered (empty conversation); ✓ synthetic draft typed into composer ([synthetic] Which synthetic sources support the D1 cohort OR); … |
| `before_results_panel_1440x900_en-US.png` | old shell Results group / Insights outcomes pane | 1440x900 | en-US | light | PASS | ✓ old shell Results group nav rendered |
| `before_activity_panel_1440x900_en-US.png` | old shell Activity Center / tasks panel (synthetic job) | 1440x900 | en-US | light | PASS | ✓ activity center opened; ✓ synthetic job card rendered (count=5) |
| `before_default_two_column_1440x900_zh-CN.png` | default two-column / host header + old shell workbench | 1440x900 | zh-CN | light | NOT_APPLICABLE | ✓ real host app header rendered ("Research workspace" + account) (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header repeats project identity (old host behaviour); ✓ no host language switch (Before limitation) (count=0); ✓ old shel… |
| `before_host_header_1440x900_zh-CN.png` | host Research page header (real host app) | 1440x900 | zh-CN | light | NOT_APPLICABLE | ✓ host header shows "Research workspace" label (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header shows project name (Before); ✓ host header shows account + Sign out (Research workspace [synthetic] D1 cohort evidence project sy); … |
| `before_sources_panel_1440x900_zh-CN.png` | left sources panel (old shell Materials/Sources) | 1440x900 | zh-CN | light | NOT_APPLICABLE | ✓ sources pane rows rendered (count=2); ✓ scope editor visible; ✓ no horizontal page scroll (1440/1440) |
| `before_chat_1440x900_zh-CN.png` | central conversation (old shell Evidence/Research Chat tab) | 1440x900 | zh-CN | light | NOT_APPLICABLE | ✓ Research Chat tab became active (Research Chat); ✓ synthetic global session created (composer reachable); ✓ chat composer rendered (empty conversation); ✓ synthetic draft typed into composer ([synthetic] Which synthetic sources support the D1 cohort OR); … |
| `before_results_panel_1440x900_zh-CN.png` | old shell Results group / Insights outcomes pane | 1440x900 | zh-CN | light | NOT_APPLICABLE | ✓ old shell Results group nav rendered |
| `before_activity_panel_1440x900_zh-CN.png` | old shell Activity Center / tasks panel (synthetic job) | 1440x900 | zh-CN | light | NOT_APPLICABLE | ✓ activity center opened; ✓ synthetic job card rendered (count=5) |
| `before_default_two_column_1024x768_en-US.png` | default two-column / host header + old shell workbench | 1024x768 | en-US | light | PASS | ✓ real host app header rendered ("Research workspace" + account) (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header repeats project identity (old host behaviour); ✓ no host language switch (Before limitation) (count=0); ✓ old shel… |
| `before_host_header_1024x768_en-US.png` | host Research page header (real host app) | 1024x768 | en-US | light | PASS | ✓ host header shows "Research workspace" label (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header shows project name (Before); ✓ host header shows account + Sign out (Research workspace [synthetic] D1 cohort evidence project sy); … |
| `before_sources_panel_1024x768_en-US.png` | left sources panel (old shell Materials/Sources) | 1024x768 | en-US | light | PASS | ✓ sources pane rows rendered (count=2); ✓ scope editor visible; ✓ no horizontal page scroll (1024/1024) |
| `before_chat_1024x768_en-US.png` | central conversation (old shell Evidence/Research Chat tab) | 1024x768 | en-US | light | PASS | ✓ Research Chat tab became active (Research Chat); ✓ synthetic global session created (composer reachable); ✓ chat composer rendered (empty conversation); ✓ synthetic draft typed into composer ([synthetic] Which synthetic sources support the D1 cohort OR); … |
| `before_results_panel_1024x768_en-US.png` | old shell Results group / Insights outcomes pane | 1024x768 | en-US | light | PASS | ✓ old shell Results group nav rendered |
| `before_activity_panel_1024x768_en-US.png` | old shell Activity Center / tasks panel (synthetic job) | 1024x768 | en-US | light | PASS | ✓ activity center opened; ✓ synthetic job card rendered (count=5) |
| `before_default_two_column_1024x768_zh-CN.png` | default two-column / host header + old shell workbench | 1024x768 | zh-CN | light | NOT_APPLICABLE | ✓ real host app header rendered ("Research workspace" + account) (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header repeats project identity (old host behaviour); ✓ no host language switch (Before limitation) (count=0); ✓ old shel… |
| `before_host_header_1024x768_zh-CN.png` | host Research page header (real host app) | 1024x768 | zh-CN | light | NOT_APPLICABLE | ✓ host header shows "Research workspace" label (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header shows project name (Before); ✓ host header shows account + Sign out (Research workspace [synthetic] D1 cohort evidence project sy); … |
| `before_sources_panel_1024x768_zh-CN.png` | left sources panel (old shell Materials/Sources) | 1024x768 | zh-CN | light | NOT_APPLICABLE | ✓ sources pane rows rendered (count=2); ✓ scope editor visible; ✓ no horizontal page scroll (1024/1024) |
| `before_chat_1024x768_zh-CN.png` | central conversation (old shell Evidence/Research Chat tab) | 1024x768 | zh-CN | light | NOT_APPLICABLE | ✓ Research Chat tab became active (Research Chat); ✓ synthetic global session created (composer reachable); ✓ chat composer rendered (empty conversation); ✓ synthetic draft typed into composer ([synthetic] Which synthetic sources support the D1 cohort OR); … |
| `before_results_panel_1024x768_zh-CN.png` | old shell Results group / Insights outcomes pane | 1024x768 | zh-CN | light | NOT_APPLICABLE | ✓ old shell Results group nav rendered |
| `before_activity_panel_1024x768_zh-CN.png` | old shell Activity Center / tasks panel (synthetic job) | 1024x768 | zh-CN | light | NOT_APPLICABLE | ✓ activity center opened; ✓ synthetic job card rendered (count=5) |
| `before_default_two_column_1440x900_en-US_dark.png` | default two-column / host header + old shell workbench | 1440x900 | en-US | dark | PASS | ✓ real host app header rendered ("Research workspace" + account) (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header repeats project identity (old host behaviour); ✓ no host language switch (Before limitation) (count=0); ✓ old shel… |
| `before_host_header_1440x900_en-US_dark.png` | host Research page header (real host app) | 1440x900 | en-US | dark | PASS | ✓ host header shows "Research workspace" label (Research workspace [synthetic] D1 cohort evidence project sy); ✓ host header shows project name (Before); ✓ host header shows account + Sign out (Research workspace [synthetic] D1 cohort evidence project sy); … |
| `before_sources_panel_1440x900_en-US_dark.png` | left sources panel (old shell Materials/Sources) | 1440x900 | en-US | dark | PASS | ✓ sources pane rows rendered (count=2); ✓ scope editor visible; ✓ no horizontal page scroll (1440/1440) |
| `before_chat_1440x900_en-US_dark.png` | central conversation (old shell Evidence/Research Chat tab) | 1440x900 | en-US | dark | PASS | ✓ Research Chat tab became active (Research Chat); ✓ synthetic global session created (composer reachable); ✓ chat composer rendered (empty conversation); ✓ synthetic draft typed into composer ([synthetic] Which synthetic sources support the D1 cohort OR); … |
| `before_results_panel_1440x900_en-US_dark.png` | old shell Results group / Insights outcomes pane | 1440x900 | en-US | dark | PASS | ✓ old shell Results group nav rendered |
| `before_activity_panel_1440x900_en-US_dark.png` | old shell Activity Center / tasks panel (synthetic job) | 1440x900 | en-US | dark | PASS | ✓ activity center opened; ✓ synthetic job card rendered (count=5) |

**Before 口径**：5 个上下文（1440/1024 × en-US/zh-CN + 1440 dark）× 6 场景。`default_two_column`=宿主页头+旧壳默认工作台（五 Tab）；`host_header`=宿主页头特写；`sources_panel`=左资料栏；`chat`=中央对话（空会话 + composer 草稿）；`results_panel`=旧壳 Results/Insights；`activity_panel`=旧壳 Activity Center/任务面板。

**zh-CN 行**：Before 无 zh-CN 能力（宿主 main 无语言切换；fork embedded 固定 en-US），状态记 **NOT_APPLICABLE**，`ui_language_actual=en-US`，截图与 en-US 相同；不记为 pass，不作为 zh-CN 能力证据。

## 6. After 场景清单与断言

| 截图文件 | 场景 | 视口 | 请求语言 | 主题 | 状态 | 关键断言 |
|-|-|-|-|-|-|-|
| `after_default_two_column_1440x900_en-US.png` | target shell default two-column (host header + topbar + sources + conversation + composer) | 1440x900 | en-US | light | PASS | ✓ host header has NO project name (D-UI-01) (Legacy workspace 中文 English synthetic-owner Sign out); ✓ host header has zh-CN/en-US language select (count=1 value=en-US); ✓ host header has legacy-workspace secondary entry (D-UI-05) (Legacy workspace aria=Lega… |
| `after_host_header_1440x900_en-US.png` | host Research page header (language switch + legacy entry, no project name) | 1440x900 | en-US | light | PASS | ✓ host header does NOT repeat project name or generic brand (D-UI-01) (Legacy workspace 中文 English synthetic-owner Sign out); ✓ host header language select present with persisted value (value=en-US); ✓ host header legacy entry visible with mode-describing a… |
| `after_right_pane_open_1440x900_en-US.png` | side panel open (outcomes catalog) — 1440 three columns / 1024 right pane replaces left pane | 1440x900 | en-US | light | PASS | ✓ right pane visible (outcomes panel) (width=355); ✓ wide: left pane stays visible (three columns) (asideHidden=false width=282); ✓ compact: left pane temporarily collapsed (right replaces left) (collapsed=false hidden=false); ✓ compact: composer shows comp… |
| `after_right_pane_closed_1440x900_en-US.png` | side panel closed with Esc — focus returns to trigger, left pane restored (compact) | 1440x900 | en-US | light | PASS | ✓ Esc closed the right pane; ✓ left pane restored after close (hidden=false width=282); ✓ focus returned to triggering control (outcomes trigger) (active=rdlens-target-outcomes-trigger); ✓ no horizontal page scroll (1440/1440) |
| `after_right_pane_tasks_1440x900_en-US.png` | side panel open (task history) | 1440x900 | en-US | light | PASS | ✓ right pane visible (task history) (open=true); ✓ task history panel rendered; ✓ no horizontal page scroll |
| `after_sources_selected_1440x900_en-US.png` | sources pane — selected scope (one source checked) | 1440x900 | en-US | light | PASS | ✓ checking a source switched scope to selected ({"selectedChecked":true,"allChecked":false,"summary":"CURREN); ✓ scope summary reflects selection (CURRENT SCOPE 1 sources); ✓ no horizontal page scroll |
| `after_sources_selected_empty_1440x900_en-US.png` | sources pane — empty selected scope (blocked data query, BEH-03) | 1440x900 | en-US | light | PASS | ✓ selected scope cleared to empty via UI (gateHint=Select at least one source to ask about your source); ✓ blocked block visible (rdlens-target-scope-blocked); ✓ block offers next steps (choose sources / switch to all); ✓ blocked reason shown before submit … |
| `after_sources_clear_via_ui_1440x900_en-US.png` | sources pane — clear selection via UI (BEH-03 / §9.3-2 walkthrough path) | 1440x900 | en-US | light | PASS | ✓ UI clear path reachable (can uncheck the last selected source) (remaining=src_2 disabled=false :: empty selected reached and) |
| `after_sources_scope_all_1440x900_en-US.png` | sources pane — all available sources scope (default) | 1440x900 | en-US | light | PASS | ✓ scope=all checked, no selected rows ({"allChecked":true,"selectedChecked":false,"checkedRows":0,"); ✓ no blocked state under all scope; ✓ scope summary reflects all-available scope (CURRENT SCOPE All available sources); ✓ no horizontal page scroll |
| `after_empty_conversation_1440x900_en-US.png` | empty conversation (target shell) | 1440x900 | en-US | light | PASS | ✓ conversation title fallback shown (Conversation); ✓ message area empty (no turns) (Ask a question about the selected sources and notes.); ✓ composer present with empty-draft hint (Ask about your sources…); ✓ no horizontal page scroll |
| `after_legacy_old_shell_1440x900_en-US.png` | legacy=1 old shell via host header secondary entry (D-UI-05) | 1440x900 | en-US | light | PASS | ✓ page mode is legacy (mode=legacy); ✓ iframe src carries legacy=1 (http://127.0.0.1:3011/research?legacy=1); ✓ old shell five main-action tabs rendered (count=5); ✓ host header now offers target-workspace return (Target workspace aria=Target workspace (cur… |
| `after_legacy_return_target_1440x900_en-US.png` | return from legacy to target shell (D-UI-05) | 1440x900 | en-US | light | PASS | ✓ page mode back to target (mode=target); ✓ iframe src no longer carries legacy=1; ✓ host header back to legacy entry (Legacy workspace aria=Legacy workspace (currently target wor); ✓ target shell states preserved (sources rows + composer) (rows=2) |
| `after_default_two_column_1440x900_zh-CN.png` | target shell default two-column (host header + topbar + sources + conversation + composer) | 1440x900 | zh-CN | light | PASS | ✓ host header has NO project name (D-UI-01) (旧版工作台 中文 English synthetic-owner 退出); ✓ host header has zh-CN/en-US language select (count=1 value=zh-CN); ✓ host header has legacy-workspace secondary entry (D-UI-05) (旧版工作台 aria=旧版工作台（当前为目标版，点击切换）); ✓ host head… |
| `after_host_header_1440x900_zh-CN.png` | host Research page header (language switch + legacy entry, no project name) | 1440x900 | zh-CN | light | PASS | ✓ host header does NOT repeat project name or generic brand (D-UI-01) (旧版工作台 中文 English synthetic-owner 退出); ✓ host header language select present with persisted value (value=zh-CN); ✓ host header legacy entry visible with mode-describing aria-label (旧版工作台 … |
| `after_right_pane_open_1440x900_zh-CN.png` | side panel open (outcomes catalog) — 1440 three columns / 1024 right pane replaces left pane | 1440x900 | zh-CN | light | PASS | ✓ right pane visible (outcomes panel) (width=355); ✓ wide: left pane stays visible (three columns) (asideHidden=false width=282); ✓ compact: left pane temporarily collapsed (right replaces left) (collapsed=false hidden=false); ✓ compact: composer shows comp… |
| `after_right_pane_closed_1440x900_zh-CN.png` | side panel closed with Esc — focus returns to trigger, left pane restored (compact) | 1440x900 | zh-CN | light | PASS | ✓ Esc closed the right pane; ✓ left pane restored after close (hidden=false width=282); ✓ focus returned to triggering control (outcomes trigger) (active=rdlens-target-outcomes-trigger); ✓ no horizontal page scroll (1440/1440) |
| `after_right_pane_tasks_1440x900_zh-CN.png` | side panel open (task history) | 1440x900 | zh-CN | light | PASS | ✓ right pane visible (task history) (open=true); ✓ task history panel rendered; ✓ no horizontal page scroll |
| `after_sources_selected_1440x900_zh-CN.png` | sources pane — selected scope (one source checked) | 1440x900 | zh-CN | light | PASS | ✓ checking a source switched scope to selected ({"selectedChecked":true,"allChecked":false,"summary":"当前范围 1); ✓ scope summary reflects selection (当前范围 1 sources); ✓ no horizontal page scroll |
| `after_sources_selected_empty_1440x900_zh-CN.png` | sources pane — empty selected scope (blocked data query, BEH-03) | 1440x900 | zh-CN | light | PASS | ✓ selected scope cleared to empty via UI (gateHint=请至少选择一份资料后再就资料提问，或切回全部可用资料。); ✓ blocked block visible (rdlens-target-scope-blocked); ✓ block offers next steps (choose sources / switch to all); ✓ blocked reason shown before submit (请至少选择一份资料后再就资料提问，或切回全部可… |
| `after_sources_clear_via_ui_1440x900_zh-CN.png` | sources pane — clear selection via UI (BEH-03 / §9.3-2 walkthrough path) | 1440x900 | zh-CN | light | PASS | ✓ UI clear path reachable (can uncheck the last selected source) (remaining=src_2 disabled=false :: empty selected reached and) |
| `after_sources_scope_all_1440x900_zh-CN.png` | sources pane — all available sources scope (default) | 1440x900 | zh-CN | light | PASS | ✓ scope=all checked, no selected rows ({"allChecked":true,"selectedChecked":false,"checkedRows":0,"); ✓ no blocked state under all scope; ✓ scope summary reflects all-available scope (当前范围 全部可用资料); ✓ no horizontal page scroll |
| `after_empty_conversation_1440x900_zh-CN.png` | empty conversation (target shell) | 1440x900 | zh-CN | light | PASS | ✓ conversation title fallback shown (对话); ✓ message area empty (no turns) (就选中的来源与笔记提问。); ✓ composer present with empty-draft hint (就你的来源提问…); ✓ no horizontal page scroll |
| `after_legacy_old_shell_1440x900_zh-CN.png` | legacy=1 old shell via host header secondary entry (D-UI-05) | 1440x900 | zh-CN | light | PASS | ✓ page mode is legacy (mode=legacy); ✓ iframe src carries legacy=1 (http://127.0.0.1:3011/research?legacy=1); ✓ old shell five main-action tabs rendered (count=5); ✓ host header now offers target-workspace return (目标版工作台 aria=目标版工作台（当前为旧版，点击返回）) |
| `after_legacy_return_target_1440x900_zh-CN.png` | return from legacy to target shell (D-UI-05) | 1440x900 | zh-CN | light | PASS | ✓ page mode back to target (mode=target); ✓ iframe src no longer carries legacy=1; ✓ host header back to legacy entry (旧版工作台 aria=旧版工作台（当前为目标版，点击切换）); ✓ target shell states preserved (sources rows + composer) (rows=2) |
| `after_default_two_column_1024x768_en-US.png` | target shell default two-column (host header + topbar + sources + conversation + composer) | 1024x768 | en-US | light | PASS | ✓ host header has NO project name (D-UI-01) (Legacy workspace 中文 English synthetic-owner Sign out); ✓ host header has zh-CN/en-US language select (count=1 value=en-US); ✓ host header has legacy-workspace secondary entry (D-UI-05) (Legacy workspace aria=Lega… |
| `after_host_header_1024x768_en-US.png` | host Research page header (language switch + legacy entry, no project name) | 1024x768 | en-US | light | PASS | ✓ host header does NOT repeat project name or generic brand (D-UI-01) (Legacy workspace 中文 English synthetic-owner Sign out); ✓ host header language select present with persisted value (value=en-US); ✓ host header legacy entry visible with mode-describing a… |
| `after_right_pane_open_1024x768_en-US.png` | side panel open (outcomes catalog) — 1440 three columns / 1024 right pane replaces left pane | 1024x768 | en-US | light | PASS | ✓ right pane visible (outcomes panel) (width=355); ✓ wide: left pane stays visible (three columns) (asideHidden=true width=0); ✓ compact: left pane temporarily collapsed (right replaces left) (collapsed=true hidden=true); ✓ compact: composer shows compact s… |
| `after_right_pane_closed_1024x768_en-US.png` | side panel closed with Esc — focus returns to trigger, left pane restored (compact) | 1024x768 | en-US | light | PASS | ✓ Esc closed the right pane; ✓ left pane restored after close (hidden=false width=282); ✓ focus returned to triggering control (outcomes trigger) (active=rdlens-target-outcomes-trigger); ✓ no horizontal page scroll (1024/1024) |
| `after_right_pane_tasks_1024x768_en-US.png` | side panel open (task history) | 1024x768 | en-US | light | PASS | ✓ right pane visible (task history) (open=true); ✓ task history panel rendered; ✓ no horizontal page scroll |
| `after_sources_selected_1024x768_en-US.png` | sources pane — selected scope (one source checked) | 1024x768 | en-US | light | PASS | ✓ checking a source switched scope to selected ({"selectedChecked":true,"allChecked":false,"summary":"CURREN); ✓ scope summary reflects selection (CURRENT SCOPE 1 sources); ✓ no horizontal page scroll |
| `after_sources_selected_empty_1024x768_en-US.png` | sources pane — empty selected scope (blocked data query, BEH-03) | 1024x768 | en-US | light | PASS | ✓ selected scope cleared to empty via UI (gateHint=Select at least one source to ask about your source); ✓ blocked block visible (rdlens-target-scope-blocked); ✓ block offers next steps (choose sources / switch to all); ✓ blocked reason shown before submit … |
| `after_sources_clear_via_ui_1024x768_en-US.png` | sources pane — clear selection via UI (BEH-03 / §9.3-2 walkthrough path) | 1024x768 | en-US | light | PASS | ✓ UI clear path reachable (can uncheck the last selected source) (remaining=src_2 disabled=false :: empty selected reached and) |
| `after_sources_scope_all_1024x768_en-US.png` | sources pane — all available sources scope (default) | 1024x768 | en-US | light | PASS | ✓ scope=all checked, no selected rows ({"allChecked":true,"selectedChecked":false,"checkedRows":0,"); ✓ no blocked state under all scope; ✓ scope summary reflects all-available scope (CURRENT SCOPE All available sources); ✓ no horizontal page scroll |
| `after_empty_conversation_1024x768_en-US.png` | empty conversation (target shell) | 1024x768 | en-US | light | PASS | ✓ conversation title fallback shown (Conversation); ✓ message area empty (no turns) (Ask a question about the selected sources and notes.); ✓ composer present with empty-draft hint (Ask about your sources…); ✓ no horizontal page scroll |
| `after_legacy_old_shell_1024x768_en-US.png` | legacy=1 old shell via host header secondary entry (D-UI-05) | 1024x768 | en-US | light | PASS | ✓ page mode is legacy (mode=legacy); ✓ iframe src carries legacy=1 (http://127.0.0.1:3011/research?legacy=1); ✓ old shell five main-action tabs rendered (count=5); ✓ host header now offers target-workspace return (Target workspace aria=Target workspace (cur… |
| `after_legacy_return_target_1024x768_en-US.png` | return from legacy to target shell (D-UI-05) | 1024x768 | en-US | light | PASS | ✓ page mode back to target (mode=target); ✓ iframe src no longer carries legacy=1; ✓ host header back to legacy entry (Legacy workspace aria=Legacy workspace (currently target wor); ✓ target shell states preserved (sources rows + composer) (rows=2) |
| `after_default_two_column_1024x768_zh-CN.png` | target shell default two-column (host header + topbar + sources + conversation + composer) | 1024x768 | zh-CN | light | PASS | ✓ host header has NO project name (D-UI-01) (旧版工作台 中文 English synthetic-owner 退出); ✓ host header has zh-CN/en-US language select (count=1 value=zh-CN); ✓ host header has legacy-workspace secondary entry (D-UI-05) (旧版工作台 aria=旧版工作台（当前为目标版，点击切换）); ✓ host head… |
| `after_host_header_1024x768_zh-CN.png` | host Research page header (language switch + legacy entry, no project name) | 1024x768 | zh-CN | light | PASS | ✓ host header does NOT repeat project name or generic brand (D-UI-01) (旧版工作台 中文 English synthetic-owner 退出); ✓ host header language select present with persisted value (value=zh-CN); ✓ host header legacy entry visible with mode-describing aria-label (旧版工作台 … |
| `after_right_pane_open_1024x768_zh-CN.png` | side panel open (outcomes catalog) — 1440 three columns / 1024 right pane replaces left pane | 1024x768 | zh-CN | light | PASS | ✓ right pane visible (outcomes panel) (width=355); ✓ wide: left pane stays visible (three columns) (asideHidden=true width=0); ✓ compact: left pane temporarily collapsed (right replaces left) (collapsed=true hidden=true); ✓ compact: composer shows compact s… |
| `after_right_pane_closed_1024x768_zh-CN.png` | side panel closed with Esc — focus returns to trigger, left pane restored (compact) | 1024x768 | zh-CN | light | PASS | ✓ Esc closed the right pane; ✓ left pane restored after close (hidden=false width=282); ✓ focus returned to triggering control (outcomes trigger) (active=rdlens-target-outcomes-trigger); ✓ no horizontal page scroll (1024/1024) |
| `after_right_pane_tasks_1024x768_zh-CN.png` | side panel open (task history) | 1024x768 | zh-CN | light | PASS | ✓ right pane visible (task history) (open=true); ✓ task history panel rendered; ✓ no horizontal page scroll |
| `after_sources_selected_1024x768_zh-CN.png` | sources pane — selected scope (one source checked) | 1024x768 | zh-CN | light | PASS | ✓ checking a source switched scope to selected ({"selectedChecked":true,"allChecked":false,"summary":"当前范围 1); ✓ scope summary reflects selection (当前范围 1 sources); ✓ no horizontal page scroll |
| `after_sources_selected_empty_1024x768_zh-CN.png` | sources pane — empty selected scope (blocked data query, BEH-03) | 1024x768 | zh-CN | light | PASS | ✓ selected scope cleared to empty via UI (gateHint=请至少选择一份资料后再就资料提问，或切回全部可用资料。); ✓ blocked block visible (rdlens-target-scope-blocked); ✓ block offers next steps (choose sources / switch to all); ✓ blocked reason shown before submit (请至少选择一份资料后再就资料提问，或切回全部可… |
| `after_sources_clear_via_ui_1024x768_zh-CN.png` | sources pane — clear selection via UI (BEH-03 / §9.3-2 walkthrough path) | 1024x768 | zh-CN | light | PASS | ✓ UI clear path reachable (can uncheck the last selected source) (remaining=src_2 disabled=false :: empty selected reached and) |
| `after_sources_scope_all_1024x768_zh-CN.png` | sources pane — all available sources scope (default) | 1024x768 | zh-CN | light | PASS | ✓ scope=all checked, no selected rows ({"allChecked":true,"selectedChecked":false,"checkedRows":0,"); ✓ no blocked state under all scope; ✓ scope summary reflects all-available scope (当前范围 全部可用资料); ✓ no horizontal page scroll |
| `after_empty_conversation_1024x768_zh-CN.png` | empty conversation (target shell) | 1024x768 | zh-CN | light | PASS | ✓ conversation title fallback shown (对话); ✓ message area empty (no turns) (就选中的来源与笔记提问。); ✓ composer present with empty-draft hint (就你的来源提问…); ✓ no horizontal page scroll |
| `after_legacy_old_shell_1024x768_zh-CN.png` | legacy=1 old shell via host header secondary entry (D-UI-05) | 1024x768 | zh-CN | light | PASS | ✓ page mode is legacy (mode=legacy); ✓ iframe src carries legacy=1 (http://127.0.0.1:3011/research?legacy=1); ✓ old shell five main-action tabs rendered (count=5); ✓ host header now offers target-workspace return (目标版工作台 aria=目标版工作台（当前为旧版，点击返回）) |
| `after_legacy_return_target_1024x768_zh-CN.png` | return from legacy to target shell (D-UI-05) | 1024x768 | zh-CN | light | PASS | ✓ page mode back to target (mode=target); ✓ iframe src no longer carries legacy=1; ✓ host header back to legacy entry (旧版工作台 aria=旧版工作台（当前为目标版，点击切换）); ✓ target shell states preserved (sources rows + composer) (rows=2) |
| `after_default_two_column_1440x900_en-US_dark.png` | target shell default two-column (host header + topbar + sources + conversation + composer) | 1440x900 | en-US | dark | PASS | ✓ host header has NO project name (D-UI-01) (Legacy workspace 中文 English synthetic-owner Sign out); ✓ host header has zh-CN/en-US language select (count=1 value=en-US); ✓ host header has legacy-workspace secondary entry (D-UI-05) (Legacy workspace aria=Lega… |
| `after_host_header_1440x900_en-US_dark.png` | host Research page header (language switch + legacy entry, no project name) | 1440x900 | en-US | dark | PASS | ✓ host header does NOT repeat project name or generic brand (D-UI-01) (Legacy workspace 中文 English synthetic-owner Sign out); ✓ host header language select present with persisted value (value=en-US); ✓ host header legacy entry visible with mode-describing a… |
| `after_right_pane_open_1440x900_en-US_dark.png` | side panel open (outcomes catalog) — 1440 three columns / 1024 right pane replaces left pane | 1440x900 | en-US | dark | PASS | ✓ right pane visible (outcomes panel) (width=355); ✓ wide: left pane stays visible (three columns) (asideHidden=false width=282); ✓ compact: left pane temporarily collapsed (right replaces left) (collapsed=false hidden=false); ✓ compact: composer shows comp… |
| `after_right_pane_closed_1440x900_en-US_dark.png` | side panel closed with Esc — focus returns to trigger, left pane restored (compact) | 1440x900 | en-US | dark | PASS | ✓ Esc closed the right pane; ✓ left pane restored after close (hidden=false width=282); ✓ focus returned to triggering control (outcomes trigger) (active=rdlens-target-outcomes-trigger); ✓ no horizontal page scroll (1440/1440) |
| `after_right_pane_tasks_1440x900_en-US_dark.png` | side panel open (task history) | 1440x900 | en-US | dark | PASS | ✓ right pane visible (task history) (open=true); ✓ task history panel rendered; ✓ no horizontal page scroll |
| `after_sources_selected_1440x900_en-US_dark.png` | sources pane — selected scope (one source checked) | 1440x900 | en-US | dark | PASS | ✓ checking a source switched scope to selected ({"selectedChecked":true,"allChecked":false,"summary":"CURREN); ✓ scope summary reflects selection (CURRENT SCOPE 1 sources); ✓ no horizontal page scroll |
| `after_sources_selected_empty_1440x900_en-US_dark.png` | sources pane — empty selected scope (blocked data query, BEH-03) | 1440x900 | en-US | dark | PASS | ✓ selected scope cleared to empty via UI (gateHint=Select at least one source to ask about your source); ✓ blocked block visible (rdlens-target-scope-blocked); ✓ block offers next steps (choose sources / switch to all); ✓ blocked reason shown before submit … |
| `after_sources_clear_via_ui_1440x900_en-US_dark.png` | sources pane — clear selection via UI (BEH-03 / §9.3-2 walkthrough path) | 1440x900 | en-US | dark | PASS | ✓ UI clear path reachable (can uncheck the last selected source) (remaining=src_2 disabled=false :: empty selected reached and) |
| `after_sources_scope_all_1440x900_en-US_dark.png` | sources pane — all available sources scope (default) | 1440x900 | en-US | dark | PASS | ✓ scope=all checked, no selected rows ({"allChecked":true,"selectedChecked":false,"checkedRows":0,"); ✓ no blocked state under all scope; ✓ scope summary reflects all-available scope (CURRENT SCOPE All available sources); ✓ no horizontal page scroll |
| `after_empty_conversation_1440x900_en-US_dark.png` | empty conversation (target shell) | 1440x900 | en-US | dark | PASS | ✓ conversation title fallback shown (Conversation); ✓ message area empty (no turns) (Ask a question about the selected sources and notes.); ✓ composer present with empty-draft hint (Ask about your sources…); ✓ no horizontal page scroll |
| `after_legacy_old_shell_1440x900_en-US_dark.png` | legacy=1 old shell via host header secondary entry (D-UI-05) | 1440x900 | en-US | dark | PASS | ✓ page mode is legacy (mode=legacy); ✓ iframe src carries legacy=1 (http://127.0.0.1:3011/research?legacy=1); ✓ old shell five main-action tabs rendered (count=5); ✓ host header now offers target-workspace return (Target workspace aria=Target workspace (cur… |
| `after_legacy_return_target_1440x900_en-US_dark.png` | return from legacy to target shell (D-UI-05) | 1440x900 | en-US | dark | PASS | ✓ page mode back to target (mode=target); ✓ iframe src no longer carries legacy=1; ✓ host header back to legacy entry (Legacy workspace aria=Legacy workspace (currently target wor); ✓ target shell states preserved (sources rows + composer) (rows=2) |
| `after_language_switch_before_1440x900_en-US.png` | language switch — en-US loaded (state to preserve: draft + selected scope) | 1440x900 | en-US | light | PASS | ✓ loaded in en-US (en-US); ✓ draft typed before switch; ✓ selected-source scope set before switch |
| `after_language_switch_after_1440x900_zh-CN.png` | language switch — host zh-CN selected, workbench text immediately zh-CN, state retained | 1440x900 | zh-CN | light | PASS | ✓ workbench text switched to zh-CN (zh-CN); ✓ host header switched to zh-CN (select=zh-CN legacy=旧版工作台); ✓ composer draft retained across switch ([synthetic] Which synthetic sources support the D1 cohort OR); ✓ scope selection retained across switch (null);… |
| `(no screenshot: assertion-only scene)` | language switch — back to en-US | 1440x900 | en-US | light | PASS | ✓ workbench text switched back to en-US (en-US); ✓ composer draft retained across second switch ([synthetic] Which synthetic sources support the D1 cohort OR) |

**After 口径**：5 个上下文（1440/1024 × en-US/zh-CN + 1440 dark）× 12 场景 + 语言切换 3 张：

| 场景前缀 | 内容 |
|-|-|
| `default_two_column` | 目标壳默认两栏：宿主页头（无项目名/语言切换/旧版入口）+ 72px 顶栏（项目名/模型/任务/成果）+ 282px 左资料栏 + 中央对话 + composer |
| `host_header` | 宿主页头特写（语言 `<select>`、旧版/目标版入口、账户、无项目名） |
| `right_pane_open` | 右栏打开（成果目录）：1440 三栏（左栏保留）；1024 右栏替代左栏（左栏 aria-hidden、composer 紧凑范围标签） |
| `right_pane_closed` | `Esc` 关闭右栏：焦点返回触发控件、1024 左栏恢复 |
| `right_pane_tasks` | 右栏任务历史面板（与 Before Activity 面板配对） |
| `sources_selected` / `sources_selected_empty` / `sources_clear_via_ui` / `sources_scope_all` | 资料栏 all / selected / UI 清空到空 selected（阻断块 `rdlens-target-scope-blocked` + 功能按钮 + send 禁用）/ 恢复 all |
| `empty_conversation` | 空对话（标题 fallback + 空消息区 + composer 空输入提示） |
| `legacy_old_shell` / `legacy_return_target` | 宿主「旧版工作台」→ iframe `legacy=1` 旧壳（五 Tab）；再点「目标版工作台」恢复目标壳（D-UI-05） |
| `language_switch_before` / `language_switch_after` | en-US 载入（composer 草稿 + selected 范围）→ 宿主页头切 zh-CN → 工作台文案即时中文、草稿/范围保留；再切回 en-US 仍保留 |

## 7. 键盘可达走查（After）

- 总判定：**PASS**；9 项。

| ID | 检查项 | 结果 | 细节 |
|-|-|-|-|
| KB-01 | Tab 顺序：宿主页头先于 iframe 工作台；页头内 返回→旧版切换→语言→退出 均可达 | **PASS** | hostSteps=Back to RDLens / Legacy workspace (currently target workspace, activate to switch) / Language / Sign out firstChildStep=5 |
| KB-02 | 工作台内 Tab 顺序：skip link → 顶栏 → 左资料栏 → 对话 → composer（单调不倒退） | **PASS** | skip-link → topbar → topbar → topbar → sources → sources → sources → sources → sources → sources → sources → conversation → conversation → composer → composer → composer |
| KB-03 | 五类焦点区域均可达（skip link / 顶栏 / 资料栏 / 对话 / composer） | **PASS** | skip-link, topbar, sources, conversation, composer |
| KB-04 | skip link 指向 composer 且 Enter 后焦点进入 composer 区域 | **PASS** | href=#rdlens-target-composer focused=true / afterEnter=composer/rdlens-target-composer |
| KB-05 | 焦点环可见（键盘聚焦控件 :focus-visible 且 ring/outline 非 none） | **PASS** | global-model-summary-trigger focusVisible=true shadow=rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, oklab(0.497701 -0.0845774 -0.00596708 / 0.484401) 0px 0px  outline=2px |
| KB-06 | 右栏打开时焦点进入面板；Esc 关闭后焦点返回触发控件 | **PASS** | openFocus=right-pane/rdlens-target-right-pane-close closed=true closedFocus=rdlens-target-outcomes-trigger |
| KB-07 | 1440 无横向页面滚动（默认两栏 + 右栏打开三栏） | **PASS** | default host=1440/1440 fork=1440/1440; open fork=1440/1440 |
| KB-08 | 1024 无横向页面滚动（默认两栏 + 右栏替代左栏；中央列 ≥640px） | **PASS** | default fork=1024/1024; open fork=1024/1024 main=669 |
| KB-09 | 1024 右栏打开时左栏临时收起、右栏 355px、composer 显示范围紧凑标签 | **PASS** | {"asideWidth":0,"asideHidden":true,"rightWidth":355,"mainWidth":669,"chipVisible":true} |

Tab 顺序（1440×900、en-US、light）：宿主页头（返回→旧版切换→语言→退出）→ iframe skip link → 顶栏 → 左资料栏 → 对话 → composer；`Esc` 关闭右栏焦点回触发控件；焦点环 2px evidence 可见；1024/1440（含右栏打开）无横向滚动。

## 8. 复现（一键命令）

先决条件：Node 22；两个 base 仓库；fork `frontend/node_modules`（lock `e802ac73…`）与 host `frontend/node_modules`；Chromium `chromium-1243`；`playwright-core` 使用本机既有安装。**未执行 npm install/ci**。

```bash
VE=/home/lchen/.dsh/state/superagent/work/wave-one-shell-bddcfc523569/evidence
TICKET=/home/lchen/.dsh/state/superagent/work/wave-one-shell-bddcfc523569

# Before/After worktrees（detached）
git -C /home/lchen/workspace/open-notebook-rdlens worktree add --detach $VE/worktrees/fork-before 2db87a8e2ccbed82acd321529f70a7b150c8d398
git -C /home/lchen/workspace/RDLens worktree add --detach $VE/worktrees/host-before 53e9b87b73fb12b60bf01d7fd217b9c7e57c657e
git -C /home/lchen/workspace/open-notebook-rdlens worktree add --detach $VE/worktrees/fork-after 476b1b26a1312fd143662ec28001de3244963e87
git -C /home/lchen/workspace/RDLens worktree add --detach $VE/worktrees/host-after d6da1a64b8ab8779e8a74b7c88fafc7bf6b87fdb
cp -al "$TICKET/fork/frontend/node_modules" $VE/worktrees/fork-before/frontend/node_modules
cp -al "$TICKET/fork/frontend/node_modules" $VE/worktrees/fork-after/frontend/node_modules
cp -al /home/lchen/workspace/RDLens/frontend/node_modules $VE/worktrees/host-before/frontend/node_modules
cp -al /home/lchen/workspace/RDLens/frontend/node_modules $VE/worktrees/host-after/frontend/node_modules

# harness-only 改动（见 §4.1；等价于 logs/harness-only-*.patch + .env.local）

# 合成 mock（host API + Research Gateway）
node $VE/harness/mock_server.js 8099

# Before 宿主/fork dev server
(cd $VE/worktrees/host-before/frontend && RD_MOCK_API_URL=http://127.0.0.1:8099 ./node_modules/.bin/vite --port 5174 --strictPort)
(cd $VE/worktrees/fork-before/frontend && NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 NEXT_PUBLIC_RD_EMBEDDED_MODE=1 NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:8099 NEXT_PUBLIC_RD_PARENT_ORIGIN=http://127.0.0.1:5174 ./node_modules/.bin/next dev --webpack -p 3010)
node $VE/harness/capture.js before http://127.0.0.1:5174/

# After 宿主/fork dev server
(cd $VE/worktrees/host-after/frontend && RD_MOCK_API_URL=http://127.0.0.1:8099 ./node_modules/.bin/vite --port 5175 --strictPort)
(cd $VE/worktrees/fork-after/frontend && NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 NEXT_PUBLIC_RD_EMBEDDED_MODE=1 NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:8099 NEXT_PUBLIC_RD_PARENT_ORIGIN=http://127.0.0.1:5175 ./node_modules/.bin/next dev --webpack -p 3011)
node $VE/harness/capture.js after http://127.0.0.1:5175/
AFTER_HOST_URL=http://127.0.0.1:5175/ node $VE/harness/keyboard_walkthrough.js
node $VE/harness/build_manifest.js
python3 $VE/harness/gen_readme.py
```

## 9. 限制 / NOT RUN（如实登记）

- 证据层：真实应用渲染（RDLens 宿主 Vite 应用 + fork Next.js 嵌入式工作台）＋本地合成 API；非 L2 真实部署验收。synthetic 只作 smoke，不单独关闭 L2（UI 规格 v1 §9.2；issue #1104 要求 L2 真实 host+DB）。
- 无真实后端/PostgreSQL/SurrealDB/Research Gateway/模型调用；无真实凭据、无私有数据。宿主登录表单由真实 host 应用提交到本地 mock（synthetic-owner@example.invalid / synthetic-credential），bootstrap token 为未签名合成 JWT。
- 全部内容为 [synthetic]：项目名、doc_a/doc_b 资料、模型 Local Qwen (synthetic)、coverage 任务、模板与统计数字均由 fixtures 生成。
- Before 的 zh-CN 场景为 NOT_APPLICABLE（Before 无 zh 能力，界面实际 en-US）；该行截图与 en-US 相同，仅证明能力缺失，不构成 zh-CN 语言证据。
- Before 使用 detached worktree（fork origin/main 2db87a8 + 宿主 origin/main 53e9b87b7），After 使用同仓 agent/wave-one-shell-bddcfc523569 的 detached worktree（fork 476b1b2 / host d6da1a64b），均非部署实例。
- harness-only 本地改动（仅 evidence/worktrees，不提交、不进入实现分支，见 logs/harness-only-*.patch）：fork config.ts 三处动态 process.env[...] → 静态 NEXT_PUBLIC_*（Next 只内联静态成员）；宿主 vite.config.ts 代理目标改为 RD_MOCK_API_URL（默认 mock 8099）；宿主 frontend/.env.local 写入 VITE_RESEARCH_WORKSPACE_URL。
- dark 冒烟仅 1440（默认/页头/右栏/资料/对话/legacy 全场景），未采 1024 dark 与弹层 dark。
- 屏幕阅读器人工走查（O-UI-04）不在本轮范围（NOT RUN）；键盘走查为 headless Chromium Tab/Esc/焦点环/无横向滚动。
- 1024 旧壳五 Tab 行在 Before 出现既有横向滚动（Custom Analysis 截断），属旧壳行为；页面本身无横向滚动（已断言）。不判为 #1104 回归。
- 截图 SHA-256 仅用于本次交付溯源，不作跨环境像素基线；headless Chromium 字体栅格化会造成字节级差异。
- Before 场景中的 Results（Insights）为空态（mock 返回空列表），未构造非空洞察/运行结果；不把空态表述为真实数据。
- F1 预跑发现（空 selected UI 清空路径不可达）如实上报后由 fork-shell 修复（476b1b2）；最终 manifest 只含修复后 head 的 PASS 记录，预跑 FAIL 记录保留在 logs/prerun-F1-empty-selected-finding.md，不作为最终场景证据。
- 合成数据非真实 DB/宿主观测：本证据不能替代真实 host+DB 的 L2 验收，也不能作为 #1104 完成声明。
- **屏幕阅读器人工走查**（O-UI-04）不在本轮范围（NOT RUN）。
- **dark 冒烟**仅 1440（默认/页头/右栏/资料/对话/legacy 全场景同 light，但未采 1024 dark）。
- **真实网络/部署**：无真实 Gateway/DB/模型/外发；bootstrap token 未签名；本证据不构成 L2 验收，synthetic 不单独关闭 L2。

## 10. 交付去向与 raw URL

- 证据分支（仅证据文件，不并入 main）：
  - RDLens：`evidence/wave-one-shell-bddcfc523569` → `dev_docs/validation/issue1104/`（Before+After 全量截图、manifest、README、keyboard）
  - fork（open-notebook-rdlens）：`evidence/wave-one-shell-bddcfc523569` → `dev_docs/validation/issue1104/`（After 截图、manifest、README、keyboard）
- 提交 message：`evidence(#1104): ...`。

> **raw URL 形态**：RDLens 仓库为 **private**，`raw.githubusercontent.com` 匿名访问会返回 404；登录且有仓库权限时 GitHub 页面内的 `blob/...?raw=true` 链接可渲染。host PR 描述建议使用 `https://github.com/HiFiBiO-Therapeutics/RDLens/blob/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/<file>?raw=true`（或直接用仓库内相对路径）。fork 仓库为 public，raw URL 可直接嵌入 fork PR。

**raw.githubusercontent.com 清单**：

- fork 证据目录：https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots

| 截图 | RDLens raw | fork raw |
|-|-|-|
| `before_default_two_column_1440x900_en-US.png` | — | — |
| `before_host_header_1440x900_en-US.png` | — | — |
| `before_sources_panel_1440x900_en-US.png` | — | — |
| `before_chat_1440x900_en-US.png` | — | — |
| `before_results_panel_1440x900_en-US.png` | — | — |
| `before_activity_panel_1440x900_en-US.png` | — | — |
| `before_default_two_column_1440x900_zh-CN.png` | — | — |
| `before_host_header_1440x900_zh-CN.png` | — | — |
| `before_sources_panel_1440x900_zh-CN.png` | — | — |
| `before_chat_1440x900_zh-CN.png` | — | — |
| `before_results_panel_1440x900_zh-CN.png` | — | — |
| `before_activity_panel_1440x900_zh-CN.png` | — | — |
| `before_default_two_column_1024x768_en-US.png` | — | — |
| `before_host_header_1024x768_en-US.png` | — | — |
| `before_sources_panel_1024x768_en-US.png` | — | — |
| `before_chat_1024x768_en-US.png` | — | — |
| `before_results_panel_1024x768_en-US.png` | — | — |
| `before_activity_panel_1024x768_en-US.png` | — | — |
| `before_default_two_column_1024x768_zh-CN.png` | — | — |
| `before_host_header_1024x768_zh-CN.png` | — | — |
| `before_sources_panel_1024x768_zh-CN.png` | — | — |
| `before_chat_1024x768_zh-CN.png` | — | — |
| `before_results_panel_1024x768_zh-CN.png` | — | — |
| `before_activity_panel_1024x768_zh-CN.png` | — | — |
| `before_default_two_column_1440x900_en-US_dark.png` | — | — |
| `before_host_header_1440x900_en-US_dark.png` | — | — |
| `before_sources_panel_1440x900_en-US_dark.png` | — | — |
| `before_chat_1440x900_en-US_dark.png` | — | — |
| `before_results_panel_1440x900_en-US_dark.png` | — | — |
| `before_activity_panel_1440x900_en-US_dark.png` | — | — |
| `after_default_two_column_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_default_two_column_1440x900_en-US.png |
| `after_host_header_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_host_header_1440x900_en-US.png |
| `after_right_pane_open_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_open_1440x900_en-US.png |
| `after_right_pane_closed_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_closed_1440x900_en-US.png |
| `after_right_pane_tasks_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_tasks_1440x900_en-US.png |
| `after_sources_selected_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_1440x900_en-US.png |
| `after_sources_selected_empty_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_empty_1440x900_en-US.png |
| `after_sources_clear_via_ui_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_clear_via_ui_1440x900_en-US.png |
| `after_sources_scope_all_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_scope_all_1440x900_en-US.png |
| `after_empty_conversation_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_empty_conversation_1440x900_en-US.png |
| `after_legacy_old_shell_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_old_shell_1440x900_en-US.png |
| `after_legacy_return_target_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_return_target_1440x900_en-US.png |
| `after_default_two_column_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_default_two_column_1440x900_zh-CN.png |
| `after_host_header_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_host_header_1440x900_zh-CN.png |
| `after_right_pane_open_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_open_1440x900_zh-CN.png |
| `after_right_pane_closed_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_closed_1440x900_zh-CN.png |
| `after_right_pane_tasks_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_tasks_1440x900_zh-CN.png |
| `after_sources_selected_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_1440x900_zh-CN.png |
| `after_sources_selected_empty_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_empty_1440x900_zh-CN.png |
| `after_sources_clear_via_ui_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_clear_via_ui_1440x900_zh-CN.png |
| `after_sources_scope_all_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_scope_all_1440x900_zh-CN.png |
| `after_empty_conversation_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_empty_conversation_1440x900_zh-CN.png |
| `after_legacy_old_shell_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_old_shell_1440x900_zh-CN.png |
| `after_legacy_return_target_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_return_target_1440x900_zh-CN.png |
| `after_default_two_column_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_default_two_column_1024x768_en-US.png |
| `after_host_header_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_host_header_1024x768_en-US.png |
| `after_right_pane_open_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_open_1024x768_en-US.png |
| `after_right_pane_closed_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_closed_1024x768_en-US.png |
| `after_right_pane_tasks_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_tasks_1024x768_en-US.png |
| `after_sources_selected_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_1024x768_en-US.png |
| `after_sources_selected_empty_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_empty_1024x768_en-US.png |
| `after_sources_clear_via_ui_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_clear_via_ui_1024x768_en-US.png |
| `after_sources_scope_all_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_scope_all_1024x768_en-US.png |
| `after_empty_conversation_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_empty_conversation_1024x768_en-US.png |
| `after_legacy_old_shell_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_old_shell_1024x768_en-US.png |
| `after_legacy_return_target_1024x768_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_return_target_1024x768_en-US.png |
| `after_default_two_column_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_default_two_column_1024x768_zh-CN.png |
| `after_host_header_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_host_header_1024x768_zh-CN.png |
| `after_right_pane_open_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_open_1024x768_zh-CN.png |
| `after_right_pane_closed_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_closed_1024x768_zh-CN.png |
| `after_right_pane_tasks_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_tasks_1024x768_zh-CN.png |
| `after_sources_selected_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_1024x768_zh-CN.png |
| `after_sources_selected_empty_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_empty_1024x768_zh-CN.png |
| `after_sources_clear_via_ui_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_clear_via_ui_1024x768_zh-CN.png |
| `after_sources_scope_all_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_scope_all_1024x768_zh-CN.png |
| `after_empty_conversation_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_empty_conversation_1024x768_zh-CN.png |
| `after_legacy_old_shell_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_old_shell_1024x768_zh-CN.png |
| `after_legacy_return_target_1024x768_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_return_target_1024x768_zh-CN.png |
| `after_default_two_column_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_default_two_column_1440x900_en-US_dark.png |
| `after_host_header_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_host_header_1440x900_en-US_dark.png |
| `after_right_pane_open_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_open_1440x900_en-US_dark.png |
| `after_right_pane_closed_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_closed_1440x900_en-US_dark.png |
| `after_right_pane_tasks_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_right_pane_tasks_1440x900_en-US_dark.png |
| `after_sources_selected_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_1440x900_en-US_dark.png |
| `after_sources_selected_empty_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_selected_empty_1440x900_en-US_dark.png |
| `after_sources_clear_via_ui_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_clear_via_ui_1440x900_en-US_dark.png |
| `after_sources_scope_all_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_sources_scope_all_1440x900_en-US_dark.png |
| `after_empty_conversation_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_empty_conversation_1440x900_en-US_dark.png |
| `after_legacy_old_shell_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_old_shell_1440x900_en-US_dark.png |
| `after_legacy_return_target_1440x900_en-US_dark.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_legacy_return_target_1440x900_en-US_dark.png |
| `after_language_switch_before_1440x900_en-US.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_language_switch_before_1440x900_en-US.png |
| `after_language_switch_after_1440x900_zh-CN.png` | — | https://raw.githubusercontent.com/lingyun-hifibio/open-notebook-rdlens/evidence/wave-one-shell-bddcfc523569/dev_docs/validation/issue1104/screenshots/after_language_switch_after_1440x900_zh-CN.png |

## 11. 产物清单

| 路径 | 内容 |
|-|-|
| `screenshots/before_*.png` | 30 张 Before（1024/1440 × en/zh + 1440 dark） |
| `screenshots/after_*.png` | 63 张 After（5 上下文 × 12 场景 + 语言切换 + 键盘走查截图） |
| `manifest.json` | 每场景 revision/视口/请求语言/实际语言/主题/断言/状态/sha256；含 keyboard_walkthrough 与 Before/After pairing |
| `keyboard-walkthrough.md` / `.json` | Tab 序、Esc 回焦、skip link、焦点环、无横向滚动逐项 PASS/FAIL |
| `logs/capture-before-summary.json` / `capture-after-summary.json` | 采集时实时断言 + 控制台 |
| `logs/mock-requests-before.log` / `logs/mock-requests.log` | 合成 API 请求日志（含场景 mark） |
| `logs/harness-only-*.patch` | worktree 内 harness-only 改动存档 |
| `logs/prerun-F1-empty-selected-finding.md` | F1 预跑发现→修复→复采工作流记录（不进入场景清单） |
| `harness/*` | capture/mock/fixtures/keyboard/build_manifest/gen_readme |
| `revisions.json` | Before/After revision、依赖、语言口径、限制 |

## 12. 变更记录与 F1 工作流

- **2026-11-07**：建立 harness（真实 host Vite + 真实 fork Next.js embedded + 合成双 API）；完成 Before（30 张：18 PASS / 12 NOT_APPLICABLE）。
- **2026-11-07（预跑）**：After 预跑发现 **F1**：目标壳 selected 范围只剩 1 份时 checkbox 禁用 → UI 无法清空到空 selected（与 §9.3-2 / BEH-03 冲突）。已如实报 Lead，未改产品代码、未伪造 PASS。
- **2026-11-07（GO）**：fork-shell 提交 F1 修复 `476b1b2`（取消最后一份可用 + `rdlens-target-scope-blocked` 阻断块 + 提交门禁同源）；Before 在统一依赖集（lock `e802ac73…`，Next 16.3.2）下重采，结果不变（18 PASS / 12 N/A）。
- **2026-11-07（正式 After）**：GO head（host `d6da1a64b` / fork `476b1b2`）采集 After + 语言切换 + 键盘走查；F1 场景由 FAIL→PASS，最终 manifest 只含修复后 head 的 PASS 记录。预跑 FAIL 记录保留在 `logs/` 作为发现记录。

---

_生成：2026-11-07 02:59 CST · [synthetic] · 非 L2 部署验收_

