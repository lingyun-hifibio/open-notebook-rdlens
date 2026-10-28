# §10.4 腿 8/9：失败路径、故障注入与错误 envelope 实样（隔离环境）

- **日期**：2026-10-28（取证窗口 11:41–12:30 CST）
- **任务**：#602 第三批 6b 收口 / 子代理「503/故障注入与错误 envelope」
- **证据级别**：
  - **real**（真实 HTTP 503 + 真实 envelope 字节，来自运行中的隔离 Gateway `127.0.0.1:7896` 与独立故障实例 `127.0.0.1:7899`）；
  - **simulated**（UI 侧的传输层故障用 Playwright `route` 注入——浏览器与页面真实，网络层人为替换）；
  - **real**（依赖真停机：独立故障实例的 Surreal 依赖上游被切断，非 route 注入）。
- **性质**：隔离真实 Gateway + 独立 PG/Surreal + 本机 SGLang；**不是生产部署**。未启用生产 flag，未停/未改共享服务（7896/8503/8504/18004 全程可用，见 §7）。
- **结论**：**partially pass → 记为 `limited`**
  - 腿 9（错误 envelope 实样）：**pass** — 采集到 **4 个真实 503**（3 个稳定码 + 1 个依赖断开变体），均含稳定码/`retryable`/`request_id`，脱敏完成。
  - 腿 8（失败路径/故障注入）：**limited** — UI 在三种故障下均**不崩溃、不清稿**且能恢复，但**真实 503 在上层 UI 不产生可见错误提示**（重复提交被静默吞掉），见 §6 缺陷 F-1。这是本次发现的**产品缺陷**，按要求**未改代码**，故该腿不能记 pass。

---

> **后续更新（2026-10-28，PR-13 #86）**：F-1 已修复——`ResearchChatPanel` 将 `idle+errorCode`（not_accepted）投影为 error，空答案保留 assistant 行，渲染稳定码错误卡与恢复说明；真实 503 envelope 回放复验：`chat-error=1`、`role=alert=2`、草稿保留、无崩溃。腿 8 的 UI 静默项据此关闭；传输层回放仍标 simulated。

## 1. 版本与 SHA

| 组件 | 版本 / SHA | 取证方式 |
|---|---|---|
| RDLens 后端（7896 运行中 + 7899 故障实例，同一份代码） | **`3620c9c1d741cb9173e7355f8c6a23b609f48687`**（隔离 worktree `/home/lchen/workspace/RDLens-issue602-b3`，工作树干净） | `git -C … rev-parse HEAD`；7899 以 `cwd`/`PYTHONPATH` 指向该 worktree 启动 |
| fork 证据 worktree（本文件所在） | HEAD `8226f12564569c91df1afca82e3cb79f4bea0e50`，分支 `feat/issue602-b3-remaining-evidence` | `git rev-parse HEAD` |
| 前端 8503 | `next dev -p 8503`，worktree `.worktrees/batch3-pr12` | 运行中进程 |
| 依赖 | FastAPI `0.136.0` / Starlette `0.52.1` / Pydantic `2.13.1`；PG `127.0.0.1:5436`；Surreal `127.0.0.1:18004`；SGLang `127.0.0.1:9999` | `python -c` 版本探针；端口探针 |
| 浏览器 | Playwright-core + Chromium `1243`（`chromium-1243/chrome-linux64/chrome`，headless） | 脚本内 `executablePath` |

---

## 2. 故障注入手法（可复现，不含 token/密钥）

### 2.1 独立故障实例 7899（不碰 7896）

复用同一套隔离 env（`/tmp/rdlens-issue602-b3/app.env`，脱敏后见 `deployment.md` §3），仅**改一个依赖地址**，其余逐字节相同：

```bash
cd /home/lchen/workspace/RDLens-issue602-b3
export PYTHONPATH=/home/lchen/workspace/RDLens-issue602-b3/src
# 其余 env 由 app.env 注入（RESEARCH_ENABLED=true 等，同 7896）
export RESEARCH_SURREAL_URL=http://127.0.0.1:19998   # 可切断的 TCP 代理，非真实 Surreal
export RESEARCH_CORS_ALLOWED_ORIGINS=http://127.0.0.1:8503,http://127.0.0.1:8504
/home/lchen/workspace/RDLens/.venv/bin/python -m uvicorn rdlens.api.app:create_app \
  --factory --host 127.0.0.1 --port 7899 --proxy-headers
```

`19998` 是一个**自建 TCP 转发代理**（`127.0.0.1:19998 → 127.0.0.1:18004`）。这样可以在实例**运行期间**用 `kill <proxy pid>` 精确切断 Surreal 依赖，而不触碰共享的 SurrealDB 容器。

> **观察（fail-closed，正向行为）**：若启动时 Surreal 直接不可达，Gateway **拒绝启动**：
> ```text
> SurrealDB 请求瞬态失败，重试 1/2（URL=http://127.0.0.1:19999）
> SurrealDB 请求瞬态失败，重试 2/2（URL=http://127.0.0.1:19999）
> SurrealDB research schema migration failed; refusing to start: SurrealDB 不可用（3 次尝试后）
> ```
> 即「依赖死 → 不带着坏依赖对外服务」，符合 fail-closed。

### 2.2 UI 传输故障（Playwright `route`，标记 `simulated`）

- 场景 A：`ctx.route('**/v1/research/**', r => r.abort('connectionfailed'))` → 全量 research API 断连。
- 场景 B：`ctx.route` **回放真实采集到的 503 字节**（body/`X-Request-ID` 均来自 §3 的真实响应），只替换传输层。

---

## 3. 真实 503 原始样本（腿 9 → **pass**）

均来自运行中的隔离 Gateway，稳定码 + `retryable` + `request_id` 齐全，响应头含 `X-Request-ID`。

### 3.1 `503 c05_entry_not_ready`（C-05 未接线入口，真实 HTTP 请求）

```text
POST /v1/research/projects/<project>/context-preview     # entry="chat"（C-05 只接通 search）
HTTP/1.1 503
X-Request-ID: req_22d3e306174344d4
{"detail":{"code":"c05_entry_not_ready","entry":"chat",
 "message":"the C-05 scope contract is not wired for this entry yet; keep the c05-v1 intent and do not resend as v1",
 "retryable":false,"recovery_action":"show_unavailable","acceptance":"not_accepted"}}
```

### 3.2 `503 c05_mode_not_ready`（C-05 未适配 mode）

```text
POST /v1/research/projects/<project>/search              # X-Research-Contract: c05-v1 + mode="deep_compare"
HTTP/1.1 503
X-Request-ID: req_8b64dea544d54e9f
{"detail":{"code":"c05_mode_not_ready","entry":"search",
 "message":"deep_compare is not available under the C-05 scope contract yet; keep the c05-v1 intent and do not resend as v1",
 "retryable":false,"recovery_action":"show_unavailable","acceptance":"not_accepted"}}
```

### 3.3 `503 note_availability_unavailable`（**依赖真断开**：Surreal 上游被切断）

```text
# 依赖正常时（对照，同一请求）：HTTP 404 {"detail":{"code":"note_not_found",...}}
POST /v1/research/projects/<project>/search   # c05-v1，source_scope.mode=selected，note_ids=[...]
HTTP/1.1 503
Retry-After: 1
X-Request-ID: req_09dc2d6ae64e402c
{"detail":{"code":"note_availability_unavailable",
 "message":"note content probe failed for project '<project_id>'",
 "retryable":true}}
```

**对照价值**：同一请求在依赖正常时返回 `404 note_not_found`（确定的业务结论），依赖断开时返回 `503 retryable=true`（故障不得当作任一方向的证据）——与源码注释的意图一致（`router.py:3340-3352`：`NoteProbeUnavailable` → 可重试临时不可用，且零副作用）。这是本次唯一一个**由依赖不可用产生的 503**。

### 3.4 动作字段交叉验证

3 个码与 `src/rdlens/research/scope_errors.py:85,92,132` 的动作表逐项一致：

| 码 | 状态 | acceptance | recovery_action | retryable |
|---|---|---|---|---|
| `c05_entry_not_ready` | 503 | `not_accepted` | `show_unavailable` | `false` |
| `c05_mode_not_ready` | 503 | `not_accepted` | `show_unavailable` | `false` |
| `note_availability_unavailable` | 503 | （wire 未带） | （wire 未带） | `true` |

> 差异说明：`note_availability_unavailable` 的 wire 只带 `code/message/retryable`，**不带** `recovery_action`/`acceptance`，尽管 `scope_errors.py:132` 登记它为 `not_accepted + retry_same_key`。前端走 `c05-error-actions.ts` 的码表回落，功能可达；但 wire 上的「同一套动作解析」在该码上不成立（§6 F-2，低危）。

---

## 4. UI 故障投影（腿 8 → **limited**）

### 4.1 场景 A：全量 research API 断连（`simulated`）

```text
A_ABORT {"errorLines":["Failed to load workspace data","Failed to load"],
         "retryButtons":["Retry"],"textareas":1,"draft":"","hasCrash":false}
```

- 表现：**三处**错误条 `Failed to load workspace data` 各带 Retry（顶栏 / 主区 / 侧栏 RESULTS）；`Send` 置灰并给出门禁文案 `Select a research model before generating.`；页面不崩溃，导航/标签页/布局完好。
- 说明：本场景经历了 `reload`，草稿框为空是重载所致，**不用于**"草稿保留"结论（该结论只看场景 B，无 reload）。
- 截图：`screenshots/fault_route_abort.png`

### 4.2 场景 B：真实 503 字节投递到 UI（`simulated` 传输 + `real` envelope）

在已建立会话、composer 可用的基线上点击 Send：

```text
B_503_CHAT {"err":["Scope unavailable (restored from history)"],"retry":[],
            "ta":1,"draft":"fault-inject draft 27+27 不得丢失","crash":false}
NET: 503 POST /chat  X-Request-ID: req_22d3e306174344d4
     {"detail":{"code":"c05_entry_not_ready",...,"retryable":false,
                "recovery_action":"show_unavailable","acceptance":"not_accepted"}}
```

- **正面**：请求确实失败（503 到达），**草稿完整保留**（`draft` 与输入逐字节相同），**不崩溃**，composer 仍可用 → 可再次发送。
- **缺陷**：**上层 UI 没有可见错误提示**——没有错误卡（`data-testid="chat-error"`）、没有 Retry。屏幕上唯一与错误相关的字样是 "Scope unavailable (restored from history)"，但那是 `data-testid="chat-turn-scope-unavailable"`（`ResearchChatPanel.tsx:1580-1582`）在 `scopeSnapshot === null` 时的**历史范围缺失标注**，只要是从历史恢复的 turn 都会显示，**不是**对本次 503 的响应。用户看到的是「点了 Send，什么都没有发生」。见 §6 F-1。
- 截图：`screenshots/fault_503_envelope.png`、基线 `screenshots/fault_baseline.png`

### 4.3 静默是否只是"还没渲染完"？——独立复核（**持续性**）

针对 F-1 做了时序复核，排除"采样太早"的可能：注入同一份真实 503 后，在 1.2s / 3s / 10s / 18s 四个时间点采样，并在仍注入状态下**再次** Send：

```text
T+1.2s  {"chatError":0,"anyAlert":[],"sendDisabled":false,"ta":1,"taVal":"verify-silence 27+27","turnNodes":1}
T+3s    {"chatError":0,"anyAlert":[],"sendDisabled":false,"ta":1,"taVal":"verify-silence 27+27","turnNodes":1}
T+10s   {"chatError":0,"anyAlert":[],"sendDisabled":false,"ta":1,"taVal":"verify-silence 27+27","turnNodes":1}
T+18s   {"chatError":0,"anyAlert":[],"sendDisabled":false,"ta":1,"taVal":"verify-silence 27+27","turnNodes":1}
T+2ndSEND {"chatError":0,"anyAlert":[],"sendDisabled":false,"ta":1,"taVal":"verify-silence 27+27","turnNodes":2}
```

- `chatError:0` 与 `anyAlert:[]` 在 18 秒内**始终**为 0/空 → 不是渲染延迟，是**不投影**。
- 用户 turn 会累加（`turnNodes` 1→2），说明**用户气泡正常出现**，缺的是 assistant 侧的错误行/错误卡。
- 草稿始终保留（`taVal` 不变）→ 不丢稿；但用户**没有任何失败信号**，可无限重复提交。

### 4.4 场景 C：故障解除后恢复

撤掉注入后再次 Send：

```text
C_RECOVERED {"err":["Scope unavailable (restored from history)",
                    "生成式回答…本轮证据一致性校验…已被拦截"], "ta":1,"draft":"","crash":false}
```

- 恢复成功：真实 `POST /chat` 202 → SSE 200，答案被证据一致性闸门拦截（degraded，与 README 记录的模型状态一致），**无崩溃、无残留错误态**。
- 截图：`screenshots/fault_retry_recovered.png`

### 4.5 场景 D：真实端口停机（`real`，沿用既有证据）

隔离 Gateway 停机时 UI 显示 `Failed to load workspace data` + Retry、无崩溃——**已由同批证据采集**（`deployment.md` / `README.md` 引用的 `screenshots/final_gateway_down.png`）。本次**未重复停止 7896**（共享服务，禁止重启/停止），该场景以既有 `real` 证据 + 本次场景 A（等价投影、`simulated`）交叉支撑。

---

## 5. 判定汇总

| 腿 | 结论 | 依据 | 限制 |
|---|---|---|---|
| 9 错误 envelope 实样 | **pass** | §3：4 个真实 503，含稳定码/`retryable`/`request_id`，脱敏；与动作表逐项核对 | 仅覆盖 C-05 族 503；`acceptance_retry_budget_exhausted` 等接受阶段 503 未构造（需制造预算耗尽，超出本轮时限） |
| 8 失败路径/故障注入 | **limited** | §4：三类故障下不崩溃/不清稿/可恢复；A 场景有错误条+Retry | **F-1**：真实 503 不投影到上层 UI（静默失败），属产品缺陷；未改代码故不记 pass |

---

## 6. 发现的缺陷（未改代码，按要求登记）

### F-1（中）：`not_accepted` 类 503 被归为 `idle`，上层 UI 静默丢弃错误

- **位置**：
  - `frontend/src/lib/research/conversation-machine.ts:925-935`（`classification === 'not_accepted'` 分支把 turn 置为 `state: 'idle'`，只写 `errorCode`）
  - `frontend/src/components/research/ResearchChatPanel.tsx:165-172`（状态派生：`turn.state === 'terminal'` 才是 `error`；`idle` 落入 `'streaming'`）
  - `frontend/src/components/research/ResearchChatPanel.tsx:1705`（错误卡 `data-testid="chat-error"` 仅在 `turn.status === 'error'` 渲染）
  - `frontend/src/components/research/ResearchChatPanel.tsx:192`（空答案且非 error 的 turn **不投影 assistant 行**）
- **复现**：§4.2。已建立会话 → 输入草稿 → 路由回放真实 `503 c05_entry_not_ready` 到 `POST /chat` → 点 Send。
- **实际**：请求 503，turn 落到 `idle` + `errorCode='c05_entry_not_ready'`，但 `status` 派生为 `streaming`、空答案被过滤掉 → **无 assistant 行、无 `chat-error` 卡、无 Retry**。用户视角是「点击无反应」。
- **预期**：503 + `recovery_action=show_unavailable`（`retryable=false`）应显示不可用提示（如"该能力当前不可用"），而不是静默。
- **影响**：所有被判为「确定未受理」的非 426/422 错误码（`c05_entry_not_ready`、`c05_mode_not_ready`、`editor_state_invalid`、`session_contract_unsupported`、`input_snapshot_invalid`、`context_limit_exceeded`、`invalid_request`、`session_context_changed`，见 `conversation-machine.ts:382-391`）走**同一条静默路径**。这是一族问题，不是单码问题。
- **未验证**：jsdom 单测可能只断言 state 机（`conversation-machine.test.ts:414` 断言 `not_accepted` 分类），未断言 UI 可见性，故该族缺陷未被现有测试覆盖——**这是推断，未运行前端测试确认**（本轮只写证据，不跑前端单测）。
- **注**：不排除产品有意为之（"确定未受理 → 静默回到可编辑态"），但 `shared` 的 `recovery_action: show_unavailable` 语义与 `c05-error-actions.ts:118` 的 `show_unavailable` 表明**应当**有提示。需产品/前端负责人裁定。

### F-2（低）：`note_availability_unavailable` 的 wire 缺 `recovery_action`/`acceptance`

- **位置**：`src/rdlens/research/router.py:3340-3352`（`NoteProbeUnavailable` 分支只构造 `code/message/retryable`）
- **对照**：同族码 `c05_entry_not_ready`/`c05_mode_not_ready` 由 `scope_capabilities.py` 的 builder 产出，带全 4 字段（§3.1/§3.2）；`scope_errors.py:132` 也登记了该码的动作。
- **影响**：前端需靠码表回落（`c05-error-actions.ts`）才能得到动作；若前端只按 wire 字段解析（契约 §5 的"不解析英文文案"意图），该码动作不可达。功能上当前可达，故低危。
- **复现**：§3.3。

---

## 7. 隔离与安全核对

- 共享服务**全程未停/未重启**：取证后复核 `7896/health=200`、`/v1/research/health={"enabled":true,"status":"ready"}`、`8503=307`、`8504=200`、`18004=307`。
- 独立故障实例 `7899` 与代理 `19998` **用完即停**（`kill <pid>`，两端口均 `closed` 复核）。
- 未改生产 flag/配置；未改任何产品代码；未 commit/push。
- 证据不含 token/密钥/真实内容：JWT 由隔离 `RESEARCH_JWT_SECRET` 现签且不落盘；`project_id` 为合成 fixture；正文为合成草稿串。

---

## 8. 复现清单

```bash
# 1) 真实 503（在 7896 上，只读语义）
python /tmp/b3fault_probe.py            # context-preview entry=chat / search mode=deep_compare
# 2) 依赖断开 503（独立 7899 + 可切断代理 19998）
python /tmp/b3fault_proxy.py &          # 19998 -> 18004
#    启动 7899（RESEARCH_SURREAL_URL=http://127.0.0.1:19998）
python /tmp/b3fault_note.py out_up.json      # 依赖正常 -> 404 note_not_found
kill <proxy pid>                             # 切断 Surreal
python /tmp/b3fault_note.py out_down.json    # -> 503 note_availability_unavailable
# 3) UI 投影
node /tmp/b3fault_ui.js         # A=全量 route abort（截图 fault_route_abort.png）
node /tmp/b3fault_ui4.js        # B=回放真实 503 字节到 POST /chat + C=恢复（截图 fault_503_envelope / fault_retry_recovered）
node /tmp/b3fault_verify.js     # F-1 时序复核（1.2/3/10/18s 均无 chat-error、无 alert）
```

脚本位于 `/tmp`，**不入仓**（含隔离环境装配细节）；原始输出摘要见本文 §3/§4。
