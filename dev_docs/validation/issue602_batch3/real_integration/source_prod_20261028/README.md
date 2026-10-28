# 生产 Source 完整链路走查（2026-10-28，真实生产）

- **目标**：把 §10.4 第 6 腿（Source 完整链路）从 `limited` 收紧为真实证据。
- **环境**：生产 `192.168.5.82:7890`（host）→ iframe `7800/research`；后端 `81d3f0ef` + `RDLENS_RESEARCH_SESSION_CONTRACT=true`；前端镜像 **`rdlens.32`**（`sha256:d564a1da…`，fork `7c570ac`）。
- **账号/项目**：`testuser@hifibio.com`（owner user 1）；`usr_1_8976d1453a214062bfb82c45d3bea7a3`（DEMO-01）。
- **证据级别**：`real`（真实生产 + 真实 Chromium）。

## 走查中发现并修复的 2 个 P0（隔离环境测不出）

### P0-1：来源 id 含冒号导致 Source 面板完全不可用
- 真实来源 id 是 Surreal record id `source:rdlens_<32hex>`；会话存储层 `_validate_id`（`^[A-Za-z0-9_-]{1,128}$`）拒绝 `:`。
- 症状：`POST …/sources/source:rdlens_…/chat/sessions` → **500**（未捕获 ValueError）；`GET` 同路径 → **422** `source_id 非法`。
- 修复：RDLens **PR #844**（`81d3f0ef`）新增 `_validate_source_id`（允许 `:`，≤256），4 处调用点切换；`session_id` 仍严格。回归测试 4 条；`test_issue602_pr4_session_api.py` 47 passed。
- 隔离环境漏检原因：fixture 用 `s1` 这类不含冒号的 fake 来源 id。

### P0-2：source 会话发送按钮永久禁用
- source 会话 editor 的 `base_scope` 按 DESIGN §4.3 **恒为 null**；`deriveResearchDraftGate` 的全局 legacy 规则 `baseScope===null && singleSourceId===null → scope_invalid`（DESIGN §7.2）直接命中。
- 症状：草稿 `All changes saved`，但 `research-draft-gate-hint` 恒为 `Select a source or note to use a selected scope.`、`chat-send.disabled=true`、点击**零网络请求**。
- 修复：fork **PR #97**（`7c570ac`）`deriveResearchDraftGate` 新增可选 `kind`（默认 global），legacy 分支加 `input.kind !== 'source'`；SourceChatPanel 传 `kind:'source'`；新增 1 条回归用例（回退生产代码即变红）。
- 隔离环境漏检原因：单测 mock 造了 `baseScope:{mode:'selected',…}`，与后端真实响应（null）不一致。

## 逐腿结果（修复后实测）

| # | 腿 | 结果 | 证据 |
|---|---|---|---|
| 1 | 打开来源 → Source 面板 | **pass** | `srcchat-panel`/`srcchat-input` 渲染 |
| 2 | 新建 source 会话 | **pass** | `POST …/sources/{id}/chat/sessions` → **201**，`srcchat-session-sess_…` 出现在列表 |
| 3 | 保存 editor（draft） | **pass** | `All changes saved`；`PUT …/editor-state` 200 |
| 4 | **发送（本地模型）→ SSE** | **pass** | `POST …/sources/{id}/chat` **202** → 同 URL **200 `text/event-stream`**；回复含 `Mode: direct_context | Usage: 16341 in / 25 out` |
| 5 | 切换另一 source 再返回 | **pass** | A 草稿 `restored=true`（`src_A_sent.png`） |
| 6 | 刷新后重开 | **pass** | 面板自动重开，A 草稿 `restored=true`（`src_A_reload.png`） |
| 7 | B 草稿独立 | **pass** | `restoredB=true`，互不覆盖 |
| 8 | 切 source 不 cancel | **pass** | 全流程 `DELETE`/`cancel` 请求 **0** |
| 9 | 来源 404 不清指针 | **limited** | 本轮未构造解析失败场景（需撤权/mirror 缺失 fixture，生产不宜构造）；PR-14 已按设计映射为“来源暂不可用、保留指针与本机稿”，有单测覆盖 |

## 附：走查过程中发生的一次生产事故（已闭环）
`rdlens.31` 首次构建时 `git worktree add` 因未 fetch 失败，而后台 `docker build ... &` 仍在 fork 主检出的**另一分支**执行 → 镜像内**无第三批 UI**（`workspace-tabs-row` 等 chunk 标记全 0）；部署后研究页短时回退旧界面，**已立即回滚 `rdlens.30`**。
更正：以 `pwd` + `git rev-parse` + 源码标记三重断言后重建 **`rdlens.32`**，并在**推送前**加硬门禁——正标记 `workspace-tabs-row`/`research-session-nav`/`session-switcher-new`/`chatRestoreRunning`/`coverage_not_enabled`/`source-list-rows` 全 >0、负标记 `session-content-gate`=0、`frame-ancestors` 精确，全部通过后才 push。台账 RDLens **PR #849** 将 `.31` 标记为 **❌ 作废、不得使用**，`.32` 为当前基线。

## 结论
Source 完整链路（创建 → 保存 → 发送 → SSE → 切换 → 刷新重开 → 草稿独立 → 无 cancel）在生产**真实验证通过**；仅「来源 404 不清指针」维持 `limited`（有单测覆盖、生产未构造）。§10.4 第 6 腿由 `limited` 收紧为 **pass（主链）/limited（404）**。
