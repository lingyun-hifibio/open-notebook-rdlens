# Issue #1134 — d2-v1 Note 删除入口 Before/After 合成视觉证据

- **Issue**：`HiFiBiO-Therapeutics/RDLens#1134`（#1046 PR4 范围外的删除入口：目录行 + 编辑器工具栏 + 二次确认 + 失败/重试语义）
- **实现**：fork 前端单 PR（`NoteCatalog` / `NoteEditorView` 接线 + 新增 `NoteDeleteDialog` / `note-delete` 状态机 / `use-note-delete` + 14 语言文案 + 单测）。
- **BEFORE 基线**：fork `origin/main` = `f3e4e47a3aa68ec0ee97370c9b5341929bb0fb46`（含 PR #128/#1135；`git fetch origin` 后确认；d2-v1 行**没有**删除入口）。
- **AFTER head**：`cb628c48e4e5fc95174e231e95ab56423df0b412`（fork 分支 `agent/note-delete-ui-a35682a0d739`，base `f3e4e47`，3 commits：`f07149b` 状态机/hook/对话框 → `f2e9f81` 目录行+编辑器接线 → `cb628c4` round-1 审查修复；27 文件）。
- **证据分支**：`evidence/note-delete-ui-a35682a0d739`（本分支，从 fork `origin/main` 创建，**不属于实现 PR diff**；仅 `dev_docs/validation/issue-1134/` 证据文件）。

## round-1 审查修复后的部分重采（captured_heads）

独立审查 round-1（0 BLOCKING / 0 HIGH / 2 MEDIUM / 6 LOW）后实现 head 从 `f2e9f81` 前进到 `cb628c4`。按 Lead 约定**只重采受影响的 E2/E4/E6**（两视口），其余场景沿用 `f2e9f81` 的截图与断言：

| 场景 | 截图/断言采集时 head | 说明 |
|---|---|---|
| E2 确认对话框（+E12） | `cb628c48e4e5fc95174e231e95ab56423df0b412` | 新增目标正文复核块 `note-delete-content`（label “Note content”）；断言 +1 |
| E4 编辑器内删除（未保存文本） | `cb628c48e4e5fc95174e231e95ab56423df0b412` | 同上；正文块显示**当前编辑器正文**（含未保存本地文本）；断言 +1 |
| E6 409 → Refresh and review | `cb628c48e4e5fc95174e231e95ab56423df0b412` | 复核改为「先执行 1 次已认证单条 GET 读取最新投影，再用最新 revision/标题/正文回到二次确认」；断言 +6（含 `note-delete-content` 显示 GET 返回正文、单条 GET 计数 +1） |
| E1/E3/E5/E7/E8/E9/E10/E11 | `f2e9f8131dc109a381e7465452361e1b03b2a29c` | 无 UI/文案/行为变化（实现 diff `f2e9f81..cb628c4` 仅涉及删除对话框正文块、409 复核路径、回执专有校验、404 草稿声明与 `stale_request` 文案），保留原截图/断言；E9/E10/E11 重新通过容差逐像素等价复核 |

`after-manifest.json` 的 `captured_heads` / `recapture_history` 记录该拆分；`f2e9f81..cb628c4` 的实现差异集中在：`NoteDeleteDialog`（`note-delete-content`）、`NotesPanel`（409 复核先 `getNoteD2` 最新版 + `reconfirm(revision,title,content)`；404 消息文案；删除后关闭编辑器顺序）、`note-delete.ts`（delete 回执专有校验：`note_id` 目标 / `mutation_id` 回显 / `applied_revision === expected_revision` / `snapshot_hash === null`；`stale_request` 失败分类）、14 locale 文案。

## 结论摘要

| 场景 | BEFORE（`f3e4e47`，无删除入口） | AFTER（`cb628c4`） |
|---|---|---|
| E1 目录行操作区（hover） | d2-v1 行**没有** `note-delete-*`；`Insert excerpt` 与 legacy `Edit`/`Delete` 保持 | d2-v1 行出现 **紧凑删除图标** `note-delete-note_d1`（28×28，Trash2，`aria-label`/`title` = “Delete note”），与 `Insert excerpt`、legacy 旧入口共存；布局断言全 PASS（标题不被挤压、图标/旧 Delete 不被裁剪） |
| E2 二次确认对话框（含 E12） | N/A（基线无入口/对话框） | `note-delete-dialog`（confirming）：标题 “Delete note?”、描述含目标标题与不可恢复说明、`note-delete-revision` = “Revision 1”、**`note-delete-content` 复核块**（label “Note content” + 目标正文）、`note-delete-impact` 精确包含“已插入文档的副本保留/确认时重新校验权限”；`note-delete-confirm`=“Delete”、`note-delete-cancel`=“Cancel”；Esc / Cancel 关闭且 **DELETE=0**；遮罩点击不关闭 = **known deviation**（见下） |
| E3 目录行删除成功 | N/A | 确认 → **1×** `DELETE`（`X-Research-Note-Contract: d2-v1` + body 恰好 `{mutation_id, expected_revision:1}`）→ 200 receipt（`snapshot_hash:null, replayed:false`）→ 行消失 + “Note deleted” toast + 目录重新 GET + **2 条草稿 tab 分支全部清除** |
| E4 编辑器内删除（有未保存本地文本） | N/A | 打开 d2-v1 Note → 编辑器 `note-editor-delete`（aria/title = “Delete note”）→ 输入本地文本（合成 save 503 使其保持未保存）→ 对话框显示 `note-delete-unsaved` 精确文案 + **`note-delete-content` 显示当前编辑器正文（含未保存文本）** → 确认 → **1×** DELETE（exp=1）→ 编辑器关闭（**无 leave-guard 二次弹窗**）+ 行消失 + toast + 草稿两分支清零 |
| E5 403 restricted | N/A | `note-delete-error data-failure-kind=restricted` + 精确文案；**无重试**、只有 Close；行仍在目录；`/__stats` **DELETE=1 / 语义删除=0** |
| E6 409 revision conflict | N/A | 首次 DELETE 409（`current_revision=2`）→ 错误 kind=conflict + “Refresh and review” → 点击后**新增 1 次已认证单条 GET** 读取最新投影 + 目录刷新 → 对话框回 confirming 且 `note-delete-revision` = **Revision 2**、`note-delete-content` 显示 **GET 返回的最新正文**（refresh marker）→ 再次确认 → 200 删除；**2×DELETE、不同 mutation_id、expected_revision 1→2、语义删除 1** |
| E7 结果未知（已应用后 503） | N/A | kind=unknown + “Confirm result” → **同一 mutation_id + 同 expected_revision** 重放 → 200 `replayed:true` → 行消失 + toast；**2×DELETE、语义删除恰好 1、delete_replays=1** |
| E8 503 依赖不可判定 | N/A | kind=unavailable + “Confirm result” → 同 mutation 重放 → 200 → 行消失；**2×DELETE、语义删除 1** |
| E9 Admin 只读 | 无删除入口 + `admin-readonly-banner`；旧写入入口隐藏 | 同左；与 BEFORE **容差逐像素等价（PASS）** |
| E10 `note_editor_existing.available=false` | 无删除入口；打开 d2 Note → `note-capability-blocked`（note store unavailable） | 同左（fail-closed）；与 BEFORE **容差逐像素等价（PASS）** |
| E11 legacy 行旧删除不回归 | 旧 `Delete` 文本按钮 → 旧确认框 → **旧路径 DELETE 204**（无 d2 头/无 mutation_id）→ 行消失 | 同左；legacy 行区域与 BEFORE **容差逐像素等价（PASS）** |
| E12 对话框引用/历史说明 | N/A（无对话框） | 合并进 E2：`note-delete-impact` 精确文案（副本保留 + 权限复核） |

**浏览器行为断言**（真实 headless Chromium 点击/输入 + 真实请求头/body 抓取 + `/__stats` 网关计数 + 真实 `getBoundingClientRect()` 布局测量，非 mock 断言）：BEFORE `104 PASS / 0 FAIL / 0 scene errors（104 assertions，8 scene runs）`；AFTER `426 PASS / 0 FAIL / 0 scene errors（426 assertions，22 scene runs）`（E2/E4/E6 在 `cb628c4` 重采，其余在 `f2e9f81`）。

## 证据性质与公开安全声明（synthetic）

本证据完全合成（synthetic）：

- 运行的是**真实 fork Next.js 应用**（`next dev --webpack`，嵌入式 iframe 模式），但宿主页面是本地合成 host（`harness/host_server.js`），Research Gateway 是**路由 mock**（`harness/gateway_mock.js`），无真实 RDLens host / PostgreSQL / 真实文件 / 模型调用 / 飞书内容 / 真实用户或项目数据。
- 所有 note 标题/正文/ID、来源、会话均为 `[synthetic]` fixtures（项目 `p1`、viewer `1`），截图顶部合成 host 栏显式标注 “synthetic harness · issue #1134 note-delete visual evidence · synthetic project p1 · role owner · no real data / no model calls”。
- Token 为**伪造未签名** claims-only JWT（Gateway mock 不验签；真实签名校验在生产 Gateway）；无任何真实凭据/密钥。

## 环境与端口

| 项 | BEFORE | AFTER |
|---|---|---|
| Next dev | `node_modules/.bin/next dev --webpack -p 8951` | `... -p 8953` |
| 合成 host | `http://127.0.0.1:8994/`（iframe `http://127.0.0.1:8951/research?legacy=1`） | `http://127.0.0.1:8996/`（iframe `http://127.0.0.1:8953/research?legacy=1`） |
| 合成 Gateway mock | `http://127.0.0.1:8963`（两侧共用同一实现，模式文件驱动） | 同左 |
| 嵌入式 env | `NEXT_PUBLIC_RD_EMBEDDED_MODE=1` / `NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:8963` / `NEXT_PUBLIC_RD_PARENT_ORIGIN=http://127.0.0.1:<host>` | 同左（parent origin 各自 host 端口） |
| 视口/主题 | 1440×900、1024×768；light；deviceScaleFactor=1；locale en-US；每个场景全新 browser context | 同左 |
| 浏览器 | headless Chromium `/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`（`--force-color-profile=srgb`） | 同左 |
| Node | v22.20.0 | 同左 |

> 端口说明：任务建议的 8941/8943 中 **8941 被本机其他进程占用**（`node gateway_mock.js 8941`），因此改用 8951/8953（host 8994/8996，gateway 8963），与先例 #1135（8931/8933、8990/8992、8961）不冲突。

> harness-only patch：`frontend/src/lib/embedded/config.ts` 的 `process.env[CONST]` 动态读取改为静态 `process.env.NEXT_PUBLIC_*` 成员访问（Next dev 不内联动态读取；#1046/#1135/#1136 证据先例）。该 patch **不属于产品改动**，捕获后已 `git checkout --` 还原。
> 两侧 original `2192fb22…42fb6` → patched `255492d4…0dade` → restored `2192fb22…42fb6`；两个 worktree `restored_clean=true`，最终 `git status --porcelain` 均为空（见 before/after-manifest `worktree_provenance`）。

## 合成 Harness 组成与驱动方式

- `harness/host_server.js`：合成宿主页，完成 research-v0 `ready → token` 握手（伪造 claims-only token），iframe 上方 24px 合成 host 栏；`?role=admin_readonly` 让初始 token claim 变成 Admin 只读（E9）。
- `harness/gateway_mock.js` + `harness/fixtures.js`：路由 mock 的 Research Gateway（d2-v1 note API、能力投影、`/v1/research/projects/<id>/...` 按后缀匹配）。**#1134 新增** d2-v1 `DELETE .../notes/{id}` 模式（模式文件 `/tmp/issue1134-delete-mode`）：`success` / `restricted403` / `conflict409`（首次把存储 revision bump 到 2、**改写正文加入 refreshed marker**，返回 409 + `current_revision`/`current_snapshot_hash`；随后 UI 的已认证单条 GET 能读到最新正文）/ `unknown503_apply`（先删除再返回 503，replay 命中回执 `replayed:true`）/ `dependency503`（首次 503、重试成功）。能力模式 `/tmp/issue1134-note-mode`：`editor_on` / `existing_off`（`note_editor_existing.available=false` reason `note_store_unavailable`）。保存模式 `/tmp/issue1134-save-mode`：`ok` / `fail503`（非 retryable，使编辑器保持未保存本地文本且不触发 leave-guard；仅 E4 控制变量）。
- `/__reset` 每场景重置；`/__stats` 提供每次 DELETE 的 method/path/`X-Research-Note-Contract` 头/body/keys/mutation_id/expected_revision/outcome/status/replay/applied、语义删除数、replay 数、legacy 删除数、notes 列表 GET（`list_requests`）与单条 GET（`detail_requests`）计数、notes 投影。回执字段满足 round-1 LOW-5 的 delete 专有校验：`note_id` 目标、`mutation_id` 回显、`applied_revision === expected_revision`、`snapshot_hash: null`；重放回执保留同样字段并带 `replayed:true`。
- **真实 UI 驱动**：只通过真实点击/输入（`note-delete-<id>`、`note-editor-delete`、`note-delete-confirm/cancel/retry/close`、legacy `Delete`/`Confirm`、编辑器 textarea/关闭）；不调用应用内部 API。
- **草稿缓存断言**：按冻结键格式在版本化草稿记录存储（`localStorage`）播种 **2 个 tab 分支**（当前 tab + 另一 tab），删除成功后断言该 note 前缀键 0 条；sessionStorage 只用于 tab id（`rdlens.research.note.v1.tab`，与产品一致）。

## 入口路径说明（如实记录）

fork 前端自 W1 #1104 起，`/research` 默认渲染目标壳 `TargetShell`；目标壳目前**不挂载** PR4 Notes 编辑器/目录。删除入口位于 **legacy 回归入口 `/research?legacy=1`**（`ResearchWorkbench` → `NotesPanel`）。因此本对比的界面表面是 `/research?legacy=1`，**不声称**该入口在默认生产入口（TargetShell）可达；Before/After 差异仅由实现 head 引入（两侧 fixture、gateway 模式、视口、入口、主题一致）。

## 浏览器行为断言（Before vs After）

每场景在两种视口各跑一遍（BEFORE 8 scene runs / AFTER 22 scene runs）；每条断言记录 expected/actual 到 `capture.log`，汇总在 `before-manifest.json` / `after-manifest.json` 的 `scenes[].assertions`；截图时刻的 DOM testid 计数与 gateway 计数记录在 `screenshots[].dom_counts` / `gateway_stats`；E1 另记录 `scenes[].layout`（真实 Chromium boundingBox）。

### BEFORE（基线缺口，`f3e4e47`）

| 场景 | 断言数（两视口合计） | 关键断言 |
|---|---|---|
| E1 目录行操作区（hover） | 44 | `e1.before_no_delete_entry, e1.before_no_editor_delete_entry, e1.d2_revision_shown, e1.d2_row_present, e1.d2_row_protected, e1.d2_row_second_present, e1.excerpt_entry_present, e1.layout_catalog_present, e1.layout_excerpt_present, e1.layout_legacy_delete_fully_inside_panel, e1.layout_legacy_delete_not_clipped, e1.layout_legacy_delete_present, e1.layout_legacy_title_present, e1.layout_probe_available, e1.layout_title_inside_panel, e1.layout_title_present, e1.layout_title_width_gt_20px, e1.legacy_edit_delete_actions, e1.legacy_row_present, e1.no_console_or_page_errors, e1.no_delete_request_on_row_view, e1.row_hovered` |
| E9 Admin 只读 | 14 | `e9.admin_banner_visible, e9.d2_rows_listed, e9.no_console_or_page_errors, e9.no_delete_entry_on_d2_rows, e9.no_delete_request_for_admin, e9.no_editor_delete_entry, e9.no_legacy_write_actions_for_admin` |
| E10 能力关闭 | 18 | `e10.capability_blocked_hint_shown, e10.capability_blocked_reason_surface, e10.catalog_rendered_with_capability_off, e10.models_capability_request_seen, e10.no_console_or_page_errors, e10.no_delete_entry_in_blocked_editor, e10.no_delete_entry_when_capability_off, e10.no_delete_request_when_capability_off, e10.note_open_attempted` |
| E11 legacy 旧删除 | 28 | `e11.d2_notes_untouched, e11.legacy_confirm_dialog_opened, e11.legacy_delete_has_no_d2_contract_header, e11.legacy_delete_has_no_mutation_or_revision_body, e11.legacy_delete_status_204, e11.legacy_delete_text_button_present, e11.legacy_dialog_buttons, e11.legacy_dialog_copy, e11.legacy_note_gone_server_side, e11.legacy_row_hovered, e11.legacy_row_removed_after_delete, e11.legacy_single_delete, e11.no_console_or_page_errors, e11.no_d2_semantic_delete` |
| E2–E8、E12 | 0（N/A） | 基线无 d2-v1 删除入口/mutation，不伪造截图；见 `before-manifest.json.before_na_scenes` |

### AFTER（实现验收，`cb628c4`；E2/E4/E6 重采）

| 场景 | 断言数（两视口合计） | 关键断言 |
|---|---|---|
| E1 目录行操作区（hover） | 62 | `e1.after_delete_entry_aria_label, e1.after_delete_entry_present, e1.after_delete_entry_title_attr, e1.after_delete_entry_visible_after_hover, e1.after_excerpt_entry_kept, e1.after_no_dialog_before_click, e1.d2_revision_shown, e1.d2_row_present, e1.d2_row_protected, e1.d2_row_second_present, e1.excerpt_entry_present, e1.layout_actions_inside_panel, e1.layout_catalog_present, e1.layout_delete_compact_icon, e1.layout_delete_fully_inside_panel, e1.layout_delete_not_clipped, e1.layout_delete_present, e1.layout_excerpt_present, e1.layout_legacy_delete_fully_inside_panel, e1.layout_legacy_delete_not_clipped, e1.layout_legacy_delete_present, e1.layout_legacy_title_present, e1.layout_probe_available, e1.layout_title_inside_panel, e1.layout_title_present, e1.layout_title_width_gt_20px, e1.legacy_edit_delete_actions, e1.legacy_row_present, e1.no_console_or_page_errors, e1.no_delete_request_on_row_view, e1.row_hovered` |
| E2 确认对话框（+E12） | 46 | `e12.dialog_reference_history_copy_visible, e2.cancel_button_label, e2.cancel_clicked, e2.cancel_closes_without_request, e2.catalog_path_no_unsaved_local_line, e2.confirm_button_enabled, e2.confirm_button_label, e2.delete_entry_clicked, e2.dialog_content_block_visible, e2.dialog_description_names_note, e2.dialog_description_warns_irreversible, e2.dialog_has_confirm_and_cancel, e2.dialog_impact_copy_exact, e2.dialog_opened, e2.dialog_phase_confirming, e2.dialog_revision_element, e2.dialog_title_copy, e2.entry_reopened_after_cancel, e2.entry_reopened_after_esc, e2.esc_cancels_without_request, e2.no_console_or_page_errors, e2.no_delete_request_before_confirm, e2.overlay_click_no_dismiss_observed` |
| E3 目录行删除成功 | 44 | `e3.catalog_refreshed_after_delete, e3.confirm_clicked, e3.confirming_revision_is_row_revision, e3.delete_body_exact_keys, e3.delete_contract_header, e3.delete_entry_clicked, e3.delete_expected_revision, e3.delete_mutation_id_present, e3.delete_receipt_fields, e3.delete_receipt_shape, e3.delete_status_ok, e3.dialog_closed_after_success, e3.draft_branches_cleared, e3.draft_branches_seeded, e3.exactly_one_delete, e3.exactly_one_semantic_delete, e3.legacy_note_still_present, e3.no_console_or_page_errors, e3.note_gone_server_side, e3.other_d2_note_still_present, e3.row_removed_from_catalog, e3.success_toast_shown` |
| E4 编辑器内删除（未保存文本） | 46 | `e4.confirm_clicked, e4.delete_contract_and_body, e4.dialog_closed_after_success, e4.dialog_content_block_shows_current_editor_text, e4.dialog_opened_from_editor, e4.draft_branches_cleared, e4.draft_branches_seeded, e4.editor_closed_after_delete, e4.editor_delete_clicked, e4.editor_delete_enabled, e4.editor_entry_aria_label, e4.editor_entry_rendered, e4.editor_has_unsaved_local_changes, e4.exactly_one_delete, e4.exactly_one_semantic_delete, e4.no_console_or_page_errors, e4.no_leave_guard_second_dialog, e4.note_gone_server_side, e4.note_opened_in_editor, e4.row_removed_from_catalog, e4.success_toast_shown, e4.typed_unsaved_local_text, e4.unsaved_local_line_shown` |
| E5 403 restricted | 28 | `e5.close_button_copy, e5.close_emits_no_extra_delete, e5.confirm_clicked, e5.delete_entry_clicked, e5.error_dialog_stays_open, e5.error_kind_restricted, e5.error_state_shown, e5.exactly_one_restricted_request, e5.no_console_or_page_errors, e5.no_retry_for_terminal_error, e5.note_still_in_catalog_store, e5.restricted_error_copy, e5.row_still_listed_after_close, e5.zero_semantic_deletes` |
| E6 409 conflict → Refresh and review（含最新版 GET 复核） | 62 | `e6.authorized_latest_read_via_get, e6.catalog_refreshed_on_retry, e6.confirm_clicked, e6.conflict_error_copy, e6.delete_entry_clicked, e6.dialog_back_to_confirming, e6.dialog_closed_after_success, e6.dialog_revision_is_two, e6.dialog_still_names_note, e6.different_mutation_ids, e6.error_kind_conflict, e6.error_phase_hides_review_block, e6.error_state_shown, e6.exactly_one_semantic_delete, e6.expected_revision_progression, e6.first_attempt_conflict, e6.initial_content_block_is_stale_row_body, e6.initial_revision_is_one, e6.no_console_or_page_errors, e6.no_semantic_delete_on_conflict, e6.note_gone_server_side, e6.refresh_and_review_clicked, e6.refreshed_latest_body_shown, e6.retry_label_refresh_and_review, e6.retry_offered_refresh_and_review, e6.row_refreshed_to_revision_two, e6.row_removed_after_second_confirm, e6.second_attempt_succeeded, e6.second_confirm_clicked, e6.target_row_revision_one, e6.two_delete_attempts` |
| E7 unknown → Confirm result 重放 | 40 | `e7.confirm_clicked, e7.confirm_result_action_present, e7.confirm_result_clicked, e7.confirm_result_label, e7.delete_entry_clicked, e7.dialog_closed_after_success, e7.exactly_one_semantic_delete, e7.first_attempt_unknown_applied, e7.no_console_or_page_errors, e7.note_gone_server_side, e7.replay_receipt_replayed_flag, e7.row_removed_after_replay, e7.same_expected_revision, e7.same_mutation_id_replayed, e7.second_attempt_replayed_receipt, e7.success_toast_shown, e7.two_delete_attempts, e7.unknown_error_copy, e7.unknown_kind_reported, e7.unknown_state_shown` |
| E8 503 dependency → 重试 | 38 | `e8.confirm_clicked, e8.delete_entry_clicked, e8.dialog_closed_after_success, e8.error_kind_unavailable, e8.error_state_shown, e8.exactly_one_semantic_delete, e8.first_attempt_dependency_503, e8.first_attempt_not_applied, e8.first_retryable_second_success, e8.no_console_or_page_errors, e8.note_gone_server_side, e8.retry_clicked, e8.retry_label_confirm_result, e8.retry_offered, e8.row_removed_after_retry, e8.same_mutation_id_retried, e8.success_toast_shown, e8.two_delete_attempts, e8.unavailable_error_copy` |
| E9 Admin 只读 | 14 | `e9.admin_banner_visible, e9.d2_rows_listed, e9.no_console_or_page_errors, e9.no_delete_entry_on_d2_rows, e9.no_delete_request_for_admin, e9.no_editor_delete_entry, e9.no_legacy_write_actions_for_admin` |
| E10 能力关闭 | 18 | `e10.capability_blocked_hint_shown, e10.capability_blocked_reason_surface, e10.catalog_rendered_with_capability_off, e10.models_capability_request_seen, e10.no_console_or_page_errors, e10.no_delete_entry_in_blocked_editor, e10.no_delete_entry_when_capability_off, e10.no_delete_request_when_capability_off, e10.note_open_attempted` |
| E11 legacy 旧删除不回归 | 28 | `e11.d2_notes_untouched, e11.legacy_confirm_dialog_opened, e11.legacy_delete_has_no_d2_contract_header, e11.legacy_delete_has_no_mutation_or_revision_body, e11.legacy_delete_status_204, e11.legacy_delete_text_button_present, e11.legacy_dialog_buttons, e11.legacy_dialog_copy, e11.legacy_note_gone_server_side, e11.legacy_row_hovered, e11.legacy_row_removed_after_delete, e11.legacy_single_delete, e11.no_console_or_page_errors, e11.no_d2_semantic_delete` |

合计：BEFORE `104 PASS / 0 FAIL / 0 scene errors`；AFTER `426 PASS / 0 FAIL / 0 scene errors`；两阶段均 0 unexpected console/page error（仅记录 intentional 失败模式触发的 Chromium “Failed to load resource … 403/409/503” 资源日志，按预期模式单独记录，非应用 console error）。

## 布局断言（真实 Chromium `getBoundingClientRect()`，1440/1024）

| 测量项（E1，hover 后真实布局） | BEFORE 1440 | AFTER 1440 | BEFORE 1024 | AFTER 1024 |
|---|---|---|---|---|
| d2-v1 行标题宽度 | 189.67px | 189.67px | 161.13px | 129.13px |
| 删除图标 box | — | 28×28 @x=330.72 right=358.72 | — | 28×28 @x=185.13 right=213.13 |
| Insert excerpt 右边界 / legacy Delete 右边界 / Notes 面板右边界 | 477.19 / 477.19 / 485.19 | 477.19 / 477.19 / 485.19 | 331.59 / 331.59 / 339.59 | 331.59 / 331.59 / 339.59 |

断言（两视口各一遍，`e1.layout_*`）：标题存在且宽度 > 20px、完整位于 Notes 面板内；删除图标为紧凑图标（≤40px，实测 28×28）、完整在面板内且不被裁剪；行动作区在面板内；legacy 旧 `Delete` 仍在面板内且文字不裁剪。1024 下 AFTER 标题宽度 129.13px（BEFORE 161.13px），未被新图标挤压到不可见；`Insert excerpt` 与删除图标共存。

## 请求计数（`/__stats`，每场景一次 reset）

| 场景 | 视口 | DELETE 序列（note / status / outcome / expected_revision / mutation_id 尾 6） | 语义删除 | replay | legacy 删除 | notes 列表 GET | 单条 GET |
|---|---|---|---|---|---|---|---|
| E3 | 1440 | note_d1 200 deleted exp=1 mid…5a5b80 | 1 | 0 | 0 | 3 | None |
| E3 | 1024 | note_d1 200 deleted exp=1 mid…e72e08 | 1 | 0 | 0 | 3 | None |
| E4 | 1440 | note_d1 200 deleted exp=1 mid…c4ee95 | 1 | 0 | 0 | 3 | 1 |
| E4 | 1024 | note_d1 200 deleted exp=1 mid…ef239b | 1 | 0 | 0 | 3 | 1 |
| E5 | 1440 | note_d1 403 restricted exp=1 mid…0c4c67 | 0 | 0 | 0 | 2 | None |
| E5 | 1024 | note_d1 403 restricted exp=1 mid…747e58 | 0 | 0 | 0 | 2 | None |
| E6 | 1440 | note_d2 409 conflict exp=1 mid…f5de86; note_d2 200 deleted exp=2 mid…31bd5d | 1 | 0 | 0 | 4 | 1 |
| E6 | 1024 | note_d2 409 conflict exp=1 mid…44e9a6; note_d2 200 deleted exp=2 mid…baa681 | 1 | 0 | 0 | 4 | 1 |
| E7 | 1440 | note_d1 503 unknown_applied exp=1 mid…c923fd; note_d1 200 replayed exp=1 mid…c923fd | 1 | 1 | 0 | 3 | None |
| E7 | 1024 | note_d1 503 unknown_applied exp=1 mid…942a7c; note_d1 200 replayed exp=1 mid…942a7c | 1 | 1 | 0 | 3 | None |
| E8 | 1440 | note_d1 503 dependency_unavailable exp=1 mid…47ce91; note_d1 200 deleted exp=1 mid…47ce91 | 1 | 0 | 0 | 3 | None |
| E8 | 1024 | note_d1 503 dependency_unavailable exp=1 mid…ad1ba0; note_d1 200 deleted exp=1 mid…ad1ba0 | 1 | 0 | 0 | 3 | None |
| E11 | 1440 | note_legacy 204 legacy_deleted exp=None mid… | 0 | 0 | 1 | 4 | None |
| E11 | 1024 | note_legacy 204 legacy_deleted exp=None mid… | 0 | 0 | 1 | 4 | None |

E1/E2/E9/E10 均 0×DELETE（仅查看/打开对话框不触网）。E3/E4 各 1×DELETE+1×语义删除；E6 2×不同 mutation_id、expected_revision 1→2、语义删除 1，且 Refresh and review 触发 **1×已认证单条 GET**（`detail_requests`）+ 目录刷新；E7 2×同一 mutation_id、`replayed:true`、语义删除 1、delete_replays=1；E8 2×同一 mutation_id、语义删除 1；E11 1×legacy 204、语义删除 0。

## 互阶段容差逐像素等价（E9/E10 全屏 + E11 legacy 行区域）

| 结果行 |
|---|
| `PASS e9_admin_readonly_1440: size=1440x900 diff_bbox=None pixels_over_2=0 max_channel_delta=0 -> within tolerance` |
| `PASS e10_existing_off_blocked_1440: size=1440x900 diff_bbox=(932, 33, 1423, 36) pixels_over_2=0 max_channel_delta=2 -> within tolerance` |
| `PASS e9_admin_readonly_1024: size=1024x768 diff_bbox=(378, 754, 382, 756) pixels_over_2=0 max_channel_delta=2 -> within tolerance` |
| `PASS e10_existing_off_blocked_1024: size=1024x768 diff_bbox=(516, 33, 742, 36) pixels_over_2=0 max_channel_delta=2 -> within tolerance` |
| `PASS e11_legacy_delete_dialog_1440_legacy_row_region: region=(14, 671, 487, 739) size=(473, 68) diff_bbox=None pixels_over_2=0 max_channel_delta=0 -> within tolerance` |
| `PASS e11_legacy_deleted_1440_legacy_row_region: region=(14, 671, 487, 739) size=(473, 68) diff_bbox=None pixels_over_2=0 max_channel_delta=0 -> within tolerance` |
| `PASS e11_legacy_delete_dialog_1024_legacy_row_region: region=(14, 739, 341, 807) size=(327, 68) diff_bbox=None pixels_over_2=0 max_channel_delta=0 -> within tolerance` |
| `PASS e11_legacy_deleted_1024_legacy_row_region: region=(14, 739, 341, 807) size=(327, 68) diff_bbox=None pixels_over_2=0 max_channel_delta=0 -> within tolerance` |

`E11` 全屏截图必然包含上方 d2-v1 行新增的删除图标（本 issue 的有意变更），因此 E11 只对 **legacy 行区域**做容差逐像素比较（区域取自 E1 真实布局探针，host 栏 24px 偏移）；E11 全屏 sha256 记录在 `scenes[].pixel_compare` 仅作信息。容差：忽略通道差 ≤2、允许 ≤100 像素、最大通道差 ≤8（Pillow）。E9/E10/E11 截图沿用 `f2e9f81` 采集（round-1 修复不触及这些表面），重建后仍 8/8 PASS。

## 已知契约偏差（known deviation，不计入 FAIL、不写成 PASS）

- 契约 §2「点遮罩 → 关闭对话框」：**当前实现不满足**。Radix `AlertDialog` 原语默认阻止外部交互（`onPointerDownOutside`/`onInteractOutside → preventDefault`），`NoteDeleteDialog` 未覆写；实测遮罩点击后对话框保持 confirming、DELETE=0。Lead 裁决：接受为该原语语义的 known deviation（不是本 PR 引入的缺陷，也不是 #1134 验收项；pending 单在途时 Esc/遮罩均不可关闭属预期）。证据记录在 `after-manifest.json.contract_deviations`（E2 两视口）与 `capture.log` 的 `CONTRACT-DEVIATION overlay-dismiss` 行；E2 断言为 `e2.overlay_click_no_dismiss_observed`（记录观察到的事实），**没有** `overlay_dismiss_without_request` 的 PASS。Esc 与 Cancel 均验证为「关闭对话框且 DELETE=0」。

## 场景与截图

命名 `<side>_<scene>_<width>.png`；每场景在 1440×900 与 1024×768 各采一次。BEFORE 共 10 张，AFTER 共 34 张（E2/E4/E6 于 `cb628c4` 重采覆盖同名文件；其余沿用 `f2e9f81`）。N/A 场景（BEFORE E2–E8、E12）**没有**伪造截图。

BEFORE 截图：

- `screenshots/before/before_e1_row_actions_1440.png`
- `screenshots/before/before_e9_admin_readonly_1440.png`
- `screenshots/before/before_e10_existing_off_blocked_1440.png`
- `screenshots/before/before_e11_legacy_delete_dialog_1440.png`
- `screenshots/before/before_e11_legacy_deleted_1440.png`
- `screenshots/before/before_e1_row_actions_1024.png`
- `screenshots/before/before_e9_admin_readonly_1024.png`
- `screenshots/before/before_e10_existing_off_blocked_1024.png`
- `screenshots/before/before_e11_legacy_delete_dialog_1024.png`
- `screenshots/before/before_e11_legacy_deleted_1024.png`

AFTER 截图：

- `screenshots/after/after_e1_row_actions_1024.png`
- `screenshots/after/after_e1_row_actions_1440.png`
- `screenshots/after/after_e10_existing_off_blocked_1024.png`
- `screenshots/after/after_e10_existing_off_blocked_1440.png`
- `screenshots/after/after_e11_legacy_delete_dialog_1024.png`
- `screenshots/after/after_e11_legacy_delete_dialog_1440.png`
- `screenshots/after/after_e11_legacy_deleted_1024.png`
- `screenshots/after/after_e11_legacy_deleted_1440.png`
- `screenshots/after/after_e2_delete_dialog_1024.png`
- `screenshots/after/after_e2_delete_dialog_1440.png`
- `screenshots/after/after_e3_deleted_catalog_1024.png`
- `screenshots/after/after_e3_deleted_catalog_1440.png`
- `screenshots/after/after_e4_after_delete_1024.png`
- `screenshots/after/after_e4_after_delete_1440.png`
- `screenshots/after/after_e4_editor_delete_dialog_1024.png`
- `screenshots/after/after_e4_editor_delete_dialog_1440.png`
- `screenshots/after/after_e5_restricted_error_1024.png`
- `screenshots/after/after_e5_restricted_error_1440.png`
- `screenshots/after/after_e6_conflict_error_1024.png`
- `screenshots/after/after_e6_conflict_error_1440.png`
- `screenshots/after/after_e6_deleted_1024.png`
- `screenshots/after/after_e6_deleted_1440.png`
- `screenshots/after/after_e6_refresh_confirming_1024.png`
- `screenshots/after/after_e6_refresh_confirming_1440.png`
- `screenshots/after/after_e7_after_confirm_result_1024.png`
- `screenshots/after/after_e7_after_confirm_result_1440.png`
- `screenshots/after/after_e7_unknown_error_1024.png`
- `screenshots/after/after_e7_unknown_error_1440.png`
- `screenshots/after/after_e8_after_retry_1024.png`
- `screenshots/after/after_e8_after_retry_1440.png`
- `screenshots/after/after_e8_dependency_error_1024.png`
- `screenshots/after/after_e8_dependency_error_1440.png`
- `screenshots/after/after_e9_admin_readonly_1024.png`
- `screenshots/after/after_e9_admin_readonly_1440.png`

## 复现

```bash
# 1) 准备 worktree（node_modules 用 symlink；本环境不 npm install）
git -C <fork-repo> worktree add -b evidence/note-delete-ui-a35682a0d739 <scratch>/evidence origin/main
git -C <fork-repo> worktree add --detach <scratch>/fork-before f3e4e47a3aa68ec0ee97370c9b5341929bb0fb46
git -C <fork-repo> worktree add --detach <scratch>/fork-after cb628c48e4e5fc95174e231e95ab56423df0b412
ln -s <fork-repo>/frontend/node_modules <scratch>/fork-before/frontend/node_modules
ln -s <fork-repo>/frontend/node_modules <scratch>/fork-after/frontend/node_modules

# 2) BEFORE（端口 8951/8994/8963；脚本自动启动合成 gateway/host 并还原 harness-only patch）
WT_BEFORE=<scratch>/fork-before dev_docs/validation/issue-1134/harness/run_before.sh

# 3) AFTER（端口 8953/8996/8963）
WT_AFTER=<scratch>/fork-after AFTER_SHA=cb628c48e4e5fc95174e231e95ab56423df0b412 \
  dev_docs/validation/issue-1134/harness/run_after.sh

# 3b) round-1 修复后的部分重采（仅 E2/E4/E6，merge 进既有 manifest）
CAPTURE_ARGS="--scenes=e2,e4,e6 --merge" WT_AFTER=<scratch>/fork-after \
  AFTER_SHA=cb628c48e4e5fc95174e231e95ab56423df0b412 \
  dev_docs/validation/issue-1134/harness/run_after.sh

# 4) 清单 + 像素门 + screenshots.sha256
WT_BEFORE=<scratch>/fork-before WT_AFTER=<scratch>/fork-after \
  AFTER_SHA=cb628c48e4e5fc95174e231e95ab56423df0b412 \
  dev_docs/validation/issue-1134/harness/finalize_evidence.sh
```

## 限制（NOT RUN / 如实记录）

1. **合成 harness + `next dev`**：证据证明前端行为与契约接线（真实浏览器、真实请求头/body、`/__stats` 计数），不替代真实 host/DB/真实权限数据/真实模型证据；Research Gateway 为路由 mock。
2. **入口 surface**：对比发生在前端 legacy 回归入口 `?legacy=1` 的 `ResearchWorkbench`；默认 `TargetShell` 的 Notes 集成不在本 issue 范围，**不声称生产默认入口可达**。
3. **BEFORE 的 E2–E8/E12 为 N/A**：基线（`f3e4e47`）根本没有 d2-v1 删除入口/删除 mutation（`deleteNoteD2` 客户端方法虽在 PR4 冻结契约中存在，但无 UI 调用路径），无法在基线重现这些确认/错误/未知状态；未伪造基线截图。
4. **错误注入为网关路由 mock**：403/409/503/unknown 由 mock 按契约错误信封返回；不覆盖真实 Gateway/存储/依赖的故障注入。
5. **部分重采（`captured_heads`）**：E2/E4/E6 在 round-1 修复后的 `cb628c4` 采集，其余场景在 `f2e9f81` 采集；两者之间的实现 diff 不触及这些表面，且 E9/E10/E11 重新通过容差逐像素等价。若需严格单一 head 的全量重采，可按「复现 §3」在 `cb628c4` 跑一次全量（约 6 分钟）。
6. **非确定性**：next dev/HMR 加载帧、toast 出现时机、目录刷新瞬间的 loading 文案会随运行时刻不同；**不声称截图跨次运行 byte-identical**；`screenshots.sha256` 只对本次提交的快照有效。
7. **intentional HTTP 失败**：`restricted403`/`conflict409`/`dependency503`/`unknown503_apply`/`fail503` 会让 Chromium 记录资源级 “Failed to load resource … 403/503” console 条目（浏览器自动日志）；已与意外 page/console error 分开记录，本证据断言 **unexpected = 0**。
8. **light/en-US 单主题**、两档视口（1440×900 / 1024×768）；未覆盖 dark/RTL/移动宽度/键盘或 IME 实体输入（实现仓单测覆盖交互边界）。
9. **未覆盖**：`mutation_id_reused`/`stale_request`（new_mutation 重试）未单独截图（网关已实现分类路径，未用于本证据场景；由实现仓 `note-delete.test.ts` 覆盖）；404 `note_not_found` 收敛路径未单独截图（契约 E 场景未列；由单测覆盖）；真实并发/多标签、真实用户权限矩阵、真实存储故障。
10. **布局断言的边界**：E1 布局断言基于真实 Chromium `getBoundingClientRect()`/`scrollWidth`（DOM 几何）；E9/E10 全屏与 E11 legacy 行区域另有容差逐像素等价（8/8 PASS，见 `logs/pixel-equivalence.txt`），字节 sha256 相等仅作信息记录（next dev 多次运行出现个位数 anti-aliasing/光标像素差）。
11. **本地全量测试**：本证据只覆盖前端行为证据；实现仓的 tsc/eslint/vitest/build 由 Lead/实现侧验证，不在本证据分支重复。

## 文件清单

| 文件 | 说明 |
|---|---|
| `README.md` | 本文件 |
| `screenshots/before/*.png` / `screenshots/after/*.png` | Before/After 截图（10 + 34 = 44 张；E2/E4/E6 AFTER 于 `cb628c4` 重采） |
| `screenshots.sha256` | 全部截图的 sha256（44 行） |
| `capture.log` | 逐命令/逐截图/DOM testid 计数/`/__stats`/console 证据日志（含首轮 `f2e9f81` AFTER 记录与 round-1 部分重采记录） |
| `before-manifest.json` / `after-manifest.json` | 修订（full SHA）、`captured_heads`、`recapture_history`、环境、场景、断言、布局、计数、截图 sha256、worktree 清洁度、config patch hash、像素门、契约偏差、实现 diff |
| `logs/` | gateway/host/dev 日志、config patch provenance、worktree provenance、像素等价比较 |
| `harness/` | 可复现 harness（`capture.js`（含 `--merge` 部分重采）、`host_server.js`、`gateway_mock.js`、`fixtures.js`、`run_before.sh`、`run_after.sh`、`finalize_evidence.sh`、`probe.js`、`verify_pixel_equivalence.py`） |
