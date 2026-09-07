import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useResearchSources,
  useResearchNotes,
  useCreateResearchNote,
  useDeleteResearchNote,
  useRunResearchTransformation,
  useResearchTransformationResults,
  useTransformationResult,
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
  listTransformationResults: vi.fn(),
  getTransformationResult: vi.fn(),
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
    const { wrapper, queryClient } = makeWrapper()
    const resultsKey = ['research', P, 'transformation-results']
    queryClient.setQueryData(resultsKey, { pages: [{ items: [], next_cursor: null }], pageParams: [undefined] })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
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
    // Medium-7：成功后只失效 results key，使新行在历史列表可见
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: resultsKey, exact: true }),
      )
    })
  })

  it('Rerun 允许传入显式幂等键（新建派发；复用旧 key 会被后端幂等重放）', async () => {
    vi.mocked(researchApi.runTransformation).mockResolvedValue({
      request_id: 'req_2',
      transformation_id: 'trans_1',
      requires_job: false,
      degradation_reason: null,
      result_id: 'r_2',
      model_id: 'm-global',
      source_refs: ['src_1'],
      usage: { input_tokens: 1, output_tokens: 1 },
      citations: [],
      output: 'out2',
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useRunResearchTransformation(P), { wrapper })
    result.current.mutate({
      transformationId: 'trans_1', sourceIds: ['src_1'], noteIds: [], modelId: 'm-global',
      idempotencyKey: 'ui-key-rerun-1',
    })
    await waitFor(() =>
      expect(researchApi.runTransformation).toHaveBeenCalledWith(P, 'trans_1', {
        source_ids: ['src_1'], note_ids: [], model_id: 'm-global',
      }, { idempotencyKey: 'ui-key-rerun-1' }),
    )
  })

  it('useResearchTransformationResults：首屏 20 + Load more 第 2 页（服务端游标，2 次调用、无重复）', async () => {
    const results = Array.from({ length: 21 }, (_, i) => ({
      result_id: `tres_${String(i + 1).padStart(2, '0')}`,
      project_id: P,
      title: `Run ${i + 1}`,
      transformation_id: 'trans_1',
      template_config_ref: 'cfg',
      generation_id: 'gen_1',
      model_id: 'm-global',
      status: 'completed',
      response_language: null,
      source_ids: ['src_1'],
      note_ids: [],
      source_refs: ['src_1'],
      output: `out ${i + 1}`,
      citations: [],
      created_at: `2026-09-07T00:00:${String(i).padStart(2, '0')}Z`,
      updated_at: null,
    }))
    vi.mocked(researchApi.listTransformationResults).mockResolvedValueOnce({
      items: results.slice(0, 20),
      next_cursor: 'cursor-21',
    }).mockResolvedValueOnce({
      items: results.slice(20),
      next_cursor: null,
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useResearchTransformationResults(P), { wrapper })
    await waitFor(() => {
      const first = result.current.data?.pages.flatMap((p) => p.items) ?? []
      expect(first).toHaveLength(20)
    })
    expect(researchApi.listTransformationResults).toHaveBeenCalledTimes(1)
    const first = result.current.data?.pages.flatMap((p) => p.items) ?? []
    expect(first).toHaveLength(20)
    expect(result.current.hasNextPage).toBe(true)
    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(researchApi.listTransformationResults).toHaveBeenCalledTimes(2))
    const secondCall = vi.mocked(researchApi.listTransformationResults).mock.calls[1]
    expect(secondCall[1]).toEqual({ limit: 20, cursor: 'cursor-21' })
    const all = result.current.data?.pages.flatMap((p) => p.items) ?? []
    expect(all).toHaveLength(21)
    expect(new Set(all.map((r) => r.result_id)).size).toBe(21)
    expect(result.current.hasNextPage).toBe(false)
  })

  it('useTransformationResult：by-id 详情，projectId/null 时禁用', async () => {
    vi.mocked(researchApi.getTransformationResult).mockResolvedValue({
      result_id: 'tres_42', project_id: P, title: 't',
      transformation_id: 'trans_1', template_config_ref: 'c', generation_id: 'g',
      model_id: 'm', status: 'completed', response_language: null,
      source_ids: [], note_ids: [], source_refs: [],
      output: 'o', citations: [], created_at: null, updated_at: null,
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(
      () => useTransformationResult('', 'tres_42'),
      { wrapper },
    )
    await waitFor(() => expect(result.current.isFetching).toBe(false))
    expect(researchApi.getTransformationResult).not.toHaveBeenCalled()
    const { result: enabled } = renderHook(
      () => useTransformationResult(P, 'tres_42'),
      { wrapper },
    )
    await waitFor(() => expect(researchApi.getTransformationResult).toHaveBeenCalledWith(P, 'tres_42'))
    expect(enabled.current.data?.result_id).toBe('tres_42')
  })

  it('RWV2-35：useRunResearchTransformation 显式 responseLanguage 直通 runTransformation（双语变体选择）', async () => {
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
      responseLanguage: 'zh',
    })
    await waitFor(() =>
      expect(researchApi.runTransformation).toHaveBeenCalledWith(P, 'trans_1', {
        source_ids: ['src_1'],
        note_ids: [],
        model_id: 'm-global',
        response_language: 'zh',
      }),
    )
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

  it('RWV2-42（M2）：403 带稳定码（consent/policy 拒绝）→ 映射文案，不误标 Admin 只读', async () => {
    vi.mocked(researchApi.createNote).mockRejectedValue({
      response: {
        status: 403,
        data: { detail: { code: 'policy_denied', message: 'egress policy' } },
      },
    })
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useCreateResearchNote(P), { wrapper })
    result.current.mutate({ title: 't', content: 'c' })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'research.errors.policyDenied',
        variant: 'destructive',
      }),
    )
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ description: 'research.workbench.adminWriteDenied' }),
    )
  })
})
