# PR-6 真实接入矩阵（DESIGN §10.4；2026-10-27 实测）

- **总状态**：`9 pending + 1 excluded`（**0 pass**）。第三批出口**未满足**。
- **统一原因**：RDLens Gateway 未运行（`rdlens.service` inactive；7891/7892 connection refused；对外 7890 → nginx 502）；`RDLENS_RESEARCH_SESSION_CONTRACT` 默认 off 且三处均未注入；`research.enabled=false`；部署 fork 前端镜像早于本批（2026-10-22）。证据见 [`environment_snapshot.md`](environment_snapshot.md) 与 [`raw/`](raw/)。
- **纪律**：不部署、不重启生产/共享服务、不注入 flag、不外部模型、不外发真实内容；故障注入仅允许专用隔离 Gateway（当前不存在）→ 该腿 `excluded`。

| # | 腿 | 状态 | reason | 证据/命令 | 结论 |
|---|---|---|---|---|---|
| 1 | 创建与列表（global A/B、source C、`kind=global/all`、空会话、`has_draft`、分页不重排） | `pending` | Gateway 未运行 + flag off；无可用第二批 API | `systemctl show rdlens.service -p ActiveState,SubState`；`curl 127.0.0.1:7891/health` → refused；`curl 192.168.5.82:7890/health` → 502 | 未执行，不冒充 |
| 2 | 编辑保存/读回（A/B 各自 scope/draft/anchor、CAS 409、ACK 丢失重放） | `pending` | 同上 | 同上 | 未执行 |
| 3 | 空会话与重开（B 无消息刷新仍存在） | `pending` | 同上 | 同上 | 未执行 |
| 4 | 提交与查回（本地模型+合成问题、切 B 后查回、cards 空但 completed、不清新稿） | `pending` | 同上；且禁止外部模型/真实内容 | 同上；组件证据见 `keyboard_layout_checks.md`（simulated） | 未执行 |
| 5 | SSE 绑定（A 运行中切 B、服务端继续、返回恢复、无 cancel、冷启动只 durable） | `pending` | 同上 | 同上 | 未执行 |
| 6 | Source 完整链路（创建→保存→发送→SSE→切换/关闭→重开；来源 404 不清会话/指针） | `pending` | 同上；本腿缺失则第三批出口不完整 | 同上 | 未执行 |
| 7 | 权限（owner、Admin 私有 Chat 403、跨 owner/项目 404、来源暂不可用 vs 撤权） | `pending` | 无可用 Gateway 与隔离 fixture；不得接触真实用户来源 | 同上 | 未执行 |
| 8 | 失败路径（停 Gateway/503 后保存失败保留输入、查回失败不清稿、不自动重发） | `excluded` | 无专用隔离 Gateway；规则禁止停生产/共享服务与故障注入 | `docker ps`（仅共享 research/rdlens 实例）；`systemctl is-active rdlens.service` | 环境不允许，标 excluded |
| 9 | 错误 envelope 实样（426 `c05_contract_not_enabled`、503 `c05_entry_not_ready`、C-05 422、generation 409） | `pending` | 无可用 Gateway 采集原始响应；不以冻结 JSON/fixture 冒充实样 | 同上 | 未执行 |
| 10 | 认证代际（同 token refresh 使旧代响应失效、`refresh_failed` 不卸载、QueryClient 旧代不回填） | `pending` | 同上；需真实认证链路 | 同上 | 未执行 |

## 备查：为何不能用部署前端 + 5055 冒充真实接入

- `5055` 是 ON embedded API（`/api/chat/sessions` 为旧路径），不是第二批 `/v1/research/projects/{project_id}/chat/sessions` 契约端点；`openapi.json` 路径实测无 `/v1/research/projects/*`（未带认证返回 401，路径清单来自 5055 的 `/openapi.json`）。
- `192.168.5.82:7800` / `8502` 只有前端静态入口；`RD_AI_GATEWAY_URL` 指向 `7890`，而 `7890` 上游（RDLens `7891/7892`）未运行。
- 因此任何“前端可用”都不能计为真实接入 pass；本 PR 组件证据全部标 `simulated`。
