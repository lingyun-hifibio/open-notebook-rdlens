/**
 * Research Gateway 契约类型（UI-02，契约 v0 §6/§7；REQ-API-01）。
 *
 * 字段名与契约 v0 / RDLens `research/router.py` 响应一一对应；`page_idx`
 * 唯一页码字段固定 0-based（设计 §5.3），UI 展示时 +1，绝不持久化
 * `page_number`。
 */

/** SourceMirror 状态（设计 §5.2/§6；stale=内容更新未完成，failed=可审计错误） */
export type ResearchSourceStatus = 'pending' | 'ready' | 'stale' | 'failed'

export interface ResearchSource {
  source_id: string
  document_id: string
  document_version: string
  status: ResearchSourceStatus
  content_hash: string | null
  synced_at: string | null
  /** failed 时的可审计错误（不含正文，契约 §6） */
  last_error: string | null
}

export interface ResearchChunk {
  chunk_id: string
  /** 0-based 页码（设计 §5.3）；展示用 page_idx + 1 */
  page_idx: number
  markdown: string
}

export interface ResearchSourceDetail extends ResearchSource {
  title: string | null
  markdown_chunks: ResearchChunk[]
}

export interface ResearchNote {
  note_id: string
  project_id: string
  title: string
  content: string
  note_type: 'human'
  created_at: string | null
  updated_at: string | null
}

export interface ResearchInsight {
  insight_id: string
  project_id: string
  title: string
  content: string
  insight_type: 'ai' | 'manual'
  model_id: string | null
  created_at: string | null
  updated_at: string | null
  citations?: ResearchCitation[]
}

export type ResearchTransformationScope = 'admin_template' | 'project_private'

export interface ResearchTransformation {
  transformation_id: string
  project_id: string
  name: string
  /** 标量兼容投影（RWV2-35 契约）：project/legacy 单 prompt = content；
   *  admin 双语行 = en 变体（旧 fork 只读此键仍可渲染，AC8）。 */
  prompt_template: string
  /** RWV2-35：admin 双语模板的 zh 变体；仅当 bilingual===true 存在 */
  prompt_template_zh?: string
  /** RWV2-35：admin 双语模板的 en 变体；仅当 bilingual===true 存在 */
  prompt_template_en?: string
  /** RWV2-35：true = admin 双语成对模板。缺省/undefined（旧后端无此键）
   *  与 false 等价 → 一律按单 prompt 处理（回滚天然兼容）。 */
  bilingual?: boolean
  model_id: string | null
  scope: ResearchTransformationScope
  created_at: string | null
}

/** Citation 快照（契约 v0 §13.2：与 RDLens CitationOutput 同字段集合） */
export interface ResearchCitation {
  citation_id: string
  claim: string
  chunk_id: string | null
  doc_id: string
  doc_version: string | null
  /** 0-based；展示用 page_idx + 1 */
  page_idx: number | null
  section: string | null
  original_text: string
  citation_type: string | null
  confidence: number | null
  doc_display_name: string | null
  short_name: string | null
  doc_type: string | null
  project_id: string | null
  vlm_bboxes: number[][] | null
  minio_uri: string | null
  source_path: string | null
}

export interface ResearchUsage {
  input_tokens: number
  output_tokens: number
}

export interface TransformationRunResult {
  request_id: string
  transformation_id: string
  requires_job: boolean
  degradation_reason: string | null
  result_id: string | null
  model_id: string | null
  source_refs: string[]
  usage: ResearchUsage
  citations: ResearchCitation[]
  output: string | null
}

export interface ResearchExport {
  export_id: string
  project_id: string
  format: string
  artifacts: string[]
  created_at: string | null
  download_url: string
}

/**
 * 持久化 Citation 快照字段子集（RWV2-20；RDLens `build_citation_snapshots`）。
 *
 * Surreal 结果 Artifact 的 `citations[]` 只含身份字段 + claim/original_text，
 * **不含** `citation_id`/`doc_display_name`/`short_name` 等富字段（REQ-DATA-03
 * 不伪造）；与富 `ResearchCitation`（run 响应/SSE 形态）区分，展示前必须经
 * display 归一化（合成稳定 key + 名回退链）。
 */
export interface PersistedCitationSnapshot {
  project_id?: string | null
  doc_id: string
  doc_version?: string | null
  chunk_id?: string | null
  /** 0-based；持久化唯一页码字段，展示用 +1 */
  page_idx?: number | null
  claim?: string | null
  original_text?: string | null
  citation_type?: string | null
  confidence?: string | null
}

/** Transformation Result（RWV2-20 冻结 result-object；list/detail 同构）。 */
export interface TransformationResultRecord {
  result_id: string
  project_id: string
  title: string | null
  /** legacy 行（无 run_metadata envelope）为 null，不可 rerun */
  transformation_id: string | null
  template_config_ref: string | null
  generation_id: string | null
  model_id: string | null
  status: string | null
  /** 键位冻结：RWV2-31 前恒 null；区分 legacy/真实 null 以 envelope_version 为准 */
  response_language: string | null
  source_ids: string[]
  note_ids: string[]
  source_refs: string[]
  output: string | null
  citations: PersistedCitationSnapshot[]
  created_at: string | null
  updated_at: string | null
}

/** 分页载荷（契约 §3.4：cursor/limit；next_cursor 为 null 表示末页） */
export interface ResearchPage<T> {
  items: T[]
  next_cursor: string | null
}

/**
 * RWV2-22/RWV2-23（Issue #331/#43）：Save-as-Insight/Note 源与目标类型。
 *
 * `origin_id` 恒为服务端持久化的 generation_id（RDLens 侧 ≤100 字符、
 * `[A-Za-z0-9_-]+`）；正文/Citation/scope/model/response_language 全部由
 * 服务端从项目内持久源解析，客户端不重建可信 provenance。
 */
export type ResearchSaveOriginKind = 'search' | 'chat' | 'transformation'
export type ResearchSaveDestinationKind = 'insight' | 'note'

export interface ResearchSaveFromResultRequest {
  origin_kind: ResearchSaveOriginKind
  origin_id: string
  destination_kind: ResearchSaveDestinationKind
  /** 可选；空白视为未提供（服务端用 origin 派生标题或固定缺省） */
  title?: string
}

/** Save 的 provenance envelope（服务端 run_metadata 解析后的展示键，§4.3） */
export interface ResearchSaveProvenance {
  envelope_version: number
  kind: 'save_from_result'
  origin_kind: ResearchSaveOriginKind
  origin_id: string
  destination_kind: ResearchSaveDestinationKind
  scope: { source_ids: string[]; note_ids: string[] }
  model_id: string | null
  response_language: string | null
  saved_at: string
  saved_by_user_id: number
  source_timestamps: Record<string, unknown>
}

/** Save-as-Note 的 201/200 响应（note detail 视图 + citations + provenance） */
export interface SavedNoteRecord {
  note_id: string
  project_id: string
  title: string
  content: string
  note_type: 'human'
  created_at: string | null
  updated_at: string | null
  citations: PersistedCitationSnapshot[]
  provenance: ResearchSaveProvenance
}

/** Save-as-Insight（ai）的 201/200 响应（insight detail 视图 + citations + provenance） */
export interface SavedInsightRecord {
  insight_id: string
  project_id: string
  title: string
  content: string
  insight_type: 'ai'
  model_id: string | null
  created_at: string | null
  updated_at: string | null
  citations: PersistedCitationSnapshot[]
  provenance: ResearchSaveProvenance
}

export type ResearchSaveResultResponse = SavedNoteRecord | SavedInsightRecord
