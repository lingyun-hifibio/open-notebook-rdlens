# 生产 B5 · 浏览器 UI 走查记录（2026-10-28）

- **环境**：真实生产（`rdlens.service` @ `932c0b4f`，`RDLENS_RESEARCH_SESSION_CONTRACT=true`；前端镜像 `rdlens.30` `sha256:d0c0b519…`；nginx `192.168.5.82:7890` → 7891，iframe `192.168.5.82:7800/research`）。
- **账号**：`testuser@hifibio.com`（user 1，owner；密码由用户提供，不入证据）。项目 `usr_1_8976…a7a3`（DEMO-01 演示项目）。
- **证据级别**：`real`（真实生产 + 真实 Chromium 153）。唯一 simulated 项为无。
- **前置修复（本窗口内）**：宿主 `frontend/dist` 重建并带 `VITE_RESEARCH_WORKSPACE_URL=http://192.168.5.82:7800/research`——原 dist 缺该变量导致研究页恒 `workspace_not_configured`（见 `runbook_20261028.md` §执行前置 1）。

## 逐项结果

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | 登录 → `#/research/<project>` → iframe 挂载 | **pass** | frames 含 `http://192.168.5.82:7800/research`；header 显示 `DEMO-01 演示项目` / `testuser` |
| 2 | bootstrap 与首屏数据 | **pass** | `workspace-status`/`bootstrap`/`jobs`/`models`/`notes`/`execution-preferences`/`external-egress-consent`/`sources`/`chat/sessions` 全 **200**；console error 0 |
| 3 | 新建会话 + composer 输入 + 自动保存 | **pass** | 新会话触发；`All changes saved` 出现；`chat-input` 可输入 |
| 4 | 发送（本地模型）→ 202 → attach 200 SSE | **pass** | `POST .../chat` **202** → 同 URL **200 `text/event-stream`**（首帧 `usage` 带 accepted 回执） |
| 5 | 回答终态投影 | **pass（degraded）** | 该合成提问命中 `persistent_job_required`（`source_over_budget`），UI 显示稳定码错误卡与后台任务 CTA，非崩溃 |
| 6 | 错误卡与恢复动作（PR-13 真正生效） | **pass** | `chat-error` 1 个、`role=alert` 3、文案“This question needs a background research job — the selected sources exceed the single-turn budget.”；`netTail` 含 202/200 |
| 7 | 草稿刷新恢复（PR-12/PR-14 生效） | **pass** | 保存后刷新 → composer 出现且 `inputValue === 草稿串`（`restored: true`） |
| 8 | 会话持久化 | **pass** | `GET .../chat/sessions?kind=all` 返回本会话；详情 `messages` 含本轮 user 消息；`has_draft` 状态正确 |
| 9 | 外部模型路径 | **pass（fail-closed，符合设计）** | 选 `DeepSeek V4 Flash`（external）发送 → **422** `session_contract_unsupported: external models are not supported on the session submission path yet`；UI 显示错误卡、不静默 |
| 10 | 生产模型偏好 | 变更并记录 | 为完成本地模型发送腿，`PATCH execution-preferences preferred_model_id=Qwen3.6-35B`（原 `deepseek-v4-flash`，可回滚） |

## 未覆盖（不伪造）

1. **Source 面板真实链路**：本轮只验证全局 Chat；Source 端的 404/cancel 未取证（延续 `source_chain.md` 的 limited）。
2. **1024/compact 生产视口**：本轮 1440×900；隔离环境已测 1440/1024/820（`keyboard_ime_visual.md`）。
3. **48 场景复核（E13）**、**24h 观察（E14）**：未执行。
4. **C-05 范围能力**：生产 `capabilities.c05.enabled=false`（各入口 `unavailable_reason=c05_contract_disabled`），未开启（需单独授权）。
5. **正常 `success` 综合答案样本**：本项目的 source 规模触发 `persistent_job_required`，未取得正常答案轮（属数据规模与既有产品行为，非本次部署缺陷）。

## 结论

生产第三批 UI 主链路（登录→研究页→bootstrap→新建会话→输入保存→发送 202/200 SSE→终态/错误卡→刷新恢复）**已真实验证通过**；PR-12/PR-13/PR-14 的修复在生产均可见生效。E13/E14、Source UI、C-05 仍 outstanding。
