'use client'

import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { useResearchScope } from '@/lib/research/scope'
import { formatResearchTimestamp } from '@/lib/research/format'
import type { ResearchSource, ResearchSourceStatus } from '@/lib/types/research'

/**
 * Sources 状态面板（UI-02，REQ-SRC-04/05，契约 §6）。
 *
 * PR5（C3/D-33）：
 * - 状态 6 值全部可见（pending/ready/stale/failed/retiring/deleted），
 *   `retiring`/`deleted` 与 `failed` 视觉与文案区分；
 * - `source_id` 可为 null（无镜像身份的行）→ 复选与打开按钮 disabled 并
 *   给出原因，绝不作为可选项出现；
 * - **版本号常显纪律**：`document_version` 始终渲染在行内 meta（D-33/T33），
 *   不得移入 tooltip 或断点隐藏——同文档多版本必须可辨；
 * - React key 用 document 维度（`document_id:version:source_id`），避免
 *   null→真实 ID 的 key 漂移导致重挂载。
 *
 * RWV2-13（Issue #34）：行首复选框是本面板唯一的 Scope 选择入口；「View
 * content」打开预览与选择互不干扰；selected 模式最后一项不可取消。
 */

const STATUS_CONFIG: Record<
  ResearchSourceStatus,
  { labelKey: string; variant: 'secondary' | 'default' | 'outline' | 'destructive' }
> = {
  pending: { labelKey: 'research.sources.statusPending', variant: 'secondary' },
  ready: { labelKey: 'research.sources.statusReady', variant: 'default' },
  stale: { labelKey: 'research.sources.statusStale', variant: 'outline' },
  failed: { labelKey: 'research.sources.statusFailed', variant: 'destructive' },
  retiring: { labelKey: 'research.sources.statusRetiring', variant: 'outline' },
  deleted: { labelKey: 'research.sources.statusDeleted', variant: 'destructive' },
}

const DISPLAY_PAGE_SIZE = 20

function isSelectableStatus(status: ResearchSourceStatus): boolean {
  return status === 'ready' || status === 'stale'
}

function rowKey(item: ResearchSource): string {
  return `${item.document_id}:${item.document_version}:${item.source_id ?? 'null'}`
}

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
          const selectable = item.source_id !== null && isSelectableStatus(item.status)
          const selected = item.source_id !== null && selectedSourceIds.includes(item.source_id)
          // R2-1：synced 段仅当 synced_at 非 null 渲染
          const syncedText = item.synced_at !== null
            ? formatResearchTimestamp(item.synced_at)
            : null
          return (
            <li
              key={rowKey(item)}
              className="group flex min-w-0 items-center gap-2 overflow-hidden rounded px-2 py-1.5 hover:bg-accent/60"
            >
              <Checkbox
                checked={selected}
                onCheckedChange={() => {
                  if (item.source_id !== null) toggleSource(item.source_id)
                }}
                disabled={
                  !selectable ||
                  mode === 'selected' &&
                  selectedCount === 1 &&
                  selected
                }
                aria-label={t('research.sources.scopeSelect', { name: item.document_id })}
                data-testid={`source-scope-${item.source_id ?? `doc-${item.document_id}-${item.document_version}`}`}
                className="shrink-0"
              />
              <Badge variant={config.variant} className="shrink-0">
                {t(config.labelKey)}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{item.document_id}</p>
                {/* D-33：版本号常显（不放 tooltip、不断点隐藏） */}
                <p className="truncate text-xs text-muted-foreground" data-testid="source-row-version">
                  {item.document_version}
                  {syncedText !== null && (
                    <>
                      {' · '}
                      {t('research.sources.synced')}: {syncedText}
                    </>
                  )}
                </p>
                {item.source_id === null && (
                  <p className="truncate text-xs text-muted-foreground">
                    {t('research.sources.noSourceIdentity')}
                  </p>
                )}
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
              {/* F13/C-M4：图标按钮（aria-label/title），保留 hover/focus 显形 */}
              <Button
                size="sm"
                variant="ghost"
                disabled={item.source_id === null}
                className="shrink-0 px-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
                aria-label={t('research.sources.open')}
                title={t('research.sources.open')}
                onClick={() => {
                  if (item.source_id !== null) onOpenSource?.(item.source_id)
                }}
              >
                <ArrowRight />
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
