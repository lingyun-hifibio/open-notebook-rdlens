/**
 * Research Gateway 契约类型（UI-02，契约 v0 §6/§7；REQ-API-01）。
 *
 * 字段名与契约 v0 / RDLens `research/router.py` 响应一一对应；`page_idx`
 * 唯一页码字段固定 0-based（设计 §5.3），UI 展示时 +1，绝不持久化
 * `page_number`。
 */

/** SourceMirror 状态（PR5 对齐 `_source_view`：6 值，含退役态） */
export type ResearchSourceStatus = 'pending' | 'ready' | 'stale' | 'failed' | 'retiring' | 'deleted'

export interface ResearchSource {
  /** PR5（C3）：`_source_view` 的 source_id 可为 null（无镜像身份的行不可选） */
  source_id: string | null
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
  /**
   * Issue #1013（D1-E-2）§2.3：reader chunk 序号（`build_reader_chunks` 排序后
   * 下标）。reader_anchor 的 `chunk_ordinal` 必须取服务端该值，**不得**用
   * 前端数组下标代替（chunk 集合变化时两者会漂移）。
   */
  chunk_ordinal?: number
  /**
   * Issue #1013（D1-E-2）§2.3：逐 chunk reader content hash
   * （`H(["research-session-v1/reader-chunk", doc, version, ordinal, markdown])`）。
   * reader_anchor 与选段载荷的 `content_hash` 必须取该值，不得用来源级
   * `content_hash`（口径不同 → 服务端校验必失配）。
   */
  content_hash?: string | null
}

export interface ResearchSourceDetail extends ResearchSource {
  title: string | null
  markdown_chunks: ResearchChunk[]
  /**
   * Issue #1011（D1-E 主单）§2.4：技术格式（`pdf`/`ppt`/`xlsx`/`docx`/`csv`/
   * 其他或 null）。**加性可选**——旧 host 无此键（`undefined`）→ 来源详情
   * 保持 pin 基线 UI（不显示格式 badge/页图/打开原文件，fail-closed）。
   * 仅在 `useResearchD1e(projectId).ready === true` 且该键存在时消费。
   */
  source_type?: string | null
  /**
   * Issue #1011 §2.4：documents 行是否含可解析文件引用（`minio_uri` 或
   * `source_path`）。加性可选；仅 `true` 且 D1-E 能力就绪时显示「打开原文件」。
   */
  file_available?: boolean
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

// ── Issue #1046 PR4（D2-B2）：d2-v1 受保护 Note 的加性 DTO ──
//
// 只描述 d2-v1 契约（`X-Research-Note-Contract: d2-v1`）新增的读取投影与
// 能力/回执形状；旧 v1 响应没有这些键，因此全部为**加性**类型。编辑器内部
// 状态类型（ResearchNoteD2/NoteEditorState/…）在
// `lib/research/issue585/types.ts`，本文件只放 wire 层 DTO。

/** d2-v1 编辑格式标识（受保护 Note）；旧未保护 Note 为 null。 */
export type ResearchNoteEditSchema = 'd2-v1'

/** 当前权限投影（服务端判定；restricted = 仅返回无标题占位）。 */
export type ResearchNoteAccessState = 'visible' | 'restricted'

/** d2-v1 Note 读取投影的保护字段（§3.1；旧 v1 响应无这些键）。 */
export interface ResearchNoteProtection {
  revision: number | null
  snapshot_hash: string | null
  edit_schema: string | null
  access_state?: ResearchNoteAccessState | null
}

/** d2-v1 Note 列表/详情行（旧字段 + 保护字段）。 */
export interface ResearchNoteProtected extends ResearchNote, ResearchNoteProtection {}

/** 能力位原始投影（§8.2；`{available, reason}`，reason 为机器可读码）。 */
export interface ResearchNoteCapabilityProjection {
  available: boolean
  reason: string | null
}

/**
 * `GET /models` 的 Note 能力加性键（原始 snake_case wire 形状）。
 *
 * 既有 `ResearchCapabilities` 是封闭接口且不在本 PR 白名单内；这里以
 * 交叉类型的方式记录新增键，供 `lib/research/api.ts::listModels` 返回类型
 * 加性扩展。解析/归一（camelCase + fail-closed）由
 * `lib/research/issue585/use-note-capabilities.ts` 负责。
 */
export interface ResearchNoteCapabilitiesProjection {
  note_editor?: unknown
  note_editor_existing?: unknown
  markdown_export?: unknown
  writing_local?: unknown
  writing_external?: unknown
}

/** 变更回执（契约 §4；删除的 snapshot_hash 为 null）。 */
export interface ResearchNoteReceipt {
  note_id: string
  mutation_id: string
  applied_revision: number
  snapshot_hash: string | null
  saved_at: string
  replayed: boolean
}
