import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useResearchSources,
  useCreateResearchNote,
  useDeleteResearchNote,
  useRunResearchTransformation,
} from './use-research'
import * as researchApi from '@/lib/research/api'

// UI-02 Red：项目级 research hooks（REQ-API-01）——查询/写入全部经
// Gateway API 模块；mutation 失败（403 Admin 写拒绝）以 toast 呈现，
// 前端禁用不替代后端授权。

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

const toastMock = vi.fn()

vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { wrapper, queryClient }
}

const P = 'proj_1'

describe('use-research hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toastMock.mockClear()
  })

  it('useResearchSources 经 Gateway listSources 拉取项目 Source', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useResearchSources(P), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(researchApi.listSources).toHaveBeenCalledWith(P)
  })

  it('createNote mutation 调用 Gateway createNote（保存不触发 Embedding）', async () => {
    vi.mocked(researchApi.createNote).mockResolvedValue({
      note_id: 'note_1',
      project_id: P,
      title: 't',
      content: 'c',
      note_type: 'human',
      created_at: null,
      updated_at: null,
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateResearchNote(P), { wrapper })
    result.current.mutate({ title: 't', content: 'c' })
    await waitFor(() => expect(researchApi.createNote).toHaveBeenCalledWith(P, { title: 't', content: 'c' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('deleteNote mutation 调用 Gateway deleteNote', async () => {
    vi.mocked(researchApi.deleteNote).mockResolvedValue(undefined)
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useDeleteResearchNote(P), { wrapper })
    result.current.mutate('note_1')
    await waitFor(() => expect(researchApi.deleteNote).toHaveBeenCalledWith(P, 'note_1'))
  })

  it('runTransformation mutation 只调用 Gateway run 端点（REQ-DIS-02，无上游调用）', async () => {
    vi.mocked(researchApi.runTransformation).mockResolvedValue({
      request_id: 'req_1',
      transformation_id: 'trans_1',
      requires_job: false,
      degradation_reason: null,
      result_id: 'r_1',
      model_id: 'qwen3.6',
      source_refs: ['src_1'],
      usage: { input_tokens: 1, output_tokens: 1 },
      citations: [],
      output: 'out',
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useRunResearchTransformation(P), { wrapper })
    result.current.mutate({ transformationId: 'trans_1', sourceIds: ['src_1'], noteIds: [] })
    await waitFor(() =>
      expect(researchApi.runTransformation).toHaveBeenCalledWith(P, 'trans_1', {
        source_ids: ['src_1'],
        note_ids: [],
      }),
    )
    expect(researchApi.createTransformation).not.toHaveBeenCalled()
  })

  it('403 写入失败 → toast 呈现 adminWriteDenied（禁用按钮不替代后端授权）', async () => {
    vi.mocked(researchApi.createNote).mockRejectedValue({ response: { status: 403 } })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateResearchNote(P), { wrapper })
    result.current.mutate({ title: 't', content: 'c' })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'research.workbench.adminWriteDenied',
        variant: 'destructive',
      }),
    )
  })
})
