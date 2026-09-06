/**
 * Compare 选择边界纯函数（UI-03，REQ-QUOTA-01，设计 §7.4/§13）。
 *
 * 默认最多 30 篇、系统硬上限 50 篇；51 篇 → 服务端 422 不入队。
 * 客户端在发起请求前前置校验（31–50 提示超出默认，>50 拒绝提交）。
 *
 * RWV2-11（K2）：`entire_project` 模式无显式 Source 集合（Compare 是
 * Source-only 动作，且当前来源列表受 20 条/页限制）——`ComparePanel`
 * 在调用本函数**之前**按 mode 优先产生 `reason:'entire_project'`，
 * 不落入通用 `empty`（见 ComparePanel 的 mode 前置判断）。
 */

export const COMPARE_DEFAULT_MAX = 30
export const COMPARE_HARD_MAX = 50

export type CompareSelectionCheck =
  | { ok: true; count: number; overDefault: boolean }
  | {
      ok: false
      reason: 'empty' | 'over_hard' | 'entire_project'
      count: number
    }

export function checkCompareSelection(documentIds: readonly string[]): CompareSelectionCheck {
  const count = documentIds.length
  if (count === 0) {
    return { ok: false, reason: 'empty', count }
  }
  if (count > COMPARE_HARD_MAX) {
    return { ok: false, reason: 'over_hard', count }
  }
  return { ok: true, count, overDefault: count > COMPARE_DEFAULT_MAX }
}
