# B5 生产部署执行记录（#602 第三批，2026-10-28）

- **性质**：用户授权后**真实生产变更**（区别于 `b5_deployment_readiness.md` 的只读就绪评估）。
- **窗口**：2026-10-28 16:35–17:10 CST（用户当轮授权“B5 现在授权，一起处理”）。
- **执行人**：Lead（本会话）。备份/证据目录：`/mnt/data_ext-disk/lychen/RDLens/b5_evidence/20261028T1644`、`…/20261028T164604`、`…/20261028T164801`、`…/20261028T164924`、`…/20261028T165106`。

## 1. 部署对象

| 组件 | 变更前 | 变更后 |
|---|---|---|
| RDLens 后端 | `4b26b900`（HEAD，未记录漂移） | **`932c0b4f`**（origin/main，含第二批 + 会话契约路由） |
| PG 迁移账本 | 34 | 34（无新增；`migrate ok: postgresql=34, surreal=[1..11]`） |
| Surreal 迁移账本 | 1–11 | 1–11（`--check` 通过） |
| `RDLENS_RESEARCH_SESSION_CONTRACT` | 未设置（off） | **`true`**（`/home/lchen/.config/rdlens/research-preview.env`，先于镜像切换） |
| 前端候选镜像 | `rdlens.29`（`sha256:1041c88e…`，fork `e2c9d8d1`） | **`rdlens.30`**（`sha256:d0c0b519…`，fork `644f8f95`） |
| 台账 | — | RDLens PR **#833**（`1ff54ef5`）五处锁步 |

## 2. 执行步骤与结果

| # | 步骤 | 命令/动作 | 结果 |
|---|---|---|---|
| 1 | preflight | `b5_deploy_window.sh preflight` | 全部 OK（部署树含脚本、unit verify、冻结 JSON digest 一致、flag off 三源核对、磁盘充足） |
| 2 | 备份 | PG `pg_dump -Fc` → 120,329,479 B；Surreal `SELECT * FROM rdlens_chat_session; rdlens_chat_message;` → 595,700 B（79 sessions / 125 messages）；`INFO FOR DB`；Redis DBSIZE=22 | 全部落盘 + sha256 摘要（`backup_summary.txt`） |
| 3 | 构建镜像 | 干净 detached worktree `644f8f9` + 4 冻结 build args → `docker build` → **首次失败**（见 §3）→ 修复后成功 | `sha256:f163688085…` |
| 4 | 推送 | `docker push ghcr.io/…:v1.14.0-rdlens.30` | digest **`sha256:d0c0b5194e4d704a3658103d57f389a8b0eafe7d8d22715f0a784beeae39fb2e`** |
| 5 | 镜像自检 | `frame-ancestors`；chunk 正/负标记 | `frame-ancestors http://192.168.5.82:7890` 精确；`research-session-nav`=1、`session-switcher-new`=1、`coverage_not_enabled`=1、`global-model-summary-trigger`=1、`chatRestoreRunning`=3；**`session-content-gate`=0**（PR-9 移除门禁，负向正确） |
| 6 | 台账同步 | RDLens PR #833（compose / baseline.yaml / BASELINE.md / candidate_manifest / contract test） | 校验：`validate_research_compose` 通过、`validate_research_baseline` 通过、`pytest test_deployment_contract.py` **58 passed** |
| 7 | 暂存后端 | `b5_deploy_window.sh stage --apply --deploy-sha 932c0b4f --allow-stash` | **首次 FAIL**（见 §3 第 2 项）→ 移除 flag 后重跑 OK（E01/E03） |
| 8 | 迁移 | `migrate --apply` | `--status` 正常；`migrate ok: postgresql=34, surreal=[1..11], verified`；`--check` 通过 |
| 9 | 启动后端 | `start --apply` | `rdlens.service active`；`/health` `{"status":"ok"}`；journal 无 MIGRATE-FAIL；research-preview.env 已加载 |
| 10 | 开 session 契约 | 写入 `RDLENS_RESEARCH_SESSION_CONTRACT=true` → `systemctl restart` | 重启后 active；**路由语义从 404 → 401**（带头请求 401 = 已注册未认证，符合 §6.1） |
| 11 | 换前端容器 | `docker compose -p research-open-notebook up -d open_notebook` | 容器重建，image = `@sha256:d0c0b519…`，**healthy** |
| 12 | 入口验证 | `192.168.5.82:7800/research` 200；`7890/v1/research/health` 200 | iframe 页 HTML 正常、`Content-Security-Policy: frame-ancestors http://192.168.5.82:7890` 精确 |

## 3. 窗口内发现并修复的阻塞（2 项）

### 3.1 `next build` 因未声明的 devDependency 失败（阻断镜像构建）
```
src/components/research/ResearchContextReport.test.tsx(16,23): error TS2307: Cannot find module '@testing-library/user-event'
src/components/research/ResearchSubmissionStatus.test.tsx(13,23): error TS2307: Cannot find module '@testing-library/user-event'
```
- 根因：PR-5b（`f175bc6`）在测试里 import `@testing-library/user-event`，但从未写入 `frontend/package.json`；宿主 `node_modules` 恰好有，容器 `npm ci` 后没有。
- 修复：fork PR **#92**（`e631a18`）仅改 `package.json`/`package-lock.json`；验证 `npm ci` → 759 packages、相关测试 17 passed、`tsc -b` 0、`npm run build` 成功。
- 影响：这是 `rdlens.30` 无法构建的**唯一根因**，不修则 B5 无法完成。

### 3.2 B5 脚本的 flag 断言与“先开 flag”发布顺序冲突
- `b5_deploy_window.sh` 在 §1/§3/§8 三处断言 `RDLENS_RESEARCH_SESSION_CONTRACT` 必须为 off（该脚本设计前提是 flag 在窗口后单独开）。
- 与 DESIGN §2.6 的发布顺序（session 契约必须在换镜像**前或同窗口**开启）冲突：脚本执行到 §3 时因 flag=on 直接失败退出。
- 处置：窗口内**先移除 flag** 完成 stage/migrate/start（保持脚本契约），随后**再写入 flag 并 restart**（步骤 10），最终状态满足发布顺序。备份文件 `research-preview.env.bak.*` 与 `.flagged` 保留。
- 建议：后续把该脚本改为支持 `--enable-session-contract` 或在 §6 后开 flag，避免同类手工绕行。

## 4. 生产真实链路验证（API 级，已通过）

项目：`usr_1_8976d1453a214062bfb82c45d3bea7a3`（该用户 1 的 research 映射项目）；模型：`Qwen3.6-35B`（local-sglang，`data_egress=false`）。

| 断言 | 结果 |
|---|---|
| `GET /v1/research/health` | 200 `{"enabled":true,"status":"ready"}` |
| `GET .../models` | 200，含 local Qwen3.6-35B（`supports_stream=true`）+ `capabilities.sessions{submission_ready:{global:true,source:true}}`（列表响应） |
| `GET .../chat/sessions?kind=all&limit=3` | 200，返回真实历史会话（含 2026-09 旧会话） |
| `POST .../chat/sessions` | **201** |
| `GET .../editor-state` | 200（revision 0） |
| `PUT .../editor-state` | 200（revision → 1，草稿写入） |
| `POST .../chat`（session 头 + c05 头 + 冻结 body + 后端实算 `editor_intent_hash`） | **202 accepted**，返回 `acceptance_state:"accepted"` + `generation_id` |
| `POST .../chat` + `Last-Event-ID: 0` | **200 `text/event-stream`**，首帧 `usage` 携带 accepted 回执 |

**契约细节（真实踩坑，已记录供后续）**：
- global session-v1 提交必须同时带 `X-Research-Contract: c05-v1`，否则 426 `X-Research-Contract: c05-v1 is required…`；
- `source_scope` 必填且为对象，`extra=forbid`（不能塞 `note_ids`，否则 422 `scope_unknown_field`）；
- body 必须含 `session_id`/`editor_revision`/`draft_token`/`editor_intent_hash`/`query`/`model_id`/`context_level`/`source_scope`；
- `editor_intent_hash` 必须与后端 `editor_state.editor_intent_hash(...)` **逐字节一致**（自造 hash 会 409 `session_context_changed`）。

## 5. 未完成 / limited（不伪造）

1. ~~浏览器 UI 端到端未做~~ → **已完成**（2026-10-28 19:00，用户提供 `testuser@hifibio.com` 凭据）：见 `prod_ui_20261028/README.md`。登录→研究页→bootstrap 全 200→新建会话→输入保存→发送 **202→200 SSE**→错误卡（`persistent_job_required`）→刷新草稿恢复 `restored:true`。前置修复：宿主 `frontend/dist` 重建并注入 `VITE_RESEARCH_WORKSPACE_URL`（原 dist 缺该变量 → `workspace_not_configured`）。
2. **24h 观察（E14）未开始**：需窗口内不停服 + 12h 中途复检。
2b. **Source 面板生产 UI**、**1024/compact 生产视口**未覆盖（隔离环境已测）。
3. **48 场景复核（E13）未做**。
4. **C-05 范围能力仍 disabled**（`capabilities.c05.enabled=false`，各入口 `unavailable_reason=c05_contract_disabled`）：按第二批既有状态，不在本次窗口开启（需负责人对 C-05 单独授权）。
5. **B5 脚本 flag 断言未改代码**（见 §3.2，只做手工绕行）。

## 6. 回滚
- 后端：`git checkout 4b26b900` + 移除 `RDLENS_RESEARCH_SESSION_CONTRACT` + `systemctl restart`（脚本 `rollback --apply` 可用；不 down migration，两库账本无变更）。
- 前端：`compose.yaml` 回 `@sha256:1041c88e…` + `docker compose up -d open_notebook`。
- 数据：PG dump（120 MB）+ Surreal 会话/消息 JSON（79/125）可恢复；Redis 22 键。

## 7. 结论
**生产 B5 已执行并达到“已部署 + API 真实链路通过”**；剩余生产验收项为 UI 人工走查、48 场景复核、24h 观察（E14），以及 C-05 单独授权。不宣称 E14/第三批生产验收完成。
