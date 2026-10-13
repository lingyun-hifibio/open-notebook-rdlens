'use client'

import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useResearchScope, type ResearchScopeMode } from '@/lib/research/scope'

/**
 * 左栏唯一 Scope 编辑面——模式控件（RWV2-13 Issue #34 + PR5 三档）。
 *
 * - `all` 显式可见可点（D2）；selected 需 ≥1 项有效选择（D3：0 选择禁止
 *   执行，不扩大数据范围）；
 * - PR5（C4/D-04）：`single` 不在模式单选里（它是**会话级临时限定**，由
 *   SourceDetailPanel「只问此来源」设置）；生效时本面显示限定条目 +
 *   「取消限定」按钮（`clearSingle` 恢复基础范围），键盘可达（普通按钮）；
 * - 模式切换/勾选会清除临时限定（provider 内约束）；UI 在 all 下提示
 *   「选择资料或笔记即切换为仅所选」（D-10 反推规则的用户可见说明）；
 * - `min-w-0 + flex-wrap`：1024px 视口最小栏宽不隐藏标题、不横向滚动。
 */
export function ResearchScopeEditor({
  scopeEditRequest,
}: {
  /** 递增序号：右栏 `Edit scope` 请求聚焦本编辑面（含退出最大化后） */
  scopeEditRequest?: number
}) {
  const { t } = useTranslation()
  const { mode, singlePin, clearSingle, selectedSourceIds, selectedNoteIds, setMode } = useResearchScope()
  const selectedCount = selectedSourceIds.length + selectedNoteIds.length
  const radioGroupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // RWV2-13：只在明确的编辑请求（序号 ≥1）时聚焦；初始挂载/重挂载
    // 传 0 或 undefined 均不得抢焦点（a11y：不做焦点窃取，复审 N1 修复）
    if (scopeEditRequest === undefined || scopeEditRequest <= 0) return
    radioGroupRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus()
  }, [scopeEditRequest])

  return (
    <div className="min-w-0 space-y-2 border-b pb-3" data-testid="research-scope-editor">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('research.layout.scope.modeLabel')}
      </p>
      <RadioGroup
        ref={radioGroupRef}
        value={mode === 'single' ? undefined : mode}
        onValueChange={(value) => setMode(value as Exclude<ResearchScopeMode, 'single'>)}
        className="flex min-w-0 flex-wrap gap-x-4 gap-y-2"
        aria-label={t('research.layout.scope.modeLabel')}
      >
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <RadioGroupItem value="all" data-testid="scope-entire-project" />
          <span className="min-w-0">{t('research.layout.scope.entireProject')}</span>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <RadioGroupItem
            value="selected"
            disabled={selectedCount === 0}
            data-testid="scope-selected"
          />
          <span className="min-w-0">{t('research.layout.scope.selected')}</span>
        </label>
      </RadioGroup>
      {singlePin !== null && (
        <div
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border px-2 py-1.5"
          data-testid="scope-single-pin"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground" role="status">
            {t('research.layout.scope.singleActive', { source: singlePin.sourceId })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={clearSingle}
            data-testid="scope-single-clear"
          >
            {t('research.layout.scope.singleClear')}
          </Button>
        </div>
      )}
      {mode === 'all' && (
        <p className="text-xs text-muted-foreground" data-testid="scope-all-hint">
          {t('research.layout.scope.allHint')}
        </p>
      )}
      {selectedCount === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="scope-selection-required">
          {t('research.layout.scope.selectItemRequired')}
        </p>
      )}
    </div>
  )
}
