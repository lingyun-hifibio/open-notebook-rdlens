import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NotesPanel } from './NotesPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, useResearchScope } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'
import { useNoteCatalog } from '@/lib/research/issue585/use-note-catalog'
import { useNoteCapabilities } from '@/lib/research/issue585/use-note-capabilities'
import { useNoteEditor } from '@/lib/research/issue585/use-note-editor'
import {
  clearNoteDraftMemoryFallback,
  readOrCreateNoteDraftTabId,
  removeNoteDraft,
  writeNoteDraft,
} from '@/lib/research/issue585/note-draft-cache'
import type {
  NoteCapabilities,
  NoteEditorActions,
  NoteEditorState,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'

// UI-02 Red：Notes 工作台（REQ-SCOPE-04/REQ-API-01/REQ-DIS-01，设计
// §4.4）——Owner 可 CRUD；Admin 只读（无写入口）且 403 写入失败仍以
// toast 呈现（验收：不得把后端 403 仅靠隐藏按钮替代）。
// RWV2-13（Issue #34）：行首复选框承担 Scope 选择；搜索/筛选只影响可见
// 行，不丢失隐藏选择；Edit/Delete 与选择互不干扰。
// Issue #1046 PR4（D2-B2）：目录改为 d2-v1 单源（useNoteCatalog），
// d2-v1 行走新编辑器、旧未保护 Note 保持旧表单；空白新建入口受
// capabilities.noteEditor.available 控制；能力故障不退回旧表单。
//
// 基线修复说明（Lead 已核实）：fork origin/main 上本文件 11 项红，根因是
// wrapper 未传 userId → owner 查询身份为 null → 列表查询 enabled=false。
// 本 PR 在 wrapper 补 userId="u1"（最小修复，不改既有断言语义）。

vi.mock('@/lib/research/api', () => ({
  saveResultFromResult: vi.fn(),
  listSources: vi.fn(),
  getSource: vi.fn(),
  listNotes: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  listInsights: vi.fn(),
  createInsight: vi.fn(),
  listTransformations: vi.fn(),
  createTransformation: vi.fn(),
  runTransformation: vi.fn(),
  createExport: vi.fn(),
  downloadExport: vi.fn(),
}))

const downloadLocalDraftMarkdownMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/research/issue585/note-download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/issue585/note-download')>()
  return { ...actual, downloadLocalDraftMarkdown: downloadLocalDraftMarkdownMock }
})

vi.mock('@/lib/research/issue585/use-note-catalog', () => ({
  useNoteCatalog: vi.fn(),
}))
vi.mock('@/lib/research/issue585/use-note-capabilities', () => ({
  useNoteCapabilities: vi.fn(),
}))
vi.mock('@/lib/research/issue585/use-note-editor', () => ({
  useNoteEditor: vi.fn(),
}))

// PR5/B3：页面级组合根的打开请求/目录刷新（Issue #1047 review M-2'）。
const workspaceMock = vi.hoisted(() => ({
  current: null as null | {
    pendingOpenNote?: { noteId: string; selection: { start: number; end: number } | null; seq: number } | null
    consumeOpenNote?: (seq: number) => void
    notesChangedSeq?: number
  },
}))
vi.mock('./issue585/NoteWorkspaceProvider', () => ({
  useNoteWorkspaceOptional: () => workspaceMock.current,
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.title ?? '')}` : key,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

const baseNote: Omit<ResearchNoteD2, 'note_id' | 'title' | 'content'> = {
  project_id: 'proj_1',
  note_type: 'human',
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
  revision: 3,
  snapshot_hash: 'hash-3',
  edit_schema: 'd2-v1',
  access_state: 'visible',
}

const d2Note = (overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 => ({
  ...baseNote,
  note_id: 'note_d2',
  title: '受保护笔记',
  content: '受保护正文',
  ...overrides,
})

const legacyNote = (overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 => ({
  ...baseNote,
  note_id: 'note_legacy',
  title: '旧笔记',
  content: '旧正文',
  revision: null,
  snapshot_hash: null,
  edit_schema: null,
  access_state: null,
  ...overrides,
})

const restrictedNote = (overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 =>
  d2Note({
    note_id: 'note_restricted',
    title: null as unknown as string,
    content: null as unknown as string,
    access_state: 'restricted',
    ...overrides,
  })

const allCapabilities = (overrides: Partial<NoteCapabilities> = {}): NoteCapabilities => ({
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
  ...overrides,
})

function makeEditorState(overrides: Partial<NoteEditorState> = {}): NoteEditorState {
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

function makeActions(overrides: Partial<NoteEditorActions> = {}): NoteEditorActions {
  return {
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
    ...overrides,
  }
}

const refreshCatalog = vi.fn(async () => undefined)
const refreshCapabilities = vi.fn(async () => undefined)

function stubCatalog(items: ResearchNoteD2[], overrides: Record<string, unknown> = {}) {
  vi.mocked(useNoteCatalog).mockReturnValue({
    items,
    isLoading: false,
    error: null,
    refresh: refreshCatalog,
    ...overrides,
  })
}

function stubCapabilities(
  capabilities: NoteCapabilities | null,
  overrides: Record<string, unknown> = {},
) {
  vi.mocked(useNoteCapabilities).mockReturnValue({
    capabilities,
    isLoading: false,
    error: null,
    refresh: refreshCapabilities,
    ...overrides,
  })
}

function stubEditor(state: Partial<NoteEditorState> = {}, actions: Partial<NoteEditorActions> = {}) {
  const editorState = makeEditorState(state)
  const editorActions = makeActions(actions)
  vi.mocked(useNoteEditor).mockReturnValue({ state: editorState, actions: editorActions })
  return { state: editorState, actions: editorActions }
}

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {/* 基线修复（PR4 前置）：owner 查询身份需要 userId，否则列表查询
          enabled=false（基线 11 项红，非本 PR 功能引入）。 */}
      {/* Issue #1136：已认证 shell 的 authGeneration≥1；可恢复草稿入口据此校验
          身份代际（与 PR4 草稿缓存读授权一致）。 */}
      <ResearchWorkspaceProvider projectId="proj_1" role={role} userId="u1" authGeneration={1}>
        <ResearchScopeProvider userId="u1" projectId="proj_1">
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

/** Issue #1136：在真实 PR4 草稿缓存里种一条“服务端保存未完成”的本地草稿。 */
const DRAFT_HASH = 'a'.repeat(64)

function seedRecoverableDraft(
  overrides: { noteId?: string; title?: string; projectId?: string; ownerId?: string } = {},
): void {
  const noteId = overrides.noteId ?? 'note_d2'
  const projectId = overrides.projectId ?? 'proj_1'
  const ownerId = overrides.ownerId ?? 'u1'
  writeNoteDraft(
    { ownerId, projectId, noteId, tabId: readOrCreateNoteDraftTabId() },
    {
      v: 1,
      ownerId,
      projectId,
      noteId,
      title: overrides.title ?? '受保护笔记',
      content: '本地未保存正文',
      baseRevision: 3,
      baseSnapshotHash: DRAFT_HASH,
      localSeq: 1,
      pendingMutation: null,
      savedAt: '2026-11-10T04:00:00.000Z',
    },
  )
}

function ScopeProbe() {
  const { mode, selectedNoteIds } = useResearchScope()
  return (
    <div>
      <span data-testid="probe-note-mode">{mode}</span>
      <span data-testid="probe-note-selected">{selectedNoteIds.join(',')}</span>
    </div>
  )
}

describe('NotesPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    clearNoteDraftMemoryFallback()
    vi.clearAllMocks()
    workspaceMock.current = null
    refreshCatalog.mockReset()
    refreshCatalog.mockImplementation(async () => undefined)
    refreshCapabilities.mockReset()
    refreshCapabilities.mockImplementation(async () => undefined)
    toastMock.mockClear()
    downloadLocalDraftMarkdownMock.mockClear()
    stubCatalog([d2Note(), legacyNote()])
    stubCapabilities(allCapabilities())
    stubEditor()
  })

  it('目录渲染 d2-v1 与旧未保护行：d2 行走新编辑器入口，旧行保留旧表单操作', async () => {
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('受保护笔记')).toBeInTheDocument())

    expect(screen.getByTestId('note-open-note_d2')).toBeInTheDocument()
    expect(screen.getByTestId('note-catalog-row-note_legacy')).toHaveAttribute(
      'data-edit-schema',
      'legacy',
    )
    expect(screen.getByRole('button', { name: 'research.notes.edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'research.notes.delete' })).toBeInTheDocument()
  })

  it('点击 d2-v1 行调用 openNote（新编辑器），旧未保护行不触发新编辑器', async () => {
    const { actions } = stubEditor()
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-open-note_d2')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('note-open-note_d2'))
    await waitFor(() => expect(actions.openNote).toHaveBeenCalledWith('note_d2'))
    expect(actions.openNote).not.toHaveBeenCalledWith('note_legacy')
  })

  it('搜索框输入经过 300ms 防抖后才以搜索词请求目录（词法搜索，不生成向量）', async () => {
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(useNoteCatalog).toHaveBeenCalled())

    const searchInput = screen.getByPlaceholderText('research.notes.search')
    fireEvent.change(searchInput, { target: { value: '蛋' } })
    fireEvent.change(searchInput, { target: { value: '蛋白' } })
    expect(useNoteCatalog).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: '蛋白' }),
    )
    await waitFor(() =>
      expect(useNoteCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: '蛋白' }),
      ),
    )
    expect(
      vi.mocked(useNoteCatalog).mock.calls.filter(([options]) => options.search === '蛋白'),
    ).toHaveLength(1)
  })

  it('空白新建入口在 capabilities.noteEditor.available 时创建并刷新目录', async () => {
    const { actions } = stubEditor({}, { createBlankNote: vi.fn(async () => 'note_new') })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-catalog-new')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('note-catalog-new'))
    await waitFor(() => expect(actions.createBlankNote).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(refreshCatalog).toHaveBeenCalledTimes(1))
  })

  it('note_editor 能力关闭时新建入口禁用并说明原因（开关只控制入口）', async () => {
    const { actions } = stubEditor()
    stubCapabilities(
      allCapabilities({
        noteEditor: { available: false, reason: 'disabled_by_flag' },
      }),
    )
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-catalog-new')).toBeInTheDocument())

    expect(screen.getByTestId('note-catalog-new')).toBeDisabled()
    expect(screen.getByTestId('note-catalog-new-blocked')).toHaveTextContent(
      'research.notes.catalog.createUnavailable',
    )
    fireEvent.click(screen.getByTestId('note-catalog-new'))
    expect(actions.createBlankNote).not.toHaveBeenCalled()
  })

  it('旧未保护 Note 编辑保持旧表单行为（PATCH updateNote，载荷 title/content）', async () => {
    vi.mocked(researchApi.updateNote).mockResolvedValue(
      d2Note({ note_id: 'note_legacy', title: '改后标题' }),
    )
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('旧笔记')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.notes.edit' }))
    expect(screen.getByTestId('legacy-note-form-hint')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), {
      target: { value: '改后标题' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    await waitFor(() =>
      expect(researchApi.updateNote).toHaveBeenCalledWith('proj_1', 'note_legacy', {
        title: '改后标题',
        content: '旧正文',
      }),
    )
  })

  it('旧表单写入 403：后端拒绝以 destructive toast 呈现（禁用入口不替代后端授权）', async () => {
    vi.mocked(researchApi.updateNote).mockRejectedValue({ response: { status: 403 } })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('旧笔记')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.notes.edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'common.error',
          description: 'research.workbench.adminWriteDenied',
          variant: 'destructive',
        }),
      ),
    )
  })

  it('旧未保护 Note 删除保持旧行为（deleteNote）', async () => {
    vi.mocked(researchApi.deleteNote).mockResolvedValue(undefined)
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('旧笔记')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.notes.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
    await waitFor(() =>
      expect(researchApi.deleteNote).toHaveBeenCalledWith('proj_1', 'note_legacy'),
    )
  })

  it('d2-v1 行不提供旧 Edit/Delete 入口（绝不退回无 revision 旧表单）', async () => {
    stubCatalog([d2Note()])
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-open-note_d2')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'research.notes.edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'research.notes.delete' })).toBeNull()
  })

  it('能力读取失败：显示阻断与重试，目录仍可见，旧表单与 d2 打开均不被静默退回', async () => {
    stubCapabilities(null, {
      error: { code: 'network_error', message: 'models down', retryable: true, status: 0 },
    })
    const { actions } = stubEditor()
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() =>
      expect(screen.getByTestId('note-capability-blocked')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('note-capability-blocked')).toHaveAttribute(
      'data-reason',
      'network_error',
    )
    // 旧未保护行仍可走旧表单（能力故障不影响旧行为）
    expect(screen.getByRole('button', { name: 'research.notes.edit' })).toBeInTheDocument()
    // d2-v1 行仍可请求打开；编辑器内部 fail-closed（不退回旧表单）
    fireEvent.click(screen.getByTestId('note-open-note_d2'))
    await waitFor(() => expect(actions.openNote).toHaveBeenCalledWith('note_d2'))
  })

  it('能力故障重试按钮调用能力 refresh', async () => {
    stubCapabilities(null, {
      error: { code: 'note_store_unavailable', message: 'store down', retryable: true, status: 503 },
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() =>
      expect(screen.getByTestId('note-capability-blocked')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.capability.retry' }))
    expect(refreshCapabilities).toHaveBeenCalledTimes(1)
  })

  it('打开 d2-v1 文档后渲染新编辑器；关闭调用 closeEditor', async () => {
    const { actions } = stubEditor({
      status: 'ready',
      note: d2Note(),
      title: '受保护笔记',
      content: '受保护正文',
      saveStatus: 'saved',
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-editor')).toBeInTheDocument())
    expect(screen.getByTestId('note-save-status')).toHaveAttribute('data-status', 'saved')
    fireEvent.click(screen.getByTestId('note-editor-close'))
    await waitFor(() => expect(actions.closeEditor).toHaveBeenCalledTimes(1))
  })

  it('目录加载中显示 loading（不渲染空态）', async () => {
    stubCatalog([], { isLoading: true })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    expect(await screen.findByTestId('note-catalog-loading')).toBeInTheDocument()
    expect(screen.queryByText('research.notes.empty')).toBeNull()
  })

  it('d2-v1 打开后恢复本地草稿：显示恢复横幅与待保存状态', async () => {
    stubEditor({
      status: 'ready',
      note: d2Note(),
      title: '恢复标题',
      content: '恢复正文',
      saveStatus: 'pending',
      restoredFromCache: true,
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-editor')).toBeInTheDocument())
    expect(screen.getByTestId('note-draft-recovery-banner')).toBeInTheDocument()
    expect(screen.getByTestId('note-draft-restored')).toBeInTheDocument()
    expect(screen.getByTestId('note-save-status')).toHaveAttribute('data-status', 'pending')
  })

  it('冲突状态弹出冲突对话框（复制/受保护另存/加载最新版，无合并/覆盖）', async () => {
    stubEditor({
      status: 'ready',
      note: d2Note(),
      title: '受保护笔记',
      content: '本地冲突正文',
      saveStatus: 'conflict',
      conflict: { currentRevision: 9, currentSnapshotHash: 'hash-9' },
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-conflict-dialog')).toBeInTheDocument())
    expect(screen.getByTestId('note-conflict-copy-local')).toBeInTheDocument()
    expect(screen.getByTestId('note-conflict-save-as-copy')).toBeInTheDocument()
    expect(screen.getByTestId('note-conflict-load-latest')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /merge|合并|overwrite|覆盖/i })).toBeNull()
  })

  it('离开被阻断时弹出离开保护对话框（重试/复制/下载/放弃）', async () => {
    stubEditor({
      status: 'ready',
      note: d2Note(),
      title: '受保护笔记',
      content: '未保存正文',
      saveStatus: 'unknown',
      pendingMutationId: 'mut_1',
      leaveBlockReason: 'unknown',
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() =>
      expect(screen.getByTestId('note-leave-guard-dialog')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('note-leave-retry')).toBeInTheDocument()
    expect(screen.getByTestId('note-leave-copy')).toBeInTheDocument()
    expect(screen.getByTestId('note-leave-download')).toBeInTheDocument()
    expect(screen.getByTestId('note-leave-discard')).toBeInTheDocument()
  })

  it('目录结果不本地缓存：搜索变化后只渲染 hook 当前返回值（旧结果不回填）', async () => {
    // 目录请求/缓存/乱序响应由 core `useNoteCatalog` + TanStack Query（按
    // search 分段 queryKey）负责；NotesPanel 只渲染 hook 当前返回值，不得
    // 自留旧结果（原「旧响应不覆盖新响应」断言在 PR4 移到该层验证）。
    vi.mocked(useNoteCatalog).mockImplementation((options) => ({
      items:
        options.search === 'old'
          ? [d2Note({ note_id: 'note_old', title: 'Old result' })]
          : options.search === 'new'
            ? [d2Note({ note_id: 'note_new', title: 'New result' })]
            : [],
      isLoading: false,
      error: null,
      refresh: refreshCatalog,
    }))
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    fireEvent.change(screen.getByPlaceholderText('research.notes.search'), {
      target: { value: 'old' },
    })
    await waitFor(() => expect(screen.getByText('Old result')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('research.notes.search'), {
      target: { value: 'new' },
    })
    await waitFor(() => expect(screen.getByText('New result')).toBeInTheDocument())
    expect(screen.queryByText('Old result')).toBeNull()
  })

  it('空白新建失败不静默：以 destructive toast 呈现最新错误原因（审查 A M2）', async () => {
    stubEditor({
      status: 'error',
      note: null,
      saveStatus: 'failed',
      error: { code: 'network_error', message: 'down', retryable: true, status: 0 },
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-catalog-new')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('note-catalog-new'))
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'common.error',
          description: 'research.notes.editor.errors.network_error',
          variant: 'destructive',
        }),
      ),
    )
    expect(refreshCatalog).not.toHaveBeenCalled()
  })

  it('阻断态（打开失败）可从目录关闭并重试打开当前 note（审查 A HIGH-1/M1）', async () => {
    const { actions } = stubEditor({
      status: 'error',
      note: null,
      saveStatus: 'failed',
      error: { code: 'network_error', message: 'down', retryable: true, status: 0 },
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-open-note_d2')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('note-open-note_d2'))
    await waitFor(() => expect(actions.openNote).toHaveBeenCalledWith('note_d2'))

    // 阻断视图提供重试（重试打开当前 note），且关闭出口可用（不是死胡同）
    fireEvent.click(screen.getByTestId('note-capability-retry'))
    await waitFor(() => expect(actions.openNote).toHaveBeenCalledTimes(2))
    expect(actions.openNote).toHaveBeenLastCalledWith('note_d2')

    fireEvent.click(screen.getByTestId('note-capability-close'))
    await waitFor(() => expect(actions.closeEditor).toHaveBeenCalledTimes(1))
  })

  it('NotesPanel 卸载时尽力 flush 未决保存/草稿（审查 A M3 最小缓解）', async () => {
    const { actions } = stubEditor()
    const { wrapper } = makeWrapper()
    const { unmount } = render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByTestId('note-catalog')).toBeInTheDocument())
    unmount()
    expect(actions.flushBeforeLeave).toHaveBeenCalledTimes(1)
  })

  it('受限成果只显示无标题占位（不泄露标题/正文）', async () => {
    stubCatalog([restrictedNote()])
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() =>
      expect(screen.getByTestId('note-catalog-restricted-note_restricted')).toBeInTheDocument(),
    )
    const row = screen.getByTestId('note-catalog-row-note_restricted')
    expect(row.textContent).not.toContain('受保护正文')
  })

  it('目录加载失败显示重试且不伪装为空数据', async () => {
    stubCatalog([], {
      error: { code: 'network_error', message: 'down', retryable: true, status: 0 },
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    expect(await screen.findByText('research.workbench.loadFailed')).toBeInTheDocument()
    expect(screen.queryByText('research.notes.empty')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.catalog.retry' }))
    expect(refreshCatalog).toHaveBeenCalledTimes(1)
  })

  it('目录为空时显示空态', async () => {
    stubCatalog([])
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    expect(await screen.findByText('research.notes.empty')).toBeInTheDocument()
  })

  it('Admin：只读——无新建/搜索/编辑/删除入口，但列表可见', async () => {
    const { wrapper } = makeWrapper('admin_readonly')
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('受保护笔记')).toBeInTheDocument())
    expect(screen.queryByTestId('note-catalog-new')).toBeNull()
    expect(screen.queryByPlaceholderText('research.notes.search')).toBeNull()
    expect(screen.queryByRole('button', { name: 'research.notes.delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'research.notes.edit' })).toBeNull()
    expect(screen.getByText('research.workbench.adminBanner')).toBeInTheDocument()
  })

  it('行首复选框进入/退出选中：写入 provider 并切换 selected 模式（左栏编辑）', async () => {
    stubCatalog([d2Note(), legacyNote({ note_id: 'note_2', title: '第二篇' })])
    const { wrapper } = makeWrapper()
    render(
      <>
        <NotesPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    await waitFor(() => expect(screen.getByTestId('note-scope-note_d2')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('note-scope-note_d2'))
    expect(screen.getByTestId('probe-note-mode')).toHaveTextContent('selected')
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_d2')
    fireEvent.click(screen.getByTestId('note-scope-note_2'))
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_d2,note_2')
    fireEvent.click(screen.getByTestId('note-scope-note_2'))
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_d2')
  })

  it('搜索/筛选不丢失隐藏选择：过滤后 provider 选择保持（RWV2-13 不变量）', async () => {
    stubCatalog([
      d2Note({ note_id: 'note_1', title: '目标' }),
      legacyNote({ note_id: 'note_2', title: '其他' }),
    ])
    const { wrapper } = makeWrapper()
    render(
      <>
        <NotesPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    await waitFor(() => expect(screen.getByTestId('note-scope-note_1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('note-scope-note_1'))
    fireEvent.click(screen.getByTestId('note-scope-note_2'))
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_1,note_2')

    // 搜索只剩「目标」：note_2 行被过滤（隐藏选择仍在 provider）
    stubCatalog([d2Note({ note_id: 'note_1', title: '目标' })])
    fireEvent.change(screen.getByPlaceholderText('research.notes.search'), {
      target: { value: '目标' },
    })
    await waitFor(() => {
      expect(screen.queryByTestId('note-scope-note_2')).toBeNull()
    })
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_1,note_2')
  })

  it('删除已选旧 Note 后保持 selected 模式、清理 ID 并显示 Scope 更新反馈', async () => {
    localStorage.setItem(
      'rdlens.research.scope.v1/u1/proj_1',
      JSON.stringify({ version: 1, mode: 'selected', sourceIds: [], noteIds: ['note_legacy'] }),
    )
    stubCatalog([legacyNote()])
    vi.mocked(researchApi.deleteNote).mockResolvedValue(undefined)
    const { wrapper } = makeWrapper()
    render(
      <>
        <NotesPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    await screen.findByText('旧笔记')
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))

    await waitFor(() => expect(screen.getByTestId('probe-note-selected')).toHaveTextContent(''))
    expect(screen.getByTestId('probe-note-mode')).toHaveTextContent('selected')
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'research.layout.scope.reconciled' }),
    )
  })

  it('revealSeq 变化时清除活跃搜索词（否则新 Note 会被过滤隐藏）', async () => {
    const { wrapper } = makeWrapper()
    const { rerender } = render(<NotesPanel revealSeq={1} />, { wrapper })
    const input = await screen.findByPlaceholderText('research.notes.search')
    fireEvent.change(input, { target: { value: '蛋白' } })
    expect(input).toHaveValue('蛋白')
    rerender(<NotesPanel revealSeq={2} />)
    await waitFor(() =>
      expect(screen.getByPlaceholderText('research.notes.search')).toHaveValue(''),
    )
  })

  it('每行复选框带可访问名称且与 CRUD 按钮区分（aria-label 含标题）', async () => {
    stubCatalog([legacyNote({ title: '旧笔记' })])
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    const checkbox = await screen.findByTestId('note-scope-note_legacy')
    expect(checkbox).toHaveAttribute('aria-label', 'research.notes.scopeSelect:旧笔记')
    expect(checkbox).toHaveAttribute('role', 'checkbox')
  })

  // ── Issue #1136：父级导航「自动保存＋可恢复」──────────────────────────────

  it('父级导航后回到 Notes 目录：服务端保存未完成的草稿显式列出并可打开', async () => {
    seedRecoverableDraft()
    const { actions } = stubEditor()
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    const inbox = await screen.findByTestId('note-recovery-inbox')
    expect(within(inbox).getByTestId('note-recovery-title-note_d2')).toHaveTextContent(
      '受保护笔记',
    )
    fireEvent.click(screen.getByTestId('note-recovery-open-note_d2'))
    await waitFor(() => expect(actions.openNote).toHaveBeenCalledWith('note_d2'))
  })

  it('没有待恢复草稿时不渲染恢复入口（避免噪声）', async () => {
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await screen.findByTestId('note-catalog')
    expect(screen.queryByTestId('note-recovery-inbox')).toBeNull()
  })

  it('编辑器已打开时不重复渲染恢复入口（打开后由编辑器恢复正文）', async () => {
    seedRecoverableDraft()
    stubEditor({ status: 'ready', note: d2Note() })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await screen.findByTestId('note-catalog')
    expect(screen.queryByTestId('note-recovery-inbox')).toBeNull()
  })

  it('Admin 只读会话不展示恢复入口（无编辑入口）', async () => {
    seedRecoverableDraft()
    const { wrapper } = makeWrapper('admin_readonly')
    render(<NotesPanel />, { wrapper })
    await screen.findByTestId('note-catalog')
    expect(screen.queryByTestId('note-recovery-inbox')).toBeNull()
  })

  it('其它项目/其它 owner 的草稿不会串到当前目录', async () => {
    seedRecoverableDraft({ projectId: 'proj_other' })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await screen.findByTestId('note-catalog')
    expect(screen.queryByTestId('note-recovery-inbox')).toBeNull()
  })

  it('保存完成后草稿清理，恢复入口随之消失（不残留旧提示）', async () => {
    seedRecoverableDraft()
    const { wrapper } = makeWrapper()
    const { rerender } = render(<NotesPanel />, { wrapper })
    // 先断言入口确实出现（否则“消失”断言在无实现时也恒真）。
    expect(await screen.findByTestId('note-recovery-inbox')).toBeInTheDocument()

    // ACK 成功后 PR4 writeCache 删除该草稿；模拟草稿已清理后的目录重扫。
    removeNoteDraft({
      ownerId: 'u1',
      projectId: 'proj_1',
      noteId: 'note_d2',
      tabId: readOrCreateNoteDraftTabId(),
    })
    stubEditor({ status: 'idle', note: null, saveStatus: 'saved' })
    rerender(<NotesPanel />)
    await waitFor(() => expect(screen.queryByTestId('note-recovery-inbox')).toBeNull())
  })

  it('打开失败（离线/503）时恢复入口仍可见，且阻断视图 Close 不删除唯一草稿（HIGH-1）', async () => {
    seedRecoverableDraft()
    const { actions } = stubEditor({
      status: 'error',
      note: null,
      saveStatus: 'failed',
      error: { code: 'network_error', message: '', retryable: true, status: 0 },
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    // 打开失败：编辑器进入未加载阻断态，但恢复入口必须仍可见（否则用户
    // 连“还有草稿”都看不到）。
    expect(await screen.findByTestId('note-recovery-inbox')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('note-capability-close'))

    // Close 只是关闭错误视图：不得静默 discardLocal 删除唯一持久草稿。
    // （mock 编辑器不写存储，故这里只钉包装后的可观察契约；真实状态机下
    // “草稿 key 保留”由独立审查 round-2 的 machine/UI 探针验证。）
    expect(actions.discardLocal).not.toHaveBeenCalled()
    expect(actions.closeEditor).toHaveBeenCalled()
  })

  it('404 + 仅空白草稿：与状态机同口径判“有本地文本”，关闭不再锁死（round-3 MEDIUM-1 回归）', async () => {
    seedRecoverableDraft()
    const { actions } = stubEditor({
      status: 'error',
      note: null,
      saveStatus: 'failed',
      blockReason: 'note_not_found',
      // 只有空白：NoteEditorView 的 trim 判空不会弹二次确认，但 machine 的
      // hasUnsyncedLocalText 视为未同步文本；wrapper 必须用严格长度允许放弃。
      title: '   ',
      content: '',
      error: { code: 'note_not_found', message: '', retryable: false, status: 404 },
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    fireEvent.click(await screen.findByTestId('note-capability-close'))
    expect(actions.discardLocal).toHaveBeenCalledTimes(1)
    expect(actions.closeEditor).toHaveBeenCalled()
  })

  it('404 + 本地草稿：阻断态 Close 二次确认后可显式放弃（round-2 HIGH 回归）', async () => {
    seedRecoverableDraft()
    const { actions } = stubEditor({
      status: 'error',
      note: null,
      saveStatus: 'failed',
      blockReason: 'note_not_found',
      title: '本地草稿标题',
      content: '本地草稿正文',
      error: { code: 'note_not_found', message: '', retryable: false, status: 404 },
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    // note_not_found 会把本地草稿回填进编辑器（有本地文本）⇒ Close 先二次确认，
    // 确认后必须真正 discardLocal（PR4 显式放弃语义），不得被“打开失败 no-op”
    // 锁死（否则既不能关闭、也不能切换笔记）。
    fireEvent.click(await screen.findByTestId('note-capability-close'))
    expect(actions.discardLocal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('note-capability-close-confirm-action'))
    expect(actions.discardLocal).toHaveBeenCalledTimes(1)
    expect(actions.closeEditor).toHaveBeenCalled()
  })

  it('恢复入口提供复制/下载本地草稿（不打开编辑器也能取回，HIGH-1）', async () => {
    seedRecoverableDraft()
    stubEditor()
    const clipboardWrite = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWrite },
      configurable: true,
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    await screen.findByTestId('note-recovery-inbox')
    fireEvent.click(screen.getByTestId('note-recovery-copy-note_d2'))
    expect(clipboardWrite).toHaveBeenCalledWith('本地未保存正文')
    fireEvent.click(screen.getByTestId('note-recovery-download-note_d2'))
    expect(downloadLocalDraftMarkdownMock).toHaveBeenCalledWith({
      title: '受保护笔记',
      content: '本地未保存正文',
      noteId: 'note_d2',
      savedAt: '2026-11-10T04:00:00.000Z',
    })
  })

  it('目录中已确认 restricted 的草稿标题脱敏且不提供取回动作（MEDIUM-2）', async () => {
    seedRecoverableDraft()
    stubCatalog([d2Note({ note_id: 'note_d2', access_state: 'restricted' })])
    stubEditor()
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    await screen.findByTestId('note-recovery-inbox')
    const title = screen.getByTestId('note-recovery-title-note_d2')
    expect(title).toHaveTextContent('research.notes.catalog.restricted')
    expect(title).not.toHaveTextContent('受保护笔记')
    expect(screen.queryByTestId('note-recovery-copy-note_d2')).toBeNull()
    expect(screen.queryByTestId('note-recovery-download-note_d2')).toBeNull()
  })

  it('消费摘入后的打开请求：openNote 目标文档并刷新目录', async () => {
    const { actions } = stubEditor()
    const consumeOpenNote = vi.fn()
    workspaceMock.current = {
      pendingOpenNote: { noteId: 'note_d2', selection: { start: 2, end: 4 }, seq: 7 },
      consumeOpenNote,
      notesChangedSeq: 0,
    }
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    await waitFor(() => expect(actions.openNote).toHaveBeenCalledWith('note_d2'))
    await waitFor(() => expect(consumeOpenNote).toHaveBeenCalledWith(7))
    await waitFor(() => expect(refreshCatalog).toHaveBeenCalled())
  })
})
