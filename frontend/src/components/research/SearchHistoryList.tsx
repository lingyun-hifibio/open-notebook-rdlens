'use client'

/**
 * 搜索历史列表（Issue #1014 / D1-F 主单 §2.8）。
 *
 * - 行内只展示列表 wire 已有字段：query（截断展示）、outcome 中文标签、
 *   created_at、scope mode + source_total、hit_count、failed 的 failure_code；
 * - 列表**不做 authority**、不渲染来源身份/片段/conclusion（#1015 列表契约）；
 * - `limit/next_cursor` 游标分页：`load more` 追加，不穷尽抓取；
 * - 加载/空/错误/未启用/无权/不存在状态；`search_record_not_enabled` 不给
 *   重试按钮（重试不会改变结果，避免重试风暴）。
 */

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useTranslation } from '@/lib/hooks/use-translation'
import { formatResearchTimestamp } from '@/lib/research/format'
import {
  isSearchRecordErrorRetryable,
  searchRecordErrorCopyKey,
  searchRecordOutcomeLabelKey,
  searchRecordScopeModeLabelKey,
} from '@/lib/research/search-records'
import type {
  ResearchSearchRecordErrorKind,
  ResearchSearchRecordListItem,
} from '@/lib/research/types'

export function SearchHistoryList({
  items,
  isLoading,
  isError,
  errorKind,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRetry,
  onSelect,
}: {
  items: readonly ResearchSearchRecordListItem[]
  isLoading: boolean
  isError: boolean
  errorKind: ResearchSearchRecordErrorKind
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  onRetry: () => void
  onSelect: (recordId: string) => void
}) {
  const { t } = useTranslation()

  if (isLoading) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="search-history-loading">
        {t('common.loading')}
      </p>
    )
  }

  if (isError) {
    return (
      <div className="space-y-2 p-4" data-testid="search-history-error">
        <Alert variant="destructive">
          <AlertDescription>{t(searchRecordErrorCopyKey(errorKind))}</AlertDescription>
        </Alert>
        {isSearchRecordErrorRetryable(errorKind) && (
          <Button size="sm" variant="outline" onClick={onRetry} data-testid="search-history-retry">
            {t('research.retry')}
          </Button>
        )}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="search-history-empty">
        {t('research.searchHistory.listEmpty')}
      </p>
    )
  }

  return (
    <div className="space-y-2 p-3" data-testid="search-history-list">
      <ul className="space-y-2">
        {items.map((item) => {
          const outcomeLabel = t(searchRecordOutcomeLabelKey(item.outcome))
          const scopeLabel = t(searchRecordScopeModeLabelKey(item.scope_mode))
          const createdText = formatResearchTimestamp(item.created_at) ?? '—'
          return (
            <li key={item.record_id}>
              <button
                type="button"
                className="w-full rounded-md border p-3 text-left hover:bg-muted/50"
                data-testid={`search-history-row-${item.record_id}`}
                onClick={() => onSelect(item.record_id)}
              >
                <p className="truncate text-sm font-medium" title={item.query}>
                  {item.query || t('research.searchHistory.fields.query')}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" data-testid={`search-history-row-outcome-${item.record_id}`}>
                    {outcomeLabel}
                  </Badge>
                  <span>{createdText}</span>
                  <span data-testid={`search-history-row-scope-${item.record_id}`}>
                    {t('research.searchHistory.listScope', {
                      scope: scopeLabel,
                      sources: item.source_total,
                    })}
                  </span>
                  <span data-testid={`search-history-row-hits-${item.record_id}`}>
                    {t('research.searchHistory.hitCount', { count: item.hit_count })}
                  </span>
                  {item.failure_code !== null && (
                    <span className="font-mono" data-testid={`search-history-row-failure-${item.record_id}`}>
                      {t('research.searchHistory.failureCodeLabel')}: {item.failure_code}
                    </span>
                  )}
                </div>
              </button>
            </li>
          )
        })}
      </ul>

      {hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          disabled={isFetchingNextPage}
          onClick={onLoadMore}
          data-testid="search-history-load-more"
        >
          {isFetchingNextPage
            ? t('research.pagination.loadingMore')
            : t('research.pagination.loadMore')}
        </Button>
      )}
    </div>
  )
}
