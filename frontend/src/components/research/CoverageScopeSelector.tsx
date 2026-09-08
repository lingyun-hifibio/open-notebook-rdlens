'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { ResearchSynthesisScope } from '@/lib/research/types'
import type { ResearchScopeMode } from '@/lib/research/scope'

/**
 * COV-09：合成范围显式选择（§12.3/REQ-COV-01）——「相关证据回答」与
 * 「覆盖全部所选来源（Sources）」二选一，不依赖自动意图猜测。
 *
 * - 选择 Notes 时 all_selected 选项禁用，并展示可访问的文字说明
 *   （不只依赖颜色，验收标准）——Notes Coverage 首期不支持（§6.1）；
 * - 0 个 Source：all_selected 可选中但提交前给出提示（提交按钮禁用）；
 * - 超过 50 个 Source：前端预检文案（服务端仍是权威，422 兜底）；
 * - RWV2-11（K3/W4）：`entire_project` 无显式 Source 集合——通知文案
 *   优先于通用 noSourcesHint，说明需切换到 Selected 才能覆盖；提交闸门
 *   在 ChatPanel 单点（本组件只出通知）。
 */

export const COVERAGE_SOURCE_HARD_MAX = 50

export interface CoverageScopeSelectorProps {
  value: ResearchSynthesisScope
  onChange: (scope: ResearchSynthesisScope) => void
  /** RWV2-11（K3）：当前 Scope 模式——entire_project 下显示专属说明 */
  scopeMode: ResearchScopeMode
  /**
   * #358：后端 Coverage 能力。false/缺失 → 禁用 all_selected 并展示
   * 可访问说明（fail-closed；能力门禁最终在 ChatPanel 提交闸门单点，
   * 本组件只出通知与禁用）。缺省 true 仅为组件直用兼容——生产调用链
   * （ResearchWorkspace → ChatPanel）恒显式传入，缺失即 false。
   */
  capabilityEnabled?: boolean
  selectedSourceCount: number
  selectedNoteCount: number
}

export function CoverageScopeSelector({
  value,
  onChange,
  scopeMode,
  capabilityEnabled = true,
  selectedSourceCount,
  selectedNoteCount,
}: CoverageScopeSelectorProps) {
  const { t } = useTranslation()
  const notesSelected = selectedNoteCount > 0
  const overHardMax = selectedSourceCount > COVERAGE_SOURCE_HARD_MAX
  const noSources = selectedSourceCount === 0
  // #358：能力关闭优先于其他说明（后端未开启时不谈 Notes/数量预检）
  const capabilityOff = capabilityEnabled === false

  let notice: string | null = null
  if (capabilityOff) {
    notice = t('research.coverage.capabilityDisabled')
  } else if (notesSelected) {
    notice = t('research.coverage.notesNotSupported')
  } else if (overHardMax) {
    notice = t('research.coverage.tooManySources', {
      count: selectedSourceCount,
      max: COVERAGE_SOURCE_HARD_MAX,
    })
  } else if (scopeMode === 'entire_project') {
    // RWV2-11（K3/W4）：entire_project 优先级高于通用 noSourcesHint
    notice = t('research.coverage.entireProjectNotice')
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
            notesSelected || capabilityOff ? 'cursor-not-allowed opacity-60' : ''
          }`}
        >
          <RadioGroupItem
            id="scope-all-selected"
            value="all_selected"
            disabled={notesSelected || capabilityOff}
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
