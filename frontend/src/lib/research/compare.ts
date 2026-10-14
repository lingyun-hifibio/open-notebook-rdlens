/**
 * Compare 选择边界纯函数（UI-03，REQ-QUOTA-01，设计 §7.4/§13）。
 *
 * 默认最多 30 篇、系统硬上限 50 篇；51 篇 → 服务端 422 不入队。
 * 客户端在发起请求前前置校验（31–50 提示超出默认，>50 拒绝提交）。
 *
 * RWV2-11（K2）+ PR5：`all` 模式无显式 Source 集合（Compare 是
 * Source-only 动作，且当前来源列表受 20 条/页限制）——`ComparePanel`
 * 在调用本函数**之前**按 mode 优先产生 `reason:'all'`，
 * 不落入通用 `empty`（见 ComparePanel 的 mode 前置判断）。
 */

export const COMPARE_DEFAULT_MAX = 30
export const COMPARE_HARD_MAX = 50

/**
 * PR5（D-16）：Compare 以**文档**为计量单位的数量下限。同一文档的多个版本
 * 合并后不构成"两份文献"，去重后 < 2 时按不足阻断（C-05 允许同文档多版本
 * 共选，这是常态而非边缘情形）。
 */
export const COMPARE_MIN_DOCUMENTS = 2

/** 阻断原因：`all` = 无显式集合（D-11）；`single_document` = 去重后不足两份（D-16） */
export type CompareDenyReason = 'empty' | 'over_hard' | 'all' | 'single_document'

export type CompareSelectionCheck =
  | { ok: true; count: number; overDefault: boolean }
  | {
      ok: false
      reason: CompareDenyReason
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

/**
 * D-16 的**文档计量下限**判定（与 `checkCompareSelection` 的"按文献计数上限"
 * 分层）：输入必须已按 `document_id` 去重。仅用于提交前的客户端预检——
 * 不并入 `checkCompareSelection`，以免改变既有 Compare **重试**路径
 * （`use-research-jobs`）对历史 Job 的判定语义。
 */
export function checkCompareDocumentFloor(
  uniqueDocumentCount: number,
): { ok: true } | { ok: false; reason: 'single_document' } {
  // 注意：**只有恰好 1 篇**才归"合并后不足两份"；0 篇交回 `empty` 分支
  // （原因归属必须准确——"没有可用资料"与"只有同一份的两版本"是两回事）。
  if (uniqueDocumentCount === 1) {
    return { ok: false, reason: 'single_document' }
  }
  return { ok: true }
}
