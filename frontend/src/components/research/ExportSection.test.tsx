import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ExportSection } from './ExportSection'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import * as researchApi from '@/lib/research/api'

// UI-02 Red：导出（REQ-SCOPE-04/REQ-API-01，契约 §7.4）——Owner/Admin
// 均可导出（§4.4）；导出经 Gateway 创建 + 鉴权下载（无浏览器直连内部
// API）；审计由后端承担。

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

describe('ExportSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toastMock.mockClear()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:export'),
      revokeObjectURL: vi.fn(),
    })
  })

  it('Owner：导出创建 + 经 Gateway 鉴权下载（download_url 来自 export 响应）', async () => {
    vi.mocked(researchApi.createExport).mockResolvedValue({
      export_id: 'exp_1',
      project_id: 'proj_1',
      format: 'json',
      artifacts: ['note', 'insight', 'transformation_result'],
      created_at: '2026-08-06T02:00:00Z',
      download_url: '/v1/research/projects/proj_1/export/exp_1/file',
    })
    vi.mocked(researchApi.downloadExport).mockResolvedValue(new Blob(['{}']))
    const { wrapper } = makeWrapper()
    render(<ExportSection />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'research.workbench.exportAll' }))
    await waitFor(() => expect(researchApi.createExport).toHaveBeenCalledWith('proj_1'))
    await waitFor(() =>
      expect(researchApi.downloadExport).toHaveBeenCalledWith(
        'proj_1',
        '/v1/research/projects/proj_1/export/exp_1/file',
      ),
    )
  })

  it('Admin：导出按钮可用（§4.4：Admin 只读但可导出并审计）', async () => {
    vi.mocked(researchApi.createExport).mockResolvedValue({
      export_id: 'exp_2',
      project_id: 'proj_1',
      format: 'json',
      artifacts: ['note'],
      created_at: null,
      download_url: '/v1/research/projects/proj_1/export/exp_2/file',
    })
    vi.mocked(researchApi.downloadExport).mockResolvedValue(new Blob(['{}']))
    const { wrapper } = makeWrapper('admin_readonly')
    render(<ExportSection />, { wrapper })
    const button = screen.getByRole('button', { name: 'research.workbench.exportAll' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(researchApi.createExport).toHaveBeenCalledWith('proj_1'))
  })
})
