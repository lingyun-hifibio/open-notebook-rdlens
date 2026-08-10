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
  prompt_template: string
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

/** 分页载荷（契约 §3.4：cursor/limit；next_cursor 为 null 表示末页） */
export interface ResearchPage<T> {
  items: T[]
  next_cursor: string | null
}
