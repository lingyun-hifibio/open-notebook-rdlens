/**
 * 搜索历史 Dialog 测试（Issue #1014 / D1-F 主单 §5.2）。
 *
 * 覆盖：关闭时不请求；打开→列表；行点击→详情；返回列表；关闭回调；列表
 * 未启用/无权/不存在/存储不可用重试；详情 404 错误态；分页追加；关闭后
 * 重新打开回到列表。
 */
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { SearchHistoryDialog } from './SearchHistoryDialog'
import { getSearchRecord, listSearchRecords } from '@/lib/research/api'
import type { ResearchSearchRecordDetail, ResearchSearchRecordPage } from '@/lib/research/types'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : `${key}|${JSON.stringify(opts)}`,
  }),
}))

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

vi.mock('@/lib/research/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...original,
    listSearchRecords: vi.fn(),
    getSearchRecord: vi.fn(),
  }
})

const listPage: ResearchSearchRecordPage = {
  schema_version: 'd1f-search-record-list-v1',
  items: [
    {
      schema_version: 'd1f-search-record-v1',
      record_id: 'gen_1',
      generation_id: 'gen_1',
      created_at: '2026-11-04T10:00:00+00:00',
      completed_at: null,
      query: 'first query',
      outcome: 'no_hit',
      outcome_detail: 'source_evidence_empty',
      generation_state: 'completed',
      requested_mode: 'auto',
      resolved_mode: 'hybrid_rag',
      context_level: 'focused',
      hit_count: 0,
      scope_mode: 'selected',
      source_total: 2,
      failure_code: null,
      degradation_codes: [],
    },
    {
      schema_version: 'd1f-search-record-v1',
      record_id: 'gen_2',
      generation_id: 'gen_2',
      created_at: '2026-11-04T11:00:00+00:00',
      completed_at: null,
      query: 'second query',
      outcome: 'failed',
      outcome_detail: null,
      generation_state: 'failed',
      requested_mode: 'auto',
      resolved_mode: 'hybrid_rag',
      context_level: 'focused',
      hit_count: 0,
      scope_mode: 'all',
      source_total: 0,
      failure_code: 'generation_failed',
      degradation_codes: [],
    },
  ],
  next_cursor: null,
}

const detail: ResearchSearchRecordDetail = {
  schema_version: 'd1f-search-record-v2',
  record_id: 'gen_1',
  generation_id: 'gen_1',
  created_at: '2026-11-04T10:00:00+00:00',
  completed_at: '2026-11-04T10:00:05+00:00',
  query: 'detail query',
  outcome: 'completed',
  outcome_detail: null,
  generation_state: 'completed',
  requested_mode: 'auto',
  resolved_mode: 'hybrid_rag',
  context_level: 'focused',
  hit_count: 1,
  scope: {
    schema_version: 'd1f-search-scope-v1',
    contract_version: null,
    resolution: 'execution_resolution',
    mode: 'selected',
    requested_source_ids: [],
    note_ids: [],
    resolved_source_refs: [{ document_id: 'doc_a', document_version: 'v1' }],
    missing_source_ids: [],
    includes_exact_versions: true,
    contains_document_body: false,
    single_source_id: null,
    warnings: [],
    source_total: 1,
  },
  source_counts: { total: 1, visible: 1, restricted: 0 },
  sources: [
    { document_id: 'doc_a', document_version: 'v1', source_id: 'src_1', status: 'ready', warning: null },
  ],
  conclusion: { text: 'detail conclusion', truncated: false },
  degradations: [],
  degradation_schema_version: null,
  failure: null,
  coverage: null,
  record_visibility: 'visible',
  warnings: [],
  result_available: true,
  hits: { total: 1, truncated: false, items: [] },
  citations: { total: 0, truncated: false, items: [] },
  model: { model_id: 'm-local', provider_id: 'prov-local' },
}

function Harness({
  initialOpen = true,
}: {
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <div>
      <button data-testid="harness-open" onClick={() => setOpen(true)}>
        open
      </button>
      <SearchHistoryDialog
        open={open}
        onOpenChange={setOpen}
        projectId="p1"
        sources={[]}
        onCitationJump={vi.fn()}
      />
    </div>
  )
}

let queryClient: QueryClient

function renderDialog(initialOpen = true) {
  render(
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="p1" role="owner" userId="u1">
        <Harness initialOpen={initialOpen} />
      </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  vi.mocked(listSearchRecords).mockResolvedValue(listPage)
  vi.mocked(getSearchRecord).mockResolvedValue(detail)
})

describe('SearchHistoryDialog', () => {
  it('关闭时不发起列表请求', () => {
    renderDialog(false)
    expect(listSearchRecords).not.toHaveBeenCalled()
    expect(screen.queryByTestId('search-history-dialog')).toBeNull()
  })

  it('打开 → 列表渲染；点击行 → 详情六分区；返回列表', async () => {
    renderDialog(true)
    await waitFor(() =>
      expect(screen.getByTestId('search-history-row-gen_1')).toBeTruthy(),
    )
    expect(screen.getByTestId('search-history-row-gen_2')).toBeTruthy()

    fireEvent.click(screen.getByTestId('search-history-row-gen_1'))
    await waitFor(() =>
      expect(screen.getByTestId('search-record-detail')).toBeTruthy(),
    )
    expect(getSearchRecord).toHaveBeenCalledWith('p1', 'gen_1')
    expect(screen.getByTestId('search-record-query').textContent).toBe('detail query')
    expect(screen.getByTestId('search-record-section-context')).toBeTruthy()
    expect(screen.getByTestId('search-record-section-model')).toBeTruthy()

    fireEvent.click(screen.getByTestId('search-history-back'))
    await waitFor(() =>
      expect(screen.getByTestId('search-history-list')).toBeTruthy(),
    )
  })

  it('详情关闭按钮回调 onOpenChange(false)；重新打开回到列表', async () => {
    renderDialog(true)
    await waitFor(() =>
      expect(screen.getByTestId('search-history-row-gen_1')).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('search-history-row-gen_1'))
    await waitFor(() => expect(screen.getByTestId('search-record-detail')).toBeTruthy())
    fireEvent.click(screen.getByTestId('search-history-close'))
    await waitFor(() => expect(screen.queryByTestId('search-record-detail')).toBeNull())

    fireEvent.click(screen.getByTestId('harness-open'))
    await waitFor(() =>
      expect(screen.getByTestId('search-history-row-gen_1')).toBeTruthy(),
    )
    expect(screen.queryByTestId('search-record-detail')).toBeNull()
  })

  it('列表 503 not_enabled：显示未启用终态且无重试', async () => {
    vi.mocked(listSearchRecords).mockRejectedValue(
      Object.assign(new Error('not enabled'), {
        response: {
          status: 503,
          data: { detail: { code: 'search_record_not_enabled' } },
        },
      }),
    )
    renderDialog(true)
    await waitFor(() =>
      expect(screen.getByTestId('search-history-error')).toBeTruthy(),
    )
    expect(screen.getByTestId('search-history-error').textContent).toContain(
      'research.searchHistory.errors.notEnabled',
    )
    expect(screen.queryByTestId('search-history-retry')).toBeNull()
    expect(listSearchRecords).toHaveBeenCalledTimes(1)
  })

  it('列表 403：仅 Owner 可查看文案', async () => {
    vi.mocked(listSearchRecords).mockRejectedValue(
      Object.assign(new Error('forbidden'), { response: { status: 403 } }),
    )
    renderDialog(true)
    await waitFor(() =>
      expect(screen.getByTestId('search-history-error')).toBeTruthy(),
    )
    expect(screen.getByTestId('search-history-error').textContent).toContain(
      'research.searchHistory.errors.forbidden',
    )
  })

  it('列表存储不可用：重试可恢复', async () => {
    vi.mocked(listSearchRecords)
      .mockRejectedValueOnce(
        Object.assign(new Error('store down'), {
          response: {
            status: 503,
            data: { detail: { code: 'search_record_store_unavailable' } },
          },
        }),
      )
      .mockResolvedValueOnce(listPage)
    renderDialog(true)
    await waitFor(() =>
      expect(screen.getByTestId('search-history-retry')).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('search-history-retry'))
    await waitFor(() =>
      expect(screen.getByTestId('search-history-row-gen_1')).toBeTruthy(),
    )
  })

  it('详情 404：记录不存在/无权查看，提供返回列表', async () => {
    vi.mocked(getSearchRecord).mockRejectedValue(
      Object.assign(new Error('not found'), { response: { status: 404 } }),
    )
    renderDialog(true)
    await waitFor(() =>
      expect(screen.getByTestId('search-history-row-gen_1')).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId('search-history-row-gen_1'))
    await waitFor(() =>
      expect(screen.getByTestId('search-record-detail-error')).toBeTruthy(),
    )
    expect(screen.getByTestId('search-record-detail-error').textContent).toContain(
      'research.searchHistory.errors.notFound',
    )
    expect(screen.queryByTestId('search-record-detail-retry')).toBeNull()
    fireEvent.click(screen.getByTestId('search-record-detail-back'))
    await waitFor(() =>
      expect(screen.getByTestId('search-history-list')).toBeTruthy(),
    )
  })

  it('游标分页：load more 追加下一页行', async () => {
    vi.mocked(listSearchRecords)
      .mockResolvedValueOnce({
        ...listPage,
        items: [listPage.items[0]],
        next_cursor: 'cursor_2',
      })
      .mockResolvedValueOnce({
        ...listPage,
        items: [listPage.items[1]],
        next_cursor: null,
      })
    renderDialog(true)
    await waitFor(() =>
      expect(screen.getByTestId('search-history-row-gen_1')).toBeTruthy(),
    )
    expect(screen.queryByTestId('search-history-row-gen_2')).toBeNull()
    fireEvent.click(screen.getByTestId('search-history-load-more'))
    await waitFor(() =>
      expect(screen.getByTestId('search-history-row-gen_2')).toBeTruthy(),
    )
    expect(listSearchRecords).toHaveBeenLastCalledWith('p1', {
      limit: 20,
      cursor: 'cursor_2',
    })
  })
})
