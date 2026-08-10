/**
 * Compare 选择边界纯函数（UI-03，REQ-QUOTA-01，设计 §7.4/§13）。
 *
 * 默认最多 30 篇、系统硬上限 50 篇；51 篇 → 服务端 422 不入队。
 * 客户端在发起请求前前置校验（31–50 提示超出默认，>50 拒绝提交）。
 */

export const COMPARE_DEFAULT_MAX = 30
export const COMPARE_HARD_MAX = 50

export type CompareSelectionCheck =
  | { ok: true; count: number; overDefault: boolean }
  | { ok: false; reason: 'empty' | 'over_hard'; count: number }

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
