'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
    <div className="space-y-2">
      {items.map((item) => {
        const config = STATUS_CONFIG[item.status]
        return (
          <Card key={item.source_id}>
            <CardContent className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{item.document_id}</p>
                <p className="text-xs text-muted-foreground">
                  {item.document_version}
                  {item.synced_at ? ` · ${item.synced_at}` : ''}
                </p>
                {item.status === 'failed' && item.last_error && (
                  <p className="mt-1 text-xs text-destructive">
                    {t('research.sources.lastError', { error: item.last_error })}
                  </p>
                )}
                {item.status === 'failed' && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('research.sources.retryHint')}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={config.variant}>{t(config.labelKey)}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenSource?.(item.source_id)}
                >
                  {t('research.sources.open')}
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
