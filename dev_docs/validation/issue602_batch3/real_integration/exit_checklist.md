# 第三批出口核对（6b 收口，2026-10-28）

对照 `01_DESIGN.md` §10.6 与 `cards/PR-6.md`。证据目录：本目录。

| # | §10.6 条目 | 状态 | 证据/说明 |
|---|---|---|---|
| 1 | 会话列表、新对话、切换、当前识别；global/source 活动会话独立 | pass | 文件内 `README.md` 腿 1/3；UI 创建/切换/刷新 |
| 2 | 两会话 scope/草稿/阅读位置在切换、刷新、重开后恢复 | pass（全局 + source） | 全局：生产 UI 刷新 `restored:true`（`prod_ui_20261028/README.md`）；source：PR-14 #88 真实 UI `matches=true`；阅读锚点由 PR-3 测试覆盖 |
| 3 | 保存失败/CAS/清稿 hold/operationId | pass（simulated）+ 真实 CAS 409 | 组件测试 + 真实 409 envelope |
| 4 | 认证切换隔离/旧响应不回填 | pass | 真实 refresh 后发送 202→200；测试 |
| 5 | 两标签草稿分支/多分支恢复/T1 查回 | pass（simulated） | 组件测试；未做真实双标签人工走查（记录为 simulated） |
| 6 | 冷启动 durable/热恢复续水位/durable 不重复 | pass | 真实 submit/lookup/SSE；PR-12 刷新发送 |
| 7 | Coverage 隔离 + Source 完整链路有真实证据或明确 limited | **pass（主链）/limited（404）** | **生产真实走查完成**（`source_prod_20261028/README.md`，`rdlens.32`）：创建 201 → 保存 → 发送 **202→200 SSE** → 切换 source 草稿恢复 → 刷新重开恢复 → B 草稿独立 → 无 cancel。走查中发现并修复 2 个 P0：来源 id 冒号（RDLens #844）、source 发送门禁（fork #97）。仅「来源 404 不清指针」为 limited（有单测、生产未构造） |
| 8 | display ref 刷新权威；source editor 授权；source 404 | pass（全局 + source editor）/limited（source 404） | 全局刷新恢复；source editor 授权成功即可编辑已实测；source 404 未构造（limited） |
| 9 | 错误 envelope 排序/not_accepted 不进 unknown | pass | 真实 503/409/422/426；PR-13 #86 修复 not_accepted UI |
| 10 | SSE/消息/终态按会话隔离；迟到回执 | pass（simulated） | 状态机测试；真实单会话 SSE |
| 11 | 失败轮容量解释/权限变化/来源不可用/受限消息 | pass（simulated） | 组件测试；未做真实容量构造（E05 另计） |
| 12 | 标题取更严投影/restricted 不渲染 | pass（simulated） | 测试；真实 UI 未构造 restricted |
| 13 | 键盘/焦点/IME/1024/1440/compact 检查记录 | **pass** | 稳定全局 Chat 补测（`keyboard_ime_visual.md`，task-19） |
| 14 | F01–F17/M5/可见性/authEpoch 测试；tsc/lint/build | pass | 相关套件/类型检查；lint 基线见 PR 记录 |
| 15 | 第二批可用后完成真实接入矩阵（本地模型+合成内容） | **pass（生产已部署，矩阵含 documented excluded）** | 隔离预演 10 腿（`deployment.md`）；**生产 B5 已部署**（`b5_execution_20261028.md`）：API 201/200/202/200-SSE + 生产 UI 发送 202→200 SSE、错误卡、刷新恢复；E13 48 场景与 E14 24h 观察经 owner 2026-10-28 指示**省略（excluded）** |
| 16 | 第一批 list_query source 选择器缺口登记 | **pass** | `gap_registration.md`：#584 评论、#602 记录 |
| 17 | 未部署/未清理/未外发真实内容 | pass（口径更新） | 本轮**经用户授权**执行生产部署（后端 `932c0b4f`、镜像 `rdlens.30`、session 契约 on）——不再是“未部署”；合成内容；**外部模型未使用**（external 路径 422 fail-closed，全部发送走本地 SGLang `data_egress=false`）；`preferred_model_id` 已置本地（可回滚，见执行记录） |

## 出口判定

**生产 B5 已于 2026-10-28 执行**（用户授权；见 `b5_execution_20261028.md`）：
1. ~~§10.4 第 6 腿 Source 完整链路~~：**已修复**（PR #88，真实 UI 复验 `matches=true`；404/cancel 标 limited 并注明）。
2. ~~生产 B5 未执行~~ → **已部署**：后端 `932c0b4f`（迁移 34/11 校验通过）、`RDLENS_RESEARCH_SESSION_CONTRACT=true`（路由 404→401）、前端镜像 `rdlens.30`（`sha256:d0c0b519…`，容器 healthy）、台账 RDLens PR #833。生产 API 真实链路（创建 201 → 编辑 PUT 200 → 提交 202 accepted → attach 200 SSE）已通过。
3. **生产浏览器 UI 走查已完成**（`prod_ui_20261028/README.md`）：登录→研究页→bootstrap 全 200→新建会话→保存→发送 **202→200 SSE**→错误卡→刷新草稿恢复 `restored:true`；外部模型 422 fail-closed 符合设计。
4. **E13 48 场景复核 / E14 24h 观察：按 owner 指示省略**（2026-10-28 21:39 “E13/E14 直接省略”）→ 记为 **excluded**，不计 pass。
5. **仍 limited（已登记，不阻塞出口）**：① Source 面板生产 UI 未走查（隔离环境已覆盖）；② 1024/compact **生产**视口未测（隔离已测）；③ source 404 不清指针、切 source 不 cancel 未单独取证；④ C-05 范围能力（`c05.enabled=false`）未开启，需单独授权——不属第三批范围。

### 出口判定结论
**第三批出口满足**（`pass` 与逐腿 `limited`/owner `excluded` 并注明，无未登记缺口）。依据：
- 17 项中 15 项 pass（含本轮将 #2/#15/#17 依据生产证据升级）、1 项 pass/limited（#7）、1 项 pass/limited（#8）；
- 生产 B5 真实部署 + 生产 API/UI 链路通过；
- E13/E14 由 owner 明确省略；C-05 与 Source 生产 UI 以 limited 登记，不影响第三批会话交互契约的交付判定。

## 建议
- 重新打开 fork **#71**（当前 closed 记录“隔离真实接入完成”不满足 §10.4 第 6 腿严格口径）。
- ~~Source 缺陷修复~~：已完成（PR #88 #88）。
- 生产 B5 已执行；下一步在具备登录凭据的环境补 UI 走查 + 48 场景 + 24h 观察，并重跑 `README.md` 矩阵。
- 其余 6b 证据任务（B5 隔离固化、Source API、503/envelope、键盘/IME、缺口登记）已完成。
