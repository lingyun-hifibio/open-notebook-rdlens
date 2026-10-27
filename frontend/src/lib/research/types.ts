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
  /** #602 第三批 PR-5a：受理回执（usage 事件扩展字段；形状非法整组丢弃） */
  accepted?: ResearchAcceptedReceiptWire
  /** #602 第三批 PR-5a：容量解释（形状非法整组丢弃；投影归 PR-5b） */
  context_report?: ResearchContextReportWire
  /** #602 第三批 PR-5a：上下文覆盖（形状非法整组丢弃） */
  context_coverage?: ResearchContextCoverage
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
