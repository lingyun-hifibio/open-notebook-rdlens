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
  /** §13.2：无真实 usage 按本地估算结算时为 true（v1 响应） */
  estimated?: boolean
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
  /** Issue #200 §14.2：v1 必填的显式模型 */
  model_id?: string
  /** Issue #200 §8：三档上下文（focused/document/workspace） */
  context_level?: string
}

/** §8.1/§8.5 focused coverage report（v1 响应可选字段） */
export interface ResearchContextCoverage {
  context_level?: string
  selected_full?: number
  relevant_extra?: number
  trimmed?: number
  missing?: number
  token_estimate?: number
  input_budget?: number | null
  estimator_version?: string
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
  /** Issue #200：v1 响应固定携带（§14.2/§14.3 结果展示依据） */
  generation_id?: string
  job_id?: string | null
  status?: string
  model_id?: string
  provider_id?: string | null
  context_level?: string
  context_coverage?: ResearchContextCoverage
}

/**
 * v1 搜索结果判别联合（§14.3：按 HTTP status 分支，不能只看 body）。
 * direct = 200 JSON；background = 202 JSON（generation/job 引用）。
 */
export type ResearchSearchOutcome =
  | { kind: 'direct'; result: ResearchSearchResponse }
  | {
      kind: 'background'
      generation_id: string
      job_id: string | null
      status: string
    }

/** 用户模型列表条目（§5.2 GET models；本地 enabled 且非 embedding） */
export interface ResearchModelOption {
  model_id: string
  display_name?: string | null
  provider_id?: string | null
  context_window?: number | null
  /** Issue #202 Phase 3b：data_egress=true 表示外部模型（本地恒 false） */
  data_egress?: boolean | null
  /**
   * #243 GMOD §5.2：Search 交互式上下文档位（服务端真实能力，前端不得
   * 按 provider/data_egress 自行猜测）。外部模型恒 ['focused']。
   */
  interactive_context_levels?: ResearchContextLevel[]
}

/** Search 交互式上下文档位（服务端能力声明子集） */
export type ResearchContextLevel = 'focused' | 'document' | 'workspace'

/** Issue #202 Phase 3b：Workspace 外发确认（§6.3 GET 契约形状） */
export interface ResearchEgressConsent {
  project_id: string
  acknowledged_by: number | null
  acknowledged_at: string | null
  policy_version: string
  scope_hash: string
  revoked_at: string | null
  revoked_by: number | null
  valid: boolean
}

/** Issue #202 Phase 3b：外发范围（用户被告知的数据类别与目的地） */
export interface ResearchEgressRequiredScope {
  policy_version: string
  provider_destinations: {
    provider_id: string
    api_base_url: string
  }[]
  data_categories: string[]
  scope_hash: string
}

export interface ResearchEgressConsentResponse {
  consent: ResearchEgressConsent | null
  required_scope: ResearchEgressRequiredScope
}

/** Workspace 执行偏好（§6.2 GET/PUT execution-preferences 契约形状） */
export interface ResearchExecutionPreferences {
  project_id: string
  default_context_level: 'focused' | 'document' | 'workspace'
  preferred_model_id: string | null
  updated_by: number | null
  updated_at: string | null
}

/** Context Preview 响应（§9.1 本地只读预判；结论只是提示） */
export interface ResearchContextPreview {
  source_count: number
  chunk_count: number
  note_count: number
  token_estimate: number
  direct_or_background: 'direct' | 'background_job'
  needs_consent: boolean
  coverage: Record<string, unknown>
  warnings: string[]
}

export interface ResearchChatRequest {
  query: string
  source_ids?: string[]
  note_ids?: string[]
  session_id?: string
  /** #238：v1 契约必填——显式透传已保存执行偏好（不变量 2：后端不隐式补值） */
  model_id?: string
}

export interface ResearchCompareCreateRequest {
  job_type: 'deep_compare' // 契约 §8.3 必填（RDLens JobCreateRequest）
  document_ids: string[]
  group_size?: number
  mode?: string
  /** #238：v1 契约必填——显式透传已保存执行偏好（不变量 2） */
  model_id?: string
}

export interface ResearchCompareCreateResponse {
  job_id: string
  status: ResearchJobStatus
}

