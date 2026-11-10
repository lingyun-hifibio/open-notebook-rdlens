'use client'

/**
 * Issue #1047 PR5（D2-B3）：摘入片段 / 引用往返的页面级组合根。
 *
 * 职责（只新增接线，不改既有面板职责）：
 * - 在组合根（`app/research/page.tsx`）承载三类来源的「摘入选段」对话框；
 * - 承载引用阅读 overlay（来源/Note/回答/旧 insight），点击引用时记录
 *   `{noteId, localSeq, selection, scrollTop}` 返回点；关闭时仅当文档与
 *   localSeq 仍匹配才恢复原选区/滚动位置（否则保留当前光标，§5.2）；
 * - 向 NotesPanel 暴露「注册当前编辑器」「打开指定 Note」两个窄接口：编辑器
 *   machine 仍由 NotesPanel 持有（不因引用阅读卸载 → 保留内存 undo/草稿）；
 * - 不持有任何权限判定：能力/权限仍由各面板 fail-closed，本 provider 只做 UI
 *   编排与失败状态展示。
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
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { NoteEditorSlotProvider } from '@/lib/research/issue585/note-workspace-slot'
import { useNoteCapabilities } from '@/lib/research/issue585/use-note-capabilities'
import { useNoteEditor } from '@/lib/research/issue585/use-note-editor'
import type {
  EditorTextSelectionSnapshot,
  NoteCitationBinding,
  NoteCitationSourceKind,
  NoteCitationReaderRequest,
  NoteEditorActions,
  NoteEditorState,
} from '@/lib/research/issue585/types'
import { ExcerptInsertDialog } from './ExcerptInsertDialog'
import { NoteCitationReader } from './NoteCitationReader'

/** 摘入来源描述（快照文本 + 来源身份；文本不提交服务端，只用于确认层/预览）。 */
export interface ExcerptSourcePayload {
  readonly sourceKind: NoteCitationSourceKind
  readonly sourceId: string
  readonly sourceVersion: string | null
  /** 快照文本（source = markdown_chunks join；其余 = 记录 content 原串）。 */
  readonly text: string
  /** 展示用标题（来源名/回答标题/文档标题）。 */
  readonly title: string
  /** DOM 选区映射得到的初始 UTF-16 区间；null = 由用户在确认层选择。 */
  readonly initialSelection?: { start: number; end: number } | null
}

/** NotesPanel 注册给组合根的编辑器句柄（只暴露公共 state/actions）。 */
export interface NoteWorkspaceEditorHandle {
  readonly state: NoteEditorState
  readonly actions: NoteEditorActions
}

/** 插入成功后请求 NotesPanel 打开/定位的 Note（selection 为 UTF-16 半开区间）。 */
export interface PendingNoteOpen {
  readonly noteId: string
  readonly selection: { start: number; end: number } | null
  readonly seq: number
}

export interface NoteWorkspaceValue {
  readonly projectId: string
  readonly isAdminReadonly: boolean
  /** 服务端能力 `note_editor.available`：默认关闭时隐藏所有摘入入口（§8.2）。 */
  readonly insertionAvailable: boolean
  readonly editor: NoteWorkspaceEditorHandle | null
  /** 打开摘入选段对话框（SourceDetailPanel / ResultActions / Note 编辑器/目录）。 */
  openExcerptInsert: (source: ExcerptSourcePayload) => void
  /** 正文引用点击：记录返回点并进入独立阅读 overlay。 */
  openCitation: (
    binding: NoteCitationBinding,
    selection: EditorTextSelectionSnapshot | null,
    scrollTop: number | null,
  ) => void
  /** 插入成功后的打开请求（NotesPanel 消费；不要求目标此前已打开）。 */
  requestOpenNote: (noteId: string, selection: { start: number; end: number } | null) => void
  consumeOpenNote: (seq: number) => void
  readonly pendingOpenNote: PendingNoteOpen | null
  /** 编辑器内容发生变化（插入/另存后目录需刷新）。 */
  readonly notesChangedSeq: number
  notifyNotesChanged: () => void
}

const NoteWorkspaceContext = createContext<NoteWorkspaceValue | null>(null)

/** 无 Provider 的宿主（单测/旧壳）返回 null：入口 fail-closed 隐藏，不崩溃。 */
export function useNoteWorkspaceOptional(): NoteWorkspaceValue | null {
  return useContext(NoteWorkspaceContext)
}

export function NoteWorkspaceProvider({
  children,
  onNotesChanged,
}: {
  children: ReactNode
  /** 插入/另存成功后组合根 reveal Notes pane（可选；不影响 provider 内部编排）。 */
  onNotesChanged?: (noteId: string | null) => void
}) {
  const { projectId, isAdminReadonly, userId, authGeneration } = useResearchWorkspace()
  // Provider 是跨 pane 常驻的组合根：唯一编辑器 machine 与能力投影由它持有，
  // NotesPanel 通过 slot 消费（切 Sources/来源专注时不卸载 machine）。
  const capabilitiesResult = useNoteCapabilities(projectId)
  const editorHook = useNoteEditor({
    projectId,
    capabilities: capabilitiesResult.capabilities,
    isAdminReadonly,
  })
  const editor = useMemo<NoteWorkspaceEditorHandle>(
    () => ({ state: editorHook.state, actions: editorHook.actions }),
    [editorHook.state, editorHook.actions],
  )
  const insertionAvailable =
    !isAdminReadonly && capabilitiesResult.capabilities?.noteEditor.available === true
  const [excerptSource, setExcerptSource] = useState<ExcerptSourcePayload | null>(null)
  // 身份/项目切换：丢弃上一身份的编排态（对话框/阅读 overlay/打开请求），
  // 绝不让旧项目来源进入新项目；编辑器 machine 由 useNoteEditor 按身份重建。
  useEffect(() => {
    setExcerptSource(null)
    setCitationRequest(null)
    setPendingOpenNote(null)
  }, [projectId, userId, authGeneration])
  const [citationRequest, setCitationRequest] = useState<NoteCitationReaderRequest | null>(null)
  const [pendingOpenNote, setPendingOpenNote] = useState<PendingNoteOpen | null>(null)
  const [notesChangedSeq, setNotesChangedSeq] = useState(0)
  const editorRef = useRef<NoteWorkspaceEditorHandle | null>(editor)
  editorRef.current = editor
  const seqRef = useRef(0)

  const openExcerptInsert = useCallback(
    (source: ExcerptSourcePayload) => {
      // 能力关闭/Admin 只读时入口不应出现；这里再 fail-closed 一层。
      if (!insertionAvailable) return
      setExcerptSource(source)
    },
    [insertionAvailable],
  )

  const openCitation = useCallback(
    (
      binding: NoteCitationBinding,
      selection: EditorTextSelectionSnapshot | null,
      scrollTop: number | null,
    ) => {
      const handle = editorRef.current
      const note = handle?.state.note ?? null
      if (handle === null || note === null) return
      setCitationRequest({
        binding,
        noteId: note.note_id,
        localSeq: handle.state.localSeq ?? 0,
        baseRevision: handle.state.baseRevision ?? note.revision,
        selection,
        scrollTop,
      })
    },
    [],
  )

  const requestOpenNote = useCallback(
    (noteId: string, selection: { start: number; end: number } | null) => {
      seqRef.current += 1
      setPendingOpenNote({ noteId, selection, seq: seqRef.current })
    },
    [],
  )

  const consumeOpenNote = useCallback((seq: number) => {
    setPendingOpenNote((previous) => (previous?.seq === seq ? null : previous))
  }, [])

  const notifyNotesChanged = useCallback(() => {
    setNotesChangedSeq((value) => value + 1)
  }, [])

  /** 引用阅读关闭：仅当编辑器仍停在原文档且 localSeq 未变时恢复选区/滚动。 */
  const handleCitationClose = useCallback(() => {
    const request = citationRequest
    setCitationRequest(null)
    if (request === null) return
    editorRef.current?.actions.restoreEditorPosition?.({
      noteId: request.noteId,
      expectedLocalSeq: request.localSeq,
      selection: request.selection,
      scrollTop: request.scrollTop,
    })
  }, [citationRequest])

  const value = useMemo<NoteWorkspaceValue>(
    () => ({
      projectId,
      isAdminReadonly,
      insertionAvailable,
      editor,
      openExcerptInsert,
      openCitation,
      requestOpenNote,
      consumeOpenNote,
      pendingOpenNote,
      notesChangedSeq,
      notifyNotesChanged,
    }),
    [
      projectId,
      isAdminReadonly,
      insertionAvailable,
      editor,
      openExcerptInsert,
      openCitation,
      requestOpenNote,
      consumeOpenNote,
      pendingOpenNote,
      notesChangedSeq,
      notifyNotesChanged,
    ],
  )

  return (
    <NoteWorkspaceContext.Provider value={value}>
      <NoteEditorSlotProvider
        value={{
          state: editorHook.state,
          actions: editorHook.actions,
          capabilities: capabilitiesResult.capabilities,
          capabilitiesResult,
        }}
      >
        {children}
      </NoteEditorSlotProvider>
      <ExcerptInsertDialog
        source={excerptSource}
        editor={editor}
        onClose={() => setExcerptSource(null)}
        onInserted={(noteId, selection) => {
          notifyNotesChanged()
          onNotesChanged?.(noteId)
          const currentNoteId = editorRef.current?.state.note?.note_id ?? null
          if (currentNoteId !== noteId) requestOpenNote(noteId, selection)
        }}
      />
      <NoteCitationReader
        request={citationRequest}
        onClose={handleCitationClose}
      />
    </NoteWorkspaceContext.Provider>
  )
}
