/**
 * Issue #1048 PR7（D2-B4）：本地写作（writing）前端契约类型。
 *
 * 权威依据：
 * - 方案 v4 §6.1（请求与调用路径、当前/新对话、composer 身份桥接）、
 *   §6.3（v4 冻结输入读投影）、§6.4（引用校验与 writing_checks）、
 *   §6.5（依赖传播）、§8.2（能力与回退）；
 * - 主仓机器契约 `deploy/research/issue585_d2_contract_v1.yaml`
 *   `writing_input_v4` / `capabilities` / `errors` 节；
 * - 主仓实现 `src/rdlens/research/issue585/writing_contract.py`（意图编码、
 *   请求闭合 11 键、读投影形状）。
 *
 * 本文件只放 wire / 前端内部类型，不含 React 与网络副作用；传输适配在
 * `writing-client.ts`，缓存字段在 `writing-cache.ts`。
 */

import type { ResearchSessionKind, ResearchSessionRef } from '@/lib/research/session-contract'

// ── 版本与命名空间（契约冻结值，不得按语言习惯改名） ──

/** 写作请求 schema_version（请求 11 键之二；与 input v4 区分）。 */
export const WRITING_REQUEST_SCHEMA_VERSION = 1 as const

/** 写作意图摘要命名空间（owner 2026-11-05 批准的 v4 命名空间）。 */
export const WRITING_INTENT_NAMESPACE = 'research-writing-v4/intent' as const

/** 工作性质：写作入口恒为显式 `writing`（不接受 default_legacy/推断）。 */
export const WRITING_WORK_PURPOSE = 'writing' as const

/** history_mode 枚举；默认 none（未采用会话历史）。 */
export type WritingHistoryMode = 'none' | 'current'

/** 选区：全文或 UTF-16 半开区间 `[start, end)`。 */
export type WritingSelection =
  | { readonly kind: 'full' }
  | { readonly kind: 'range'; readonly start_utf16: number; readonly end_utf16: number }

/** 请求级 document_context（`{note_id, revision, snapshot_hash, selection}`）。 */
export interface WritingDocumentContext {
  readonly note_id: string
  readonly revision: number
  readonly snapshot_hash: string
  readonly selection: WritingSelection
}

/**
 * `POST .../chat/sessions/{session_id}/writing`（及 source 变体）请求体：
 * 闭合 11 键（契约 `writing_input_v4.request.keys`）。
 */
export interface WritingSubmissionRequest {
  readonly schema_version: typeof WRITING_REQUEST_SCHEMA_VERSION
  readonly editor_revision: number
  readonly draft_token: string
  readonly editor_intent_hash: string
  readonly writing_intent_hash: string
  readonly query: string
  readonly model: string
  readonly response_language: string | null
  readonly work_purpose: typeof WRITING_WORK_PURPOSE
  readonly document_context: WritingDocumentContext
  readonly history_mode: WritingHistoryMode
}

/** 写作意图 15 键（服务端重算并核对；命名空间固定）。 */
export interface WritingIntentFields {
  readonly schema_version: 1
  readonly project_id: string
  readonly owner_user_id: number
  readonly session_kind: ResearchSessionKind
  readonly source_id: string | null
  readonly session_id: string
  readonly editor_revision: number
  readonly editor_intent_hash: string
  readonly draft_token: string
  readonly query: string
  readonly model_id: string
  readonly response_language: string | null
  readonly work_purpose: typeof WRITING_WORK_PURPOSE
  readonly document_context: WritingDocumentContext
  readonly history_mode: WritingHistoryMode
}

// ── GET /writing-contexts/{generation_id} 读投影（契约 read_projection） ──

/** 实际输入回看的访问状态；受限时正文为 null（只显示受限状态）。 */
export type WritingAccessState = 'visible' | 'restricted'

/** 历史未采用原因（契约 §6.5 稳定码）。 */
export type WritingHistoryExcludedReason =
  | 'history_scope_excluded'
  | 'history_budget_excluded'
  | 'history_authority_excluded'

export interface WritingContextAdoptedTurn {
  readonly message_id: string
  readonly role: 'user' | 'assistant'
  /** 受限时为 null（不返回冻结正文）。 */
  readonly text: string | null
  readonly text_hash: string
}

export interface WritingContextExcludedTurn {
  readonly message_id: string
  readonly reason: WritingHistoryExcludedReason
}

export interface WritingContextDocumentContext {
  readonly note_id: string
  readonly revision: number
  readonly snapshot_hash: string
  readonly selection_kind: 'full' | 'range'
  readonly start_utf16: number | null
  readonly end_utf16: number | null
  /** 受限时为 null。 */
  readonly selected_text: string | null
  readonly selected_text_hash: string
}

export interface WritingContextIntegrity {
  readonly document_context_hash: string
  readonly history_hash: string
  readonly envelope_hash: string
}

export interface WritingContextCapacity {
  readonly input_utf8_bytes: number
  readonly envelope_utf8_bytes: number
  readonly limit_utf8_bytes: number
}

/**
 * 独立派生的缺失引用提示槽位（§6.4）。
 *
 * **不**是新的校验事实源、建议状态或旧 message DTO 扩展：只用于「部分输入
 * 引用未在建议中沿用」的可见提示，不可冒充完整执行或语义通过。
 */
export interface WritingChecks {
  readonly version: 1
  readonly missing_binding_ids: readonly string[]
  readonly unavailable_reason: string | null
}

/** 实际输入回看读投影（契约 read_projection 10 键，闭合校验见 writing-client）。 */
export interface WritingContextProjection {
  readonly generation_id: string
  readonly input_id: string
  readonly input_schema_version: number
  readonly input_hash: string
  readonly document_context: WritingContextDocumentContext
  readonly history: {
    readonly mode: WritingHistoryMode
    readonly adopted: readonly WritingContextAdoptedTurn[]
    readonly excluded: readonly WritingContextExcludedTurn[]
  }
  readonly integrity: WritingContextIntegrity
  readonly capacity: WritingContextCapacity
  readonly writing_checks: WritingChecks | null
  readonly access_state: WritingAccessState
}

// ── 错误码（契约 §8 稳定码 + 传输层兜底码） ──

export type WritingErrorCode =
  | 'writing_not_available'
  | 'writing_context_changed'
  | 'writing_input_unavailable'
  | 'context_limit_exceeded'
  | 'submission_intent_conflict'
  | 'session_contract_unsupported'
  | 'session_busy'
  | 'invalid_request'
  | 'conflict'
  | 'access_denied'
  | 'session_not_found'
  | 'chat_owner_required'
  | 'generation_failed'
  | 'invalid_response'
  | 'network_error'
  | 'unknown_error'

/** 归一化的写作 API 错误（不含正文/堆栈；detail.message 不直接展示）。 */
export interface WritingApiError {
  readonly code: WritingErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly status: number
  readonly requestId?: string
}

// ── 会话选择（方案 §6.1.1） ──

/** 当前会话选择：显式绑定一个已存在的会话身份。 */
export interface WritingCurrentSessionChoice {
  readonly kind: 'current'
  readonly ref: ResearchSessionRef
}

/** 新会话选择：默认全局；来源会话入口新建保持 source 绑定。 */
export interface WritingNewSessionChoice {
  readonly kind: 'new'
  readonly sessionKind: ResearchSessionKind
  readonly sourceId: string | null
}

export type WritingSessionChoice = WritingCurrentSessionChoice | WritingNewSessionChoice

/** 会话创建结果（客户端预生成 session_id；同 id 重试，禁止重复创建）。 */
export type WritingSessionCreateResult =
  | { readonly ok: true; readonly ref: ResearchSessionRef; readonly created: boolean }
  | { readonly ok: false; readonly error: WritingApiError }

/**
 * 恢复未发送选择前的 Note 权限/版本重查结果（方案 §6.1.2）。
 *
 * `restricted`：当前权限受限（清理缓存、只显示受限说明）；`not_found`：
 * 文档已不存在；`unavailable`：服务端暂时无法判定权限/版本（不恢复正文/
 * 选择，保留缓存并允许稍后重试）；`ok` 时返回服务端当前 revision/hash。
 */
export type WritingNoteVerification =
  | {
      readonly ok: true
      readonly revision: number
      readonly snapshotHash: string
    }
  | {
      readonly ok: false
      readonly reason: 'restricted' | 'not_found' | 'unavailable'
    }

// ── 提交/结果状态（UI 显式状态；不伪造成功） ──

export type WritingSubmitStage =
  | 'idle'
  | 'preparing_session'
  | 'preparing_composer'
  | 'submitting'
  | 'streaming'
  | 'fetching_context'
  | 'done'
  | 'cancelled'
  | 'error'

export interface WritingSubmissionView {
  readonly stage: WritingSubmitStage
  /** 已获得的 generation_id（202 回执或 accepted 事件；之后严格等值）。 */
  readonly generationId: string | null
  /** 已发布的候选正文（校验完成后的内容事件累积；校验前不发布）。 */
  readonly answer: string
  /** SSE thinking 累积（可空；服务端在校验前不会发送候选正文）。 */
  readonly thinking: string
  readonly terminal: 'done' | 'error' | null
  readonly terminalErrorCode: string | null
  readonly context: WritingContextProjection | null
  readonly contextError: WritingApiError | null
  readonly error: WritingApiError | null
  /** 本地已断开读取（服务端可能仍在执行；不冒充取消）。 */
  readonly detached: boolean
}

/** 静止态（对话框打开时展示既有缓存/上一次结果）。 */
export const IDLE_WRITING_SUBMISSION: WritingSubmissionView = {
  stage: 'idle',
  generationId: null,
  answer: '',
  thinking: '',
  terminal: null,
  terminalErrorCode: null,
  context: null,
  contextError: null,
  error: null,
  detached: false,
}

// ── 容量说明（§6.3；超限 422 不静默截断/改选全文） ──

/** 完整信封 UTF-8 上限（1 MiB）。 */
export const WRITING_ENVELOPE_MAX_UTF8_BYTES = 1024 * 1024

/** query UTF-8 上限（128 KiB）。 */
export const WRITING_QUERY_MAX_UTF8_BYTES = 128 * 1024

/** 单条历史文字上限（128 KiB，沿用 #602）。 */
export const WRITING_HISTORY_TURN_MAX_UTF8_BYTES = 128 * 1024

/** 冻结历史轮次上限（沿用 #602）。 */
export const WRITING_HISTORY_MAX_TURNS = 64

/** 字符/字节容量摘要（对话框的输入选择确认与容量说明）。 */
export interface WritingCapacitySummary {
  readonly selectedTextChars: number
  readonly selectedTextBytes: number
  readonly queryChars: number
  readonly queryBytes: number
  readonly envelopeLimitBytes: number
  readonly queryLimitBytes: number
  /** 任一份实测值已超上限（发送前即提示；服务端仍权威）。 */
  readonly overLimit: boolean
  readonly overLimitParts: readonly ('document_context' | 'query')[]
}
