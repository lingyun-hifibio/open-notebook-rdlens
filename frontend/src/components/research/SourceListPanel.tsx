'use client'

import { useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { useResearchScope } from '@/lib/research/scope'
import type { ResearchSourceStatus } from '@/lib/types/research'

/**
 * Sources 状态面板（UI-02，REQ-SRC-04/05，契约 §6）。
 *
 * - 每项目独立 Source（REQ-SRC-04）；状态 pending/ready/stale/failed 全部
 *   可见，缓存失败只表现为 Workspace stale/failed（不阻塞 RDLens RAG）；
 * - failed 附 last_error（可审计，不含正文）；同步重试仅 Admin（契约 §6，
 *   UI-04 管理员入口），Owner 面板只提示 retry 可见性，不放重试按钮；
 * - 项目隔离：source_id 服务端解析，跨项目 404（REQ-SCOPE-02）。
 *
 * RWV2-13（Issue #34）：行首复选框是本面板唯一的 Scope 选择入口（写入根级
 * ResearchScopeProvider，与右栏摘要/所有动作即时同步）；「View content」
 * 打开预览与选择互不干扰；selected 模式最后一项不可取消（provider 不变量
 * D3，复选框禁用给出可见状态）。
 */

const STATUS_CONFIG: Record<
  ResearchSourceStatus,
  { labelKey: string; variant: 'secondary' | 'default' | 'outline' | 'destructive' }
> = {
  pending: { labelKey: 'research.sources.statusPending', variant: 'secondary' },
  ready: { labelKey: 'research.sources.statusReady', variant: 'default' },
  stale: { labelKey: 'research.sources.statusStale', variant: 'outline' },
  failed: { labelKey: 'research.sources.statusFailed', variant: 'destructive' },
}

const DISPLAY_PAGE_SIZE = 20

export function SourceListPanel({
  onOpenSource,
}: {
  onOpenSource?: (sourceId: string) => void
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const { data, isLoading, isError, refetch } = useResearchSources(projectId)
  const [visibleCount, setVisibleCount] = useState(DISPLAY_PAGE_SIZE)
  const {
    mode,
    selectedSourceIds,
    selectedNoteIds,
    toggleSource,
  } = useResearchScope()
  const selectedCount = selectedSourceIds.length + selectedNoteIds.length

  useEffect(() => {
    setVisibleCount(DISPLAY_PAGE_SIZE)
  }, [projectId])

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (isError) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {t('research.retry')}
        </Button>
      </div>
    )
  }
  const items = data?.items ?? []
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('research.sources.empty')}</p>
  }

  const visibleItems = items.slice(0, visibleCount)

  return (
    <div className="min-w-0 space-y-2">
      <ul className="divide-y divide-border" data-testid="source-list-rows">
        {visibleItems.map((item) => {
          const config = STATUS_CONFIG[item.status]
          const isSelectable = item.status === 'ready' || item.status === 'stale'
          return (
            <li
              key={item.source_id}
              className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/60"
            >
              <Checkbox
                checked={selectedSourceIds.includes(item.source_id)}
                onCheckedChange={() => toggleSource(item.source_id)}
                disabled={
                  !isSelectable ||
                  mode === 'selected' &&
                  selectedCount === 1 &&
                  selectedSourceIds.includes(item.source_id)
                }
                aria-label={t('research.sources.scopeSelect', { name: item.document_id })}
                data-testid={`source-scope-${item.source_id}`}
                className="shrink-0"
              />
              <Badge variant={config.variant} className="shrink-0">
                {t(config.labelKey)}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{item.document_id}</p>
                {item.status === 'failed' && item.last_error && (
                  <p className="truncate text-xs text-destructive">
                    {t('research.sources.lastError', { error: item.last_error })}
                  </p>
                )}
                {item.status === 'failed' && (
                  <p className="truncate text-xs text-muted-foreground">
                    {t('research.sources.retryHint')}
                  </p>
                )}
                {item.status === 'stale' && (
                  <p className="truncate text-xs text-amber-700 dark:text-amber-400">
                    {t('research.sources.staleSelectionWarning')}
                  </p>
                )}
              </div>
              <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                {item.document_version}
                {item.synced_at ? ` · ${item.synced_at}` : ''}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                onClick={() => onOpenSource?.(item.source_id)}
              >
                {t('research.sources.open')}
              </Button>
            </li>
          )
        })}
      </ul>
      {visibleItems.length < items.length && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setVisibleCount((count) => count + DISPLAY_PAGE_SIZE)}
        >
          {t('research.pagination.loadMore')}
        </Button>
      )}
    </div>
  )
}
