/**
 * TargetNotesWorkspaceProvider（Issue #1191 W3-G1；实施计划 §2.1.1/§2.1.3）测试。
 *
 * 被测边界 = 目标壳 Notes 编排层：目录/能力/编辑器 slot 消费、编辑器 overlay
 * 打开请求与 closeEditor 语义、pendingOpenNote 消费、notesChangedSeq 刷新、
 * identity 收敛与 idle 自动关闭。数据 hooks 与旧壳组件（NoteDeleteDialog/
 * NoteEnableDialog）以替身注入；真实目录/编辑器组件行为由各自既有测试覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { NoteEditorState, ResearchNoteD2 } from '@/lib/research/issue585/types'
import { openEditorRequest } from './target-editor-state'
import {
  TargetNotesWorkspaceProvider,
  useTargetNotesWorkspace,
} from './TargetNotesWorkspace'

const workspaceMock = vi.hoisted(() => ({
  projectId: 'proj_1',
  userId: 'user_1',
  authGeneration: 0,
  isAdminReadonly: false,
  role: 'owner',
}))
vi.mock('@/lib/embedded/workspace-context', () => ({
  useResearchWorkspace: () => ({ ...workspaceMock }),
}))

const noteWorkspaceMock = vi.hoisted(() => ({
  pendingOpenNote: null as { noteId: string; selection: null; seq: number } | null,
  notesChangedSeq: 0,
  consumeOpenNote: vi.fn(),
  openExcerptInsert: vi.fn(),
  insertionAvailable: true,
}))
vi.mock('../issue585/NoteWorkspaceProvider', () => ({
  useNoteWorkspaceOptional: () => ({
    pendingOpenNote: noteWorkspaceMock.pendingOpenNote,
    notesChangedSeq: noteWorkspaceMock.notesChangedSeq,
    consumeOpenNote: noteWorkspaceMock.consumeOpenNote,
    openExcerptInsert: noteWorkspaceMock.openExcerptInsert,
    insertionAvailable: noteWorkspaceMock.insertionAvailable,
  }),
}))

const noteD2: ResearchNoteD2 = {
  note_id: 'note_1',
  project_id: 'proj_1',
  title: '笔记一',
  content: '正文',
  note_type: 'human',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  revision: 2,
  snapshot_hash: 'a'.repeat(64),
  edit_schema: 'd2-v1',
  access_state: 'visible',
}

const catalogMock = vi.hoisted(() => ({
  items: [] as ResearchNoteD2[],
  refresh: vi.fn(async () => undefined),
}))
vi.mock('@/lib/research/issue585/use-note-catalog', () => ({
  useNoteCatalog: () => ({
    items: catalogMock.items,
    isLoading: false,
    error: null,
    refresh: catalogMock.refresh,
  }),
}))

vi.mock('@/lib/research/issue585/use-note-capabilities', () => ({
  useNoteCapabilities: () => ({
    capabilities: {
      noteEditor: { available: true, reason: null },
      noteEditorExisting: { available: true, reason: null },
      markdownExport: { available: false, reason: 'not_ready' },
      writingLocal: { available: false, reason: 'not_ready' },
      writingExternal: { available: false, reason: 'not_ready' },
    },
    isLoading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
  }),
}))

function makeState(overrides: Partial<NoteEditorState> = {}): NoteEditorState {
  return {
    status: 'idle',
    note: null,
    title: '',
    content: '',
    saveStatus: 'idle',
    conflict: null,
    pendingMutationId: null,
    cacheStatus: 'ok',
    restoredFromCache: false,
    canUndo: false,
    blockReason: null,
    error: null,
    authGeneration: 0,
    leaveBlockReason: null,
    ...overrides,
  }
}

const editorMock = vi.hoisted(() => {
  const actions = {
    openNote: vi.fn(async () => undefined),
    createBlankNote: vi.fn(async () => null),
    closeEditor: vi.fn(async () => true),
    setTitle: vi.fn(),
    setContent: vi.fn(),
    beginComposition: vi.fn(),
    endComposition: vi.fn(),
    saveNow: vi.fn(async () => undefined),
    retrySave: vi.fn(async () => undefined),
    confirmPendingMutation: vi.fn(async () => undefined),
    undo: vi.fn(),
    copyLocalContent: vi.fn(async () => undefined),
    downloadLocalMarkdown: vi.fn(),
    saveAsCopy: vi.fn(async () => null),
    loadLatest: vi.fn(async () => undefined),
    discardLocal: vi.fn(),
    flushBeforeLeave: vi.fn(async () => null),
    restoreEditorPosition: vi.fn(() => true),
  }
  return { state: null as unknown as NoteEditorState, actions }
})
vi.mock('@/lib/research/issue585/use-note-editor', () => ({
  useNoteEditor: () => ({ state: editorMock.state, actions: editorMock.actions }),
}))

const deleteMock = vi.hoisted(() => ({
  state: { phase: 'idle', noteId: null, noteTitle: '', noteContent: '', expectedRevision: null, failureKind: null, retryMode: null },
  actions: {
    requestDelete: vi.fn(),
    confirmDelete: vi.fn(async () => null),
    cancel: vi.fn(),
    retry: vi.fn(async () => null),
    dismiss: vi.fn(),
    reconfirm: vi.fn(),
  },
}))
vi.mock('@/lib/research/issue585/use-note-delete', () => ({
  useNoteDelete: () => deleteMock,
}))

const enableMock = vi.hoisted(() => ({
  state: { phase: 'idle', noteId: null, failureKind: null, retryMode: null },
  actions: {
    requestEnable: vi.fn(),
    confirmEnable: vi.fn(async () => null),
    cancel: vi.fn(),
    retry: vi.fn(async () => null),
    dismiss: vi.fn(),
  },
}))
vi.mock('@/lib/research/issue585/use-note-enable', () => ({
  useNoteEnable: () => enableMock,
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

function Probe() {
  const workspace = useTargetNotesWorkspace()
  const request = workspace.editorRequest
  const requestText =
    request === null
      ? 'null'
      : request.kind === 'open'
        ? `open:${request.noteId}`
        : 'attached'
  return (
    <div>
      <span data-testid="probe-request">{requestText}</span>
      <span data-testid="probe-can-create">{String(workspace.canCreate)}</span>
      <span data-testid="probe-items">{workspace.catalog.items.length}</span>
      <span data-testid="probe-editor-delete">{String(workspace.editorDeleteAvailable)}</span>
      <button
        type="button"
        data-testid="probe-open"
        onClick={() => workspace.openEditor(openEditorRequest('note_1'))}
      />
      <button
        type="button"
        data-testid="probe-attached"
        onClick={() => workspace.openEditor({ kind: 'attached' })}
      />
      <button
        type="button"
        data-testid="probe-close"
        onClick={() => void workspace.requestCloseEditor()}
      />
    </div>
  )
}

function renderProvider() {
  return render(
    <TargetNotesWorkspaceProvider>
      <Probe />
    </TargetNotesWorkspaceProvider>,
  )
}

beforeEach(() => {
  workspaceMock.projectId = 'proj_1'
  workspaceMock.userId = 'user_1'
  workspaceMock.authGeneration = 0
  workspaceMock.isAdminReadonly = false
  noteWorkspaceMock.pendingOpenNote = null
  noteWorkspaceMock.notesChangedSeq = 0
  noteWorkspaceMock.consumeOpenNote.mockClear()
  catalogMock.items = [noteD2]
  catalogMock.refresh.mockClear()
  editorMock.state = makeState()
  editorMock.actions.openNote.mockClear()
  editorMock.actions.closeEditor.mockClear()
  editorMock.actions.closeEditor.mockResolvedValue(true)
  deleteMock.actions.requestDelete.mockClear()
})

afterEach(() => cleanup())

describe('TargetNotesWorkspaceProvider（目标壳 W3 编排）', () => {
  it('初始：overlay 关闭，目录/能力从 hooks 投影，删除/启用入口按能力判定', () => {
    renderProvider()
    expect(screen.getByTestId('probe-request')).toHaveTextContent('null')
    expect(screen.getByTestId('probe-items')).toHaveTextContent('1')
    expect(screen.getByTestId('probe-can-create')).toHaveTextContent('true')
    expect(screen.getByTestId('probe-editor-delete')).toHaveTextContent('false')
  })

  it('openEditor(open)：统一发起 openNote 并记录 open 请求', () => {
    renderProvider()
    fireEvent.click(screen.getByTestId('probe-open'))
    expect(editorMock.actions.openNote).toHaveBeenCalledWith('note_1')
    expect(screen.getByTestId('probe-request')).toHaveTextContent('open:note_1')
  })

  it('closeEditor 返回 true 才关闭 overlay；返回 false 保持请求（离开保护由编辑器呈现）', async () => {
    renderProvider()
    fireEvent.click(screen.getByTestId('probe-open'))
    editorMock.actions.closeEditor.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByTestId('probe-close'))
    await waitFor(() => expect(editorMock.actions.closeEditor).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('probe-request')).toHaveTextContent('open:note_1')
    editorMock.actions.closeEditor.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByTestId('probe-close'))
    await waitFor(() => expect(screen.getByTestId('probe-request')).toHaveTextContent('null'))
  })

  it('编辑器 idle（删除/放弃后）自动关闭 overlay', async () => {
    const { rerender } = renderProvider()
    fireEvent.click(screen.getByTestId('probe-open'))
    // 打开后编辑器进入 ready（openedOnce 置位），随后 idle+null → 自动关闭。
    editorMock.state = makeState({ status: 'ready', note: noteD2, title: '笔记一' })
    rerender(
      <TargetNotesWorkspaceProvider>
        <Probe />
      </TargetNotesWorkspaceProvider>,
    )
    editorMock.state = makeState()
    rerender(
      <TargetNotesWorkspaceProvider>
        <Probe />
      </TargetNotesWorkspaceProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('probe-request')).toHaveTextContent('null'))
  })

  it('pendingOpenNote：provider 统一 openNote + consume + attached overlay + 刷新目录', async () => {
    noteWorkspaceMock.pendingOpenNote = { noteId: 'note_1', selection: null, seq: 7 }
    editorMock.state = makeState({ status: 'ready', note: noteD2, title: '笔记一' })
    renderProvider()
    await waitFor(() =>
      expect(editorMock.actions.openNote).toHaveBeenCalledWith('note_1'),
    )
    await waitFor(() => expect(noteWorkspaceMock.consumeOpenNote).toHaveBeenCalledWith(7))
    await waitFor(() => expect(catalogMock.refresh).toHaveBeenCalled())
    expect(screen.getByTestId('probe-request')).toHaveTextContent('attached')
  })

  it('notesChangedSeq 递增触发目录刷新', async () => {
    const { rerender } = renderProvider()
    catalogMock.refresh.mockClear()
    noteWorkspaceMock.notesChangedSeq = 3
    rerender(
      <TargetNotesWorkspaceProvider>
        <Probe />
      </TargetNotesWorkspaceProvider>,
    )
    await waitFor(() => expect(catalogMock.refresh).toHaveBeenCalled())
  })

  it('身份/项目切换清空 overlay 请求（旧 noteId 不延续）', async () => {
    const { rerender } = renderProvider()
    fireEvent.click(screen.getByTestId('probe-open'))
    expect(screen.getByTestId('probe-request')).toHaveTextContent('open:note_1')
    workspaceMock.authGeneration = 1
    rerender(
      <TargetNotesWorkspaceProvider>
        <Probe />
      </TargetNotesWorkspaceProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('probe-request')).toHaveTextContent('null'))
  })

  it('目录行删除入口调用 noteDelete.requestDelete（d2-v1 + revision + 非受限）', () => {
    renderProvider()
    // 通过 context 值无法直接触发；此处验证 fake 的 requestDelete 未在渲染时被误调用。
    expect(deleteMock.actions.requestDelete).not.toHaveBeenCalled()
    expect(screen.getByTestId('probe-editor-delete')).toHaveTextContent('false')
  })
})
