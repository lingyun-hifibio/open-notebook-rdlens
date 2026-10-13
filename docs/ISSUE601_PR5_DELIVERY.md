# Issue #601 PR 5：前端资料交互与联合验收（交付说明）

> 日期：2026-10-14；状态：**已实现（前端层），联合验收待 PR4 集成**
> 权威计划：实施计划 v8 + 终审增补（D-19…D-26）；plan9 §4/§5
> 分支：主仓 `codex/issue601-pr5-frontend`（基线 `389ac8a6`）；
> fork `codex/issue601-pr5-c05-frontend`（基线 `260fe5d`，配对 PR 另开）
> 关联：#601（`Refs #601`）、#615（接口交接）、#610（PR4 承接）

## 0. 证据分级

| 标记 | 含义 |
|---|---|
| 【已实现·源码】 | 本 PR 交付的代码，附符号名 |
| 【已实现·测试】 | 可复现的测试（fork 1080 passed / 宿主 452 passed，全量绿） |
| 【待验证·运行】 | 需 PR4 执行接线 + C-05 flag 打开后的真实环境（F1/F2） |

## 1. 交付内容（fork，全部【已实现·源码】）

| 决定 | 实现 | 位置 |
|---|---|---|
| C1/D-04/D-10/D-21 | 三档范围模型（all/selected/single）+ 会话级 single（绑定/清除/跨会话丢弃）+ `normalizePersistedScope` 全量迁移 | fork `frontend/src/lib/research/scope.tsx` |
| B1 | 能力解析（整条形状校验、`c05_entry_pending_pr4`、无 fallback 表） | `c05-contract.ts`、`use-research-c05.ts` |
| B2/D-03 | 错误动作分类（三形态 detail；字符串 detail → 426 保守识别，其余未识别） | `c05-error-actions.ts` |
| B2/D-01/D-14 | 投影"存在才消费"+ 严格校验 + stale 来源纪律 | `c05-scope-projection.ts` |
| B2/D-02/D-13 | 键生命周期纯函数（acceptance 锚、string-shape 确定性清键、24h 窗口） | `c05-idempotency-key.ts`、`c05-key-retention.ts` |
| B2/D-12 | Preview 门禁矩阵（exceeded 阻断 / 非必需放行 / 缺失不阻断不冒充） | `c05-preview-gate.ts` |
| B2/D-17 | 警告有界聚合（计数摘要 + 截断标注） | `c05-warning-summary.ts` |
| B2/D-16 | 文档计量去重（document 语义去重 / 版本语义不去重） | `document-set.ts` |
| B3/D-05/D-11 | 请求体唯一构造函数（forbid/insight 入口排除、all 空集 fail-closed） | `c05-request.ts` |
| C2 | 删除 `resolveScopeSelection` 全部 3 处调用与定义；TransformationsPanel/InsightsPanel/RunDetail 的 D-11 阻断（`all` → 明确"请先选择资料"） | `scope-utils.ts`、三个面板 |
| C3 | 6 值状态 + null `source_id` 禁选 + 版本常显（T33） | `types/research.ts`、`SourceListPanel.tsx` |
| C4 | 编辑面三档 + single 取消按钮 + all 反推提示；Summary single 徽标 | `ResearchScopeEditor.tsx`、`ResearchScopeSummary.tsx` |
| C6/D-13 | SearchPanel：C-05 派发分支、键生命周期替换"有 response 即清键"、Preview 门禁、投影消费 | `ResearchSearchPanel.tsx` |
| C6 | Chat：契约判定入 ActiveTurn（重连不重判）、C-05 请求体、`bindSession` 接线（D-04） | `use-research-chat.ts` |
| C6/D-26 | Workspace 后台 CTA 纳入 D-11 矩阵 + C-05 分支 | `ResearchWorkspace.tsx` |
| D-19/T37 | 静态零残留守卫（`entire_project` 仅存于迁移点） | `c05-static-guards.test.ts` |
| D-16/T42 | Citation 版本感知解析（不静默打开错误版本） | `citation-utils.ts` |
| i18n | 14 语言包 9 个新键（英文值，parity 绿） | `locales/*/index.ts` |

## 2. 交付内容（宿主）

| 项 | 实现 | 位置 |
|---|---|---|
| D1/D-06 | `open_ingest` 协议（握手后接受、载荷忽略、origin 校验） | `src/research/parentSession.ts` |
| D1/D-07 | 入库对话框（`attempt` 不递增保位置、Esc/焦点管理、失败不关闭） | `ResearchIngestDialog.tsx`、`ResearchWorkspacePage.tsx` |
| E2 | `readC05Capabilities` 维持仅测试引用（不新增父子能力桥） | `src/api/research.ts` |

## 3. 明确排除（非本 PR）

- AI Insight 的 C-05 适配（D-09：PR4 五项解禁条件）；
- fresh/202 的 `resolved_scope` 服务端投影与 `c05_warnings` 消费（D-01，PR4）；
- `all` 候选读取无 LIMIT 的规模治理（D-18，PR4）；
- `idempotency_conflict`/426 的对象化 detail（D-03 wire 缺口，PR4）；
- SSE 传输改造（D-24：handover §5.3 标注"PR5 落地"——本 PR 未含，**登记为缺口**，见 §5 风险）。

## 4. 测试与验证【已实现·测试】

```bash
# fork（frontend/）— 全量
npx vitest run          # 1080 passed / 1080
npx tsc -b              # clean
npm run build           # 成功
# 主仓（frontend/）— 全量
npx vitest run          # 452 passed / 51 files
npx tsc -b              # clean
npm run build           # 成功
```

关键新增用例（矩阵映射）：T1–T3（能力/降级/不展开）、T6（6 状态/null）、
T17/T18（限定归属/不自造 session）、T19/T27/T28/T29（字符串 detail 与键双向）、
T24/T25（D-11 阻断/引擎模式）、T32/T33/T42（去重/版本常显/citation 版本）、
T35（400 条警告有界）、T37（静态守卫）、T40 同意路径（闭包语义验证）。

## 5. 已知风险与承接

1. **D-24 SSE 传输改造未含本 PR**（handover §5.3：timeout 作用域、流空闲计时、
   abort 原因区分、每次尝试一次结算）。属 PR5 范围内的执行缺口，因工作包顺序
   未能在本批交付；**请求在审查确认后作为紧随的第二个 commit 或独立 PR 补齐**，
   不默认转 PR4。
2. D-01/D-18/D-03/D-09 均 PR4 承接（见 §3）。
3. 联合验收（F1/F2：组合根核对、Playwright 走查、1024/1440 截图）等待
   PR2–PR4 集成 + 双 flag 打开；本 PR 不宣称 C-05 可用、不关闭 #601。

## 6. 回滚

- fork/宿主分别 `git revert`；无迁移、无数据影响；
- 功能回滚：关 `research_c05_scope_enabled` → 能力 fail-closed 自动回 v1；
- D-11/D-13/D-16/D-19 与其依赖改动成对回滚（单独回滚恢复旧缺陷）。
