# 第三批出口核对（6b 收口，2026-10-28）

对照 `01_DESIGN.md` §10.6 与 `cards/PR-6.md`。证据目录：本目录。

| # | §10.6 条目 | 状态 | 证据/说明 |
|---|---|---|---|
| 1 | 会话列表、新对话、切换、当前识别；global/source 活动会话独立 | pass | 文件内 `README.md` 腿 1/3；UI 创建/切换/刷新 |
| 2 | 两会话 scope/草稿/阅读位置在切换、刷新、重开后恢复 | pass（全局）；source 见 #6 | 全局 chat 刷新恢复 + PR-12；source 重开 limited |
| 3 | 保存失败/CAS/清稿 hold/operationId | pass（simulated）+ 真实 CAS 409 | 组件测试 + 真实 409 envelope |
| 4 | 认证切换隔离/旧响应不回填 | pass | 真实 refresh 后发送 202→200；测试 |
| 5 | 两标签草稿分支/多分支恢复/T1 查回 | pass（simulated） | 组件测试；未做真实双标签人工走查（记录为 simulated） |
| 6 | 冷启动 durable/热恢复续水位/durable 不重复 | pass | 真实 submit/lookup/SSE；PR-12 刷新发送 |
| 7 | Coverage 隔离 + Source 完整链路有真实证据或明确 limited | **limited** | Source API 主链 pass；UI 刷新/重开草稿恢复 limited（`source_chain.md`），且发现疑似缺陷；按 §10.4“缺该链路则出口不完整” |
| 8 | display ref 刷新权威；source editor 授权；source 404 | pass（全局）/limited（source 404） | 全局刷新恢复；source 404 未构造 |
| 9 | 错误 envelope 排序/not_accepted 不进 unknown | pass | 真实 503/409/422/426；PR-13 #86 修复 not_accepted UI |
| 10 | SSE/消息/终态按会话隔离；迟到回执 | pass（simulated） | 状态机测试；真实单会话 SSE |
| 11 | 失败轮容量解释/权限变化/来源不可用/受限消息 | pass（simulated） | 组件测试；未做真实容量构造（E05 另计） |
| 12 | 标题取更严投影/restricted 不渲染 | pass（simulated） | 测试；真实 UI 未构造 restricted |
| 13 | 键盘/焦点/IME/1024/1440/compact 检查记录 | **pass** | 稳定全局 Chat 补测（`keyboard_ime_visual.md`，task-19） |
| 14 | F01–F17/M5/可见性/authEpoch 测试；tsc/lint/build | pass | 相关套件/类型检查；lint 基线见 PR 记录 |
| 15 | 第二批可用后完成真实接入矩阵（本地模型+合成内容） | **limited** | 隔离真实部署（`deployment.md`）；10 腿 8 pass + 1 limited（Source）+ 1 limited（生产 B5/非生产），非生产构建 |
| 16 | 第一批 list_query source 选择器缺口登记 | **pass** | `gap_registration.md`：#584 评论、#602 记录 |
| 17 | 未部署/未清理/未外发真实内容 | pass | 未改生产 flag/服务；合成内容；外部模型关闭 |

## 出口判定

**未满足**。仅剩两项硬性未闭合：
1. **§10.4 第 6 腿 Source 完整链路**：UI 刷新/重开草稿恢复 limited，且 `source_chain.md` 记录疑似缺陷（reload 后草稿 0、session 不在列表）；需在稳定 source 会话下复现并修复/补证。
2. **生产 B5 未执行**：隔离真实部署可作 §10.4 隔离证据，但设计明确“第二批可用的构建/部署”；生产 `rdlens.service` inactive、契约 flag false，需用户授权后部署并在部署环境重跑矩阵。

## 建议
- 重新打开 fork **#71**（当前 closed 记录“隔离真实接入完成”不满足 §10.4 第 6 腿严格口径）。
- 新增 Source 缺陷修复任务（先复现，确认是 UI 还是后端/缓存）。
- 生产 B5 由部署窗口完成后，重跑 `README.md` 矩阵并更新 `deployment.md`。
- 其余 6b 证据任务（B5 隔离固化、Source API、503/envelope、键盘/IME、缺口登记）已完成。
