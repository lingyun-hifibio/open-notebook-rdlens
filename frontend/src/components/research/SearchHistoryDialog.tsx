'use client'

/**
 * 搜索历史 Dialog（Issue #1014 / D1-F 主单 §2.8）。
 *
 * 单一入口内的列表 ↔ 详情切换：
 * - 打开：列表（服务端游标分页，`load more` 追加）；点击记录切换到详情；
 * - 详情：① 查询与执行上下文 ② 允许来源 ③ 实际命中 ④ 最终引用
 *   ⑤ 结论与原因 ⑥ 实际模型；「返回列表」「关闭」「打开来源」三个动作；
 * - 错误态：列表/详情各自 403（仅 Owner）、404（不存在/无权查看）、
 *   503 `search_record_not_enabled`（未启用，不重试）、503
 *   `search_record_store_unavailable`（存储暂不可用，可重试）；
 * - 不提供 Save/Continue/Rerun；不新增 Tab/pane/路由，实时 Search 结果区不变。
 */

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useTranslation } from '@/lib/hooks/use-translation'
import {
  useResearchSearchRecord,
  useResearchSearchRecords,
} from '@/lib/hooks/use-research-search-records'
import {
  classifySearchRecordError,
  isSearchRecordErrorRetryable,
  searchRecordErrorCopyKey,
} from '@/lib/research/search-records'
import type { ResearchSource } from '@/lib/types/research'
import { SearchHistoryList } from './SearchHistoryList'
import { SearchRecordDetail } from './SearchRecordDetail'

export function SearchHistoryDialog({
  open,
  onOpenChange,
  projectId,
  sources = [],
  onCitationJump,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** 工作区来源列表：仅用于把记录内 `source_id` 解析为展示身份/跳转闸门。 */
  sources?: readonly ResearchSource[]
  /** Citation 跳转回调（工作台提供：选源 + source focus + 高亮目标页）。 */
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)

  // Dialog 关闭即回到列表（下次打开从列表开始；详情不保留旧选择）。
  useEffect(() => {
    if (!open) setSelectedRecordId(null)
  }, [open])

  const listQuery = useResearchSearchRecords(projectId, { enabled: open })
  const detailQuery = useResearchSearchRecord(projectId, selectedRecordId)
  const items = (listQuery.data?.pages ?? []).flatMap((page) => page.items)
  const listErrorKind = classifySearchRecordError(listQuery.error)
  const detailErrorKind = classifySearchRecordError(detailQuery.error)

  const handleOpenChange = (next: boolean) => {
    if (!next) setSelectedRecordId(null)
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-0 p-0"
        data-testid="search-history-dialog"
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{t('research.searchHistory.title')}</DialogTitle>
          <DialogDescription>{t('research.searchHistory.description')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selectedRecordId === null ? (
            <SearchHistoryList
              items={items}
              isLoading={listQuery.isLoading}
              isError={listQuery.isError}
              errorKind={listErrorKind}
              hasNextPage={listQuery.hasNextPage}
              isFetchingNextPage={listQuery.isFetchingNextPage}
              onLoadMore={() => void listQuery.fetchNextPage()}
              onRetry={() => void listQuery.refetch()}
              onSelect={setSelectedRecordId}
            />
          ) : detailQuery.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground" data-testid="search-record-detail-loading">
              {t('common.loading')}
            </p>
          ) : detailQuery.isError ? (
            <div className="space-y-2 p-4" data-testid="search-record-detail-error">
              <Alert variant="destructive">
                <AlertDescription>
                  {t(searchRecordErrorCopyKey(detailErrorKind))}
                </AlertDescription>
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedRecordId(null)}
                  data-testid="search-record-detail-back"
                >
                  {t('research.searchHistory.backToList')}
                </Button>
                {isSearchRecordErrorRetryable(detailErrorKind) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void detailQuery.refetch()}
                    data-testid="search-record-detail-retry"
                  >
                    {t('research.retry')}
                  </Button>
                )}
              </div>
            </div>
          ) : detailQuery.data ? (
            <SearchRecordDetail
              record={detailQuery.data}
              sources={sources}
              onBack={() => setSelectedRecordId(null)}
              onClose={() => handleOpenChange(false)}
              onCitationJump={onCitationJump}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
