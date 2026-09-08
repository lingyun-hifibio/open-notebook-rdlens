'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchTransformationResults } from '@/lib/hooks/use-research'
import { useResearchSources } from '@/lib/hooks/use-research'
import { formatResearchTimestamp, researchLanguageLabelKey } from '@/lib/research/format'
import type { ResearchCitation, TransformationResultRecord } from '@/lib/types/research'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import { TransformationRunDetail } from './TransformationRunDetail'

/**
 * Transformation Result 历史面板（RWV2-21 / Issue #42）。
 *
 * - 只读历史列表，来自 RDLens 服务端（RWV2-20 `transformation-results`），
 *   分页由服务端游标驱动（useInfiniteQuery，页大小 20）；**不**穷尽抓取
 *   全量结果行（列表项含完整 output/citations，High-1）。
 * - 模板与 result 实例分离：本面板只渲染 result 历史，模板 CRUD/Run 在
 *   transformations tab。
 * - 点行打开只读详情（TransformationRunDetail）；详情内 Rerun 走既有
 *   guarded 执行原语（W5）。
 * - 挂 `useResearchSources` 供 citation 归一化/跳转解析（High-5）——漏挂
 *   会让所有历史 citation 静默降级 unavailable。
 * - Admin 只读：列表/详情可浏览，无 Rerun/写入口（W7，后端权威）。
 */
export function TransformationRunsPanel({
  onCitationJump,
  onRevealSavedArtifact,
  onOpenResearchChatDraft,
}: {
  /** Citation 跳转回调（工作台提供：解析来源并定位目标页；右栏契约不同源） */
  onCitationJump?: (citation: ResearchCitation) => void
  /** RWV2-23（AC3）：保存成功后跳转左栏 Notes/Insights（关闭详情后） */
  onRevealSavedArtifact?: (kind: 'note' | 'insight', artifactId: string) => void
  /** RWV2-23（AC4）：Continue research —— 关闭详情并打开 Chat 预填 */
  onOpenResearchChatDraft?: (text: string) => void
}) {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useResearchTransformationResults(projectId)
  // High-5：citations 归一化/跳转依赖项目来源（TransformationsPanel 同款；只读消费）
  const { data: sourcesData } = useResearchSources(projectId)

  const [selected, setSelected] = useState<TransformationResultRecord | null>(null)
  const [highlightedResultId, setHighlightedResultId] = useState<string | null>(null)

  const items = (data?.pages ?? []).flatMap((page) => page.items)

  const handleRetry = useCallback(() => {
    void refetch()
  }, [refetch])

  const openDetail = (record: TransformationResultRecord) => {
    setSelected(record)
  }

  const closeDetail = useCallback(() => {
    setSelected(null)
  }, [])

  const handleRerunSuccess = useCallback((resultId: string) => {
    // The mutation invalidates this query. Keep the new id until its first
    // page arrives, then close the historical detail and make the new result
    // discoverable without requiring the user to find it manually.
    setSelected(null)
    setHighlightedResultId(resultId)
  }, [])

  useEffect(() => {
    if (highlightedResultId === null || !items.some((item) => item.result_id === highlightedResultId)) {
      return
    }
    document.querySelector<HTMLElement>(`[data-testid="runs-row-${highlightedResultId}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedResultId, items])

  return (
    <div className="space-y-2">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

      {isError && (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>
          <Button size="sm" variant="outline" onClick={handleRetry}>
            {t('research.pagination.retry')}
          </Button>
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="runs-empty">
          {t('research.transformations.historyEmpty')}
        </p>
      )}

      <div className="space-y-2">
        {items.map((record) => {
          // RWV2-43：语言码 en/zh → 英文标签（F4）；未知非 null → 原码（C-M1）；
          // 时间 → 可读绝对时间（null → '—'）。与 jobTypeLabelKey 的
          // 「key 前缀判断 + 原码回退」调用模式一致。
          const languageKey = researchLanguageLabelKey(record.response_language)
          const languageText = languageKey === null
            ? '—'
            : languageKey.startsWith('research.transformations.')
              ? t(languageKey)
              : languageKey
          const createdText = formatResearchTimestamp(record.created_at) ?? '—'
          return (
            <Card
              key={record.result_id}
              className={record.result_id === highlightedResultId ? 'ring-1 ring-primary' : undefined}
              data-highlighted={record.result_id === highlightedResultId || undefined}
            >
              <CardContent className="flex cursor-pointer items-center justify-between gap-3 p-3">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  data-testid={`runs-row-${record.result_id}`}
                  onClick={() => openDetail(record)}
                >
                  <p className="truncate text-sm font-medium">{record.title ?? '—'}</p>
                  <p
                    className="mt-1 truncate text-xs text-muted-foreground"
                    data-testid={`run-row-meta-${record.result_id}`}
                  >
                    {languageText} · {createdText} ·{' '}
                    {t('research.transformations.inputsCount', {
                      count: record.source_ids.length + record.note_ids.length,
                    })}
                  </p>
                </button>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {!isLoading && !isError && hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          data-testid="runs-load-more"
        >
          {isFetchingNextPage
            ? t('research.pagination.loadingMore')
            : t('research.pagination.loadMore')}
        </Button>
      )}

      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) closeDetail() }}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('research.transformations.runDetailTitle')}</DialogTitle>
          </DialogHeader>
          {selected !== null && (
            <TransformationRunDetail
              record={selected}
              sources={sourcesData?.items}
              showRerun={!isAdminReadonly}
              onCitationJump={onCitationJump}
              onRerunSuccess={handleRerunSuccess}
              onViewInsight={
                onRevealSavedArtifact !== undefined
                  ? (insightId) => {
                      closeDetail()
                      onRevealSavedArtifact('insight', insightId)
                    }
                  : undefined
              }
              onViewNote={
                onRevealSavedArtifact !== undefined
                  ? (noteId) => {
                      closeDetail()
                      onRevealSavedArtifact('note', noteId)
                    }
                  : undefined
              }
              onContinueResearch={
                onOpenResearchChatDraft !== undefined
                  ? () => {
                      const output = selected.output ?? ''
                      // AC4：预填为可编辑的续研上下文（引用本结果输出摘录），
                      // 不自动派发；真正 Send 仍走既有守卫/当前 Scope。
                      const excerpt = output.trim().slice(0, 400)
                      const draft = excerpt !== ''
                        ? `Continue from this result: ${excerpt}`
                        : 'Continue research on this result.'
                      closeDetail()
                      onOpenResearchChatDraft(draft)
                    }
                  : undefined
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
