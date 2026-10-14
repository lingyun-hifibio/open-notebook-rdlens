/**
 * Issue #601 PR5（D-12）：Preview 门禁判定——**submit 权威 =
 * execution_ready + 本地范围校验；Preview 是辅助，不是门**。
 *
 * 判定矩阵（handover §4.2 / v6 §4）：
 * - `exceeded`（必需检查已确认硬超限）→ 阻断该路径提交；
 * - `unavailable` / 必需 `not_checked` → 阻断并说明，不猜测可转后台；
 * - 非必需 `not_checked`（执行期检查如检索后 Prompt tokens）→ 放行并标注"执行期复检"；
 * - 交互阈值 `exceeded` 只阻断**交互路径**，可与合法后台 `validated` 并存（H-01）；
 * - **Preview 缺失/不可用 → 不推断任何超限**，按 execution_ready 放行，
 *   UI 显示"未经预览校验"；不得把"未检查"渲染成通过（无万能 can_submit）。
 */

export type C05BudgetCheckState =
  | 'not_checked' | 'estimated' | 'validated' | 'exceeded' | 'unavailable'

export interface C05BudgetCheck {
  name: string
  unit: string
  state: C05BudgetCheckState
  value: number | null
  limit: number | null
  limit_source: string | null
  required_for_submit: boolean
  reason: string | null
}

export interface C05Budget {
  preflight_status: 'validated' | 'not_checked' | 'exceeded' | 'unavailable'
  checks: C05BudgetCheck[]
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
  const required = budget.checks.filter(check => check.required_for_submit)
  const exceededRequired = required.find(check => check.state === 'exceeded')
  if (exceededRequired) {
    return { canSubmit: false, blockedReason: 'budget_exceeded', notice: null }
  }
  const unavailableRequired = required.find(
    check => check.state === 'unavailable'
      || (check.state === 'not_checked' && check.required_for_submit),
  )
  if (unavailableRequired) {
    return { canSubmit: false, blockedReason: 'budget_incomplete', notice: null }
  }
  // 非必需检查的执行期提示
  const deferred = budget.checks.find(
    check => !check.required_for_submit
      && (check.state === 'not_checked' || check.state === 'estimated'),
  )
  const interactiveOnly = budget.checks.find(
    check => check.state === 'exceeded' && !check.required_for_submit,
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
