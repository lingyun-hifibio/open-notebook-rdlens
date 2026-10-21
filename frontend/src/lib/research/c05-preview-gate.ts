/**
 * Issue #601 PR5（D-12）：Preview 门禁判定——**submit 权威 =
 * execution_ready + 本地范围校验；Preview 是辅助，不是门**。
 *
 * 形状权威：`fixtures/issue615_c05/schemas.json#c05_preview_response`
 * （2026-10-21 同步主仓 #748 / `50c6e415`；PR5 初版按交接文档 §4 草案写成
 * `budget.preflight_status` / `checks[].state`，与 #748 实际响应字段不一致，
 * 已按实际实现改为 `budget.status` / `checks[].status` / `checks[].required`，
 * 并新增执行期 `deferred[]`）。
 *
 * 判定矩阵（handover §4.2 / v6 §4，映射到 #748 响应）：
 * - `budget.status === 'exceeded'`（选定路径必需检查已确认硬超限）→ 阻断该路径提交；
 * - `unavailable` / 必需 `not_checked`（必需检查不可用/未完成）→ 阻断并说明，不猜测可转后台；
 * - `deferred[]`（执行期检查）或非必需 `not_checked` → 放行并标注"执行期复检"；
 * - 非必需 `exceeded`（交互阈值）只提示，不阻断全局（H-01）；
 * - **Preview 缺失/不可用 → 不推断任何超限**，按 execution_ready 放行，
 *   UI 显示"未经预览校验"；不得把"未检查"渲染成通过（无万能 can_submit）。
 *
 * 防御纪律：除聚合位 `budget.status` 外，必需检查自身若报 exceeded/unavailable/
 * not_checked 也按阻断处理——聚合位与明细矛盾时 fail-closed，不静默放行。
 */

export type C05BudgetCheckStatus =
  | 'not_checked' | 'validated' | 'exceeded' | 'unavailable' | 'deferred'

/** 单条预算检查（`c05_preview_response.budget.checks[]` / `.deferred[]`）。 */
export interface C05BudgetCheck {
  name: string
  path: string
  unit: 'tokens' | 'policy' | 'characters' | 'sources'
  phase: 'preflight' | 'execution'
  required: boolean
  status: C05BudgetCheckStatus
  observed: number | null
  limit: number | null
  limit_source: string
}

/** 选定路径的预算块（#748 实际响应形状；字段顺序与契约无关）。 */
export interface C05Budget {
  status: 'validated' | 'not_checked' | 'exceeded' | 'unavailable'
  checks: C05BudgetCheck[]
  /** 执行期检查：显式单列，不被 `validated` 覆盖（handover §4.2）。 */
  deferred: C05BudgetCheck[]
  token_estimate: number | null
  estimate_kind: 'source_and_note_units'
  resolved_mode: string | null
  input_budget: number | null
}

export interface C05PreviewGateInput {
  executionReady: boolean
  scopeValid: boolean
  /** null = Preview 不可用/缺失（不阻断，但也不宣称通过） */
  budget: C05Budget | null
}

export interface C05PreviewGateResult {
  canSubmit: boolean
  /** 阻断原因码（稳定字符串，i18n 键映射） */
  blockedReason: 'entry_not_ready' | 'scope_invalid' | 'budget_exceeded' | 'budget_incomplete' | null
  /** 有 Preview 数据时的提示（不阻断的也要显示） */
  notice: 'unvalidated' | 'execution_recheck' | 'interactive_only_exceeded' | null
}

export function evaluatePreviewGate(input: C05PreviewGateInput): C05PreviewGateResult {
  if (!input.executionReady) {
    return { canSubmit: false, blockedReason: 'entry_not_ready', notice: null }
  }
  if (!input.scopeValid) {
    return { canSubmit: false, blockedReason: 'scope_invalid', notice: null }
  }
  const budget = input.budget
  if (budget === null) {
    // Preview 缺失：放行（权威在后端执行），但明确"未经预览校验"
    return { canSubmit: true, blockedReason: null, notice: 'unvalidated' }
  }
  const required = budget.checks.filter(check => check.required)
  const requiredExceeded = required.find(check => check.status === 'exceeded')
  if (budget.status === 'exceeded' || requiredExceeded) {
    return { canSubmit: false, blockedReason: 'budget_exceeded', notice: null }
  }
  const requiredIncomplete = required.find(
    check => check.status === 'unavailable'
      || check.status === 'not_checked'
      // 契约 schema 的 checks[].status 与 deferred 同 enum；required + deferred
      // 属矛盾形状（执行期检查不应标记为提交前必需）——fail-closed，不静默放行。
      || check.status === 'deferred',
  )
  if (
    budget.status === 'unavailable'
    || budget.status === 'not_checked'
    || requiredIncomplete
  ) {
    return { canSubmit: false, blockedReason: 'budget_incomplete', notice: null }
  }
  // 非必需检查的执行期提示（检索后实际 Prompt tokens 等）
  const deferred = budget.deferred.length > 0 || budget.checks.some(
    check => !check.required && check.status === 'not_checked',
  )
  const interactiveOnly = budget.checks.find(
    check => check.status === 'exceeded' && !check.required,
  )
  if (interactiveOnly) {
    // 交互阈值超限只表示交互路径不可用（H-01：可与后台 validated 并存）
    return { canSubmit: true, blockedReason: null, notice: 'interactive_only_exceeded' }
  }
  return {
    canSubmit: true,
    blockedReason: null,
    notice: deferred ? 'execution_recheck' : null,
  }
}
