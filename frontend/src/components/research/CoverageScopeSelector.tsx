'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { ResearchSynthesisScope } from '@/lib/research/types'

/**
 * COV-09：合成范围显式选择（§12.3/REQ-COV-01）——「相关证据回答」与
 * 「覆盖全部所选来源（Sources）」二选一，不依赖自动意图猜测。
 *
 * - 选择 Notes 时 all_selected 选项禁用，并展示可访问的文字说明
 *   （不只依赖颜色，验收标准）——Notes Coverage 首期不支持（§6.1）；
 * - 0 个 Source：all_selected 可选中但提交前给出提示（提交按钮禁用）；
 * - 超过 50 个 Source：前端预检文案（服务端仍是权威，422 兜底）。
 */

export const COVERAGE_SOURCE_HARD_MAX = 50

export interface CoverageScopeSelectorProps {
  value: ResearchSynthesisScope
  onChange: (scope: ResearchSynthesisScope) => void
  selectedSourceCount: number
  selectedNoteCount: number
}

export function CoverageScopeSelector({
  value,
  onChange,
  selectedSourceCount,
  selectedNoteCount,
}: CoverageScopeSelectorProps) {
  const { t } = useTranslation()
  const notesSelected = selectedNoteCount > 0
  const overHardMax = selectedSourceCount > COVERAGE_SOURCE_HARD_MAX
  const noSources = selectedSourceCount === 0

  let notice: string | null = null
  if (notesSelected) {
    notice = t('research.coverage.notesNotSupported')
  } else if (overHardMax) {
    notice = t('research.coverage.tooManySources', {
      count: selectedSourceCount,
      max: COVERAGE_SOURCE_HARD_MAX,
    })
  } else if (noSources) {
    notice = t('research.coverage.noSourcesHint')
  }

  return (
    <div className="space-y-2" data-testid="coverage-scope-selector">
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as ResearchSynthesisScope)}
        aria-label={t('research.coverage.scopeLabel')}
        aria-describedby={notice ? 'coverage-scope-notice' : undefined}
        className="flex flex-wrap gap-4"
      >
        <Label
          htmlFor="scope-relevant"
          className="flex cursor-pointer items-center gap-2 text-sm"
        >
          <RadioGroupItem id="scope-relevant" value="relevant" />
          {t('research.coverage.scopeRelevant')}
        </Label>
        <Label
          htmlFor="scope-all-selected"
          className={`flex cursor-pointer items-center gap-2 text-sm ${
            notesSelected ? 'cursor-not-allowed opacity-60' : ''
          }`}
        >
          <RadioGroupItem
            id="scope-all-selected"
            value="all_selected"
            disabled={notesSelected}
            data-testid="scope-all-selected-option"
          />
          {t('research.coverage.scopeAllSelected')}
        </Label>
      </RadioGroup>
      {notice !== null && (
        <p
          id="coverage-scope-notice"
          className={`text-xs ${overHardMax ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid="coverage-scope-notice"
        >
          {notice}
        </p>
      )}
    </div>
  )
}
