/**
 * ExcerptInsertDialog（Issue #1047 PR5 / D2-B3）组件测试。
 *
 * 覆盖：原始 Markdown 确认层（UTF-16 选区/emoji 边界）、目标选择（当前 / 已有 /
 * 新建）、已有目标必须先 GET 新鲜 revision、插入成功后回调与光标位置、409 时
 * 暂停并要求重选、未知结果同 mutation 显式重试、当前文档未知结果交给编辑器
 * 状态机确认（不另造直连写入）。
 */

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createNoteFragmentD2,
  getNoteD2,
  insertNoteFragmentD2,
} from '@/lib/research/issue585/note-client'
import type {
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'
import { ExcerptInsertDialog } from './ExcerptInsertDialog'
import type { NoteWorkspaceEditorHandle } from './NoteWorkspaceProvider'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options === undefined ? key : `${key} ${JSON.stringify(options)}`,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/lib/embedded/workspace-context', () => ({
  useResearchWorkspace: () => ({ projectId: 'p1', isAdminReadonly: false }),
}))

let catalogItems: ResearchNoteD2[] = []
vi.mock('@/lib/research/issue585/use-note-catalog', () => ({
  useNoteCatalog: () => ({
    items: catalogItems,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

vi.mock('@/lib/research/issue585/note-client', () => ({
  getNoteD2: vi.fn(),
  insertNoteFragmentD2: vi.fn(),
  createNoteFragmentD2: vi.fn(),
  newNoteMutationId: () => 'nm_test',
  normalizeNoteApiError: (error: unknown) =>
    (error as { apiError?: unknown })?.apiError ?? {
      code: 'unknown_error',
      message: '',
      retryable: false,
      status: 0,
    },
}))

const mockedGet = vi.mocked(getNoteD2)
const mockedInsert = vi.mocked(insertNoteFragmentD2)
const mockedCreate = vi.mocked(createNoteFragmentD2)

const HASH = 'a'.repeat(64)

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function note(overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 {
  return {
    note_id: 'n2',
    project_id: 'p1',
    title: '目标笔记',
    content: '目标正文',
    note_type: 'human',
    created_at: null,
    updated_at: null,
    revision: 5,
    snapshot_hash: HASH,
    edit_schema: 'd2-v1',
    access_state: 'visible',
    ...overrides,
  }
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    note_id: 'n2',
    mutation_id: 'nm_test',
    applied_revision: 6,
    snapshot_hash: 'b'.repeat(64),
    saved_at: '2026-11-05T00:00:00.000Z',
    replayed: false,
    ...overrides,
  }
}

function editorHandle(overrides: {
  content?: string
  note?: ResearchNoteD2 | null
  insertFragment?: ReturnType<typeof vi.fn>
} = {}): NoteWorkspaceEditorHandle {
  const content = overrides.content ?? '当前正文'
  const state = {
    status: 'ready',
    note: overrides.note ?? note({ note_id: 'n1', title: '当前笔记', content, revision: 3 }),
    title: '当前笔记',
    content,
    saveStatus: 'saved',
    conflict: null,
    pendingMutationId: null,
    cacheStatus: 'ok',
    restoredFromCache: false,
    canUndo: false,
    blockReason: null,
    error: null,
    authGeneration: 0,
    leaveBlockReason: null,
    localSeq: 2,
    baseRevision: 3,
    inserting: false,
    selectionRequest: null,
  } as NoteEditorState
  const actions = {
    openNote: vi.fn(),
    createBlankNote: vi.fn(),
    closeEditor: vi.fn(),
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
    flushForInsert: vi.fn(async () => null),
    insertFragment: overrides.insertFragment ?? vi.fn(async () => ({ ok: true as const, noteId: 'n1', appliedRevision: 3, snapshotHash: HASH, insertedRange: { start: 4, end: 6 }, replayed: false })),
    restoreEditorPosition: vi.fn(),
  } as unknown as NoteEditorActions
  return { state, actions }
}

const SOURCE = {
  sourceKind: 'source' as const,
  sourceId: 'src_1',
  sourceVersion: 'docv_1',
  text: '第一段\n\n第二段 😀',
  title: '来源 A',
  initialSelection: { start: 0, end: 3 },
}

const onClose = vi.fn()
const onInserted = vi.fn()

function renderDialog(props: {
  source?: typeof SOURCE | null
  editor?: NoteWorkspaceEditorHandle | null
} = {}) {
  return render(
    <ExcerptInsertDialog
      source={props.source === undefined ? SOURCE : props.source}
      editor={props.editor === undefined ? null : props.editor}
      onClose={onClose}
      onInserted={onInserted}
    />,
  )
}

function resetMocks(): void {
  vi.clearAllMocks()
  catalogItems = []
}

describe('ExcerptInsertDialog', () => {
  it('shows the raw Markdown confirmation layer with the initial UTF-16 range', () => {
    resetMocks()
    renderDialog()
    expect(screen.getByTestId('excerpt-insert-dialog')).toBeInTheDocument()
    expect((screen.getByTestId('excerpt-source-text') as HTMLTextAreaElement).value).toBe(SOURCE.text)
    expect(screen.getByTestId('excerpt-selection-range').textContent).toContain('0')
    expect(screen.getByTestId('excerpt-preview').textContent).toContain('第一段')
    expect(screen.getByTestId('excerpt-target-new')).toBeChecked()
  })

  it('select-all switches to the full snapshot range', () => {
    resetMocks()
    renderDialog()
    fireEvent.click(screen.getByTestId('excerpt-select-all'))
    expect(screen.getByTestId('excerpt-selection-range').textContent).toContain(
      String(SOURCE.text.length),
    )
  })

  it('does not create a new note when the active draft cannot be flushed first', async () => {
    resetMocks()
    const editor = editorHandle()
    ;(editor.actions.flushForInsert as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      'conflict',
    )
    renderDialog({ editor })
    await waitFor(() =>
      expect((screen.getByTestId('excerpt-target-text') as HTMLTextAreaElement).value).toBe(
        '当前正文',
      ),
    )
    fireEvent.click(screen.getByTestId('excerpt-target-new'))
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() =>
      expect(screen.getByTestId('excerpt-target-error')).toBeInTheDocument(),
    )
    expect(mockedCreate).not.toHaveBeenCalled()
    expect(screen.getByTestId('excerpt-target-error').textContent).toContain(
      'research.notes.editor.errors.note_revision_conflict',
    )
  })

  it('disables insertion when the selection splits a surrogate pair', () => {
    resetMocks()
    const source = { ...SOURCE, text: 'a😀b', initialSelection: { start: 1, end: 2 } }
    renderDialog({ source })
    expect(screen.getByTestId('excerpt-insert')).toBeDisabled()
  })

  it('creates a new note from the trusted fragment and opens it at the inserted end', async () => {
    resetMocks()
    mockedCreate.mockResolvedValueOnce(receipt({ note_id: 'n_new', applied_revision: 1, snapshot_hash: HASH }))
    mockedGet.mockResolvedValueOnce(note({ note_id: 'n_new', content: '第一段[[cite:cb_1]]', revision: 1 }))
    renderDialog()
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() => expect(onInserted).toHaveBeenCalled())
    expect(mockedCreate).toHaveBeenCalledWith('p1', {
      mutation_id: 'nm_test',
      title: expect.any(String),
      fragment: {
        source: {
          source_kind: 'source',
          source_id: 'src_1',
          source_version: 'docv_1',
          expected_content_hash: sha256(SOURCE.text),
          selection: { kind: 'range', start_utf16: 0, end_utf16: 3 },
        },
      },
    })
    expect(onInserted).toHaveBeenCalledWith(
      'n_new',
      expect.objectContaining({ start: 16, end: 16 }),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('inserts into the current open note through the editor machine (undo/pause protected)', async () => {
    resetMocks()
    const insertFragment = vi.fn(async () => ({
      ok: true as const,
      noteId: 'n1',
      appliedRevision: 4,
      snapshotHash: HASH,
      insertedRange: { start: 4, end: 6 },
      replayed: false,
    }))
    const editor = editorHandle({ content: '当前正文', insertFragment })
    renderDialog({ editor })
    await waitFor(() =>
      expect((screen.getByTestId('excerpt-target-text') as HTMLTextAreaElement).value).toBe(
        '当前正文',
      ),
    )
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() => expect(insertFragment).toHaveBeenCalled())
    expect(insertFragment).toHaveBeenCalledWith(
      {
        target: { kind: 'cursor', position_utf16: 4 },
        source: expect.objectContaining({ source_kind: 'source', source_id: 'src_1' }),
      },
      { start: 4, end: 4 },
    )
    expect(onInserted).toHaveBeenCalledWith('n1', { start: 6, end: 6 })
  })

  it('reads an existing note fresh before inserting and uses that revision as CAS base', async () => {
    resetMocks()
    catalogItems = [note()]
    mockedGet.mockResolvedValueOnce(note())
    mockedInsert.mockResolvedValueOnce(receipt())
    mockedGet.mockResolvedValueOnce(note({ content: '目标正文[[cite:cb_1]]', revision: 6 }))
    renderDialog()
    fireEvent.click(screen.getByTestId('excerpt-target-existing'))
    fireEvent.click(screen.getByTestId('excerpt-target-note-n2'))
    await waitFor(() =>
      expect((screen.getByTestId('excerpt-target-text') as HTMLTextAreaElement).value).toBe(
        '目标正文',
      ),
    )
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() => expect(onInserted).toHaveBeenCalled())
    expect(mockedInsert).toHaveBeenCalledWith('p1', 'n2', {
      mutation_id: 'nm_test',
      expected_revision: 5,
      target: { kind: 'cursor', position_utf16: 4 },
      source: expect.objectContaining({ source_kind: 'source' }),
    })
    expect(mockedGet).toHaveBeenCalledTimes(2)
  })

  it('stops on a 409, re-reads the target and does not auto-retry the insert', async () => {
    resetMocks()
    catalogItems = [note()]
    mockedGet.mockResolvedValueOnce(note())
    mockedInsert.mockRejectedValueOnce({
      apiError: { code: 'note_revision_conflict', message: '', retryable: false, status: 409 },
    })
    mockedGet.mockResolvedValueOnce(note({ revision: 7 }))
    renderDialog()
    fireEvent.click(screen.getByTestId('excerpt-target-existing'))
    fireEvent.click(screen.getByTestId('excerpt-target-note-n2'))
    await waitFor(() =>
      expect((screen.getByTestId('excerpt-target-text') as HTMLTextAreaElement).value).toBe(
        '目标正文',
      ),
    )
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() => expect(screen.getByTestId('excerpt-target-error')).toBeInTheDocument())
    expect(mockedInsert).toHaveBeenCalledTimes(1)
    expect(mockedGet).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('excerpt-target-error').textContent).toContain(
      'research.notes.editor.errors.note_revision_conflict',
    )
  })

  it('keeps the same mutation id for an unknown result and retries only on demand', async () => {
    resetMocks()
    catalogItems = [note()]
    mockedGet.mockResolvedValueOnce(note())
    mockedInsert.mockRejectedValueOnce({
      apiError: { code: 'note_store_unavailable', message: '', retryable: true, status: 503 },
    })
    renderDialog()
    fireEvent.click(screen.getByTestId('excerpt-target-existing'))
    fireEvent.click(screen.getByTestId('excerpt-target-note-n2'))
    await waitFor(() =>
      expect((screen.getByTestId('excerpt-target-text') as HTMLTextAreaElement).value).toBe(
        '目标正文',
      ),
    )
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() =>
      expect(screen.getByTestId('excerpt-retry-same-mutation')).toBeInTheDocument(),
    )
    expect(mockedInsert).toHaveBeenCalledTimes(1)
    mockedInsert.mockResolvedValueOnce(receipt())
    mockedGet.mockResolvedValueOnce(note({ content: '目标正文[[cite:cb_1]]', revision: 6 }))
    fireEvent.click(screen.getByTestId('excerpt-retry-same-mutation'))
    await waitFor(() => expect(onInserted).toHaveBeenCalled())
    expect(mockedInsert).toHaveBeenCalledTimes(2)
    expect(mockedInsert.mock.calls[1][2]).toMatchObject({ mutation_id: 'nm_test' })
  })

  it('routes current-note unknown results to the editor confirmation, not a second direct POST', async () => {
    resetMocks()
    const insertFragment = vi.fn(async () => ({
      ok: false as const,
      code: 'note_store_unavailable' as const,
      retryable: true,
      pendingMutationId: 'nm_machine',
    }))
    const editor = editorHandle({ insertFragment })
    renderDialog({ editor })
    await waitFor(() =>
      expect((screen.getByTestId('excerpt-target-text') as HTMLTextAreaElement).value).toBe(
        '当前正文',
      ),
    )
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() =>
      expect(screen.getByTestId('excerpt-retry-same-mutation')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId('excerpt-retry-same-mutation'))
    await waitFor(() => expect(editor.actions.confirmPendingMutation).toHaveBeenCalled())
    expect(mockedInsert).not.toHaveBeenCalled()
  })

  it('uses the non-destructive flushForInsert for new/existing targets', async () => {
    resetMocks()
    mockedCreate.mockResolvedValueOnce(receipt({ note_id: 'n_new', applied_revision: 1 }))
    mockedGet.mockResolvedValueOnce(note({ note_id: 'n_new', content: '正文[[cite:cb_1]]', revision: 1 }))
    const editor = editorHandle()
    const flushForInsert = vi.mocked(editor.actions.flushForInsert as unknown as ReturnType<typeof vi.fn>)
    const flushBeforeLeave = vi.mocked(editor.actions.flushBeforeLeave as unknown as ReturnType<typeof vi.fn>)
    renderDialog({ editor })
    fireEvent.click(screen.getByTestId('excerpt-target-new'))
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() => expect(onInserted).toHaveBeenCalled())
    expect(flushForInsert).toHaveBeenCalledTimes(1)
    expect(flushBeforeLeave).not.toHaveBeenCalled()
  })

  it('maps a locally preserved draft to the explicit editorNotSaved error', async () => {
    resetMocks()
    const editor = editorHandle()
    ;(editor.actions.flushForInsert as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      'unsaved',
    )
    renderDialog({ editor })
    fireEvent.click(screen.getByTestId('excerpt-target-new'))
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() => expect(screen.getByTestId('excerpt-target-error')).toBeInTheDocument())
    expect(screen.getByTestId('excerpt-target-error').textContent).toContain(
      'research.notes.excerpt.errors.editorNotSaved',
    )
    expect(mockedCreate).not.toHaveBeenCalled()
  })

  it('retries only the read-back after create succeeds, never creating a second note', async () => {
    resetMocks()
    mockedCreate.mockResolvedValueOnce(receipt({ note_id: 'n_created', applied_revision: 1 }))
    mockedGet.mockRejectedValueOnce({
      apiError: { code: 'note_store_unavailable', message: '', retryable: false, status: 503 },
    })
    mockedGet.mockResolvedValueOnce(
      note({ note_id: 'n_created', content: '正文[[cite:cb_1]]', revision: 1 }),
    )
    renderDialog()
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() => expect(screen.getByTestId('excerpt-target-error')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('excerpt-insert'))
    await waitFor(() => expect(onInserted).toHaveBeenCalled())
    expect(mockedCreate).toHaveBeenCalledTimes(1)
    expect(mockedGet).toHaveBeenCalledTimes(2)
    expect(onInserted).toHaveBeenCalledWith('n_created', expect.anything())
  })
})
