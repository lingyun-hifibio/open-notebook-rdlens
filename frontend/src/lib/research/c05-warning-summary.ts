/**
 * Issue #601 PR5（D-17）：范围警告的有界聚合——`_resolve_all` 对每个无可读
 * 版本的文档各产出一条警告且无上限（v8 §2.1），真实大项目可能返回数百条。
 * 前端**必须**按"计数摘要 + 有界明细"呈现，防御性截断并标注，不得静默丢弃。
 */

import type { C05ScopeWarning } from './c05-scope-projection'

/** 明细渲染上限（可配置；首屏节点数不随文档数增长） */
export const WARNING_DETAIL_LIMIT = 5

export interface C05WarningSummary {
  /** `stale_fallback` 中"回退到旧版本"的文档数 */
  fallbackCount: number
  /** "无可读版本被排除"的文档数（used_version 为空串） */
  excludedCount: number
  /** 有界明细（≤ WARNING_DETAIL_LIMIT 条，保留原始顺序） */
  detail: C05ScopeWarning[]
  /** 被截断的警告条数（0 = 无截断） */
  truncated: number
  total: number
}

export function summarizeWarnings(
  warnings: C05ScopeWarning[] | undefined,
  limit: number = WARNING_DETAIL_LIMIT,
): C05WarningSummary {
  const list = warnings ?? []
  const total = list.length
  let fallbackCount = 0
  let excludedCount = 0
  for (const warning of list) {
    if (warning.code !== 'stale_fallback') continue
    const docs = warning.documents ?? []
    const isExclusion = docs.length > 0 && docs.every(doc => doc.used_version === '')
    if (isExclusion) excludedCount += docs.length
    else fallbackCount += docs.length > 0 ? docs.length : 1
  }
  const detail = list.slice(0, limit)
  return { fallbackCount, excludedCount, detail, truncated: Math.max(0, total - detail.length), total }
}

/**
 * `resolved_source_refs` 计数摘要——它**不是**逐条渲染给用户的资料清单
 * （D-17 第 2 条），UI 只用计数。
 */
export function refCountSummary(refs: Array<{ document_id: string }> | undefined): {
  documentCount: number
} {
  return { documentCount: refs?.length ?? 0 }
}
