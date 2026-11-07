/**
 * Research Workspace API 类型（UI-03，契约 v0 §8–§10）。
 *
 * 字段名与 Gateway 契约一致（snake_case 保持为 API 传输形状，前端不改写
 * 契约字段）。SSE 事件集：thinking/answer/citation/usage/done/error，
 * 每个事件带单调递增 `event_id`（从 1 开始，每事件 +1）。
 */

import type {
  ResearchSessionRef,
  WireChatAnchor,
  WireEditorBaseScope,
  WireReaderAnchor,
  WireSelectionContext,
  WireSelectionContextBody,
} from './session-contract'

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
/**
 * Issue #1013（D1-E-2）§2.11：页级 pending 选段（来源详情「讨论选段」→
 * 当前活动会话 composer chip）。`selection` 是 11 键请求对象；chip 展示
 * 元信息随对象携带（来源名/页码/序号），不参与请求。
 */
export interface ResearchPendingSelection {
  readonly selection: WireSelectionContext
  readonly sourceId: string
  readonly sourceTitle: string | null
  readonly pageIdx: number | null
  readonly chunkOrdinal: number
  /** 选段归属 surface：当前活跃会话（global 或 source）。 */
  readonly target: 'global' | 'source'
}

export interface ResearchCitationDisplayItem {
  citation_id: number | string
  claim: string
  doc_id: string
  /** 0-based；null 时只展示声明不展示页码 */
  page_idx: number | null
  confidence?: string | number | null
  /**
   * Issue #1013（D1-E-2）§2.10：citation 身份（return target 匹配用）。
   * SSE 9 字段与持久化 17 字段快照都携带；展示最小结构此前丢弃，恢复路径
   * 需要它把「引用 → durable message」反查保持确定性，故加性保留。
   */
  doc_version?: string | null
  chunk_id?: string | null
  doc_display_name?: string | null
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
  /** #602 第三批 PR-5a：受理回执（usage 事件扩展字段；形状非法整组丢弃） */
  accepted?: ResearchAcceptedReceiptWire
  /** #602 第三批 PR-5a：容量解释（形状非法整组丢弃；投影归 PR-5b） */
  context_report?: ResearchContextReportWire
  /** #602 第三批 PR-5a：上下文覆盖（形状非法整组丢弃） */
  context_coverage?: ResearchContextCoverage
  /**
   * #1106（W1 PR-B）：`usage` 事件的持久化工作目的两级事实（与消息行/
   * completed 重放同一来源）。旧行 `null` + `not_recorded`；flag off 时两键
   * 不出现（不投影）。
   */
  work_purpose?: 'document_qa' | 'exploration' | 'writing' | null
  work_purpose_source?: 'explicit' | 'inferred' | 'default_legacy' | 'not_recorded'
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
  /** COV-08：research_coverage Job 额外返回 coverage 段（§12.1） */
  coverage?: ResearchCoverageJobView
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
  /** Issue #243 §6.7：正式前端必填——顶层 confirmed 全局模型快照 */
  model_id: string
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
      /**
       * PR5（D-01，评审 MEDIUM-7）：`#615 §3.3` 明确 202 与 200 采用**同一**
       * 范围投影（`project_scope_response`）。此前 202 分支把响应体裁成
       * generation/job/status，投影被丢弃 → 排队中的 C-05 检索会显示"服务端
       * 未返回范围详情"并隐藏排除/回退警告。原样透传，由消费方严格校验。
       */
      scope_contract_version?: unknown
      resolved_scope?: unknown
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

/**
 * Research 工作区能力协商（#358，§17.2）。顶层字段来自
 * GET /v1/research/projects/{project_id}/models 响应，直接反映后端
 * 运行时 feature flag 真值。旧后端/字段缺失/类型非法一律按 false
 * 处理（fail-closed，见 `coverageAllSelectedFrom`）。
 */
export interface ResearchCapabilities {
  /** 后端 research_coverage_enabled 真值；仅 true 允许提交 all_selected */
  coverage_all_selected?: unknown
  /** PR5（B1）：C-05 能力块（加性；缺失/畸形按不可用处理，不降级） */
  c05?: unknown
  /**
   * Issue #1013（D1-E-2）§2.2/§2.11：往返/选段能力键（加性；flag on 才出现）。
   * 严格读取见 `c05-contract.readD1eCapability`：缺失/畸形/false → 全部选段
   * UI 不可用（fail-closed），既有 UI 保持现状。
   */
  'd1e_roundtrip'?: unknown
  /**
   * #1014：搜索历史回访能力位（加性；缺失/非严格 true 一律 fail-closed，
   * 见 `readSearchHistoryCapability`）。
   */
  search_history?: unknown
  /**
   * #1016（D1-G，加性）：主题概览能力位。仅当 contract-v1 ∧ C-05 ∧ D1-C ∧
   * 概览 flag **四条件全真**时出现且为 `true`；否则键缺席。读取见
   * `topic-overview.readTopicOverviewCapability`——严格 `=== true` 才渲染
   * 入口（缺失/false/非法一律 fail-closed，既有 UI 零变化）。
   */
  topic_overview?: unknown
  /**
   * #813（加性）：当前引擎模式下本地模型是否可以执行。三键恒在
   * （`available`/`reason`/`message`；exclusive 下 reason/message 为 null）。
   * 读取见 `localModelCapabilityFrom`——缺失/畸形返回 null（保持既有行为
   * 零回归，不臆造状态）；后端 fail-closed 仍是安全权威。
   */
  local_model?: unknown
  /**
   * #1106（W1 PR-A，加性）：目的推断能力位。只在 inference flag on 且
   * D1-C 契约 on 时出现且为 `true`；缺失/非法/旧后端一律按不可用处理
   * （fail-closed），读取见 `work-purpose.readPurposeInferenceCapability`。
   * flag off 时 composer 摘要显示「默认（资料问答）」，不显示假控件。
   */
  purpose_inference?: unknown
  /**
   * #1106（W1 PR-A，加性）：当前可持久化的目的来源集合（含 `inferred`）。
   * 只作探测/诊断参考；前端展示严格按消息行/SSE 的持久化 pair 读取，
   * 不由该集合推断任何记录的值（不读就不猜）。
   */
  purpose_sources?: unknown
}

/** GET models 响应（#358：能力与模型同一次返回，避免两次请求间竞态） */
export interface ResearchModelsResponse {
  models: ResearchModelOption[]
  capabilities?: ResearchCapabilities
}

/**
 * #358：从 models 响应解析 Coverage 能力——缺失、类型非法、值为 false
 * 一律归一为 false（fail-closed）。只有严格 `=== true` 才允许提交
 * all_selected。
 */
export function coverageAllSelectedFrom(
  capabilities: ResearchCapabilities | undefined,
): boolean {
  return capabilities?.coverage_all_selected === true
}

/**
 * #813：`capabilities.local_model` 的稳定形状（三键恒在，后端契约见
 * RDLens #820 / `local_model_capability`）。
 */
export interface ResearchLocalModelCapability {
  /** 当前模式下本地模型是否允许执行（不是「目录里是否存在本地模型」） */
  available: boolean
  /** 稳定原因码（当前只可能为 'shared_gpu'；可空） */
  reason: string | null
  /** 后端下发的用户可见文案（可空——缺失时不伪造提示） */
  message: string | null
}

/**
 * #813：从 models 响应解析本地模型能力。
 *
 * 只认后端单源（不在前端复制 `mode == shared` 判定）：`available === false`
 * 即「当前模式下本地模型不可执行」。判据只在后端一处，前端缺失/畸形时
 * 返回 null（旧后端无该能力时保持既有行为零回归；后端 fail-closed 仍是
 * 最终安全权威）。`reason`/`message` 缺失按 null 归一，类型非法整块按缺失
 * 处理——绝不根据猜测补文案或状态。
 */
export function localModelCapabilityFrom(
  capabilities: ResearchCapabilities | undefined,
): ResearchLocalModelCapability | null {
  const raw = capabilities?.local_model
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { available, reason, message } = raw as Record<string, unknown>
  if (typeof available !== 'boolean') return null
  if (reason != null && typeof reason !== 'string') return null
  if (message != null && typeof message !== 'string') return null
  return {
    available,
    reason: reason ?? null,
    message: message ?? null,
  }
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
  /** 旧 v1 契约：显式 ID 集合；C-05 分支禁用（改走 source_scope） */
  source_ids?: string[]
  note_ids?: string[]
  session_id?: string
  /** Issue #243 §6.7：正式前端必填——顶层 confirmed 全局模型快照（不变量 2） */
  model_id: string
  /** COV-08 §12.1：显式合成范围；缺省 relevant（旧客户端兼容） */
  synthesis_scope?: ResearchSynthesisScope
  /** PR5（B3）：C-05 范围载荷（仅 c05-v1 分支携带） */
  source_scope?: {
    mode: 'all' | 'selected' | 'single'
    source_ids: string[]
    single_source_id: string | null
  }
  /**
   * Issue #1013（D1-E-2）§2.4：本轮显式选段上下文（11 键 wire 形状）。
   * 仅在 headed 会话提交（`protocol === 'research-session-v1'`）且 d1e 能力
   * 可用时携带；不是检索范围，不得并入 source_ids/source_scope/note_ids。
   */
  selection_context?: WireSelectionContextBody | null
  /**
   * #1106（W1 PR-B）：显式工作目的（C-01 三个可写值）。只在用户明确选择时
   * 出现；「自动判断」= **省略字段**（显式 null 会被后端 422，前端禁止发送
   * null）。推断只发生在服务端（仅 headed global Chat）。
   */
  work_purpose?: 'document_qa' | 'exploration' | 'writing'
}

/** COV-08 §12.1：调用方显式选择相关证据回答或覆盖全部所选来源 */
export type ResearchSynthesisScope = 'relevant' | 'all_selected'

/** 逐文档目标结果（契约 §6.3；COV-08 Job 视图 target_results 元素） */
export interface ResearchCoverageTargetResult {
  target_kind: string
  document_id: string
  document_revision: string
  status: 'analyzed' | 'failed'
  failure_code: string | null
}

/** 目标覆盖计数（契约 §6.3；counts 从 target_results 推导，不由 LLM 填写） */
export interface ResearchCoverageTargetCoverage {
  requested: number
  analyzed: number
  failed: number
  status: 'complete' | 'partial' | 'failed'
}

/** 提交时固定的 Source/revision snapshot（Manifest 条目，§7.5） */
export interface ResearchCoverageManifestEntry {
  source_id: string
  document_id: string
  document_revision: string
}

/** 关联 Generation 的稳定状态表达（outcome_unknown 的 API 形态，§12.2） */
export interface ResearchCoverageGenerationView {
  generation_id: string
  state: string
  failure_code: string | null
}

/** research_coverage Job 视图的 coverage 段（COV-08 GET /jobs/{id}） */
export interface ResearchCoverageJobView {
  synthesis_scope: ResearchSynthesisScope
  contract_version: string | null
  execution_plan_version: string | null
  prompt_bundle_version: string | null
  generation_id: string | null
  retry_of_generation_id?: string
  generation?: ResearchCoverageGenerationView | null
  stages?: { name: string; status: string }[]
  manifest?: { entries: ResearchCoverageManifestEntry[] }
  target_results?: ResearchCoverageTargetResult[]
  target_coverage?: ResearchCoverageTargetCoverage
  verification_status?: 'verified' | 'critic_issues' | 'degraded'
  critic_issues?: unknown[]
  report_ref?: string
  report_digest?: string
  verified_draft_digest?: string
  evidence_manifest_digest?: string
}

/** 报告 Citation（canonical ID + 服务端不可变 snapshot，§7.5/§12.1） */
export interface ResearchCoverageCitation {
  canonical_citation_id: string
  snapshot: Record<string, unknown>
}

/** COV-08 GET /jobs/{id}/report 响应（仅 render_report 完成后可读） */
export interface ResearchCoverageReportResponse {
  job_id: string
  generation_id?: string
  status: string
  verification_status?: string
  report: { ref: string; markdown: string }
  citations: ResearchCoverageCitation[]
  report_digest?: string
  verified_draft_digest?: string
  evidence_manifest_digest?: string
  target_coverage?: ResearchCoverageTargetCoverage
  target_results?: ResearchCoverageTargetResult[]
  manifest?: { entries: ResearchCoverageManifestEntry[] }
  retry_of_generation_id?: string
}

export interface ResearchCompareCreateRequest {
  job_type: 'deep_compare' // 契约 §8.3 必填（RDLens JobCreateRequest）
  document_ids: string[]
  group_size?: number
  mode?: string
  /** Issue #243 §6.7：正式前端必填——顶层 confirmed 全局模型快照（不变量 2） */
  model_id: string
}

export interface ResearchCompareCreateResponse {
  job_id: string
  status: ResearchJobStatus
}

/**
 * #307：GET /jobs/{id}/report（deep_compare 分支）——报告正文 + citations。
 * 与 coverage 共用端点（后端按 job_type 分支），无 coverage 专属字段；
 * 仅 completed 且 result_ref 指向报告 Artifact 可读，否则 409
 * report_unavailable。
 */
export interface ResearchCompareReportResponse {
  job_id: string
  status: string
  report: { ref: string; markdown: string }
  citations: ResearchCoverageCitation[]
}


// ── 会话列表 / 创建 wire 形状（#602 第三批 PR-2；02 §3） ──

/** 列表查询 kind（`list_query`）：global/source/all，默认 global。 */
export type ResearchChatSessionListKind = 'global' | 'source' | 'all'

/**
 * `create_request` wire 形状：只有 `session_id`（客户端生成，幂等重试复用）。
 */
export interface ResearchChatSessionCreateRequest {
  session_id: string
}

/**
 * `create_response` 顶层键（6 键，严格 `additionalProperties:false`）。
 * 字段值保持 `unknown`：PR-2 由 `use-research-sessions.ts` 按
 * `session-contract` 的纯函数严格校验后才投影，不在此处放宽。
 */
export interface ResearchChatSessionCreateResponseWire {
  session_ref: unknown
  editor_revision: unknown
  editor_state: unknown
  state_warnings: unknown
  created: unknown
  editor_intent_hash: unknown
}

// ── 编辑器（#602 第三批 PR-3；DESIGN §5/§9.2，02 §4） ──
//
// 只放本 PR 公开 API 的最小类型；`editor_state` wire 契约的严格解析/投影由
// `session-contract.ts`（PR-1）负责，本段不重复 conversation 契约，PR-5a 可扩展。

/** 编辑器状态机阶段（DESIGN §5.8）。 */
export type EditorPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'conflict'
  | 'blocked'
  | 'readonly'
  | 'error'

/** 保存冲突类型（02 §7）：revision=乐观并发，mutation=同 mutation 语义冲突。 */
export interface EditorConflict {
  readonly kind: 'revision' | 'mutation'
}

/** 稳定失败投影（不渲染文案；hook/组件按 code 映射 i18n）。 */
export interface EditorSaveFailure {
  readonly code: string
  readonly retryable: boolean
}

/** 本机草稿恢复候选（同一会话的其他 writer 分支，DESIGN §3.5/§5.4）。 */
export interface EditorRestoreCandidate {
  readonly writerId: string
  readonly localVersion: number
  readonly baseRevision: number
  readonly savedAt: string
  readonly dirty: boolean
}

/** 暂停自动保存的持有者；release 只释放本 operationId（DESIGN §5.6）。 */
export interface EditorHold {
  readonly reason: 'submit' | 'conflict'
  readonly operationId: string
}

/** flush 触发原因；position 变化不得生成新 intent（DESIGN §5.2）。 */
export type EditorFlushReason = 'text' | 'position' | 'switch' | 'submit'

/** 文本/位置已写本机、flush 未派发（服务端仍滞后）的稳定结果（C6）。 */
export type SaveOutcome =
  | 'saved'
  | 'queued'
  | 'blocked'
  | 'conflict'
  | 'readonly'
  | 'unsynced'
  | 'skipped'
  | 'invalid'

/**
 * 清稿结果（C9）：
 * - `cleared`：空稿被服务端采用，shadow 仍为空且未被新输入覆盖；
 * - `superseded`：ACK 只推进 revision，**不**覆盖 T2 可见 shadow；
 * - `cancelled`：在首次派发前被新输入取消（未发任何请求）；
 * - `unsynced`：已派发但结果无法确认（不表示服务端请求未发生）。
 */
export type ClearOutcome = 'cleared' | 'superseded' | 'cancelled' | 'unsynced' | 'invalid'

/** 编辑范围语义（本地 UI 类型；wire 编码见 editor-machine.buildSaveRequestWire）。 */
export type ScopeEdit =
  | { readonly mode: 'all' }
  | { readonly mode: 'selected'; readonly sourceIds: readonly string[]; readonly noteIds?: readonly string[] }
  | { readonly mode: 'single'; readonly sourceId: string | null }
  | { readonly mode: 'note'; readonly noteIds: readonly string[] }

/** 编辑快照（EditorHandle.getSnapshot / useSyncExternalStore 稳定引用）。 */
export interface EditorSnapshot {
  readonly ref: ResearchSessionRef
  readonly phase: EditorPhase
  readonly loading: boolean
  /** 服务端已确认的 revision（仅 ACK 推进；本地绝不自增）。 */
  readonly revision: number
  readonly intentHash: string | null
  /** 当前可见 shadow（T2 可覆盖 T2 之前提交的文本；ACK 不覆盖它）。 */
  readonly draftText: string
  /** 当前草稿 token；文本变化生成新 token，ACK 后才采用。 */
  readonly draftToken: string
  /** 已被服务端接收（ACK）的文本 token；沿用即"复用已消费 token"。 */
  readonly consumedToken: string | null
  readonly baseScope: WireEditorBaseScope | null
  readonly singleSourceId: string | null
  readonly noteIds: readonly string[]
  readonly chatAnchor: WireChatAnchor | null
  readonly readerAnchor: WireReaderAnchor | null
  /** shadow 含未服务端确认内容。 */
  readonly dirty: boolean
  readonly saving: boolean
  readonly readOnly: boolean
  readonly blocked: boolean
  readonly unreadable: boolean
  readonly warnings: readonly string[]
  readonly conflict: EditorConflict | null
  readonly saveFailure: EditorSaveFailure | null
  /** 503/网络多次重试仍无法确认，服务端可能滞后（不自动覆盖本机）。 */
  readonly unsynced: boolean
  readonly localVersion: number
  readonly confirmedLocalVersion: number
  readonly writerId: string
  readonly lastSavedAt: string | null
  readonly pendingMutations: number
  readonly restoreCandidates: readonly EditorRestoreCandidate[]
  readonly holds: readonly EditorHold[]
  readonly transportAvailable: boolean
  /** 服务端报告 position_unavailable：关闭位置保存（不重试）。 */
  readonly positionUnavailable: boolean
  /** 认证代际/viewer 失效后已作废（不写服务端、不 flush）。 */
  readonly invalidated: boolean
  /** 本机文本超过 TEXT_MAX（保留全文，但禁用保存/提交，不截断）。 */
  readonly oversize: boolean
}

/** `editor_state` wire JSON（02 §4；请求体字段，snake_case 原样）。 */
export interface EditorBaseScopeWire {
  readonly mode: 'all' | 'selected'
  readonly source_ids: readonly string[]
  readonly single_source_id: null
}

export interface EditorChatAnchorWire {
  readonly message_id: string
  readonly offset_px: number
  readonly follow_tail: boolean
}

export interface EditorReaderAnchorWire {
  readonly source_id: string
  readonly document_id: string
  readonly document_version: string
  readonly format: 'normalized_markdown'
  readonly chunk_id: string | null
  readonly chunk_ordinal: number
  readonly content_hash: string
  readonly page_idx: number | null
  readonly offset_px: number
}

export interface EditorStateWire {
  readonly schema_version: 1
  readonly base_scope: EditorBaseScopeWire | null
  readonly single_source_id: string | null
  readonly note_ids: readonly string[]
  readonly draft: { readonly text: string; readonly token: string }
  readonly chat_anchor: EditorChatAnchorWire | null
  readonly reader_anchor: EditorReaderAnchorWire | null
}

/** `PUT .../editor-state` 请求体（02 §4 editor_save_request）。 */
export interface EditorSaveRequestWire {
  readonly expected_revision: number
  readonly mutation_id: string
  readonly editor_state: EditorStateWire
}

/**
 * 提交响应（submission accepted）中本 PR 需要的最小稳定字段（明确标注：
 * 这是本地接收凭据，不是完整 submission_response；不可据此回提交状态）。
 * `draftToken` 必须是本次提交使用的 token，用于"清稿不得跨提交清稿"保护。
 */
export interface AcceptedReceipt {
  readonly sessionRef: ResearchSessionRef
  readonly draftToken: string
  /** 提交时的可见文本快照；清稿前必须与当前 shadow 二次核对（DESIGN §5.6/§9.2）。 */
  readonly text: string
  readonly editorRevision?: number
  readonly idempotencyKey?: string | null
}

// ── 草稿范围条与 composer（#602 第三批 PR-4；DESIGN §3.3/§6.1/§5.8，§9.2） ──
//
// 本段只放 PR-4 组件接线所需的最小类型。`conversation` 的完整契约由 PR-5a
// （conversation-machine）扩展；本 PR 仅消费最小只读投影用于发送门禁。

/** 当前会话对话阶段（PR-4 只读投影；PR-5a 扩展为完整状态机）。 */
export type ResearchConversationPhase =
  | 'idle'
  | 'streaming'
  | 'awaiting'
  | 'busy'
  | 'unknown'

/** 当前会话的最小只读对话投影（PR-4 仅用于发送门禁与清稿前提示）。 */
export interface ResearchConversationSnapshot {
  readonly activeTurnId: string | null
  readonly phase: ResearchConversationPhase
  readonly isStreaming: boolean
  /** 服务端 busy / 本地提交准备等不可派发状态。 */
  readonly isBusy: boolean
}

/**
 * 发送门禁稳定原因（DESIGN §6.1 七条前置条件）。
 *
 * 只作为文案映射键，不在本模块渲染；组件必须把非空原因展示在输入区，
 * 不能只靠按钮 `disabled`。
 */
export type ResearchDraftGateReason =
  | 'runtime_unavailable'
  | 'editor_not_ready'
  | 'editor_unreadable'
  | 'submission_not_ready'
  | 'save_failed'
  | 'saving'
  | 'conflict'
  | 'blocked'
  | 'readonly'
  | 'invalidated'
  | 'oversize'
  | 'empty_draft'
  | 'invalid_text'
  | 'scope_invalid'
  | 'turn_active'
  /**
   * Issue #1013（D1-E-2）§2.11：composer 持有选段 chip 但选段能力已不可用
   * （capability 翻转/失效）。capability off 时不显示选段 UI，因此该原因只在
   * 能力翻转的边界出现；不改变其它既有 gate 顺序。
   */
  | 'selection_unavailable'

/** 发送门禁结果；`allowed=false` 时 `reason` 必须非空并可映射文案。 */
export interface ResearchDraftGate {
  readonly allowed: boolean
  readonly reason: ResearchDraftGateReason | null
}

/** 草稿保存状态投影（DESIGN §5.8 用户可见状态）。 */
export type ResearchDraftSaveState =
  | 'clean'
  | 'dirty'
  | 'saving'
  | 'conflict'
  | 'blocked'
  | 'readonly'
  | 'unavailable'

/** 会话范围条的可选来源项（工作区资料查询投影；不复制查询逻辑）。 */
export interface ResearchScopeBarSourceOption {
  readonly sourceId: string
  readonly title: string
  /** 资源已失效/不在当前授权列表（DESIGN §7.2：保留选择并标注）。 */
  readonly unavailable?: boolean
}

/** 会话范围条的可选 Note 项。 */
export interface ResearchScopeBarNoteOption {
  readonly noteId: string
  readonly title: string
}

/**
 * `accepted_receipt` wire 形状（#602 第一批冻结契约 `$defs/accepted_receipt`，
 * 第三批 PR-5a）。`request_id`/`editor_revision` 只记录、不参与受理等值匹配
 * （DESIGN §6.3 R7）；`session_ref` 为 snake_case wire 形状，由 sse.ts 经
 * `session-contract.parseSessionRef` 校验后投影。
 */
export interface ResearchAcceptedReceiptWire {
  session_ref: {
    domain: string
    kind: 'global' | 'source'
    project_id: string
    session_id: string
    source_id: string | null
  }
  generation_id: string
  request_id: string
  editor_revision: number
  draft_token: string
  editor_intent_hash: string
}

/**
 * `context_report` wire 形状（第一批 v1；第三批 §6.9/§9.5）。投影与渲染分别归
 * `session-contract.parse*` 与 PR-5b；本文件只声明 wire 字段，便于 SSE 解析。
 */
export interface ResearchContextReportWire {
  version: 1
  status: 'complete' | 'trimmed' | 'blocked' | 'unknown'
  history: {
    available_turns: number | null
    included_turns: number | null
    omitted_turns: number | null
  }
  evidence: {
    included_chunks: number | null
    omitted_chunks: number | null
  }
  input_budget: number | null
  serialized_input_tokens: number | null
  estimator_version: string | null
  reason_codes: string[]
  required_context_missing: boolean
  measurement_scope: 'final_reasoning_call' | 'unknown'
}

// ── 搜索记录回访 wire（Issue #1014；D1-F 主单 §2.4/§2.6） ──
//
// 列表保持 `d1f-search-record-list-v1`；详情按 outcome 分支：completed 返回
// `d1f-search-record-v2`（v1 键 + result_available/hits/citations），
// no_hit 返回 v1 + 可选 `model`，no_generation/failed 返回 v1 原样。
// 消费者必须按 schema_version 与可选键分支并容错未知枚举（计划 §2.6）。
// 解析器（`./search-records.ts`）负责把 wire 未知/缺失/畸形形状归一化，
// 本文件只声明归一化后的形状；不伪造任何片段、claim 或模型。

/** 记录终态（未知值原样保留，UI 按「其他终态」展示，不崩溃）。 */
export type ResearchSearchRecordOutcome =
  | 'completed'
  | 'no_hit'
  | 'no_generation'
  | 'failed'
  | (string & {})

/** 列表 item（`d1f-search-record-list-v1`；不含来源身份/片段/conclusion）。 */
export interface ResearchSearchRecordListItem {
  schema_version: string
  record_id: string
  generation_id: string
  created_at: string | null
  completed_at: string | null
  query: string
  /** 已知值见 `ResearchSearchRecordOutcome`；未知值原样保留。 */
  outcome: string | null
  outcome_detail: string | null
  generation_state: string | null
  requested_mode: string | null
  resolved_mode: string | null
  context_level: string | null
  hit_count: number
  scope_mode: string | null
  source_total: number
  failure_code: string | null
  degradation_codes: string[]
}

/** 列表页（服务端 keyset cursor）。 */
export interface ResearchSearchRecordPage {
  schema_version: string
  items: ResearchSearchRecordListItem[]
  next_cursor: string | null
}

/** 记录内冻结的来源引用（精确版本身份）。 */
export interface ResearchSearchRecordScopeRef {
  document_id: string
  document_version: string
}

/** 记录内冻结的当时资料范围（`d1f-search-scope-v1`）。 */
export interface ResearchSearchRecordScope {
  schema_version: string
  contract_version: string | null
  resolution: string
  mode: string | null
  requested_source_ids: string[]
  note_ids: string[]
  resolved_source_refs: ResearchSearchRecordScopeRef[]
  missing_source_ids: string[]
  includes_exact_versions: boolean
  contains_document_body: boolean
  single_source_id: string | null
  warnings: string[]
  source_total: number
}

/** 详情「允许来源」条目（按现行权限过滤后的投影）。 */
export interface ResearchSearchRecordScopeSource {
  document_id: string
  document_version: string
  source_id: string | null
  status: string | null
  warning: string | null
}

/** 详情来源计数（受限时 visible=0/restricted=total）。 */
export interface ResearchSearchRecordSourceCounts {
  total: number
  visible: number
  restricted: number
}

/** 实际命中条目（片段仅当现行权限通过且 artifact 可读时出现）。 */
export interface ResearchSearchRecordHit {
  document_id: string
  document_version: string
  chunk_id: string
  page_idx: number | null
  source_id: string | null
  /** null = 片段不可用；UI 显示「片段不可用」，绝不伪造文本。 */
  snippet: string | null
  /** `source_unavailable` / `snippet_unavailable` / 未知值原样保留。 */
  warning: string | null
}

/** 最终引用条目。 */
export interface ResearchSearchRecordCitation {
  citation_id: number | null
  chunk_id: string
  document_id: string
  document_version: string
  page_idx: number | null
  source_id: string | null
  /** null = claim 不可用；不渲染伪造 claim。 */
  claim: string | null
  snippet: string | null
  warning: string | null
}

/** 实际命中集合（total 为 dispatch-time 精确总数）。 */
export interface ResearchSearchRecordHits {
  total: number
  truncated: boolean
  items: ResearchSearchRecordHit[]
}

/** 最终引用集合（total 为 dispatch-time 精确总数）。 */
export interface ResearchSearchRecordCitations {
  total: number
  truncated: boolean
  items: ResearchSearchRecordCitation[]
}

/** 实际模型（仅 completed/no_hit 有记录；成员可 null）。 */
export interface ResearchSearchRecordModel {
  model_id: string | null
  provider_id: string | null
}

/** C-17 canonical 降级原因（只消费记录已存字段，不新增降级码）。 */
export interface ResearchSearchRecordDegradation {
  code: string
  scope: string | null
  severity: string | null
  affects_answer: boolean | null
  retryable: boolean | null
  origin: string | null
}

/** failed 的安全失败信息。 */
export interface ResearchSearchRecordFailure {
  code: string
  detail_safe: string | null
}

/** 详情 conclusion（受限时 text=null）。 */
export interface ResearchSearchRecordConclusion {
  text: string | null
  truncated: boolean
}

/** 详情 coverage 有界摘要（缺失键不出现）。 */
export type ResearchSearchRecordCoverage = Record<string, string | number | boolean | null>

/**
 * 搜索记录详情（归一化后）。
 *
 * v2 三键仅在 completed 出现；parser 用 `null` 表示「wire 未携带该键」，
 * 从而让 UI 对 v1 行**不渲染** v2 分区（计划 §2.8「v1 行不渲染 v2 分区」）。
 */
export interface ResearchSearchRecordDetail {
  schema_version: string
  record_id: string
  generation_id: string
  created_at: string | null
  completed_at: string | null
  query: string
  outcome: string | null
  outcome_detail: string | null
  generation_state: string | null
  requested_mode: string | null
  resolved_mode: string | null
  context_level: string | null
  hit_count: number
  scope: ResearchSearchRecordScope | null
  source_counts: ResearchSearchRecordSourceCounts
  sources: ResearchSearchRecordScopeSource[]
  conclusion: ResearchSearchRecordConclusion
  degradations: ResearchSearchRecordDegradation[]
  degradation_schema_version: string | null
  failure: ResearchSearchRecordFailure | null
  coverage: ResearchSearchRecordCoverage | null
  /** 非 `visible` 一律按受限处理（fail-closed，不泄露来源身份）。 */
  record_visibility: 'visible' | 'restricted'
  warnings: string[]
  /** v2：artifact 可读且 response 可解析；null = wire 未携带（v1 行）。 */
  result_available: boolean | null
  /** v2：实际命中；null = wire 未携带（v1 行）。 */
  hits: ResearchSearchRecordHits | null
  /** v2：最终引用；null = wire 未携带（v1 行）。 */
  citations: ResearchSearchRecordCitations | null
  /** v1/v2 共用可选键：null = 记录无模型（键不存在）。 */
  model: ResearchSearchRecordModel | null
}

/** 搜索历史读取错误分类（UI 文案与重试策略见 `search-records.ts`）。 */
export type ResearchSearchRecordErrorKind =
  | 'not_enabled'
  | 'forbidden'
  | 'not_found'
  | 'store_unavailable'
  | 'unknown'
