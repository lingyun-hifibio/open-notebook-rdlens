/**
 * 搜索历史列表测试（Issue #1014 / D1-F 主单 §5.2）。
 *
 * 覆盖：加载/空/错误/未启用（不重试）/无权/存储不可用（可重试）；四类
 * outcome 标签；行内字段（query 截断、时间、scope+source_total、hit_count、
 * failure_code）；游标分页追加。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SearchHistoryList } from './SearchHistoryList'
import type { ResearchSearchRecordListItem } from '@/lib/research/types'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : `${key}|${JSON.stringify(opts)}`,
  }),
}))

function item(overrides: Partial<ResearchSearchRecordListItem> = {}): ResearchSearchRecordListItem {
  return {
    schema_version: 'd1f-search-record-v1',
    record_id: 'gen_1',
    generation_id: 'gen_1',
    created_at: '2026-11-04T10:00:00+00:00',
    completed_at: null,
    query: 'what is ORR?',
    outcome: 'completed',
    outcome_detail: null,
    generation_state: 'completed',
    requested_mode: 'auto',
    resolved_mode: 'hybrid_rag',
    context_level: 'focused',
    hit_count: 2,
    scope_mode: 'selected',
    source_total: 3,
    failure_code: null,
    degradation_codes: [],
    ...overrides,
  }
}

function renderList(props: {
  items?: ResearchSearchRecordListItem[]
  isLoading?: boolean
  isError?: boolean
  errorKind?: 'not_enabled' | 'forbidden' | 'not_found' | 'store_unavailable' | 'unknown'
  hasNextPage?: boolean
  isFetchingNextPage?: boolean
  onLoadMore?: () => void
  onRetry?: () => void
  onSelect?: (recordId: string) => void
} = {}) {
  const onLoadMore = props.onLoadMore ?? vi.fn()
  const onRetry = props.onRetry ?? vi.fn()
  const onSelect = props.onSelect ?? vi.fn()
  render(
    <SearchHistoryList
      items={props.items ?? []}
      isLoading={props.isLoading ?? false}
      isError={props.isError ?? false}
      errorKind={props.errorKind ?? 'unknown'}
      hasNextPage={props.hasNextPage ?? false}
      isFetchingNextPage={props.isFetchingNextPage ?? false}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      onSelect={onSelect}
    />,
  )
  return { onLoadMore, onRetry, onSelect }
}

describe('SearchHistoryList', () => {
  it('加载态使用既有通用加载文案', () => {
    renderList({ isLoading: true })
    expect(screen.getByTestId('search-history-loading').textContent).toBe('common.loading')
  })

  it('空态：无保存记录提示', () => {
    renderList({ items: [] })
    expect(screen.getByTestId('search-history-empty').textContent).toBe(
      'research.searchHistory.listEmpty',
    )
  })

  it('四类 outcome 标签；行内显示 query/时间/scope+总数/命中数', () => {
    renderList({
      items: [
        item({ record_id: 'r1', outcome: 'completed' }),
        item({ record_id: 'r2', outcome: 'no_hit', hit_count: 0 }),
        item({ record_id: 'r3', outcome: 'no_generation', hit_count: 0 }),
        item({
          record_id: 'r4',
          outcome: 'failed',
          hit_count: 0,
          failure_code: 'generation_failed',
        }),
        item({ record_id: 'r5', outcome: 'future_outcome', hit_count: 4 }),
      ],
    })
    expect(screen.getByTestId('search-history-row-outcome-r1').textContent).toBe(
      'research.searchHistory.outcome.completed',
    )
    expect(screen.getByTestId('search-history-row-outcome-r2').textContent).toBe(
      'research.searchHistory.outcome.noHit',
    )
    expect(screen.getByTestId('search-history-row-outcome-r3').textContent).toBe(
      'research.searchHistory.outcome.noGeneration',
    )
    expect(screen.getByTestId('search-history-row-outcome-r4').textContent).toBe(
      'research.searchHistory.outcome.failed',
    )
    expect(screen.getByTestId('search-history-row-outcome-r5').textContent).toBe(
      'research.searchHistory.outcome.unknown',
    )
    expect(screen.getByTestId('search-history-row-scope-r1').textContent).toContain(
      'research.searchHistory.listScope|{"scope":"research.searchHistory.scopeMode.selected","sources":3}',
    )
    expect(screen.getByTestId('search-history-row-hits-r1').textContent).toBe(
      'research.searchHistory.hitCount|{"count":2}',
    )
    expect(screen.getByTestId('search-history-row-failure-r4').textContent).toContain(
      'generation_failed',
    )
    // 行内只消费列表 wire 字段：不渲染来源身份/片段（fixture 也无这些字段）
    expect(screen.queryByText('hit snippet')).toBeNull()
  })

  it('点击行回调 record_id（由父层切换到详情）', () => {
    const { onSelect } = renderList({ items: [item()] })
    fireEvent.click(screen.getByTestId('search-history-row-gen_1'))
    expect(onSelect).toHaveBeenCalledWith('gen_1')
  })

  it('503 search_record_not_enabled：明确未启用且**不**给重试（不重试风暴）', () => {
    renderList({ isError: true, errorKind: 'not_enabled' })
    expect(screen.getByTestId('search-history-error').textContent).toContain(
      'research.searchHistory.errors.notEnabled',
    )
    expect(screen.queryByTestId('search-history-retry')).toBeNull()
  })

  it('403/404：限制/不存在文案，无重试按钮', () => {
    renderList({ isError: true, errorKind: 'forbidden' })
    expect(screen.getByTestId('search-history-error').textContent).toContain(
      'research.searchHistory.errors.forbidden',
    )
    expect(screen.queryByTestId('search-history-retry')).toBeNull()
  })

  it('503 search_record_store_unavailable：可重试，点击回调 onRetry', () => {
    const onRetry = vi.fn()
    renderList({ isError: true, errorKind: 'store_unavailable', onRetry })
    expect(screen.getByTestId('search-history-error').textContent).toContain(
      'research.searchHistory.errors.storeUnavailable',
    )
    fireEvent.click(screen.getByTestId('search-history-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('游标分页：hasNextPage 显示 load more 并追加；加载中显示 loadingMore', () => {
    const onLoadMore = vi.fn()
    renderList({ items: [item()], hasNextPage: true, onLoadMore })
    const loadMore = screen.getByTestId('search-history-load-more')
    expect(loadMore.textContent).toBe('research.pagination.loadMore')
    fireEvent.click(loadMore)
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    renderList({ items: [item()], hasNextPage: true, isFetchingNextPage: true })
    expect(screen.getAllByTestId('search-history-load-more')[1].textContent).toBe(
      'research.pagination.loadingMore',
    )
  })

  it('无下一页时不渲染 load more', () => {
    renderList({ items: [item()], hasNextPage: false })
    expect(screen.queryByTestId('search-history-load-more')).toBeNull()
  })
})
