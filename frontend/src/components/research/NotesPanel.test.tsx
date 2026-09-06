import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NotesPanel } from './NotesPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, useResearchScope } from '@/lib/research/scope'
import * as researchApi from '@/lib/research/api'
import type { ResearchNote } from '@/lib/types/research'

// UI-02 Red：Notes 工作台（REQ-SCOPE-04/REQ-API-01/REQ-DIS-01，设计
// §4.4）——Owner 可 CRUD；Admin 只读（无写入口）且 403 写入失败仍以
// toast 呈现（验收：不得把后端 403 仅靠隐藏按钮替代）。
// RWV2-13（Issue #34）：行首复选框承担 Scope 选择；搜索/筛选只影响可见
// 行，不丢失隐藏选择；Edit/Delete 与选择互不干扰。

vi.mock('@/lib/research/api', () => ({
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

const note = (overrides: Partial<ResearchNote> = {}): ResearchNote => ({
  note_id: 'note_1',
  project_id: 'proj_1',
  title: '阅读笔记',
  content: '要点 A',
  note_type: 'human',
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
  ...overrides,
})

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role={role}>
        <ResearchScopeProvider userId="u1" projectId="proj_1">
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
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
    vi.clearAllMocks()
    toastMock.mockClear()
  })

  it('Owner：列表 + 新建表单提交 createNote（载荷仅 title/content，无 Embedding）', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note()], next_cursor: null })
    vi.mocked(researchApi.createNote).mockResolvedValue(note({ note_id: 'note_2' }))
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('阅读笔记')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.notes.newNote' }))
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), {
      target: { value: '新笔记' },
    })
    fireEvent.change(screen.getByLabelText('research.notes.contentLabel'), {
      target: { value: '新内容' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    await waitFor(() =>
      expect(researchApi.createNote).toHaveBeenCalledWith('proj_1', {
        title: '新笔记',
        content: '新内容',
      }),
    )
  })

  it('Owner：删除笔记调用 deleteNote', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note()], next_cursor: null })
    vi.mocked(researchApi.deleteNote).mockResolvedValue(undefined)
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('阅读笔记')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(researchApi.deleteNote).toHaveBeenCalledWith('proj_1', 'note_1'))
  })

  it('Owner：编辑笔记调用 PATCH updateNote（CRUD 完整，REQ-API-01）', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note()], next_cursor: null })
    vi.mocked(researchApi.updateNote).mockResolvedValue(note({ title: '改后标题' }))
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('阅读笔记')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.edit' }))
    const titleInput = screen.getByLabelText('research.notes.titleLabel')
    fireEvent.change(titleInput, { target: { value: '改后标题' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    await waitFor(() =>
      expect(researchApi.updateNote).toHaveBeenCalledWith('proj_1', 'note_1', {
        title: '改后标题',
        content: '要点 A',
      }),
    )
  })

  it('Admin：只读——无新建入口、无删除按钮，但列表可见', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note()], next_cursor: null })
    const { wrapper } = makeWrapper('admin_readonly')
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('阅读笔记')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'research.notes.newNote' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'research.notes.delete' })).toBeNull()
    // Admin 只读提示可见（角色数据源来自 Token claims，非本地猜测）
    expect(screen.getByText('research.workbench.adminBanner')).toBeInTheDocument()
  })

  it('搜索框输入经过 300ms 防抖后才触发带 q 的 Gateway 词法搜索', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listNotes).toHaveBeenCalled())
    const searchInput = screen.getByPlaceholderText('research.notes.search')
    fireEvent.change(searchInput, { target: { value: '蛋' } })
    fireEvent.change(searchInput, { target: { value: '蛋白' } })
    expect(researchApi.listNotes).not.toHaveBeenCalledWith(
      'proj_1',
      expect.objectContaining({ q: '蛋白' }),
    )
    await waitFor(() =>
      expect(researchApi.listNotes).toHaveBeenLastCalledWith(
        'proj_1',
        expect.objectContaining({ q: '蛋白', limit: 100 }),
      ),
    )
    expect(
      vi.mocked(researchApi.listNotes).mock.calls.filter(([, params]) => params?.q === '蛋白'),
    ).toHaveLength(1)
  })

  it('较旧搜索响应晚到时不会覆盖较新的搜索结果', async () => {
    let resolveOld: ((value: { items: ResearchNote[]; next_cursor: null }) => void) | undefined
    let resolveNew: ((value: { items: ResearchNote[]; next_cursor: null }) => void) | undefined
    vi.mocked(researchApi.listNotes).mockImplementation(async (_projectId, params = {}) => {
      if (params.q === 'old') {
        return new Promise((resolve) => { resolveOld = resolve })
      }
      if (params.q === 'new') {
        return new Promise((resolve) => { resolveNew = resolve })
      }
      return { items: [], next_cursor: null }
    })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    const searchInput = screen.getByPlaceholderText('research.notes.search')

    fireEvent.change(searchInput, { target: { value: 'old' } })
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'))
    fireEvent.change(searchInput, { target: { value: 'new' } })
    await waitFor(() => expect(resolveNew).toBeTypeOf('function'))
    await act(async () => {
      resolveNew?.({ items: [note({ note_id: 'new', title: 'New result' })], next_cursor: null })
    })
    expect(await screen.findByText('New result')).toBeInTheDocument()
    await act(async () => {
      resolveOld?.({ items: [note({ note_id: 'old', title: 'Old result' })], next_cursor: null })
    })
    expect(screen.getByText('New result')).toBeInTheDocument()
    expect(screen.queryByText('Old result')).toBeNull()
  })

  it('行首复选框进入/退出选中：写入 provider 并切换 selected 模式（左栏编辑）', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({
      items: [note(), note({ note_id: 'note_2', title: '第二篇' })],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(
      <>
        <NotesPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    const checkboxes = await screen.findAllByRole('checkbox')
    expect(checkboxes).toHaveLength(2)
    fireEvent.click(screen.getByTestId('note-scope-note_1'))
    expect(screen.getByTestId('probe-note-mode')).toHaveTextContent('selected')
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_1')
    fireEvent.click(screen.getByTestId('note-scope-note_2'))
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_1,note_2')
    fireEvent.click(screen.getByTestId('note-scope-note_2'))
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_1')
  })

  it('搜索/筛选不丢失隐藏选择：过滤后 provider 选择保持（RWV2-13 不变量）', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({
      items: [note({ note_id: 'note_1', title: '目标' }), note({ note_id: 'note_2', title: '其他' })],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    render(
      <>
        <NotesPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    await waitFor(() => expect(screen.getByTestId('note-scope-note_1')).toBeInTheDocument())
    // 选中两篇
    fireEvent.click(screen.getByTestId('note-scope-note_1'))
    fireEvent.click(screen.getByTestId('note-scope-note_2'))
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_1,note_2')
    // 搜索只剩「目标」：note_2 行被过滤（隐藏选择仍在 provider）
    vi.mocked(researchApi.listNotes).mockResolvedValue({
      items: [note({ note_id: 'note_1', title: '目标' })],
      next_cursor: null,
    })
    fireEvent.change(screen.getByPlaceholderText('research.notes.search'), {
      target: { value: '目标' },
    })
    await waitFor(() => {
      expect(screen.queryByTestId('note-scope-note_2')).toBeNull()
    })
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('note_1,note_2')
  })

  it('21 项分两批浏览，跨页选择保持且计数准确', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) =>
      note({ note_id: `n${index + 1}`, title: `Note ${index + 1}` }),
    )
    vi.mocked(researchApi.listNotes).mockImplementation(async (_projectId, params = {}) => {
      if (params.cursor === 'cursor_20') {
        return {
          items: [note({ note_id: 'n21', title: 'Note 21' })],
          next_cursor: null,
        }
      }
      return { items: firstPage, next_cursor: 'cursor_20' }
    })
    const { wrapper } = makeWrapper()
    render(
      <>
        <NotesPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )

    const rows = await screen.findByTestId('note-list-rows')
    await waitFor(() => expect(within(rows).getAllByRole('listitem')).toHaveLength(20))
    fireEvent.click(screen.getByTestId('note-scope-n1'))
    fireEvent.click(screen.getByRole('button', { name: 'research.pagination.loadMore' }))
    expect(within(rows).getAllByRole('listitem')).toHaveLength(21)
    fireEvent.click(screen.getByTestId('note-scope-n21'))
    expect(screen.getByTestId('probe-note-selected')).toHaveTextContent('n1,n21')
  })

  it('删除已选 Note 后保持 selected 模式、清理 ID 并显示 Scope 更新反馈', async () => {
    localStorage.setItem(
      'rdlens.research.scope.v1/u1/proj_1',
      JSON.stringify({ version: 1, mode: 'selected', sourceIds: [], noteIds: ['note_1'] }),
    )
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note()], next_cursor: null })
    vi.mocked(researchApi.deleteNote).mockResolvedValue(undefined)
    const { wrapper } = makeWrapper()
    render(
      <>
        <NotesPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    await screen.findByText('阅读笔记')
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))

    await waitFor(() => expect(screen.getByTestId('probe-note-selected')).toHaveTextContent(''))
    expect(screen.getByTestId('probe-note-mode')).toHaveTextContent('selected')
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'research.layout.scope.reconciled' }),
    )
  })

  it('加载失败显示重试且不伪装为空数据', async () => {
    vi.mocked(researchApi.listNotes)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })

    expect(await screen.findByText('research.workbench.loadFailed')).toBeInTheDocument()
    expect(screen.queryByText('research.notes.empty')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'research.retry' }))
    await waitFor(() => expect(screen.getByText('research.notes.empty')).toBeInTheDocument())
  })

  it('每行复选框带可访问名称且与 CRUD 按钮区分（aria-label 含标题）', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [note({ title: '阅读笔记' })], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    const checkbox = await screen.findByTestId('note-scope-note_1')
    expect(checkbox).toHaveAttribute('aria-label', 'research.notes.scopeSelect:阅读笔记')
    expect(checkbox).toHaveAttribute('role', 'checkbox')
    expect(screen.getByRole('button', { name: 'research.notes.edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'research.notes.delete' })).toBeInTheDocument()
  })
})
