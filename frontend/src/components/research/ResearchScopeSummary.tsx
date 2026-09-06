'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { useResearchScope } from '@/lib/research/scope'

/**
 * 右栏紧凑 Scope Summary（RWV2-13 Issue #34，RFC §3 唯一 Scope 契约）。
 *
 * 完整 Sources/Notes 选择编辑面迁移到左栏（唯一编辑面）；右栏只保留：
 * - 模式 + 计数摘要（entire_project 显式可见，D2）——常驻展示，不折叠；
 * - `Edit scope` 入口：经组合层退出最大化并回到左栏编辑面，**不持有**任何
 *   第二套选择/模式状态（不变量 1：一个 Scope 真源）；
 * - 加载/失败/重试状态沿用原选择器语义。
 * 摘要文本以 `aria-live=polite` 播报：左栏复选框写入 provider 后，右栏
 * 摘要与所有消费方立即同步（AC：左栏选择即时更新摘要与每次动作）。
 */
export function ResearchScopeSummary({
  loading,
  loadError,
  onRetry,
  onEditScope,
}: {
  loading: boolean
  loadError: string | null
  onRetry: () => void
  onEditScope: () => void
}) {
  const { t } = useTranslation()
  const { mode, selectedSourceIds, selectedNoteIds } = useResearchScope()
  const label = mode === 'entire_project'
    ? t('research.layout.scope.entireProject')
    : t('research.layout.scope.selectedSummary', {
        sources: selectedSourceIds.length,
        notes: selectedNoteIds.length,
      })

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 border-b px-3 py-2"
      data-testid="research-scope-summary"
    >
      <p
        className="min-w-0 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
        data-testid="research-context-scope"
      >
        {label}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0 bg-background shadow-sm"
        onClick={onEditScope}
        data-testid="scope-edit-button"
      >
        {t('research.layout.scope.editScope')}
      </Button>
      {loading && <span className="text-xs text-muted-foreground">{t('research.loading')}</span>}
      {loadError && (
        <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
          <span>{t('research.loadFailed')}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t('research.retry')}
          </Button>
        </div>
      )}
    </div>
  )
}