import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useResearchSources,
  useResearchNotes,
  useCreateResearchNote,
  useDeleteResearchNote,
  useRunResearchTransformation,
  RESEARCH_SOURCE_REFRESH_MS,
} from './use-research'
import * as researchApi from '@/lib/research/api'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'

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

const source = (index: number): ResearchSource => ({
  source_id: `src_${index}`,
  document_id: `doc_${index}`,
  document_version: 'v1',
  status: 'ready',
  content_hash: null,
  synced_at: null,
  last_error: null,
})

const note = (index: number): ResearchNote => ({
  note_id: `note_${index}`,
  project_id: P,
  title: `Note ${index}`,
  content: `Body ${index}`,
  note_type: 'human',
  created_at: null,
  updated_at: null,
})

describe('use-research hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toastMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('useResearchSources 经 Gateway listSources 拉取项目 Source', async () => {
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useResearchSources(P), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(researchApi.listSources).toHaveBeenCalledWith(
      P,
      { limit: 100 },
      expect.any(AbortSignal),
    )
  })

  it('useResearchSources follows every cursor and exposes more than 100 sources in one shared cache', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => source(index + 1))
    vi.mocked(researchApi.listSources).mockImplementation(async (_projectId, params = {}) => {
      if (params.cursor === 'cursor_100') {
        return { items: [source(101)], next_cursor: null }
      }
      return { items: firstPage, next_cursor: 'cursor_100' }
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useResearchSources(P), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.items).toHaveLength(101)
    expect(researchApi.listSources).toHaveBeenNthCalledWith(
      1,
      P,
      { limit: 100 },
      expect.any(AbortSignal),
    )
    expect(researchApi.listSources).toHaveBeenNthCalledWith(2, P, {
      cursor: 'cursor_100',
      limit: 100,
    }, expect.any(AbortSignal))
  })

  it('active source consumers automatically observe status transitions', async () => {
    vi.useFakeTimers()
    vi.mocked(researchApi.listSources)
      .mockResolvedValueOnce({ items: [source(1)], next_cursor: null })
      .mockResolvedValueOnce({
        items: [{ ...source(1), status: 'failed', last_error: 'sync failed' }],
        next_cursor: null,
      })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useResearchSources(P), { wrapper })

    await vi.waitFor(() => expect(result.current.data?.items[0]?.status).toBe('ready'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESEARCH_SOURCE_REFRESH_MS)
    })
    await vi.waitFor(() => expect(result.current.data?.items[0]?.status).toBe('failed'))
    expect(researchApi.listSources).toHaveBeenCalledTimes(2)
  })

  it('useResearchNotes follows search result cursors without losing the query', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => note(index + 1))
    vi.mocked(researchApi.listNotes).mockImplementation(async (_projectId, params = {}) => {
      if (params.cursor === 'cursor_20') {
        return { items: [note(21)], next_cursor: null }
      }
      return { items: firstPage, next_cursor: 'cursor_20' }
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useResearchNotes(P, 'kinase'), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.items).toHaveLength(21)
    expect(researchApi.listNotes).toHaveBeenNthCalledWith(1, P, {
      q: 'kinase',
      limit: 100,
    }, expect.any(AbortSignal))
    expect(researchApi.listNotes).toHaveBeenNthCalledWith(2, P, {
      q: 'kinase',
      cursor: 'cursor_20',
      limit: 100,
    }, expect.any(AbortSignal))
  })

  it('note mutation invalidation refreshes unfiltered and searched scope consumers', async () => {
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.deleteNote).mockResolvedValue(undefined)
    const { wrapper } = makeWrapper()
    const unfiltered = renderHook(() => useResearchNotes(P), { wrapper })
    const searched = renderHook(() => useResearchNotes(P, 'target'), { wrapper })
    await waitFor(() => expect(researchApi.listNotes).toHaveBeenCalledTimes(2))

    const mutation = renderHook(() => useDeleteResearchNote(P), { wrapper })
    mutation.result.current.mutate('note_1')

    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true))
    await waitFor(() => expect(researchApi.listNotes).toHaveBeenCalledTimes(4))
    expect(unfiltered.result.current.isSuccess).toBe(true)
    expect(searched.result.current.isSuccess).toBe(true)
  })

  it('delete cancels an older search so its late response cannot restore a deleted note', async () => {
    let resolveOld: ((page: { items: ResearchNote[]; next_cursor: null }) => void) | undefined
    let oldSignal: AbortSignal | undefined
    vi.mocked(researchApi.listNotes).mockImplementation((_projectId, _params, signal) => {
      if (resolveOld === undefined) {
        oldSignal = signal
        return new Promise((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve({ items: [], next_cursor: null })
    })
    vi.mocked(researchApi.deleteNote).mockResolvedValue(undefined)
    const { wrapper, queryClient } = makeWrapper()
    renderHook(() => useResearchNotes(P, 'deleted'), { wrapper })
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'))

    const mutation = renderHook(() => useDeleteResearchNote(P), { wrapper })
    mutation.result.current.mutate('note_1')
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true))
    expect(oldSignal?.aborted).toBe(true)

    await act(async () => {
      resolveOld?.({ items: [note(1)], next_cursor: null })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(queryClient.getQueryData<{ items: ResearchNote[] }>([
        'research', P, 'notes', 'deleted',
      ])?.items).toEqual([])
    })
  })

  it('delete also cancels a search started while the mutation is in flight', async () => {
    let resolveDelete: (() => void) | undefined
    let resolveSearch: ((page: { items: ResearchNote[]; next_cursor: null }) => void) | undefined
    let searchSignal: AbortSignal | undefined
    let searchCalls = 0
    vi.mocked(researchApi.deleteNote).mockImplementation(() => new Promise<void>((resolve) => {
      resolveDelete = resolve
    }))
    vi.mocked(researchApi.listNotes).mockImplementation((_projectId, _params, signal) => {
      searchCalls += 1
      if (searchCalls === 1) {
        searchSignal = signal
        return new Promise((resolve) => { resolveSearch = resolve })
      }
      return Promise.resolve({ items: [], next_cursor: null })
    })
    const { wrapper, queryClient } = makeWrapper()
    const mutation = renderHook(() => useDeleteResearchNote(P), { wrapper })
    mutation.result.current.mutate('note_1')
    await waitFor(() => expect(resolveDelete).toBeTypeOf('function'))

    renderHook(() => useResearchNotes(P, 'during-delete'), { wrapper })
    await waitFor(() => expect(resolveSearch).toBeTypeOf('function'))
    await act(async () => {
      resolveDelete?.()
    })

    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true))
    expect(searchSignal?.aborted).toBe(true)
    expect(searchCalls).toBe(2)
    await act(async () => {
      resolveSearch?.({ items: [note(1)], next_cursor: null })
      await Promise.resolve()
    })
    expect(queryClient.getQueryData<{ items: ResearchNote[] }>([
      'research', P, 'notes', 'during-delete',
    ])?.items).toEqual([])
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
    result.current.mutate({
      transformationId: 'trans_1',
      sourceIds: ['src_1'],
      noteIds: [],
      modelId: 'm-global',
    })
    await waitFor(() =>
      expect(researchApi.runTransformation).toHaveBeenCalledWith(P, 'trans_1', {
        source_ids: ['src_1'],
        note_ids: [],
        model_id: 'm-global',
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
