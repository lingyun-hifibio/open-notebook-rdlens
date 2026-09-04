'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import type { ResearchSourceStatus } from '@/lib/types/research'

/**
 * Sources 状态面板（UI-02，REQ-SRC-04/05，契约 §6）。
 *
 * - 每项目独立 Source（REQ-SRC-04）；状态 pending/ready/stale/failed 全部
 *   可见，缓存失败只表现为 Workspace stale/failed（不阻塞 RDLens RAG）；
 * - failed 附 last_error（可审计，不含正文）；同步重试仅 Admin（契约 §6，
 *   UI-04 管理员入口），Owner 面板只提示 retry 可见性，不放重试按钮；
 * - 项目隔离：source_id 服务端解析，跨项目 404（REQ-SCOPE-02）。
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

export function SourceListPanel({
  onOpenSource,
}: {
  onOpenSource?: (sourceId: string) => void
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const { data, isLoading, isError } = useResearchSources(projectId)

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (isError) {
    return <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>
  }
  const items = data?.items ?? []
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('research.sources.empty')}</p>
  }

  return (
    <ul className="divide-y divide-border" data-testid="source-list-rows">
      {items.map((item) => {
        const config = STATUS_CONFIG[item.status]
        return (
          <li
            key={item.source_id}
            className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/60"
          >
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
  )
}
