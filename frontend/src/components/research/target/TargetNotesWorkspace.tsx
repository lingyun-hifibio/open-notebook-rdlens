'use client'

/**
 * 目标壳 W3 成果编排层（Issue #1191 W3-G1；UI 规格 v1 §5.6/§5.8 UI-14/UI-19）。
 *
 * 职责（实施计划 §2.1.1/§2.1.2/§2.1.3）：
 * - 默认目标壳内的常驻 Notes 编排层：目录数据（d2-v1 `useNoteCatalog`）、能力
 *   投影 `useNoteCapabilities`、唯一编辑器 machine（`NoteWorkspaceProvider` 内由
 *   slot 下发，本层不创建第二个）、删除/启用状态机与两对话框宿主；
 * - 运行在 `NoteWorkspaceProvider` 内层，消费 provider 的
 *   `pendingOpenNote`/`notesChangedSeq`（摘入/写作后打开与刷新）；
 * - 持有宽屏编辑器 overlay 的打开请求（`TargetEditorOpenRequest`）与触发控件，
 *   `TargetShellBody` 只消费 context 渲染 overlay（不做反向 state 写入）；
 * - 右栏成果目录（`TargetOutcomesPane`）只渲染 `NoteCatalog` 与状态；编辑器
 *   overlay 在右栏关闭时仍可继续使用同一删除/启用状态机。
 *
 * 保护语义与旧壳 `NotesPanel` 完全同源：能力 fail-closed、Admin 只读、受限行
 * 不渲染标题正文、冲突/离开保护由编辑器 machine 驱动、删除二次确认 + revision
 * CAS、首次启用受保护编辑。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useDebounce } from 'use-debounce'

import { useToast } from '@/lib/hooks/use-toast'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useNoteCatalog } from '@/lib/research/issue585/use-note-catalog'
import { useNoteCapabilities } from '@/lib/research/issue585/use-note-capabilities'
import { getNoteD2, normalizeNoteApiError } from '@/lib/research/issue585/note-client'
import { useNoteDelete } from '@/lib/research/issue585/use-note-delete'
import { useNoteEditor } from '@/lib/research/issue585/use-note-editor'
import { useNoteEnable } from '@/lib/research/issue585/use-note-enable'
import {
  listRecoverableNoteDrafts,
  readNoteDraftForRetrieval,
  readOrCreateNoteDraftTabId,
  type RecoverableNoteDraftSummary,
} from '@/lib/research/issue585/note-draft-cache'
import { downloadLocalDraftMarkdown } from '@/lib/research/issue585/note-download'
import type {
  NoteCapabilitiesResult,
  NoteDraftCacheRecord,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'
import { NoteDeleteDialog } from '../issue585/NoteDeleteDialog'
import { NoteEnableDialog } from '../issue585/NoteEnableDialog'
import { useNoteWorkspaceOptional } from '../issue585/NoteWorkspaceProvider'
import { blockReasonLabelKey, noteErrorLabelKey } from '../issue585/note-ui-labels'
import {
  attachedEditorRequest,
  openEditorRequest,
  type TargetEditorOpenRequest,
} from './target-editor-state'

/** 目标壳 W3 编排 context（`TargetOutcomesPane`/`TargetShellBody` 消费）。 */
export interface TargetNotesWorkspaceValue {
  readonly projectId: string
  readonly isAdminReadonly: boolean
  /** 目录 d2-v1 投影（含旧未保护行；行内 scope 编辑不在此层）。 */
  readonly catalog: {
    readonly items: ResearchNoteD2[]
    readonly isLoading: boolean
    readonly error: ReturnType<typeof normalizeNoteApiError> | null
    readonly refresh: () => Promise<void>
  }
  readonly capabilities: NoteCapabilitiesResult
  readonly editor: { readonly state: NoteEditorState; readonly actions: NoteEditorActions }
  /** 目录搜索词（provider 持有：右栏关闭/重开不丢，reveal 时可清空）。 */
  readonly search: string
  setSearch: (value: string) => void
  /** Save-as-Note/摘入后的行 reveal 目标（ring；清搜索由 revealNoteInCatalog 负责）。 */
  readonly revealId: string | null
  revealNoteInCatalog: (noteId: string) => void
  /** 空白新建入口（能力 `note_editor` 只控制新建/首次启用）。 */
  readonly canCreate: boolean
  readonly createBlockedReason: string | null
  readonly createPending: boolean
  onCreateBlank: () => void
  /** 打开 d2-v1 文档（旧未保护行不得调用；由 legacyActions 提供启用入口）。 */
  readonly onOpenNote: (noteId: string) => void
  /** 摘入入口可用性（provider `insertionAvailable`）。 */
  readonly excerptAvailable: boolean
  onExcerptNote: (item: ResearchNoteD2) => void
  /** 删除入口可见性与动作（二次确认 + revision CAS 由状态机负责）。 */
  readonly canDeleteNote: (item: ResearchNoteD2) => boolean
  onRequestDelete: (item: ResearchNoteD2) => void
  /** 当前打开文档是否可删除（编辑器内删除入口；能力/revision/非受限 fail-closed）。 */
  readonly editorDeleteAvailable: boolean
  onRequestDeleteEditor: () => void
  /** 旧未保护行的「启用受保护编辑」入口（成功后按 d2-v1 打开）。 */
  readonly canEnableProtected: boolean
  onRequestEnable: (noteId: string) => void
  /** 仓库/可恢复草稿入口（右栏 outcomes 面板顶部渲染）。 */
  readonly recoverableDrafts: readonly RecoverableNoteDraftSummary[]
  readonly restrictedNoteIds: ReadonlySet<string>
  onOpenRecovery: (noteId: string) => void
  onCopyRecovery: (noteId: string) => void
  onDownloadRecovery: (noteId: string) => void
  /** 宽屏编辑器 overlay 打开请求（null = 关闭）。 */
  readonly editorRequest: TargetEditorOpenRequest | null
  /** 请求打开编辑器；`trigger` 用于关闭后焦点返回。 */
  openEditor: (request: TargetEditorOpenRequest, trigger?: HTMLElement | null) => void
  /** 关闭编辑器（返回 true 才真正关闭；false 时 overlay 保持并由离开保护呈现）。 */
  requestCloseEditor: () => Promise<boolean>
  /** 关闭后取回触发控件（取一次即清空；shell 负责聚焦）。 */
  takeEditorTrigger: () => HTMLElement | null
  /** 打开失败的可重试目标（编辑器阻断视图的「重试打开」）。 */
  readonly retryOpenNoteId: string | null
  retryOpenEditor: () => void
  refreshCatalog: () => Promise<void>
  refreshCapabilities: () => void
  /** 编辑器内部「另存副本」成功后的目录刷新（不改变当前 overlay）。 */
  onEditorCopySaved: (noteId: string) => void
}

/**
 * 编排 context（导出供纯组件测试注入 fake value；生产路径通过
 * `TargetNotesWorkspaceProvider` 提供）。
 */
export const TargetNotesWorkspaceContext =
  createContext<TargetNotesWorkspaceValue | null>(null)

/** 目标壳 W3 编排 context；无 Provider 时 throw（目标壳内必然存在）。 */
export function useTargetNotesWorkspace(): TargetNotesWorkspaceValue {
  const value = useContext(TargetNotesWorkspaceContext)
  if (value === null) {
    throw new Error('TargetNotesWorkspaceProvider is required inside the target shell')
  }
  return value
}

/**
 * 目标壳 W3 常驻编排 provider（`TargetShell` 内层；旧壳 `NotesPanel` 不修改）。
 *
 * 挂载位置：`NoteWorkspaceProvider` 内层，从而：
 * - `useNoteEditor`/`useNoteCapabilities` 走 provider slot（零重复请求/第二编辑器）；
 * - 消费 provider 的 `pendingOpenNote`（摘入/写作打开）与 `notesChangedSeq`（刷新）。
 */
export function TargetNotesWorkspaceProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, isAdminReadonly, userId, authGeneration } = useResearchWorkspace()
  const [search, setSearch] = useState('')
  const [debouncedSearch] = useDebounce(search, 300)

  const catalog = useNoteCatalog({ projectId, search: debouncedSearch })
  const capabilitiesResult = useNoteCapabilities(projectId)
  const editor = useNoteEditor({
    projectId,
    capabilities: capabilitiesResult.capabilities,
    isAdminReadonly,
  })
  // 页面级组合根（摘入/引用/写作）：本层只消费它的打开/刷新信号。
  const noteWorkspace = useNoteWorkspaceOptional()
  const consumeOpenNote = noteWorkspace?.consumeOpenNote
  const pendingOpenNote = noteWorkspace?.pendingOpenNote ?? null
  const notesChangedSeq = noteWorkspace?.notesChangedSeq ?? 0
  const insertionAvailable = noteWorkspace?.insertionAvailable === true

  const noteEnable = useNoteEnable({
    projectId,
    capabilities: capabilitiesResult.capabilities,
    isAdminReadonly,
  })
  const noteDelete = useNoteDelete({
    projectId,
    capabilities: capabilitiesResult.capabilities,
    isAdminReadonly,
  })

  /** 最新 editor 状态/动作引用（异步回调/卸载 cleanup 读取真实结果）。 */
  const editorStateRef = useRef(editor.state)
  editorStateRef.current = editor.state
  const editorActionsRef = useRef(editor.actions)
  editorActionsRef.current = editor.actions

  // —— 编辑器 overlay 状态（请求归本层；shell 只渲染） ——
  const [editorRequest, setEditorRequest] = useState<TargetEditorOpenRequest | null>(null)
  const editorTriggerRef = useRef<HTMLElement | null>(null)
  const [retryOpenNoteId, setRetryOpenNoteId] = useState<string | null>(null)
  const openedOnceRef = useRef(false)

  const takeEditorTrigger = useCallback((): HTMLElement | null => {
    const trigger = editorTriggerRef.current
    editorTriggerRef.current = null
    return trigger
  }, [])

  /** 记录当前聚焦元素作为关闭后的焦点返回目标（按钮点击时即触发控件）。 */
  const captureActiveTrigger = useCallback(() => {
    if (typeof document === 'undefined') return
    const active = document.activeElement
    if (active instanceof HTMLElement) editorTriggerRef.current = active
  }, [])

  const requestCloseEditor = useCallback(async (): Promise<boolean> => {
    const closed = await editorActionsRef.current.closeEditor()
    if (closed) {
      openedOnceRef.current = false
      setEditorRequest(null)
      setRetryOpenNoteId(null)
    }
    return closed
  }, [])

  /** 目录/作答入口：provider 统一发起 openNote（避免 overlay 与目录双开竞态）。 */
  const openEditor = useCallback(
    (request: TargetEditorOpenRequest, trigger: HTMLElement | null = null) => {
      if (trigger !== null) editorTriggerRef.current = trigger
      if (request.kind === 'open') {
        const current = editorStateRef.current
        if (current.note?.note_id === request.noteId && current.status === 'ready') {
          // 编辑器已在该文档：只保证 overlay 可见，不重复 openNote。
          openedOnceRef.current = true
          setEditorRequest(attachedEditorRequest())
          return
        }
        setRetryOpenNoteId(request.noteId)
        setEditorRequest(request)
        void editorActionsRef.current.openNote(request.noteId)
        return
      }
      openedOnceRef.current = true
      setEditorRequest(request)
    },
    [],
  )

  const retryOpenEditor = useCallback(() => {
    const noteId = retryOpenNoteId
    if (noteId === null) return
    void editorActionsRef.current.openNote(noteId)
  }, [retryOpenNoteId])

  // —— 外部收敛：编辑器 idle（删除/放弃/closeEditor 内部完成）后自动关闭 overlay ——
  const editorState = editor.state
  useEffect(() => {
    if (editorRequest === null) {
      openedOnceRef.current = false
      return
    }
    const status = editorState.status
    const note = editorState.note
    if (note !== null || status === 'ready' || status === 'error' || status === 'loading') {
      openedOnceRef.current = true
    }
    if (openedOnceRef.current && status === 'idle' && note === null) {
      openedOnceRef.current = false
      setEditorRequest(null)
      setRetryOpenNoteId(null)
    }
  }, [editorRequest, editorState.note, editorState.status])

  // —— 身份/项目切换：强制关闭 overlay（machine 会按身份重建，旧 noteId 失效） ——
  useEffect(() => {
    setEditorRequest(null)
    setRetryOpenNoteId(null)
    setRevealId(null)
    setSearch('')
    editorTriggerRef.current = null
    openedOnceRef.current = false
  }, [projectId, userId, authGeneration])

  // —— 摘入/写作打开请求：provider 统一 openNote 后以 attached 打开 overlay ——
  const handledOpenSeqRef = useRef<number | null>(null)
  const catalogRefresh = catalog.refresh
  useEffect(() => {
    if (pendingOpenNote === null || consumeOpenNote === undefined) return
    if (handledOpenSeqRef.current === pendingOpenNote.seq) return
    handledOpenSeqRef.current = pendingOpenNote.seq
    void (async () => {
      await editorActionsRef.current.openNote(pendingOpenNote.noteId)
      const latest = editorStateRef.current
      if (latest.note?.note_id === pendingOpenNote.noteId && pendingOpenNote.selection !== null) {
        editorActionsRef.current.restoreEditorPosition?.({
          noteId: pendingOpenNote.noteId,
          expectedLocalSeq: latest.localSeq ?? 0,
          selection: pendingOpenNote.selection,
          scrollTop: 0,
        })
      }
      openedOnceRef.current = true
      setRetryOpenNoteId(pendingOpenNote.noteId)
      setEditorRequest(attachedEditorRequest())
      consumeOpenNote(pendingOpenNote.seq)
      await catalogRefresh()
    })()
  }, [catalogRefresh, consumeOpenNote, pendingOpenNote])

  // —— 插入/另存后目录刷新（provider 递增 notesChangedSeq） ——
  const seenNotesChangedRef = useRef(notesChangedSeq)
  useEffect(() => {
    if (notesChangedSeq === seenNotesChangedRef.current) return
    seenNotesChangedRef.current = notesChangedSeq
    void catalogRefresh()
  }, [catalogRefresh, notesChangedSeq])

  // —— 可恢复草稿入口（Issue #1136 既有语义；本层常驻，右栏只渲染） ——
  const draftTabId = useMemo(() => readOrCreateNoteDraftTabId(), [])
  const [recoverableDrafts, setRecoverableDrafts] = useState<RecoverableNoteDraftSummary[]>([])
  const [revealId, setRevealId] = useState<string | null>(null)
  const draftAuthority = useCallback(
    (): {
      authenticatedOwnerId: string | null
      currentProjectId: string
      authGeneration: number
      currentAuthGeneration: number
      permissionConfirmed: boolean
    } => {
      const generation = authGeneration ?? 0
      return {
        authenticatedOwnerId: userId !== undefined && userId.length > 0 ? userId : null,
        currentProjectId: projectId,
        authGeneration: generation,
        currentAuthGeneration: generation,
        // 列表/取回只读本地草稿，不恢复正文；文本恢复仍由 openNote 做服务端
        // 权限确认（旧壳同一语义）。
        permissionConfirmed: false,
      }
    },
    [authGeneration, projectId, userId],
  )
  const refreshRecoverableDrafts = useCallback(() => {
    if (isAdminReadonly) {
      setRecoverableDrafts([])
      return
    }
    setRecoverableDrafts(
      listRecoverableNoteDrafts(userId ?? '', projectId, draftTabId, draftAuthority()),
    )
  }, [draftAuthority, draftTabId, isAdminReadonly, projectId, userId])
  const editorNoteId = editor.state.note?.note_id ?? null
  const editorSaveStatus = editor.state.saveStatus
  useEffect(() => {
    refreshRecoverableDrafts()
  }, [refreshRecoverableDrafts, editorNoteId, editorSaveStatus])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFocus = (): void => refreshRecoverableDrafts()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshRecoverableDrafts])

  const restrictedNoteIds = useMemo(
    () =>
      new Set(
        catalog.items
          .filter((item) => item.access_state === 'restricted')
          .map((item) => item.note_id),
      ),
    [catalog.items],
  )

  const readRecoverableDraftRecord = useCallback(
    (noteId: string): NoteDraftCacheRecord | null =>
      readNoteDraftForRetrieval(
        { ownerId: userId ?? '', projectId, noteId, tabId: draftTabId },
        draftAuthority(),
      ),
    [draftAuthority, draftTabId, projectId, userId],
  )

  const copyRecoverableDraft = useCallback(
    (noteId: string) => {
      const record = readRecoverableDraftRecord(noteId)
      if (record === null) return
      const clipboard =
        typeof navigator === 'object' && navigator !== null ? navigator.clipboard : undefined
      if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
        void clipboard.writeText(record.content).catch(() => undefined)
      }
    },
    [readRecoverableDraftRecord],
  )
  const downloadRecoverableDraft = useCallback(
    (noteId: string) => {
      const record = readRecoverableDraftRecord(noteId)
      if (record === null) return
      downloadLocalDraftMarkdown({
        title: record.title,
        content: record.content,
        noteId,
        savedAt: record.savedAt,
      })
    },
    [readRecoverableDraftRecord],
  )

  // —— 目录编排（与旧壳 NotesPanel 同源，不新增第二套能力/权限判定） ——
  const refreshCatalog = useCallback(async (): Promise<void> => {
    await catalogRefresh()
  }, [catalogRefresh])

  const revealNoteInCatalog = useCallback(
    (noteId: string) => {
      // RWV2-23（R2-5/R3-3）：活跃搜索词会过滤新行 → 先清空搜索再 reveal。
      setSearch('')
      setRevealId(noteId)
      void catalogRefresh()
    },
    [catalogRefresh],
  )

  const createBlankNote = useCallback(() => {
    captureActiveTrigger()
    void (async () => {
      const noteId = await editorActionsRef.current.createBlankNote()
      if (noteId !== null) {
        openedOnceRef.current = true
        setRetryOpenNoteId(noteId)
        setEditorRequest(attachedEditorRequest())
        await catalogRefresh()
        return
      }
      // 新建失败不得静默回 idle：原因取最新 machine 状态（错误码优先，其次阻断
      // 原因，最后通用「暂不可用」），与旧壳反馈一致。
      const latest = editorStateRef.current
      const description = latest.error?.code
        ? t(noteErrorLabelKey(latest.error.code))
        : latest.blockReason
          ? t(blockReasonLabelKey(latest.blockReason))
          : t('research.notes.catalog.createUnavailable')
      toast({ title: t('common.error'), description, variant: 'destructive' })
    })()
  }, [catalogRefresh, captureActiveTrigger, t, toast])

  const onExcerptNote = useCallback(
    (item: ResearchNoteD2) => {
      if (noteWorkspace === null || !noteWorkspace.insertionAvailable) return
      if (item.revision === null || item.snapshot_hash === null) return
      noteWorkspace.openExcerptInsert({
        sourceKind: 'note',
        sourceId: item.note_id,
        sourceVersion: `${item.revision}:${item.snapshot_hash}`,
        text: item.content,
        title: item.title,
        initialSelection: null,
      })
    },
    [noteWorkspace],
  )

  const canDeleteD2 =
    !isAdminReadonly && capabilitiesResult.capabilities?.noteEditorExisting.available === true
  const editorDeleteTarget = editor.state.note
  const editorDeleteAvailable =
    canDeleteD2 &&
    editorDeleteTarget !== null &&
    editorDeleteTarget.edit_schema === 'd2-v1' &&
    editorDeleteTarget.revision !== null
  const editorDeleteHasLocalChanges =
    editorDeleteTarget !== null &&
    noteDelete.state.noteId === editorDeleteTarget.note_id &&
    (editor.state.title !== editorDeleteTarget.title ||
      editor.state.content !== editorDeleteTarget.content)
  const canDeleteCatalogNote = useCallback(
    (item: ResearchNoteD2): boolean => {
      if (!canDeleteD2) return false
      if (item.edit_schema !== 'd2-v1' || item.access_state === 'restricted') return false
      if (item.revision === null) return false
      // 正在写当前打开文档时不允许从目录行删除同一文档（避免与在途 save 竞争）。
      const current = editorStateRef.current
      if (current.note !== null && item.note_id === current.note.note_id) {
        if (current.saveStatus === 'saving' || current.inserting === true) return false
      }
      return true
    },
    [canDeleteD2],
  )

  const requestDeleteCatalogNote = useCallback((item: ResearchNoteD2) => {
    noteDelete.actions.requestDelete(item.note_id, item.revision, item.title, item.content)
  }, [noteDelete.actions])

  /** 若被删/已不存在的 Note 正打开在编辑器里，显式放弃本地并关闭 overlay。 */
  const closeEditorForDeletedNote = useCallback(async (noteId: string): Promise<void> => {
    if (editorStateRef.current.note?.note_id !== noteId) return
    editorActionsRef.current.discardLocal()
    const closed = await editorActionsRef.current.closeEditor()
    if (closed) {
      openedOnceRef.current = false
      setEditorRequest(null)
      setRetryOpenNoteId(null)
    }
  }, [])

  const finishDelete = useCallback(
    async (noteId: string | null): Promise<void> => {
      if (noteId === null) return
      await closeEditorForDeletedNote(noteId)
      refreshRecoverableDrafts()
      try {
        await catalogRefresh()
      } catch {
        // 目录刷新失败不改变「服务端已删除」的事实；下次刷新可见。
      }
      toast({ title: t('research.notes.deleteDialog.success') })
    },
    [catalogRefresh, closeEditorForDeletedNote, refreshRecoverableDrafts, t, toast],
  )

  const confirmDeleteNote = useCallback(async (): Promise<void> => {
    await finishDelete(await noteDelete.actions.confirmDelete())
  }, [finishDelete, noteDelete.actions])

  const retryDeleteNote = useCallback(async (): Promise<void> => {
    if (noteDelete.state.retryMode !== 'reconfirm') {
      await finishDelete(await noteDelete.actions.retry())
      return
    }
    // 409 冲突：按既有权限另行读取最新版，用最新 revision/标题/正文回到二次
    // 确认（绝不在只拿到 409 detail 时直接复用旧标题确认）。
    const noteId = noteDelete.state.noteId
    if (noteId === null) {
      noteDelete.actions.dismiss()
      return
    }
    try {
      const latest = await getNoteD2(projectId, noteId)
      if (latest.access_state === 'restricted' || latest.revision === null) {
        noteDelete.actions.dismiss()
        try {
          await catalogRefresh()
        } catch {
          // 刷新失败不改变「未删除」的事实。
        }
        return
      }
      try {
        await catalogRefresh()
      } catch {
        // 目录刷新失败不阻塞复核确认（目标数据来自最新一次读取）。
      }
      noteDelete.actions.reconfirm(latest.revision, latest.title, latest.content)
    } catch (error) {
      const apiError = normalizeNoteApiError(error)
      if (apiError.code === 'note_not_found') {
        noteDelete.actions.dismiss()
        await closeEditorForDeletedNote(noteId)
        refreshRecoverableDrafts()
        try {
          await catalogRefresh()
        } catch {
          // 忽略刷新失败。
        }
        return
      }
      toast({
        title: t('common.error'),
        description: t('research.notes.deleteDialog.refreshFailed'),
        variant: 'destructive',
      })
    }
  }, [
    catalogRefresh,
    closeEditorForDeletedNote,
    finishDelete,
    noteDelete.actions,
    noteDelete.state.noteId,
    noteDelete.state.retryMode,
    projectId,
    refreshRecoverableDrafts,
    t,
    toast,
  ])

  const dismissDeleteNote = useCallback(async (): Promise<void> => {
    const noteId = noteDelete.state.noteId
    const failureKind = noteDelete.state.failureKind
    noteDelete.actions.dismiss()
    if (failureKind === 'not_found' && noteId !== null) {
      await closeEditorForDeletedNote(noteId)
      refreshRecoverableDrafts()
      try {
        await catalogRefresh()
      } catch {
        // 忽略刷新失败。
      }
    }
  }, [
    catalogRefresh,
    closeEditorForDeletedNote,
    noteDelete.actions,
    noteDelete.state.failureKind,
    noteDelete.state.noteId,
    refreshRecoverableDrafts,
  ])

  // —— 首次启用受保护编辑（复用 #1135 状态机；成功后按 d2-v1 打开 overlay） ——
  const finishEnableProtected = useCallback(
    async (noteId: string | null): Promise<void> => {
      if (noteId === null) return
      toast({ title: t('research.notes.enable.success') })
      try {
        await catalogRefresh()
      } catch {
        // 目录刷新失败不阻塞原地切入（打开仍以服务端权限为准）。
      }
      openedOnceRef.current = true
      setRetryOpenNoteId(noteId)
      setEditorRequest(attachedEditorRequest())
      await editorActionsRef.current.openNote(noteId)
    },
    [catalogRefresh, t, toast],
  )
  const confirmEnableProtected = useCallback(async (): Promise<void> => {
    await finishEnableProtected(await noteEnable.actions.confirmEnable())
  }, [finishEnableProtected, noteEnable.actions])
  const retryEnableProtected = useCallback(async (): Promise<void> => {
    await finishEnableProtected(await noteEnable.actions.retry())
  }, [finishEnableProtected, noteEnable.actions])

  const canCreate = !isAdminReadonly && capabilitiesResult.capabilities?.noteEditor.available === true
  const createBlockedReason = capabilitiesResult.isLoading
    ? null
    : (capabilitiesResult.capabilities?.noteEditor.reason ??
      capabilitiesResult.error?.code ??
      'capability_unknown')
  const canEnableProtected =
    !isAdminReadonly && capabilitiesResult.capabilities?.noteEditor.available === true
  const enableTargetTitle = useMemo(() => {
    const noteId = noteEnable.state.noteId
    if (noteId === null) return ''
    return catalog.items.find((item) => item.note_id === noteId)?.title ?? ''
  }, [catalog.items, noteEnable.state.noteId])

  // 审查 HIGH-1：打开失败（文档未加载、编辑器里没有任何本地文本）时阻断视图的
  // Close 会 discardLocal 并删除唯一持久草稿——那不是用户对已加载编辑的显式
  // 放弃，属静默丢弃。仅该状态把 discardLocal 变为 no-op（草稿保留在恢复入口）。
  const editorActionsForView = useMemo<NoteEditorActions>(() => {
    // 依赖 `editor.actions`：machine actions 引用变化时重建视图动作集合；
    // 回调体经 ref 读取最新 actions，避免把 ref 放进依赖。
    void editor.actions
    const actions = editorActionsRef.current
    return {
      ...actions,
      discardLocal: () => {
        const current = editorStateRef.current
        const hasLocalText = current.title.length > 0 || current.content.length > 0
        if (current.note === null && current.status === 'error' && !hasLocalText) return
        actions.discardLocal()
      },
    }
  }, [editor.actions])

  const onRequestDeleteEditor = useCallback(() => {
    const target = editorStateRef.current.note
    if (target === null || target.edit_schema !== 'd2-v1' || target.revision === null) return
    noteDelete.actions.requestDelete(
      target.note_id,
      target.revision,
      editorStateRef.current.title,
      editorStateRef.current.content,
    )
  }, [noteDelete.actions])

  const onEditorCopySaved = useCallback((): void => {
    void catalogRefresh()
  }, [catalogRefresh])

  const value = useMemo<TargetNotesWorkspaceValue>(
    () => ({
      projectId,
      isAdminReadonly,
      catalog: {
        items: catalog.items,
        isLoading: catalog.isLoading,
        error: catalog.error,
        refresh: refreshCatalog,
      },
      capabilities: capabilitiesResult,
      editor: { state: editor.state, actions: editorActionsForView },
      search,
      setSearch,
      revealId,
      revealNoteInCatalog,
      canCreate,
      createBlockedReason,
      createPending: editor.state.status === 'loading' && editor.state.note === null,
      onCreateBlank: createBlankNote,
      onOpenNote: (noteId: string) => {
        captureActiveTrigger()
        openEditor(openEditorRequest(noteId))
      },
      excerptAvailable: insertionAvailable,
      onExcerptNote,
      canDeleteNote: canDeleteCatalogNote,
      onRequestDelete: requestDeleteCatalogNote,
      editorDeleteAvailable,
      onRequestDeleteEditor,
      canEnableProtected,
      onRequestEnable: (noteId: string) => {
        captureActiveTrigger()
        noteEnable.actions.requestEnable(noteId)
      },
      recoverableDrafts,
      restrictedNoteIds,
      onOpenRecovery: (noteId: string) => {
        captureActiveTrigger()
        openEditor(openEditorRequest(noteId))
      },
      onCopyRecovery: copyRecoverableDraft,
      onDownloadRecovery: downloadRecoverableDraft,
      editorRequest,
      openEditor,
      requestCloseEditor,
      takeEditorTrigger,
      retryOpenNoteId,
      retryOpenEditor,
      refreshCatalog,
      refreshCapabilities: () => void capabilitiesResult.refresh(),
      onEditorCopySaved,
    }),
    [
      canCreate,
      canDeleteCatalogNote,
      canEnableProtected,
      capabilitiesResult,
      catalog.error,
      catalog.isLoading,
      catalog.items,
      captureActiveTrigger,
      copyRecoverableDraft,
      createBlankNote,
      editorDeleteAvailable,
      onRequestDeleteEditor,
      createBlockedReason,
      downloadRecoverableDraft,
      editor.state,
      editorActionsForView,
      editorRequest,
      insertionAvailable,
      isAdminReadonly,
      noteEnable.actions,
      onEditorCopySaved,
      onExcerptNote,
      openEditor,
      projectId,
      recoverableDrafts,
      refreshCatalog,
      requestCloseEditor,
      restrictedNoteIds,
      retryOpenEditor,
      retryOpenNoteId,
      revealId,
      revealNoteInCatalog,
      search,
      takeEditorTrigger,
      requestDeleteCatalogNote,
    ],
  )

  return (
    <TargetNotesWorkspaceContext.Provider value={value}>
      {children}
      {/* 常驻宿主：编辑器 overlay 在右栏关闭时仍使用同一删除/启用状态机。 */}
      <NoteEnableDialog
        open={noteEnable.state.phase !== 'idle' && noteEnable.state.noteId !== null}
        phase={noteEnable.state.phase}
        noteTitle={enableTargetTitle}
        failureKind={noteEnable.state.failureKind}
        retryMode={noteEnable.state.retryMode}
        onConfirm={() => void confirmEnableProtected()}
        onCancel={noteEnable.actions.cancel}
        onRetry={() => void retryEnableProtected()}
        onClose={noteEnable.actions.dismiss}
      />
      <NoteDeleteDialog
        open={noteDelete.state.phase !== 'idle' && noteDelete.state.noteId !== null}
        phase={noteDelete.state.phase}
        noteTitle={noteDelete.state.noteTitle}
        noteContent={noteDelete.state.noteContent}
        expectedRevision={noteDelete.state.expectedRevision}
        failureKind={noteDelete.state.failureKind}
        retryMode={noteDelete.state.retryMode}
        localChangesWarning={editorDeleteHasLocalChanges}
        onConfirm={() => void confirmDeleteNote()}
        onCancel={noteDelete.actions.cancel}
        onRetry={() => void retryDeleteNote()}
        onClose={() => void dismissDeleteNote()}
      />
    </TargetNotesWorkspaceContext.Provider>
  )
}

/**
 * 编辑器视图需要的最小句柄（供 `TargetShellBody` 渲染 overlay；只含公共面）。
 *
 * `TargetEditorFocus` 直接消费本 context，因此导出该类型便于纯组件测试。
 */
export type TargetNotesEditorHandle = Pick<
  TargetNotesWorkspaceValue,
  'editor' | 'capabilities' | 'isAdminReadonly' | 'requestCloseEditor' | 'retryOpenNoteId'
>
