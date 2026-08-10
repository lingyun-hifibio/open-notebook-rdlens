'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  checkCompareSelection,
  COMPARE_DEFAULT_MAX,
  COMPARE_HARD_MAX,
} from '@/lib/research/compare'
import type { ResearchSourceSummary, ResearchJob } from '@/lib/research/types'

/**
 * Compare 面板（UI-03，REQ-QUOTA-01，设计 §7.4/§13）。
 *
 * 将选中的 Source 映射为 document_ids；前置校验边界：≤30 直接允许、
 * 31–50 提示超默认、>50（51+）禁用创建（服务端 422 的前置客户端校验）、
 * 空选禁用。创建结果（持久 Job）由父级呈现。
 */
export function ComparePanel({
  sources,
  selectedSourceIds,
  isCreating,
  error,
  onCreate,
  onJobCreated,
}: {
  sources: ResearchSourceSummary[]
  selectedSourceIds: string[]
  isCreating: boolean
  error: string | null
  onCreate: (documentIds: string[], groupSize?: number) => ResearchJob | null
  onJobCreated: () => void
}) {
  const { t } = useTranslation()

  const selectedDocuments = sources
    .filter((source) => selectedSourceIds.includes(source.source_id))
    .map((source) => source.document_id)
  const check = checkCompareSelection(selectedDocuments)

  const handleCreate = () => {
    if (!check.ok || isCreating) return
    const created = onCreate(selectedDocuments)
    if (created) {
      onJobCreated()
    }
  }

  const disabled = !check.ok || isCreating

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t('research.compareTitle')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('research.compareSelected')}: {check.count} / {COMPARE_DEFAULT_MAX}
            {' · '}
            {t('research.compareHardMax')}: {COMPARE_HARD_MAX}
          </p>
        </div>
        <Button onClick={handleCreate} disabled={disabled} data-testid="compare-create">
          {isCreating ? t('research.compareCreating') : t('research.compareCreate')}
        </Button>
      </div>

      {check.ok && check.overDefault && (
        <Alert variant="default" data-testid="compare-over-default">
          <AlertDescription>{t('research.compareOverDefault')}</AlertDescription>
        </Alert>
      )}
      {!check.ok && check.reason === 'over_hard' && (
        <Alert variant="destructive" data-testid="compare-over-hard">
          <AlertDescription>
            {t('research.compareOverHard', { count: check.count })}
          </AlertDescription>
        </Alert>
      )}
      {!check.ok && check.reason === 'empty' && (
        <Alert variant="default" data-testid="compare-empty">
          <AlertDescription>{t('research.compareEmpty')}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" data-testid="compare-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
