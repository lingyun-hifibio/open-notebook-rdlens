/**
 * Citation 展示与失效降级纯函数（UI-02，REQ-DATA-03/04，设计 §5.3）。
 *
 * - `page_idx` 是唯一持久化页码字段（0-based）；UI 展示一律 +1，绝不
 *   引入 `page_number`；
 * - 仍被研究产物引用的旧文档版本必须保留；无法保留时保留 Citation
 *   原文并明确禁用失效跳转（REQ-DATA-04）。
 */

import type { ResearchCitation, ResearchChunk, ResearchSource } from '@/lib/types/research'
import type { PersistedCitationSnapshot } from '@/lib/types/research'

/**
 * 持久化 Citation 快照 → display 形态（RWV2-21，High-2）。
 *
 * 后端结果 Artifact 的 citations[] 只含身份字段 + claim/original_text（
 * REQ-DATA-03），无 `citation_id`/display 富字段。此处合成稳定 key 并做
 * 名回退（来源解析名 → doc_id），供 CitationCard/ResearchCitationList
 * 渲染与 React key——绝不伪造富字段（REQ-DATA-03）。
 */
export interface DisplayCitation {
  key: string
  citation_id: string
  claim: string
  doc_id: string
  doc_version: string | null
  chunk_id: string | null
  page_idx: number | null
  original_text: string
  doc_display_name: string | null
  short_name: string | null
}

/** 合成 Citation 身份基座；批量渲染时另追加不可变列表位置保证 React key 唯一。 */
export function persistedCitationKey(snapshot: PersistedCitationSnapshot): string {
  return [
    snapshot.doc_id,
    snapshot.doc_version ?? '',
    snapshot.chunk_id ?? '',
    snapshot.page_idx ?? '',
  ].join(':')
}

export function normalizePersistedCitation(
  snapshot: PersistedCitationSnapshot,
): DisplayCitation {
  const key = persistedCitationKey(snapshot)
  return {
    key,
    citation_id: key,
    claim: snapshot.claim ?? '',
    doc_id: snapshot.doc_id,
    doc_version: snapshot.doc_version ?? null,
    chunk_id: snapshot.chunk_id ?? null,
    page_idx: snapshot.page_idx ?? null,
    original_text: snapshot.original_text ?? '',
    // 名回退由 CitationCard 承担（doc_display_name || short_name || doc_id）；
    // 持久快照无富名，此处不伪造（REQ-DATA-03）
    doc_display_name: null,
    short_name: null,
  }
}

/**
 * 把持久化快照列表批量归一化为 display 形态。
 *
 * 不按 doc/chunk/page 去重：同一证据块可以支撑多个不同 claim，丢掉其中一条
 * 会破坏已保存结果的 Citation 完整性。Artifact 的 Citation 数组是不可变快照，
 * 因此以其稳定顺序追加 index，只解决 React key 碰撞而不改变内容语义。
 */
export function normalizePersistedCitations(
  snapshots: readonly PersistedCitationSnapshot[] | undefined,
): DisplayCitation[] {
  if (!snapshots || snapshots.length === 0) return []
  return snapshots.map((snapshot, index) => {
    const display = normalizePersistedCitation(snapshot)
    const key = `${display.key}:${index}`
    return { ...display, key, citation_id: key }
  })
}

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
