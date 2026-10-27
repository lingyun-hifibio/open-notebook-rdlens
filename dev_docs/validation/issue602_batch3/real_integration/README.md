# #602 第三批 6b 真实接入证据（隔离环境）

- **日期**：2026-10-28
- **代码基线**：fork `945f8a18d3ee422c94643a368f12bf6551140e56`（含 PR-1…PR-6 + PR-7…PR-12）；RDLens 主仓 `3620c9c1`（第二批已合并）
- **性质**：隔离真实 Gateway + 独立 PG/Surreal + 本机 SGLang；**不是生产部署**；未启用生产 flag、未停生产/共享服务、未外发真实项目内容（合成内容）。
- **证据级别**：本文与原始输出为 `real integration`（隔离环境）；组件/jsdom 证据仍为 `simulated`。

## 隔离环境

| 组件 | 地址/配置 |
|---|---|
| Gateway | `127.0.0.1:7896`，RDLens `3620c9c1`，`RESEARCH_ENABLED=true`、`RESEARCH_CONTRACT_V1_ENABLED=true`、`RDLENS_RESEARCH_SESSION_CONTRACT=true`、`RESEARCH_C05_SCOPE_ENABLED=true`、`RESEARCH_EXTERNAL_LLM_ENABLED=false` |
| PG | `127.0.0.1:5436/knowledge_os_issue602_b3`（独立库） |
| Surreal | `127.0.0.1:18004`，namespace/database `rdlens_research_602` / `research_artifacts_602` |
| 前端 | fork main `945f8a1` dev server `127.0.0.1:8503/research`（embedded 模式，`NEXT_PUBLIC_RD_GATEWAY_URL=http://127.0.0.1:7896`）；host 页 `127.0.0.1:8504` 下发 Research JWT |
| 模型 | 本机 SGLang `127.0.0.1:9999`，模型 `Qwen3.8-27B`（`data_egress=false`，`supports_stream=true`）；证据轮答案被证据一致性闸门拦截（degraded），终态/计量路径仍验证 |

隔离 seed：`knowledge_os_issue602_b3` 由 `RDLens validation/issue623/s3/seed_fixture.py` 思路适配生成（用户/项目/source `b3-source`/文档 `b3-doc`/索引 READY/provider `b3-local-sglang`/model `Qwen3.8-27B`）；`research_workspace_mapping` 需 1 行（notebook/owner）供 execution-preferences，已补；建议回填 seed。

## 矩阵（DESIGN §10.4，10 腿）

| # | 腿 | 结论 | 证据 |
|---|---|---|---|
| 1 | 创建与列表（global A/B、source C、空会话、分页） | **pass** | API `POST/GET .../chat/sessions` 201/200；UI 创建 201、列表出现、刷新后列表保留 |
| 2 | 编辑保存/读回（scope/draft/anchor、CAS/ACK） | **pass** | GET/PUT editor-state 200；同 mutation 重放 200；CAS 冲突 409 `editor_revision_conflict`；UI 保存后刷新读回 |
| 3 | 空会话与重开 | **pass** | API 列表/编辑器读回；UI 刷新后会话列表与指针保留（未命名标题字面量“新对话”） |
| 4 | 提交与查回（本地模型+合成问题） | **pass** | `POST /chat` 202 accepted → lookup 200；UI `Submitted — completed` + Usage 284/37 |
| 5 | SSE 绑定/切换不 cancel | **pass（API 层）** | 202 后同 body/key + `Last-Event-ID:0` → 200 SSE：thinking/answer/citation/usage/done；服务端 streaming 无 cancel 调用 |
| 6 | Source 完整链路（create→save→send→SSE→lookup） | **pass（API 层）** | source session 201；editor PUT 200；send 202→attach 200 SSE；lookup terminal；UI source 端到端未单独走查（limited） |
| 7 | 权限（owner/Admin/跨用户/来源 404） | **pass** | owner 200；admin_readonly list 403 `chat_owner_required`；跨用户 403；source 不存在 404 |
| 8 | 失败路径/故障注入 | **limited** | 停隔离 Gateway 后 UI 显示 “Failed to load workspace data / Retry”，无崩溃；未做 503 注入（无专用故障注入窗口） |
| 9 | 错误 envelope 实样 | **limited** | 已采集 403/404/409/422/426 原始 envelope；未采集 503 `c05_entry_not_ready` |
| 10 | 认证代际 refresh | **pass** | host 下发 `refresh` 后 UI 发送仍 `POST /chat` 202→200 SSE |

## 真实 UI 复核（2026-10-28）

- 创建→输入→保存→Send：`POST /chat` **202** → 同 URL **200 text/event-stream** → UI `Submitted — completed` + Thinking + `Usage 284/37`（本地模型 degraded，答案被证据一致性拦截，终态成立）。
- 刷新 host 后草稿恢复、Send 后同上 202→200（PR-12 修复）；刷新后新建会话再发也通过。
- 布局：iframe 调整为 1440/1024/820 宽度时 `scrollWidth == innerWidth`、无横向溢出、composer 可见（screenshots `screenshots/final_w1440.png`、`final_w1024.png`、`final_compact.png`）。
- 失败态：Gateway 停止时 `screenshots/final_gateway_down.png`（错误条 + Retry，无崩溃）。

## 命令与原始输出

- 隔离 Gateway：`/health` 200；`/v1/research/health` `{"enabled":true,"status":"ready"}`。
- API 探针（脚本不入仓，输出见下文摘要）：
  - `GET .../chat/sessions?kind=all&limit=5` → 200；`POST .../chat/sessions` → 201；`GET .../editor-state` → 200；`PUT` → 200（replay 200、CAS 409）。
  - `POST .../chat`（global）→ 202；`POST` + `Last-Event-ID:0` → 200 SSE，events `usage/thinking/answer/citation/usage/done`。
  - source：`POST .../sources/b3-source/chat/sessions` → 201；send → 202→200 SSE；lookup `{"acceptance_state":"terminal",...}`。
  - `GET .../submissions/{not_observed_token}` → 200 `acceptance_state=not_observed`，`idempotency_key` 与前端 `buildSubmissionKey` 逐字节相等。
- UI：Playwright-core/Chromium 1243；网络证据为 `POST /chat` 202 与同 URL 200 SSE（见 screenshots 与 PR-12/PR-10 评论）。

## 剩余限制（不伪装为 pass）

1. 生产部署/B5（flag-on、24h 观察、镜像发布）**未执行**；本证据为隔离真实 Gateway，不等于生产验收。
2. 腿 8/9 的 503 故障注入与错误实样缺失（`limited`）；腿 6 的 Source 面板 UI 端到端未单独走查（API 层 pass）。
3. 本地模型回答被证据一致性闸门拦截（degraded），未取得正常综合答案样本；容量 trimmed/blocked 的真实构造归第四批 E05。
4. 视觉仅结构/无横向溢出与截图，人工视觉走查未做（`limited`）；真实浏览器 200ms 退出动画等仍为模拟。
5. 隔离 seed 的 `research_workspace_mapping` 为运行期补行，建议回填脚本。

## 结论

第三批在隔离真实 Gateway 上完成最小矩阵：10 腿中 **7 pass + 3 limited（腿 6/8/9 的限定项）**；未发现新的产品 P0（PR-7…PR-12 的修复已覆盖发现项）。生产部署与 503/E05 取证不在本证据范围。
