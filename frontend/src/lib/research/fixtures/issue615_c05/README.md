# C-05 资料范围契约 v1 fixtures（Issue #615 W2）

契约：`deploy/research/issue601_c05_scope_contract_v1.yaml`
交接文档：`dev_docs/设计方案/Research/Issue615_PR4_PR5_接口交接_20261013.md`
权威计划：`dev_docs/设计方案/Research/Issue615_PR4_PR5_共享接口实施计划_最终审查_v6_20261013.md` §6 W2

## 用途

PR4（检索、输入冻结与执行恢复）与 PR5（前端交互与联合验收）**共同消费**
的 wire 形状样例。与 `contract_v1_fixtures/` 同一模式（draft-07，语言无关）。

- `schemas.json` — JSON Schema **draft-07**，键为 C-05 的契约类型：
  `resolved_scope` / `c05_scope_response_projection` / `c05_capabilities` /
  `c05_entry_capability` / `c05_entry_capability_pr615` / `c05_error_detail` /
  `c05_scope_request` / `c05_preview_request` / `c05_preview_response`。
- `samples.json` — 命名样例，每条声明 `schema`、`expect`
  （`valid` | `invalid`）、`value`，以及 **来源标记** `origin`：
  - `current_api` — 形状取自**当前已实现**的响应／投影（可被现有测试复现）；
  - `target_contract` — 形状**已冻结但执行待 PR4 接线**（前端可据此开发，
    但 mock 通过**不**证明执行已接通）。

## 与源码的投影关系（三方同源）

| schema | 源码投影 | 测试 |
|---|---|---|
| `resolved_scope` | `rdlens.research.scope.ResolvedScope.as_response()` | `tests/research/test_issue615_c05_wire_contract.py` |
| `c05_capabilities` / `c05_entry_capability` | `rdlens.research.scope_capabilities.build_capabilities()` | 同上 |
| `c05_error_detail` | `rdlens.research.scope_errors.classify_error()` + 各生产点的稳定码 | 同上 |
| `c05_scope_request` | `rdlens.research.scope.parse_c05_request()` | 同上 |
| `c05_preview_request` / `c05_preview_response` | `rdlens.research.preview.C05PreviewService.evaluate_acquired()`（#625/#748） | `tests/research/test_issue625_preview*.py` |

**投影测试按「源码生成 → schema 校验」方向断言**，不是两侧各写一份手工
形状：修改源码后投影若偏离 schema，测试必须变红（防 fixture 与实现漂移，
与 `coverage_contract_v1_fixtures` 的字典相等守卫同款）。

## 约束

- fixture 是**纯数据**：合成身份／文本，不含真实正文、Research Token、
  Provider 地址或凭据；测试在无外部 Provider、无网络的环境可运行。
- 样例不得把「目标接口已固定」写成「执行已接通」：`target_contract` 标记
  只表示**形状**冻结；`execution_ready` 的真实值以 `build_capabilities()`
  当前输出为准（本 PR 仅 Search 为 true）。
- 变更 schema／样例后必须重跑：

```bash
uv run python -m pytest tests/research/test_issue615_c05_wire_contract.py -q
uv run python -m pytest tests/research/test_issue601_pr1_contract_prep.py -q
```

跨仓库消费：fork 侧按**版本化复制**取得本目录并记录源 commit／SHA256，
测试独立运行，不隐式依赖相邻仓库路径（计划 §6 纪律）。

## 版本锚点

| 项 | 值 |
|---|---|
| 契约版本 | `c05-v1` |
| 请求头 | `X-Research-Contract: c05-v1` |
| PR4／PR5 交接文档 | `dev_docs/设计方案/Research/Issue615_PR4_PR5_接口交接_20261013.md` |

---

## Fork 消费副本（Issue #601 PR5）

版本化复制自主仓 `HiFiBiO-Therapeutics/RDLens` 的 `main` @ `50c6e415`（契约内容提交
`9addb721` = PR #748，含 #623 S9 WU-J 的 `execution_modes` 收窄与 Search C-05 Preview）。

| 文件 | SHA256 |
|---|---|
| schemas.json | `ba07a1d4b97dfb8614114f128b8b62f046bcc3402f278c83d6aab4d23ebcdd38` |
| samples.json | `618363a80400e087dd91be4d6b65321103a7e12b229bda7dafde0ecc5839e2b2` |

同目录 `SHA256SUMS` 记录以上两行，可用 `sha256sum --check SHA256SUMS` 复核。

消费方：`frontend/src/lib/research/c05-contract.ts`（能力解析）、`c05-error-actions.ts`（错误动作）、`c05-request.test.ts`（请求构造）、`c05-scope-projection.ts`（投影校验）、`c05-preview-gate.ts`（Preview 门禁：`budget.status` / `checks[].status` / `checks[].required` / `deferred[]`）。
