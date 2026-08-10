/**
 * Citation 展示与失效降级纯函数（UI-02，REQ-DATA-03/04，设计 §5.3）。
 *
 * - `page_idx` 是唯一持久化页码字段（0-based）；UI 展示一律 +1，绝不
 *   引入 `page_number`；
 * - 仍被研究产物引用的旧文档版本必须保留；无法保留时保留 Citation
 *   原文并明确禁用失效跳转（REQ-DATA-04）。
 */

import type { ResearchCitation, ResearchChunk, ResearchSource } from '@/lib/types/research'

/** 按 document_id 解析 Citation 所属来源（跨项目由服务端保证隔离）。 */
export function resolveCitationSource(
  sources: readonly ResearchSource[] | undefined,
  citation: ResearchCitation,
): ResearchSource | undefined {
  return (sources ?? []).find((source) => source.document_id === citation.doc_id)
}

/** page_idx（0-based）→ 展示页码（1-based）；null/负值不展示。 */
export function displayPage(pageIdx: number | null): number | null {
  if (pageIdx === null || pageIdx < 0) {
    return null
  }
  return pageIdx + 1
}

/** 在 markdown chunks 中按 0-based page_idx 定位首个匹配 chunk。 */
export function findChunkForPage(
  chunks: readonly ResearchChunk[],
  pageIdx: number | null,
): ResearchChunk | undefined {
  if (pageIdx === null || pageIdx < 0) {
    return undefined
  }
  return chunks.find((chunk) => chunk.page_idx === pageIdx)
}

export type JumpDenyReason =
  | 'source_unavailable'
  | 'version_mismatch'
  | 'no_page'
  | 'page_missing'

export interface JumpEvaluation {
  canJump: boolean
  /** 禁用时的原因（UI 展示降级提示；原文始终保留） */
  reason: JumpDenyReason | null
}

/**
 * 判定 Citation 跳转可用性：
 * - source 存在且 ready（stale/failed/pending 或 404 → 禁用）；
 * - citation.doc_version 与当前 mirror 版本一致（不一致 → 旧文件可能已
 *   失效，禁用，原文保留）；citation 无版本视为当前版本；
 * - citation 有页码（无页码 → 禁用）；
 * - 已加载内容时目标页必须存在（页缺失 → 禁用）；内容未加载
 *   （chunks=undefined）时不做页检查，由跳转目标（来源详情）兜底。
 */
export function canJumpToCitation(
  citation: ResearchCitation,
  source: ResearchSource | null | undefined,
  chunks: readonly ResearchChunk[] | undefined,
): JumpEvaluation {
  if (source === null || source === undefined || source.status !== 'ready') {
    return { canJump: false, reason: 'source_unavailable' }
  }
  if (citation.doc_version !== null && citation.doc_version !== source.document_version) {
    return { canJump: false, reason: 'version_mismatch' }
  }
  if (citation.page_idx === null || citation.page_idx < 0) {
    return { canJump: false, reason: 'no_page' }
  }
  if (chunks !== undefined && findChunkForPage(chunks, citation.page_idx) === undefined) {
    return { canJump: false, reason: 'page_missing' }
  }
  return { canJump: true, reason: null }
}
