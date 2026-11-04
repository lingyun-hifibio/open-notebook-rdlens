/**
 * 搜索历史 hook 测试（Issue #1014 / D1-F 主单 §5.2）。
 *
 * 覆盖：能力位严格 true/false；列表 useInfiniteQuery 游标分页；详情按 id
 * 启用；工作台身份段的查询键（owner viewer + authGeneration）；读取错误
 * `retry: false`（不重试风暴）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import {
  useResearchSearchHistoryCapability,
  useResearchSearchRecord,
  useResearchSearchRecords,
} from './use-research-search-records'
import { getSearchRecord, listModels, listSearchRecords } from '@/lib/research/api'
import type {
  ResearchSearchRecordDetail,
  ResearchSearchRecordListItem,
  ResearchSearchRecordPage,
} from '@/lib/research/types'

vi.mock('@/lib/research/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...original,
    listModels: vi.fn(),
    listSearchRecords: vi.fn(),
    getSearchRecord: vi.fn(),
  }
})

function listItem(recordId: string, query: string): ResearchSearchRecordListItem {
  return {
    schema_version: 'd1f-search-record-v1',
    record_id: recordId,
    generation_id: recordId,
    created_at: '2026-11-04T10:00:00+00:00',
    completed_at: null,
    query,
    outcome: 'no_hit',
    outcome_detail: 'source_evidence_empty',
    generation_state: 'completed',
    requested_mode: 'auto',
    resolved_mode: 'hybrid_rag',
    context_level: 'focused',
    hit_count: 0,
    scope_mode: 'selected',
    source_total: 1,
    failure_code: null,
    degradation_codes: [],
  }
}

const DETAIL: ResearchSearchRecordDetail = {
  schema_version: 'd1f-search-record-v1',
  record_id: 'gen_1',
  generation_id: 'gen_1',
  created_at: '2026-11-04T10:00:00+00:00',
  completed_at: null,
  query: 'q1',
  outcome: 'no_hit',
  outcome_detail: 'source_evidence_empty',
  generation_state: 'completed',
  requested_mode: 'auto',
  resolved_mode: 'hybrid_rag',
  context_level: 'focused',
  hit_count: 0,
  scope: null,
  source_counts: { total: 0, visible: 0, restricted: 0 },
  sources: [],
  conclusion: { text: null, truncated: false },
  degradations: [],
  degradation_schema_version: null,
  failure: null,
  coverage: null,
  record_visibility: 'visible',
  warnings: [],
  result_available: null,
  hits: null,
  citations: null,
  model: null,
}

let queryClient: QueryClient

function ownerWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider
        projectId="p1"
        role="owner"
        userId="u1"
        authGeneration={3}
      >
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

describe('useResearchSearchHistoryCapability', () => {
  it('capabilities.search_history 严格 true → 启用', async () => {
    vi.mocked(listModels).mockResolvedValue({
      models: [],
      capabilities: { search_history: true },
    })
    const { result } = renderHook(
      () => useResearchSearchHistoryCapability('p1'),
      { wrapper: ownerWrapper },
    )
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('缺失/非法/false → 关闭（fail-closed）', async () => {
    vi.mocked(listModels).mockResolvedValue({
      models: [],
      capabilities: { search_history: 'true' as unknown as boolean },
    })
    const { result } = renderHook(
      () => useResearchSearchHistoryCapability('p1'),
      { wrapper: ownerWrapper },
    )
    await waitFor(() => expect(listModels).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })
})

describe('useResearchSearchRecords', () => {
  it('游标分页：首屏一页，fetchNextPage 追加第二页', async () => {
    const page1: ResearchSearchRecordPage = {
      schema_version: 'd1f-search-record-list-v1',
      items: [listItem('gen_1', 'first')],
      next_cursor: 'cursor_2',
    }
    const page2: ResearchSearchRecordPage = {
      schema_version: 'd1f-search-record-list-v1',
      items: [listItem('gen_2', 'second')],
      next_cursor: null,
    }
    vi.mocked(listSearchRecords)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)

    const { result } = renderHook(() => useResearchSearchRecords('p1'), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1))
    expect(result.current.hasNextPage).toBe(true)
    expect(listSearchRecords).toHaveBeenCalledWith('p1', { limit: 20 })

    await act(async () => {
      await result.current.fetchNextPage()
    })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2))
    expect(listSearchRecords).toHaveBeenLastCalledWith('p1', {
      limit: 20,
      cursor: 'cursor_2',
    })
    expect(result.current.hasNextPage).toBe(false)
  })

  it('工作台内使用带身份段的查询键（owner + authGeneration）', async () => {
    vi.mocked(listSearchRecords).mockResolvedValue({
      schema_version: 'd1f-search-record-list-v1',
      items: [],
      next_cursor: null,
    })
    const { result } = renderHook(() => useResearchSearchRecords('p1'), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const keys = queryClient.getQueryCache().getAll().map((query) => query.queryKey)
    const key = keys.find((candidate) => candidate.includes('search-records'))
    expect(key).toBeDefined()
    const identity = key?.[key.length - 1] as {
      kind?: string
      role?: string
      viewerUserId?: string
      authGeneration?: number
    }
    expect(identity.kind).toBe('research-identity')
    expect(identity.role).toBe('owner')
    expect(identity.viewerUserId).toBe('u1')
    expect(identity.authGeneration).toBe(3)
  })

  it('503 search_record_not_enabled 只请求一次（retry: false，不重试风暴）', async () => {
    vi.mocked(listSearchRecords).mockRejectedValue(
      Object.assign(new Error('not enabled'), {
        response: {
          status: 503,
          data: { detail: { code: 'search_record_not_enabled' } },
        },
      }),
    )
    const { result } = renderHook(() => useResearchSearchRecords('p1'), {
      wrapper: ownerWrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(listSearchRecords).toHaveBeenCalledTimes(1)
  })
})

describe('useResearchSearchRecord', () => {
  it('recordId 为 null 时不请求；有 id 时读取详情', async () => {
    const { result, rerender } = renderHook(
      ({ recordId }: { recordId: string | null }) =>
        useResearchSearchRecord('p1', recordId),
      {
        wrapper: ownerWrapper,
        initialProps: { recordId: null as string | null },
      },
    )
    expect(getSearchRecord).not.toHaveBeenCalled()
    expect(result.current.fetchStatus).toBe('idle')

    vi.mocked(getSearchRecord).mockResolvedValue(DETAIL)
    rerender({ recordId: 'gen_1' })
    await waitFor(() => expect(result.current.data).toEqual(DETAIL))
    expect(getSearchRecord).toHaveBeenCalledWith('p1', 'gen_1')
  })
})
