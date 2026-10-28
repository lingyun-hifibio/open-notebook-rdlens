# Source 完整真实链路（§10.4 第 6 腿）

- 日期：2026-10-28
- 环境：隔离真实部署（见 `deployment.md`）；Gateway `127.0.0.1:7896`、前端 8503、host 8504；项目 `usr_1_...397`、source `b3-source`；本地模型 `Qwen3.8-27B`；合成内容。
- 代码：RDLens `3620c9c1`；fork 前端 worktree `batch3-pr12` @ `92be040`。
- 证据级别：`real`（隔离环境）；UI 为真实 Chromium。

## 逐项结果

| 步骤 | 结果 | 证据 |
|---|---|---|
| 创建 source session | **pass** | UI `POST .../sources/b3-source/chat/sessions` → **201**；Source chat 面板出现该 session（`sess_8556...`、`sess_e295...`） |
| 保存 editor（scope/draft/anchor） | **pass（保存）/ limited（anchor）** | UI 编辑草稿 → `PUT .../editor-state` → **200** + “All changes saved”（`screenshots/source_panel_draft_saved.png`）；anchor 未单独构造真实 UI 断言 |
| 本地模型发送 → SSE | **pass** | `POST .../sources/b3-source/chat` → **200 text/event-stream**（SSE）；UI 显示 terminal/usage（`screenshots/source_panel_send.png`） |
| 切到别的 source/关闭再返回 | **limited** | “back global → 重新打开 source” 一次 `restored_directly=true`（`source_back_global.png`）；未覆盖“切到另一个 source”的独立断言 |
| 刷新/重开后重开 | **partial/limited（发现缺口）** | 关闭再打开同 tab：`draft_matches=false, len=0`；刷新后：source 面板可开但 `restored_directly=false`，`session_present_in_list=false`（`source_reload_reopen.png`） |
| source editor 自有稿独立恢复 | **limited** | 同 tab 重开未恢复草稿；跨 source 隔离未测 |
| source 404 不清会话/指针 | **not executed（limited）** | 本轮未构造 source 解析 404 的真实请求；设计允许 limited 但需记录 |
| 无 cancel | **not observed** | 服务端 send 为单次 SSE；未观察到 cancel 调用，但未做切换中断对照 |

## 原始网络（脱敏）
- `POST /v1/research/projects/{project}/sources/b3-source/chat/sessions` → 201 application/json
- `PUT /v1/research/projects/{project}/sources/b3-source/chat/sessions/{session}/editor-state` → 200 application/json
- `POST /v1/research/projects/{project}/sources/b3-source/chat` → 200 text/event-stream（SSE）
- 原始结果：`/tmp/b3src_ui_results.json`、`/tmp/b3src_ui_v4.json`（临时，不入仓）

## 发现（不阻塞本次证据，需另开修复/复核）
1. **Source 草稿跨重开/刷新恢复失败**：关闭再打开同 tab 时 `draft_matches=false`（len 0）；刷新后 `session_present_in_list=false`。可能为 source 面板草稿缓存/列表刷新路径缺口；未定位 file:line（UI 层），建议在稳定源会话下复现并另开 PR 复核。
2. **切换/404/cancel 未取证**：本轮时间窗未能覆盖；按设计第 6 腿“缺该链路则出口不完整”，在严格口径下本项仍为 **limited**，需补测。

## 结论
- API 层主链路（create→save→send→SSE）**pass**；UI 创建/保存/发送 **pass**；重开/刷新的草稿恢复 **limited 且发现疑似缺陷**；切换/404/cancel **limited**。
- 因此 §10.4 第 6 腿在严格口径下**尚未完成**；建议补测并在有缺陷时先修复再勾选第三批出口。

## 更新（2026-10-28，PR-14 #88 合并后）

- **修复已合并**：PR #88（`5d80ac6`）实现方案 A——Source 恢复不依赖旧列表：运行时活动 source ref 直接冷恢复 detail + `selectSession`；旧列表缺会话时用 ref 合成当前会话身份行；新会话统一走新契约创建并写 display/.source。
- **复验（真实 UI）**：创建 source 会话→输入→保存→刷新 host→重新打开 source：`composerAfterReload=true`、草稿值与刷新前一致（`matches=true`）、display/.source 指针保留、console error 0；测试 4 文件 120 passed、`tsc -b` 0、红检 2 项有效。
- **本文件先前记录的 “reload 后草稿 0 / session 不在列表” 缺陷已关闭**（根因是恢复依赖旧列表 + 会话不在旧列表）。
- **仍为 limited（不影响 PR-14 合并）**：source 404 不清指针、切 source 不 cancel 两项未单独取证，建议后续补测；本轮不伪造 pass。
