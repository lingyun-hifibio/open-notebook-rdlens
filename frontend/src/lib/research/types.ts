/**
 * Research Workspace API 类型（UI-03，契约 v0 §8–§10）。
 *
 * 字段名与 Gateway 契约一致（snake_case 保持为 API 传输形状，前端不改写
 * 契约字段）。SSE 事件集：thinking/answer/citation/usage/done/error，
 * 每个事件带单调递增 `event_id`（从 1 开始，每事件 +1）。
 */

/** SSE 事件类型（契约 §9.1） */
export type ResearchSseType = 'thinking' | 'answer' | 'citation' | 'usage' | 'done' | 'error'

export interface ResearchCitation {
  citation_id: number
  claim: string
  doc_id: string
  doc_version: string
  chunk_id: string
  page_idx: number
  original_text: string
  citation_type: string
  confidence: string
}

export interface ResearchTokenUsage {
  input_tokens: number
  thinking_tokens?: number
  output_tokens: number
}

/**
 * source_ref 载荷（Issue #182：usage 事件携带的实际版本快照）。
 * wire 形状保持 snake_case（契约字段不改写）；映射到 State/turn 层才转 camelCase。
 */
export interface ResearchSourceRef {
  source_id: string
  document_id: string
  document_version: string
}

/**
 * Citation 展示最小结构（Issue #182）：兼容 SSE 侧 9 字段（citation_id:
 * number、page_idx 必有）与持久化 17 字段快照（citation_id: string、
 * page_idx 可空）两种形态，供轻量 Citation 列表统一渲染。
 */
export interface ResearchCitationDisplayItem {
  citation_id: number | string
  claim: string
  doc_id: string
  /** 0-based；null 时只展示声明不展示页码 */
  page_idx: number | null
  confidence?: string | number | null
}

/** 单个 SSE 事件载荷（契约 §9.1；字段按 type 可选） */
export interface ResearchSseEvent {
  event_id: number
  type: ResearchSseType
  delta?: string
  citations?: ResearchCitation[]
  usage?: ResearchTokenUsage
  resolved_mode?: string
  /** Issue #182：真实降级原因码集合（如 source_over_direct_cap） */
  degradation_reasons?: string[]
  /** Issue #182：本轮实际钉住的 source→document 版本 */
  source_ref?: ResearchSourceRef
  session_id?: string
  request_id?: string
  job_id?: string | null
  completion_status?: string
  code?: string
  message?: string
}

export type ResearchJobStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed'

/** Job 对象（契约 §10.1；result_ref 为 SurrealDB Artifact 引用，不含正文） */
export interface ResearchJob {
  job_id: string
  project_id: string
  job_type: string
  status: ResearchJobStatus
  stage: string | null
  progress: number
  model_id: string | null
  generation_epoch: number
  retry_count: number
  last_error: string | null
  result_ref: string | null
  created_at: string
  updated_at: string
}

export interface ResearchEvidenceItem {
  source_id: string
  document_version: string
  chunk_id: string
  page_idx: number
  original_text: string
}

export interface ResearchSearchRequest {
  query: string
  source_ids?: string[]
  note_ids?: string[]
  mode?: string
}

/** Search 响应（契约 §8.1；REQ-ENG-04：模式/证据/引用/用量/降级原因） */
export interface ResearchSearchResponse {
  request_id: string
  resolved_mode: string
  evidence: ResearchEvidenceItem[]
  citations: ResearchCitation[]
  usage: ResearchTokenUsage
  degradation_reason: string | null
  conclusion: string
}

export interface ResearchChatRequest {
  query: string
  source_ids?: string[]
  note_ids?: string[]
  session_id?: string
}

export interface ResearchCompareCreateRequest {
  job_type: 'deep_compare' // 契约 §8.3 必填（RDLens JobCreateRequest）
  document_ids: string[]
  group_size?: number
  mode?: string
}

export interface ResearchCompareCreateResponse {
  job_id: string
  status: ResearchJobStatus
}

