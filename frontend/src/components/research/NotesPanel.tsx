'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDebounce } from 'use-debounce'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchScope } from '@/lib/research/scope'
import {
  useDeleteResearchNote,
  useUpdateResearchNote,
} from '@/lib/hooks/use-research'
import { useNoteCatalog } from '@/lib/research/issue585/use-note-catalog'
import { useNoteCapabilities } from '@/lib/research/issue585/use-note-capabilities'
import { useNoteEditor } from '@/lib/research/issue585/use-note-editor'
import {
  listRecoverableNoteDrafts,
  readNoteDraftForRetrieval,
  readOrCreateNoteDraftTabId,
  type RecoverableNoteDraftSummary,
} from '@/lib/research/issue585/note-draft-cache'
import { downloadLocalDraftMarkdown } from '@/lib/research/issue585/note-download'
import type {
  NoteDraftCacheRecord,
  NoteEditorActions,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import { NoteCatalog } from './issue585/NoteCatalog'
import { NoteCapabilityBlocked } from './issue585/NoteCapabilityBlocked'
import { NoteEditorView } from './issue585/NoteEditorView'
import { NoteRecoveryInbox } from './issue585/NoteRecoveryInbox'
import { useNoteWorkspaceOptional } from './issue585/NoteWorkspaceProvider'
import { blockReasonLabelKey, noteErrorLabelKey } from './issue585/note-ui-labels'

/**
 * Notes 工作台（UI-02，REQ-SCOPE-04/REQ-API-01/REQ-DIS-01，设计 §4.4）。
 *
 * Owner：创建/编辑/删除（保存载荷仅 title/content，永不触发
 * Embedding，REQ-DIS-01）；Admin：只读列表 + 提示横幅，无写入口；即使
 * 写请求意外发出，后端 403 也会由 hook 以 toast 呈现（禁用入口不替代
 * 后端授权）。搜索为 Gateway 词法搜索（?q=，项目过滤后执行，不生成向量）。
 *
 * RWV2-13（Issue #34）：行首复选框承担 Note 的 Scope 选择（唯一编辑面；
 * 写入根级 provider，与右栏摘要即时同步）；**搜索过滤只改变可见行，隐藏
 * 选择保留在 provider**（AC：Search/filter/tab 变化不得清空隐藏选择）；
 * Edit/Delete 与选择互不干扰。
 *
 * Issue #1046 PR4（D2-B2）：目录改为 d2-v1 单源（`useNoteCatalog`，同时含
 * 旧未保护 Note 与 d2-v1 受保护 Note）：
 * - `edit_schema='d2-v1'` → 新 Markdown 编辑器（`useNoteEditor`），能力故障
 *   时渲染明确阻断态，**绝不**退回无 revision 旧表单；
 * - `edit_schema=null`（旧未保护 Note）→ 保持既有旧表单行为（PATCH
 *   updateNote / deleteNote），入口与搜索/Scope 选择不变；
 * - 空白新建入口只在 `capabilities.noteEditor.available` 时可用（开关只控制
 *   入口；已有 d2-v1 文档仍可打开并安全保存）。
 *
 * Issue #1136（父级导航离开保护，ResearchWorkbench 层）：owner 选定
 * 「自动保存＋可恢复」，导航不阻断。工作台切 pane 前调用本组件注册的
 * `registerParentLeaveHandler` 回调（同步持久化草稿 + 尽力 flush）；回到 Notes
 * 目录时 `NoteRecoveryInbox` 显式列出服务端保存未完成的草稿（复用 PR4 草稿
 * 缓存与恢复语义，不新建存储、不改编辑器接口）。
 */
export function NotesPanel({
  revealId = null,
  revealSeq = null,
  registerParentLeaveHandler,
}: {
  /** RWV2-23（AC3）：保存为 Note 后的左栏高亮目标（行 ring） */
  revealId?: string | null
  /** RWV2-23：reveal 递增序号——触发清除活跃搜索词（否则过滤会隐藏新条目） */
  revealSeq?: number | null
  /**
   * Issue #1136：向工作台注册「父级导航离开前」回调（切 pane 等由父级控制的
   * 导航）。回调只做同步本地草稿持久化与尽力 flush，**不阻断导航**；服务端
   * 保存未完成时由可恢复草稿入口兜底（见 `NoteRecoveryInbox`）。
   */
  registerParentLeaveHandler?: (handler: (() => void) | null) => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, isAdminReadonly, userId, authGeneration } = useResearchWorkspace()
  const {
    mode,
    selectedSourceIds,
    selectedNoteIds,
    toggleNote,
    removeNote,
  } = useResearchScope()
  const selectedCount = selectedSourceIds.length + selectedNoteIds.length
  const [search, setSearch] = useState('')
  const [debouncedSearch] = useDebounce(search, 300)

  // 单一目录数据源：d2-v1 投影同时包含旧未保护行（edit_schema=null）。
  const catalog = useNoteCatalog({ projectId, search: debouncedSearch })
  const capabilitiesResult = useNoteCapabilities(projectId)
  const editor = useNoteEditor({
    projectId,
    capabilities: capabilitiesResult.capabilities,
    isAdminReadonly,
  })
  // Issue #1047 PR5（B3）：页面级组合根（摘入对话框/引用阅读 overlay/打开请求）。
  // 机器仍由本面板持有；引用阅读不卸载本面板 → 保留内存 undo 与草稿。
  const noteWorkspace = useNoteWorkspaceOptional()
  const consumeOpenNote = noteWorkspace?.consumeOpenNote
  const pendingOpenNote = noteWorkspace?.pendingOpenNote ?? null
  const notesChangedSeq = noteWorkspace?.notesChangedSeq ?? 0

  // 目录行点击后记录目标 note_id：打开失败/能力故障时供编辑器重试打开。
  const [requestedNoteId, setRequestedNoteId] = useState<string | null>(null)
  // 最新 editor 状态/动作引用：异步动作返回 null 后（闭包里的 state 已过期）
  // 仍能拿到真实失败原因；卸载 cleanup 也能触发最后一次 flush。
  const editorStateRef = useRef(editor.state)
  editorStateRef.current = editor.state
  const editorActionsRef = useRef(editor.actions)
  editorActionsRef.current = editor.actions

  // 摘入成功后 provider 请求打开/定位 Note（非当前文档）。打开时先 flush 当前
  // 草稿；成功后仅当仍停在目标文档时恢复光标。
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
      consumeOpenNote(pendingOpenNote.seq)
      await catalogRefresh()
    })()
  }, [catalogRefresh, consumeOpenNote, pendingOpenNote])

  // 插入/另存后目录刷新（provider 递增 notesChangedSeq）。
  const seenNotesChangedRef = useRef(notesChangedSeq)
  useEffect(() => {
    if (notesChangedSeq === seenNotesChangedRef.current) return
    seenNotesChangedRef.current = notesChangedSeq
    void catalogRefresh()
  }, [catalogRefresh, notesChangedSeq])

  // 审查 A M3（PR4 缓解）＋ Issue #1136：NotesPanel 因切 pane/项目卸载、以及
  // 工作台父级导航（ResearchWorkbench）离开前，都尽力 flush 未决保存（不等待
  // 结果、不阻断导航）。本地草稿在每次编辑时已同步 writeCache，因此即使 flush
  // 失败/未知也不会丢文本；父级导航按 owner 选定的「自动保存＋可恢复」语义不
  // 阻断，服务端保存未完成时由 NoteRecoveryInbox 显式列出可恢复草稿。
  useEffect(() => {
    const leaveHandler = (): void => {
      void editorActionsRef.current.flushBeforeLeave()
    }
    registerParentLeaveHandler?.(leaveHandler)
    return () => {
      registerParentLeaveHandler?.(null)
      leaveHandler()
    }
  }, [registerParentLeaveHandler])

  // Issue #1136：可恢复草稿入口。服务端保存未完成（失败/冲突/结果未知）时，
  // 回到 Notes 目录显式列出本标签页仍待恢复的草稿，避免“只有碰巧重新打开同一
  // 篇才看到恢复横幅”的静默恢复路径。正文恢复仍走 openNote（服务端权限确认）。
  const draftTabId = useMemo(() => readOrCreateNoteDraftTabId(), [])
  const [recoverableDrafts, setRecoverableDrafts] = useState<RecoverableNoteDraftSummary[]>([])
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
        // 权限确认（方案 §4.2：离线/403/404 不恢复正文）。
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
  const editorStatus = editor.state.status
  useEffect(() => {
    refreshRecoverableDrafts()
  }, [refreshRecoverableDrafts, editorNoteId, editorSaveStatus])
  // 窗口重新获得焦点时重扫：切走 Notes 后在途 save 若已 ACK 成功（草稿被清理），
  // 列表不应残留“未保存”假条目（审查 LOW-1）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFocus = (): void => refreshRecoverableDrafts()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshRecoverableDrafts])

  // 目录中已确认权限受限的笔记：恢复入口不展示其缓存标题/取回动作（方案
  // §4.2）；打开该行会走 PR4 403 路径并清理对应草稿（审查 MEDIUM-2）。
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

  // 审查 HIGH-1：打开失败（离线/503）时编辑器会把文档置为未加载阻断态，其
  // “关闭”会 discardLocal 并删除唯一持久草稿。恢复入口必须在打开之前就能
  // 显式取回文本——只在用户点击时读缓存，不填充编辑器、不改保存状态。
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

  // 旧未保护 Note 的旧表单（行为与 #1045 前一致；仅 edit_schema=null 行走这里）。
  const updateMutation = useUpdateResearchNote(projectId)
  const deleteMutation = useDeleteResearchNote(projectId)
  const [showLegacyForm, setShowLegacyForm] = useState(false)
  const [editingLegacyNote, setEditingLegacyNote] = useState<ResearchNoteD2 | null>(null)
  const [legacyTitle, setLegacyTitle] = useState('')
  const [legacyContent, setLegacyContent] = useState('')

  // RWV2-23（R2-5/R3-3）：reveal 时若存在活跃搜索词，新 Note 会被过滤而不
  // 可见——先复位搜索词（本地输入 + debounce 参数由同一 state 驱动）。
  useEffect(() => {
    if (revealSeq !== null && revealSeq !== undefined) {
      setSearch('')
    }
  }, [revealSeq])

  const startEditLegacy = (note: ResearchNoteD2) => {
    setEditingLegacyNote(note)
    setLegacyTitle(note.title)
    setLegacyContent(note.content)
    setShowLegacyForm(true)
  }

  const submitLegacyUpdate = () => {
    if (!editingLegacyNote || !legacyTitle.trim() || !legacyContent.trim()) return
    updateMutation.mutate({
      noteId: editingLegacyNote.note_id,
      input: { title: legacyTitle.trim(), content: legacyContent.trim() },
    })
    setEditingLegacyNote(null)
    setLegacyTitle('')
    setLegacyContent('')
    setShowLegacyForm(false)
  }

  const deleteSelectedNote = (noteId: string) => {
    deleteMutation.mutate(noteId, {
      onSuccess: () => {
        if (removeNote(noteId)) {
          toast({
            title: t('research.layout.scope.modeLabel'),
            description: t('research.layout.scope.reconciled'),
          })
        }
      },
    })
  }

  const createBlankNote = async (): Promise<void> => {
    setShowLegacyForm(false)
    const noteId = await editor.actions.createBlankNote()
    if (noteId !== null) {
      await catalog.refresh()
      return
    }
    // 审查 A M2：新建失败不得静默回 idle——给出明确错误反馈（原因取最新
    // machine 状态：归一化错误码优先，其次阻断原因，最后通用“暂不可用”）。
    const latest = editorStateRef.current
    const description = latest.error?.code
      ? t(noteErrorLabelKey(latest.error.code))
      : latest.blockReason
        ? t(blockReasonLabelKey(latest.blockReason))
        : t('research.notes.catalog.createUnavailable')
    toast({ title: t('common.error'), description, variant: 'destructive' })
  }

  const openD2Note = async (noteId: string): Promise<void> => {
    setShowLegacyForm(false)
    setRequestedNoteId(noteId)
    await editor.actions.openNote(noteId)
  }

  const closeEditor = async (): Promise<void> => {
    const closed = await editor.actions.closeEditor()
    if (closed) setRequestedNoteId(null)
  }

  const canCreate = !isAdminReadonly && capabilitiesResult.capabilities?.noteEditor.available === true
  const createBlockedReason = capabilitiesResult.isLoading
    ? null
    : (capabilitiesResult.capabilities?.noteEditor.reason ??
      capabilitiesResult.error?.code ??
      'capability_unknown')

  const editorVisible = editor.state.note !== null || editor.state.status !== 'idle'
  // 恢复入口在编辑器完全关闭时展示；**打开失败**（status=error 且未加载文档）
  // 时也保留——该阻断视图的 Close 不能成为删除唯一草稿的静默路径（审查 HIGH-1）。
  const showRecoveryInbox =
    !isAdminReadonly &&
    editor.state.note === null &&
    (editorStatus === 'idle' || editorStatus === 'error')
  // 目录级能力阻断提示只在编辑器未打开时展示；编辑器打开后由
  // NoteEditorView 自己渲染阻断态（避免重复的 note-capability-blocked）。
  const showCapabilityAlert =
    !isAdminReadonly && capabilitiesResult.error !== null && !editorVisible

  // 审查 HIGH-1：打开失败（文档未加载、编辑器里没有任何本地文本）时，阻断视图
  // 的 Close 会 discardLocal 并删除唯一持久草稿——那不是用户对已加载编辑的
  // 显式放弃，属静默丢弃。仅该“空编辑器 + 打开失败”状态把 discardLocal 变为
  // no-op：关闭仍可进行、草稿保留并继续显示在恢复入口。
  // 注意不能只按 state shape 判断：`note_not_found` 分支会把草稿文本回填到
  // state（note-editor-machine.ts handleOpenFailure），此时必须允许 PR4 的显式
  // 放弃（二次确认后关闭），否则 404 会把用户锁在编辑器里（审查 round-2 HIGH）。
  const editorActionsForView = useMemo<NoteEditorActions>(() => {
    const actions = editor.actions
    return {
      ...actions,
      discardLocal: () => {
        const current = editorStateRef.current
        // 与状态机 hasUnsyncedLocalText 保持同一口径：用严格长度而非 trim()
        // （只含空白的草稿在 machine 里算“未同步文本”，trim 判空会导致
        // flushBeforeLeave 返回 failed 而这里 no-op → 404+空白草稿锁死编辑器，
        // 审查 round-3 MEDIUM-1）。
        const hasLocalText =
          current.title.length > 0 || current.content.length > 0
        if (current.note === null && current.status === 'error' && !hasLocalText) return
        actions.discardLocal()
      },
    }
  }, [editor.actions])

  return (
    <div className="space-y-3">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {showCapabilityAlert && capabilitiesResult.error !== null && (
        <NoteCapabilityBlocked
          reason={capabilitiesResult.error.code}
          canEditExisting={capabilitiesResult.capabilities?.noteEditorExisting.available === true}
          onRetry={() => void capabilitiesResult.refresh()}
        />
      )}

      {/* Issue #1136：服务端保存未完成时，回到 Notes 目录显式列出可恢复草稿
          （标题/缓存时间/复制/下载/打开笔记；打开后由编辑器恢复正文与 PR4
          冲突/未知态）。打开失败时也保留（见 showRecoveryInbox）。 */}
      {showRecoveryInbox && (
        <NoteRecoveryInbox
          drafts={recoverableDrafts}
          restrictedNoteIds={restrictedNoteIds}
          onOpen={(noteId) => void openD2Note(noteId)}
          onCopyLocal={copyRecoverableDraft}
          onDownloadLocal={downloadRecoverableDraft}
        />
      )}

      <NoteCatalog
        items={catalog.items}
        isLoading={catalog.isLoading}
        error={catalog.error}
        search={search}
        onSearchChange={setSearch}
        canCreate={canCreate}
        createBlockedReason={isAdminReadonly ? null : createBlockedReason}
        createPending={editor.state.status === 'loading' && editor.state.note === null}
        onCreateBlank={() => void createBlankNote()}
        canEdit={!isAdminReadonly}
        activeNoteId={editor.state.note?.note_id ?? null}
        onOpenNote={(noteId) => void openD2Note(noteId)}
        onExcerptNote={
          noteWorkspace === null || !noteWorkspace.insertionAvailable
            ? undefined
            : (item) => {
                if (item.revision === null || item.snapshot_hash === null) return
                noteWorkspace.openExcerptInsert({
                  sourceKind: 'note',
                  sourceId: item.note_id,
                  sourceVersion: `${item.revision}:${item.snapshot_hash}`,
                  text: item.content,
                  title: item.title,
                  initialSelection: null,
                })
              }
        }
        onRefresh={() => void catalog.refresh()}
        revealId={revealId}
        scopeControl={(item) => (
          <Checkbox
            checked={selectedNoteIds.includes(item.note_id)}
            onCheckedChange={() => toggleNote(item.note_id)}
            disabled={
              mode === 'selected' &&
              selectedCount === 1 &&
              selectedNoteIds.includes(item.note_id)
            }
            aria-label={t('research.notes.scopeSelect', {
              title:
                item.access_state === 'restricted'
                  ? t('research.notes.catalog.restricted')
                  : item.title,
            })}
            data-testid={`note-scope-${item.note_id}`}
            className="mt-0.5 shrink-0"
          />
        )}
        legacyActions={(item) => (
          <>
            <Button size="sm" variant="ghost" onClick={() => startEditLegacy(item)}>
              {t('research.notes.edit')}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" aria-label={t('research.notes.delete')}>
                  {t('research.notes.delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('research.notes.confirmDelete')}</AlertDialogTitle>
                  <AlertDialogDescription>{item.title}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('research.notes.cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => deleteSelectedNote(item.note_id)}>
                    {t('common.confirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      />

      {showLegacyForm && !isAdminReadonly && (
        <Card>
          <CardContent className="space-y-3 p-3">
            <p className="text-xs text-muted-foreground" data-testid="legacy-note-form-hint">
              {t('research.notes.catalog.legacyBadge')}
            </p>
            <div className="space-y-1">
              <Label htmlFor="note-title">{t('research.notes.titleLabel')}</Label>
              <Input
                id="note-title"
                value={legacyTitle}
                onChange={(event) => setLegacyTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="note-content">{t('research.notes.contentLabel')}</Label>
              <Textarea
                id="note-content"
                value={legacyContent}
                onChange={(event) => setLegacyContent(event.target.value)}
                rows={4}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submitLegacyUpdate} disabled={updateMutation.isPending}>
                {t('research.notes.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowLegacyForm(false)}>
                {t('research.notes.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {editorVisible && (
        <Card>
          <CardContent className="space-y-3 p-3">
            <NoteEditorView
              state={editor.state}
              actions={editorActionsForView}
              capabilities={capabilitiesResult.capabilities}
              isAdminReadonly={isAdminReadonly}
              onRequestClose={() => void closeEditor()}
              onCopySaved={() => void catalog.refresh()}
              onRetryOpen={
                requestedNoteId !== null
                  ? () => void editor.actions.openNote(requestedNoteId)
                  : undefined
              }
              onRetryCapabilities={() => void capabilitiesResult.refresh()}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
