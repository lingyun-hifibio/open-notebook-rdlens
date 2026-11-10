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
  /**
   * Issue #1047 PR5（B3）加性读投影（仅详情 + d2-v1 头；受限时不出现）。
   *
   * 可选：旧 host / 受限占位 / 既有测试替身可能没有这些键，消费方必须
   * fail-safe 成空数组，绝不据此伪造引用或来源。
   */
  citation_bindings?: NoteCitationBinding[]
  origins?: NoteOrigin[]
  document_dependencies?: NoteDocumentDependency[]
}

// ---------------------------------------------------------------------------
// Issue #1047 PR5（D2-B3）：片段入文档与引用往返
// ---------------------------------------------------------------------------

/** 统一来源描述的四类来源（方案 §5）。 */
export type NoteCitationSourceKind = 'source' | 'chat_message' | 'note' | 'legacy_insight'

/** locator 标量袋（冻结契约：值为 JSON 标量；键语义由 B3 约定）。 */
export type NoteLocatorScalar = string | number | boolean | null
export type NoteLocator = Record<string, NoteLocatorScalar>

/** 可见引用绑定（冻结 6 键；`binding_id` 在文档内稳定，不因插入重排）。 */
export interface NoteCitationBinding {
  binding_id: string
  source_kind: NoteCitationSourceKind
  source_id: string
  source_version: string | null
  locator: NoteLocator | null
  /** 锚点失效：保留来源关系、禁止伪造新位置（契约 `unresolved`）。 */
  unresolved: boolean
}

/** 出处（冻结 5 键）。 */
export interface NoteOrigin {
  origin_id: string
  source_kind: NoteCitationSourceKind
  source_id: string
  source_version: string | null
  locator: NoteLocator | null
}

/** 授权依赖（两种互斥形状，沿用既有 `content_dependencies` 表示）。 */
export type NoteDocumentDependency =
  | { note_id: string; note_content_hash: string }
  | { document_id: string; document_version: string }

/** 片段来源选区：整段或 UTF-16 半开区间（`[start, end)`）。 */
export type NoteFragmentSelection =
  | { kind: 'full' }
  | { kind: 'range'; start_utf16: number; end_utf16: number }

/** 片段目标：光标插入或选区替换（UTF-16 半开区间）。 */
export type NoteFragmentTargetDescriptor =
  | { kind: 'cursor'; position_utf16: number }
  | { kind: 'range'; start_utf16: number; end_utf16: number }

/** 片段来源描述（wire；不提交可信全文）。 */
export interface NoteFragmentSourceDescriptor {
  source_kind: NoteCitationSourceKind
  source_id: string
  source_version: string | null
  expected_content_hash: string | null
  selection: NoteFragmentSelection
}

/** `POST /notes/{note_id}/fragments` 请求体（冻结形状）。 */
export interface NoteD2FragmentInsertRequest {
  mutation_id: string
  expected_revision: number
  target: NoteFragmentTargetDescriptor
  source: NoteFragmentSourceDescriptor
}

/** `POST /notes` 的 fragment 变体（新目标；不同时提供 content）。 */
export interface NoteD2FragmentCreateRequest {
  mutation_id: string
  title: string
  fragment: { source: NoteFragmentSourceDescriptor }
}

/** 机器动作入参：目标由调用方按当前编辑器选区计算。 */
export interface NoteInsertFragmentInput {
  target: NoteFragmentTargetDescriptor
  source: NoteFragmentSourceDescriptor
}

/** 机器动作结果（不抛异常；未知结果保留 pending mutation 供同 ID 重放）。 */
export type NoteInsertFragmentResult =
  | {
      ok: true
      noteId: string
      appliedRevision: number
      snapshotHash: string | null
      insertedRange: { start: number; end: number }
      replayed: boolean
    }
  | {
      ok: false
      code: NoteErrorCode
      retryable: boolean
      /** 服务端可能已应用：保留同一 mutation_id，先确认再继续编辑。 */
      pendingMutationId?: string
    }

/** 引用阅读器请求（点击正文引用后进入的独立阅读上下文）。 */
export interface NoteCitationReaderRequest {
  binding: NoteCitationBinding
  /** 点击时所在文档 identity（返回时只按此匹配恢复光标）。 */
  noteId: string
  localSeq: number
  baseRevision: number | null
  selection: EditorTextSelectionSnapshot | null
  scrollTop: number | null
}

/** 编辑器 textarea 的 UTF-16 选区/光标（返回时恢复的目标）。 */
export interface EditorTextSelectionSnapshot {
  start: number
  end: number
}

/** 编辑器位置恢复请求（返回引用核查时调用；localSeq 不匹配则保留当前光标）。 */
export interface NoteEditorPositionRestoreRequest {
  noteId: string
  expectedLocalSeq: number
  selection: EditorTextSelectionSnapshot | null
  scrollTop: number | null
}

/** 恢复位置请求在界面上的渲染指令（递增 seq 触发 textarea 定位/滚动）。 */
export interface NoteEditorSelectionRequest {
  /** null = 只恢复滚动位置，不改动当前光标。 */
  selection: EditorTextSelectionSnapshot | null
  scrollTop: number | null
  seq: number
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
  /** host B3 新增：片段来源/版本不存在（404，不泄露存在性）。 */
  | 'fragment_source_not_found'
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
  /**
   * 加性（PR5/B3）：当前本地编辑序号与已确认服务端基线。
   * 引用往返只在 `localSeq` 与点击时一致才恢复原选区（§5.2）；缺失时按不可
   * 恢复处理（保留当前光标），绝不回放旧坐标。
   */
  localSeq?: number
  baseRevision?: number | null
  /** 片段插入进行中：正文编辑暂停（方案 §4.3）。 */
  inserting?: boolean
  /** 请求 textarea 恢复光标/选区（插入成功、撤销、引用返回；seq 递增触发）。 */
  selectionRequest?: NoteEditorSelectionRequest | null
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
  /**
   * 摘入前 flush（加性）：与 flushBeforeLeave 同守卫，但**不**触发
   * `localContentPreserved` 的 discardLocalInternal 副作用——插入不是导航，
   * 不能静默丢弃本地正文；该态按 `unsaved` 阻断插入。
   */
  flushForInsert?: () => Promise<NoteLeaveBlockReason | null>
  /**
   * 加性（PR5/B3）：把可信片段插入当前打开文档。
   *
   * 保护序列：先 flush 当前草稿（失败/冲突/未知结果不发插入）→ 暂停正文编辑
   * → 同 mutation_id 提交 → GET 对齐新 revision → 仅当 localSeq/项目/文档/
   * authGeneration 仍匹配时加载结果并恢复光标 → 单次插入作为一个普通撤销单元。
   * 结果未知时保留本地草稿与操作身份，`confirmPendingMutation` 用同一
   * mutation_id 重放；过期响应绝不覆盖新打开的文档。
   */
  insertFragment?: (
    input: NoteInsertFragmentInput,
    editorSelection?: EditorTextSelectionSnapshot | null,
  ) => Promise<NoteInsertFragmentResult>
  /**
   * 加性（PR5/B3）：引用核查返回时恢复原文档的选区和滚动位置。
   * 仅在身份/文档/localSeq 匹配时生效；否则保留当前光标（返回 false）。
   */
  restoreEditorPosition?: (request: NoteEditorPositionRestoreRequest) => boolean
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
  /**
   * 加性（PR5/B3）：`fragment` = 片段插入（同 mutation_id 重放，GET 对齐新
   * revision 后恢复光标）；旧缓存记录只含 save/create/copy，读取保持兼容。
   */
  kind: 'save' | 'create' | 'copy' | 'fragment'
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
  /** 加性（PR5/B3）：`fragment` 重放所需的冻结请求（target + source）。 */
  fragment?: NoteInsertFragmentInput | null
  /** 加性（PR5/B3）：片段插入发起时的编辑器 UTF-16 选区（撤销/恢复用）。 */
  editorSelection?: EditorTextSelectionSnapshot | null
  /** 加性（PR5/B3）：片段插入发起时的 localSeq（重放时判断本地草稿是否仍匹配）。 */
  capturedLocalSeq?: number
}
