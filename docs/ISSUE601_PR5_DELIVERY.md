# Issue #601 PR 5：前端资料交互与联合验收（交付说明 · fork 配对副本）

> 日期：2026-10-21（契约同步 #748）；状态：**已实现（前端层），联合验收待 PR4 剩余接线**
> 权威计划：实施计划 v8 + 终审增补（D-19…D-26）；plan9 §4/§5
> 分支：主仓 `codex/issue601-pr5-frontend`（基线 `389ac8a6`）；
> fork `codex/issue601-pr5-c05-frontend`（基线 `260fe5d`，配对 PR 另开）
> 契约基线：机器契约 fixtures 已同步主仓 `50c6e415`（内容提交 `9addb721` = #748）
> 关联：#601（`Refs #601`）、#615（接口交接）、#610（PR4 承接）、#625/#748（Search Preview）

## 0. 证据分级

| 标记 | 含义 |
|---|---|
| 【已实现·源码】 | 本 PR 交付的代码，附符号名 |
| 【已实现·测试】 | 可复现的测试（fork **1174 passed / 114 files** @ 2026-10-21 契约同步 head；宿主 **461 passed / 52 files** @ 宿主 PR5 分支 `95cb4ef0` 时点，非 origin/main 计数；两仓 `tsc -b` clean、`npm run build` 成功） |
| 【待验证·运行】 | 需 PR4 执行接线 + C-05 flag 打开后的真实环境（F1/F2） |

**本版修订说明（2026-10-14 二次收口）**：计划条款复核后补齐了此前**未落地**的部分——
D-01/D-14 投影消费、D-17 有界呈现接线、D-06 rerun 范围显示、D-09 阻断文案、
D-22 同意登记信封与幂等键、D-24 SSE 传输四条规则、D-25 跳转拒绝可见、
D-26 后台 CTA 门禁、D-16 文档计量下限，以及 T5/T17/T23/T35/T38/T40 用例与
ScopeWarningSummary/ScopePreviewPanel 等计划指定产物。**D-24 不再列为排除项**。

**本版修订说明（2026-10-21 契约同步）**：主仓 #748 已把 Search-only C-05 Preview
按实际实现落成（`c05_preview_response`），其 `budget` 字段为 `status` / `checks[].status` /
`checks[].required` / `deferred[]`，与本 PR 初版按交接 §4 草案字段名
（`preflight_status` / `checks[].state` / `required_for_submit`）实现的消费层不一致；
在 C-05 打开、`preview_supported=true` 的真实链路上，旧实现会**静默放行**超限。
本版同步 fork 的机器契约副本（`ba07a1d4…` / `618363a8…`，含 WU-J 的
`execution_modes` 收窄）并改接 Preview 门禁，新增 fixture 形状探针与
“聚合位/明细矛盾 fail-closed”用例（+4 用例）。

## 1. 交付内容（fork，全部【已实现·源码】）

| 决定 | 实现 | 位置 |
|---|---|---|
| C1/D-04/D-10/D-21 | 三档范围模型（all/selected/single）+ 会话级 single（绑定/清除/跨会话丢弃）+ `normalizePersistedScope` 全量迁移 | fork `frontend/src/lib/research/scope.tsx` |
| B1 | 能力解析（整条形状校验、`c05_entry_pending_pr4`、无 fallback 表） | `c05-contract.ts`、`use-research-c05.ts` |
| B2/D-03 | 错误动作分类（三形态 detail；字符串 detail → 426 保守识别，其余未识别） | `c05-error-actions.ts` |
| B2/D-01/D-14 | 投影"存在才消费"+ 严格校验 + stale 来源纪律；**投影真正接入 UI**（缺失→"服务端未返回范围详情"，畸形→暴露 `c05_scope_projection_invalid`，旧 v1 结果清空投影防串台；202 投影不裁掉） | `c05-scope-projection.ts`、`ScopeWarningSummary.tsx`、`ResearchSearchPanel.tsx` |
| **D-17** | **有界呈现接线**：计数摘要（回退 N／排除 M）+ ≤5 条明细 + "仅显示前 N 条"标注；`resolved_source_refs` 只出计数；首屏节点数不随规模增长 | `c05-warning-summary.ts`、`ScopeWarningSummary.tsx` |
| B2/D-02/D-13 | 键生命周期纯函数（acceptance 锚、string-shape 确定性清键、24h 窗口） | `c05-idempotency-key.ts`、`c05-key-retention.ts` |
| **D-22** | **同意登记冻结完整派发意图**：契约选择 + 请求信封 + 幂等键随登记冻结，确认后原样派发、取消不清键（搜索侧 `prepareDispatch`、Chat 侧签名持有键） | `use-research-global-model.tsx`、`ResearchSearchPanel.tsx`、`use-research-chat.ts`、`ResearchWorkspace.tsx` |
| B2/D-12 | Preview 门禁矩阵（`budget.status` exceeded 阻断 / 必需检查 unavailable·not_checked（含矛盾 `deferred`）阻断 / 非必需放行 / `deferred[]` 执行期判定 / 缺失不阻断不冒充）；按 #748 实际响应字段实现；**`notice` 提示层当前无 UI 消费者（follow-up，见 §5）** | `c05-preview-gate.ts`、`api.ts` |
| **D-24** | **SSE 传输四条规则**（handover §5.3）：`API_TIMEOUT_MS` 作用域与 `0` 禁用、状态+Content-Type 校验后进入流空闲计时（字节/heartbeat 重置、heartbeat 非模型进度）、abort 原因区分且仅 `timeout` 可进有界重试、每次尝试只结算一次 | `c05-stream-guard.ts`、`api.ts`、`use-research-chat.ts` |
| B2/D-16 | 文档计量去重（document 语义去重 / 版本语义不去重）+ **去重后唯一文档数 < 2 时按不足阻断** | `document-set.ts`、`compare.ts`（`checkCompareDocumentFloor`）、`ComparePanel.tsx` |
| B3/D-05/D-11 | 请求体唯一构造函数（forbid/insight 入口排除、all 空集 fail-closed） | `c05-request.ts` |
| C2 | 删除 `resolveScopeSelection` 全部 3 处调用与定义；TransformationsPanel/InsightsPanel/RunDetail 的 D-11 阻断（`all` → 明确"请先选择资料"） | `scope-utils.ts`、三个面板 |
| **D-09** | **阻断文案与原因码可见**：`blocked_all_scope` 此前**没有任何文案分支**（阻断被算出却静默）、原因码只对 failed 拼接——两处均修 | `InsightsPanel.tsx` |
| C3 | 6 值状态 + null `source_id` 禁选 + 版本常显（T33） | `types/research.ts`、`SourceListPanel.tsx` |
| C4 | 编辑面三档 + single 取消按钮 + all 反推提示；Summary single 徽标；单选组保持受控（消除 controlled/uncontrolled 告警） | `ResearchScopeEditor.tsx`、`ResearchScopeSummary.tsx` |
| C6/D-13 | SearchPanel：C-05 派发分支、键生命周期替换"有 response 即清键"、Preview 门禁、投影消费 | `ResearchSearchPanel.tsx` |
| C6 | Chat：契约判定入 ActiveTurn（重连不重判）、C-05 请求体、`bindSession` 接线（D-04）、恢复行"范围不可用"（T9） | `use-research-chat.ts`、`ResearchChatPanel.tsx` |
| **D-06** | Rerun 显示"本次将使用当前范围"，与记录范围不同时另行提示；`all` 下就近说明 | `TransformationRunDetail.tsx` |
| C6/D-26 | Workspace 后台 CTA 纳入 D-11 矩阵（独立 `blocked_scope` 状态，不再与 `failed` 混同）+ C-05 分支 | `ResearchWorkspace.tsx`、`ResearchChatPanel.tsx` |
| D-19/T37 | 静态零残留守卫（`entire_project` 仅存于迁移点） | `c05-static-guards.test.ts` |
| **D-11/D-26 清单守卫** | 每个在 `all` 下有派发能力的入口文件必须带阻断信号；未登记的派发点会被反向检出 | `ScopeAllBlocked.c05.test.tsx` |
| D-16/D-25 | Citation 版本感知解析（不静默打开错误版本）+ 判定展示用候选解析（`resolveCitationCandidate`）+ 被拒时可解释提示 | `citation-utils.ts`、`TransformationsPanel.tsx`、`TransformationRunDetail.tsx`、`ResearchWorkspace.tsx` |
| i18n | **26 个新键**（en-US 为真源；其余 13 语言包按 E1 复制英文值），14 语言包 parity 绿 | `locales/*/index.ts` |

## 2. 交付内容（宿主）

| 项 | 实现 | 位置 |
|---|---|---|
| D1/D-06 | `open_ingest` 协议（握手后接受、载荷忽略、origin 校验） | `src/research/parentSession.ts` |
| D1/D-07 | 入库对话框（`attempt` 不递增保位置、Esc/焦点管理、失败不关闭、Tab 循环过滤 disabled） | `ResearchIngestDialog.tsx`、`ResearchWorkspacePage.tsx` |
| E2 | `readC05Capabilities` 维持仅测试引用（不新增父子能力桥） | `src/api/research.ts` |
| F2 runner | 联合验收矩阵脚本（前置不满足时整轮 pending，退出码 2） | `scripts/e2e/issue601_pr5_c05_matrix.mjs` |
| 证据目录 | F1/F2 前置与缺口登记 | `dev_docs/validation/issue601_pr5/README.md` |
| E3 | 交接文档 §8.1/§9.1 回填（PR5 侧 SHA/命令/范围/未决项） | `dev_docs/设计方案/Research/Issue615_PR4_PR5_接口交接_20261013.md` |

## 3. 明确排除（非本 PR）

- AI Insight 的 C-05 适配（D-09：PR4 五项解禁条件）；
- **Chat SSE 的范围投影**（`done`/`usage` 事件未携带 `resolved_scope`，见 §3.1 缺口②）——
  Search 侧（fresh 200／202／完成重放）**已带且客户端已消费**；
- `all` 候选读取无 LIMIT 的规模治理（D-18，PR4）；
- `idempotency_conflict`/426 的对象化 detail（D-03 wire 缺口，PR4）。

### 3.1 Wire 缺口登记（三条，均需 PR4/契约方动作，前端不自行绕过）

| # | 缺口 | 事实依据 | 前端当前处置（诚实边界） |
|---|---|---|---|
| ① | `idempotency_conflict` / 426 仍是**纯字符串** detail | `router.py` 幂等冲突返回字符串 | 保守识别：仅 426 与覆盖 Note 视为可识别，其余按"未识别"保留原键（D-03） |
| ② | **Chat SSE 的 `done`/`usage` 事件不携带 `resolved_scope`**（§3.3 的 SSE 一格未接线） | SSE 事件构造只带 `session_id`/`request_id`/`job_id`/`completion_status`（`router.py:4535-4542`）；Search 侧四个表面均已带（fresh 200 `router.py:4274`、202 受理 `:4169`、202 重放 `:3240`、完成重放 `:1669`） | Search 侧已消费投影（有界呈现）；**Chat 侧无投影可用** → 不展示范围警告（不猜测、不显示 stale 计数）。**此前把该缺口写成"fresh 200 不携带投影"是错的**，已更正 |
| ③ | **Compare 端点无法表达精确版本** | `POST /compare/jobs` 只接受 `document_ids`，服务端逐条 `get_latest_version(doc_id)`（`router.py:2562-2570`） | 同文档多版本**按文档合并**（执行载荷去重）并提示"已合并同文档多版本"；<2 个唯一文档时按不足阻断。**不**声称保留精确版本 |

> 2026-10-21：D-12 的 Preview 响应形状已由主仓 #748 实际实现（Search-only），本 PR 已同步
> `c05_preview_response` schema 并按实际字段消费；§4 的草案字段名（`preflight_status` 等）
> 不再是权威。此前四条 wire 缺口不受影响。

## 4. 测试与验证【已实现·测试】

```bash
# fork（frontend/）— 全量
npx vitest run          # 1174 passed / 114 files（2026-10-21）
npx tsc -b              # clean
npm run build           # 成功
# 主仓（frontend/）— 全量
npx vitest run          # 461 passed / 52 files
npx tsc -b              # clean
npm run build           # 成功
```

关键新增用例（矩阵映射）：T1–T3（能力/降级/不展开）、T5/T17（**限定语义与
会话归属**，此前零覆盖）、T6（6 状态/null）、T9（恢复行范围不可用）、
T19/T27/T28/T29（字符串 detail 与键双向）、T21（Rerun 范围提示）、
T23（Insight `all` 阻断 + 原因码）、T24/D-11 清单（跨入口）、
T25（D-11 阻断/引擎模式）、T32/T33（去重/版本常显/文档下限）、
T35（**400 条警告有界呈现**，纯函数 + 组件 + 面板三层）、T37（静态守卫）、
T38（Compare 阻断原因）、T39（旧持久快照迁移）、T40（**同意路径同键同信封**）、
T42（citation 版本）、D-24 传输（空闲超时恰好一次/字节重置/中止不误报/协议违反不重连）、
D-12 Preview（#748 形状：`budget.status` / `checks[].required` / `deferred[]`；fixture
`preview.response.all.valid` 形状探针；聚合位与明细矛盾时 fail-closed）。

变异演练（移除被断言条件 → 用例必须变红）已对 D-24 Content-Type 校验、
D-22 键复用、D-25 版本感知、D-17 截断、D-09 文案分支、D-01 缺失文案、
D-16 文档下限、D-11 清单信号、T17 异会话清除、D-12 Preview 门禁（#748 字段映射）逐项执行通过。

## 5. 已知风险与承接

1. **F1/F2 联合验收未执行**（pending）：需 PR2–PR4 集成 + 双 flag 打开；runner
   与前置清单已落盘，见 `dev_docs/validation/issue601_pr5/README.md`。
2. D-01（服务端投影补齐）/D-03/D-09 解禁/D-18 均 PR4 承接（见 §3）。
3. **D-18 `all` 规模**：真实大项目上候选读取与响应体量无上限，F1/F2 超阈值记
   `limited` 而非 `pass`。
4. **2026-10-21 契约同步后的剩余前置**：主仓 #748 已提供 Search-only Preview，
   但 `execution_ready` 仍只有 `search`；F1/F2 还需 S9/S10 完成（#623/#702）、
   双 flag、含本 PR 的镜像 digest 与 CORS 暴露；本 PR 合入不等于 PR5 验收完成。
5. **D-12 提示层未接线（2026-10-21 复核发现）**：`evaluatePreviewGate` 的
   `notice`（unvalidated / execution_recheck / interactive_only_exceeded）已由纯函数
   产出，但 Search 面板当前只消费 `canSubmit` / `blockedReason`，不渲染提示；
   **不计为本 PR 已完成项**，需 follow-up 接 UI 提示（含 i18n）或由 owner 明确降级。
6. **宿主 main 的 C-05 fixture 消费测试仍冻结旧 schema**：`frontend/tests/issue615C05Fixtures.test.ts`
   在 origin/main `50c6e415` 上 4 failed（仍断言旧 schema 键 / `preview_supported=false`）；
   属宿主侧 follow-up，不计入 fork 本 PR 的验证结论。
7. 本 PR 不宣称 C-05 可用、不关闭 #601。

## 6. 回滚

- fork/宿主分别 `git revert`；无迁移、无数据影响；
- 功能回滚：关 `research_c05_scope_enabled` → 能力 fail-closed 自动回 v1；
- **成对回滚**：D-11↔删除枚举、D-13↔替换清键逻辑、D-16↔Compare 计量、
  D-17↔有界呈现、D-19↔改名守卫、D-21↔统一归一、D-22↔信封入登记、
  D-24↔传输规则（与 C6 同批）。
