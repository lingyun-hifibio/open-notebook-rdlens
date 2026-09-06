import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TransformationsPanel } from './TransformationsPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { resetGlobalModelStub } from '@/test/global-model-stub'
import * as researchApi from '@/lib/research/api'

// RWV2-12 防御分支（F6/R3）：selected 空态在 provider 不变量下 UI 不可达
// （toggle 拒删最后一项 / setMode 守卫 / restoreScope 丢弃空态），但面板
// 仍须防御性阻断并英文引导——本文件以模块级 mock 强制「selected 且 0 项」
// 状态，锁定该防御契约（RWV2-14 删除清理落地后此状态将可能真实可达）。
// 独立文件：避免 vi.mock 整个 scope 模块污染主测试文件的真实 provider 用例。

vi.mock('@/lib/research/scope', () => ({
  useResearchScope: () => ({
    mode: 'selected',
    selectedSourceIds: [],
    selectedNoteIds: [],
    validate: () => ({ valid: false, reason: 'empty_selected_scope' }),
    getSnapshot: () => ({ mode: 'selected', sourceIds: [], noteIds: [] }),
  }),
}))

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

vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId="proj_1" role="owner">
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('TransformationsPanel scope-guard（selected 空态防御分支）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toastMock.mockClear()
    resetGlobalModelStub()
    vi.mocked(researchApi.listTransformations).mockResolvedValue({
      items: [{
        transformation_id: 'trans_1',
        project_id: 'proj_1',
        name: '总结模板',
        prompt_template: '请总结：',
        model_id: 'qwen3.6-35b-a3b-fp8',
        scope: 'project_private',
        created_at: '2026-08-06T02:00:00Z',
      }],
      next_cursor: null,
    })
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
  })

  it('selected 且 0 项：Confirm 禁用 + 英文引导（emptyScopeBlocked），点击不派发', async () => {
    const { wrapper } = makeWrapper()
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-empty-scope-blocked')).toHaveTextContent(
        'research.transformations.emptyScopeBlocked',
      ),
    )
    const confirmButton = screen.getByRole('button', { name: 'research.transformations.confirmRun' })
    expect(confirmButton).toBeDisabled()
    fireEvent.click(confirmButton)
    expect(researchApi.runTransformation).not.toHaveBeenCalled()
  })
})