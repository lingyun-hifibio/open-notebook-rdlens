/**
 * Issue #1046 PR4（D2-B2：Markdown 编辑与恢复）内部类型契约。
 *
 * 先由 Lead 冻结提交，作为 frontend-core（实现）与 frontend-ui（消费）的接口；
 * 之后由 frontend-core 拥有（允许加性扩展），frontend-ui 只读消费。破坏性改动
 * 必须先同步 Lead 与对方 owner。
 *
 * 权威依据（只收窄、不放宽）：
 * - issue #1046 PR4 行；
 * - 方案 v4 §4.1—4.4（编辑状态机/独立草稿缓存/离开保护）、§8.2（能力与回退）；
 * - `deploy/research/issue585_d2_contract_v1.yaml`（d2-v1 回执/错误码/能力投影键）。
 */

import type { ResearchNote } from '@/lib/types/research'

/** d2-v1 契约头（新 Note 读写；旧 v1 头请求/响应形状不变）。 */
export const NOTE_CONTRACT_HEADER = 'X-Research-Note-Contract'
export const NOTE_CONTRACT_VALUE = 'd2-v1'

/** 草稿缓存命名空间（契约 §4.2；独立于 #602 会话缓存）。 */
export const NOTE_DRAFT_STORAGE_NAMESPACE = 'rdlens.research.note.v1'

/** d2-v1 Note 读取投影：旧字段 + 保护字段（§3.1）。 */
export interface ResearchNoteD2 extends ResearchNote {
  revision: number | null
  snapshot_hash: string | null
  edit_schema: string | null
  access_state?: 'visible' | 'restricted' | null
}

/** 变更回执（契约 §4；删除的 snapshot_hash 为 null）。 */
export interface NoteReceipt {
  note_id: string
  mutation_id: string
  applied_revision: number
  snapshot_hash: string | null
  saved_at: string
  replayed: boolean
}

/** 契约 §8 稳定错误码 + 传输层兜底码。 */
export type NoteErrorCode =
  | 'note_not_found'
  | 'note_access_restricted'
  | 'note_edit_schema_unsupported'
  | 'note_revision_required'
  | 'note_revision_conflict'
  | 'note_revision_exhausted'
  | 'note_snapshot_fence_exhausted'
  | 'mutation_id_reused'
  | 'note_request_invalid'
  | 'note_snapshot_unavailable'
  | 'note_dependency_unavailable'
  | 'note_store_unavailable'
  | 'network_error'
  | 'unknown_error'

/** 归一化后的 API 错误（不携带正文/堆栈；409 可带已授权当前 revision/hash）。 */
export interface NoteApiError {
  code: NoteErrorCode
  message: string
  retryable: boolean
  requestId?: string
  status: number
  currentRevision?: number | null
  currentSnapshotHash?: string | null
}

/** 能力位（§8.2；reason 为机器可读阻断原因，文案由 UI 映射）。 */
export interface NoteCapability {
  available: boolean
  reason: string | null
}

export interface NoteCapabilities {
  noteEditor: NoteCapability
  noteEditorExisting: NoteCapability
  markdownExport: NoteCapability
  writingLocal: NoteCapability
  writingExternal: NoteCapability
}

/** 保存状态（方案 §4.1 的七类显式状态 + idle/blocked）。 */
export type NoteSaveStatus =
  | 'idle'
  | 'saved'
  | 'pending'
  | 'saving'
  | 'failed'
  | 'unknown'
  | 'conflict'
  | 'restricted'
  | 'blocked'

/** 冲突快照：来自 409 `note_revision_conflict` 的 current_revision/hash。 */
export interface NoteEditorConflict {
  currentRevision: number | null
  currentSnapshotHash: string | null
}

/** 离开阻断原因（离开保护对话框的稳定机器码）。 */
export type NoteLeaveBlockReason =
  | 'unsaved'
  | 'saving'
  | 'unknown'
  | 'conflict'
  | 'failed'
  | 'restricted'
  | 'composing'

/** 用户视角的编辑器状态（UI 只读渲染；不暴露内部 seq 细节）。 */
export interface NoteEditorState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  note: ResearchNoteD2 | null
  title: string
  content: string
  saveStatus: NoteSaveStatus
  conflict: NoteEditorConflict | null
  /** 未决 mutation（未知结果时保留；确认前禁止新写入/静默导航）。 */
  pendingMutationId: string | null
  /** 草稿缓存可用性：ok / 内存降级（quota、SecurityError）/ 不可用。 */
  cacheStatus: 'ok' | 'memory_only' | 'unavailable'
  /** 本次打开是否来自本地草稿恢复。 */
  restoredFromCache: boolean
  canUndo: boolean
  /** 能力/权限/删除等阻断的稳定机器码（UI 映射文案）。 */
  blockReason: string | null
  error: NoteApiError | null
  /** 身份/项目切换计数；变化后 UI 必须丢弃旧回调与旧视图状态。 */
  authGeneration: number
  /** 应用内离开被阻断时的原因（closeEditor/flushBeforeLeave 结果也用它）。 */
  leaveBlockReason: NoteLeaveBlockReason | null
}

/**
 * 编辑器动作（方案 §4 的行为集合）。所有网络动作都不抛异常：失败体现在
 * state.saveStatus/error 上；返回 Promise 的动作在完成后已更新 state。
 */
export interface NoteEditorActions {
  /** 打开/恢复文档：先验证当前权限，再按缓存规则恢复本地草稿。 */
  openNote: (noteId: string) => Promise<void>
  /** 新建空白文档；成功返回 note_id（能力关闭/失败返回 null）。 */
  createBlankNote: () => Promise<string | null>
  /** 关闭编辑器；true=已关闭，false=被离开保护阻断（state.leaveBlockReason）。 */
  closeEditor: () => Promise<boolean>
  setTitle: (value: string) => void
  setContent: (value: string) => void
  /** IME composition 开始/结束（期间不提交服务端保存）。 */
  beginComposition: () => void
  endComposition: () => void
  /** 立即 flush 保存（成功后 saveStatus=saved；失败/冲突/未知见 state）。 */
  saveNow: () => Promise<void>
  /** 重试上一次失败的保存（同文档保留 mutation 语义）。 */
  retrySave: () => Promise<void>
  /** 未知结果先确认原 mutation（完全相同 mutation_id + 请求重放）。 */
  confirmPendingMutation: () => Promise<void>
  /** 本地文本撤销（恢复正文 → 以当前 revision 走同一自动保存）。 */
  undo: () => void
  /** 复制本地正文（不改服务端）。 */
  copyLocalContent: () => Promise<void>
  /** 下载本地 Markdown（用户取回入口；不冒充已保存版本导出）。 */
  downloadLocalMarkdown: () => void
  /** 受保护另存（copies API）；成功返回新 note_id。 */
  saveAsCopy: () => Promise<string | null>
  /** 加载最新版（调用方已确认放弃本地编辑）；仍冲突时 state.conflict 保留。 */
  loadLatest: () => Promise<void>
  /** 放弃本地编辑并清理本档草稿缓存（不删除服务端内容）。 */
  discardLocal: () => void
  /** 应用内导航前置检查：flush 完成返回 null；被阻断返回原因。 */
  flushBeforeLeave: () => Promise<NoteLeaveBlockReason | null>
}

export interface UseNoteEditorResult {
  state: NoteEditorState
  actions: NoteEditorActions
}

/** 单文档编辑器 hook 签名（实现见 `./use-note-editor.ts`）。
 *
 * 能力关闭（note_editor=false）只影响新建/首次启用入口；已有 d2-v1 文档按
 * note_editor_existing + 当前权限仍可打开并安全保存（§8.2 R31）。能力/权限故障
 * 时不得退回无 revision 的旧表单。
 */
export type UseNoteEditorHook = (options: {
  projectId: string
  capabilities: NoteCapabilities | null
  isAdminReadonly: boolean
}) => UseNoteEditorResult

/** 成果目录结果（冻结签名；实现见 `./use-note-catalog.ts`）。 */
export interface UseNoteCatalogResult {
  items: ResearchNoteD2[]
  isLoading: boolean
  error: NoteApiError | null
  refresh: () => Promise<void>
}

/** 成果目录（d2-v1 列表 + 词法搜索）hook 签名（实现见 `./use-note-catalog.ts`）；
 * 搜索词由调用方状态驱动。 */
export type UseNoteCatalogHook = (options: {
  projectId: string
  search: string
}) => UseNoteCatalogResult

/** 服务端能力投影读取结果（冻结签名；实现见 `./use-note-capabilities.ts`）。 */
export interface NoteCapabilitiesResult {
  capabilities: NoteCapabilities | null
  isLoading: boolean
  error: NoteApiError | null
  refresh: () => Promise<void>
}

/** 服务端能力投影读取 hook 签名（实现见 `./use-note-capabilities.ts`；§8.2：
 * 失败即 null，UI fail-closed，不得按环境变量推断）。 */
export type UseNoteCapabilitiesHook = (projectId: string) => NoteCapabilitiesResult

/** 持久化草稿记录（只含编辑所需字段；无令牌/对话/写作候选）。 */
export interface NoteDraftCacheRecord {
  v: 1
  ownerId: string
  projectId: string
  noteId: string
  title: string
  content: string
  baseRevision: number
  baseSnapshotHash: string
  localSeq: number
  pendingMutation: PendingNoteMutation | null
  savedAt: string
}

/** 未决 mutation 快照（未知结果时用于同请求确认；不含令牌）。 */
export interface PendingNoteMutation {
  mutationId: string
  kind: 'save' | 'create' | 'copy'
  noteId: string | null
  expectedRevision: number | null
  title: string
  content: string
  createdAt: string
  /**
   * 加性（PR4 frontend-core）：`copy` 未知结果重放所需的源草稿基线
   * `source_snapshot_hash`（契约 §4 request_keys）；save/create 省略。
   * 缺少该键的旧缓存记录仍按合法记录读取（仅 copy 重放要求存在）。
   */
  sourceSnapshotHash?: string | null
}
