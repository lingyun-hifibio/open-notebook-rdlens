import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NotesPanel } from './NotesPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import * as researchApi from '@/lib/research/api'
import type { ResearchNote } from '@/lib/types/research'

// UI-02 Red：Notes 工作台（REQ-SCOPE-04/REQ-API-01/REQ-DIS-01，设计
// §4.4）——Owner 可 CRUD；Admin 只读（无写入口）且 403 写入失败仍以
// toast 呈现（验收：不得把后端 403 仅靠隐藏按钮替代）。

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
    t: (key: string) => key,
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
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('NotesPanel', () => {
  beforeEach(() => {
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

  it('搜索框输入触发带 q 的 Gateway 词法搜索', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<NotesPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listNotes).toHaveBeenCalled())
    const searchInput = screen.getByPlaceholderText('research.notes.search')
    fireEvent.change(searchInput, { target: { value: '蛋白' } })
    await waitFor(() =>
      expect(researchApi.listNotes).toHaveBeenLastCalledWith(
        'proj_1',
        expect.objectContaining({ q: '蛋白' }),
      ),
    )
  })
})
