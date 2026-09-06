'use client'

import { useEffect, useRef } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useResearchScope, type ResearchScopeMode } from '@/lib/research/scope'

/**
 * 左栏唯一 Scope 编辑面——模式控件（RWV2-13 Issue #34，RFC §3）。
 *
 * - `entire_project` 显式可见可点（D2：首次进入显式展示，不由 0 个选择
 *   隐式推导）；selected 需 ≥1 项有效选择（D3：0 选择禁止执行，不扩大
 *   数据范围）。
 * - 模式与选择全部写入根级 ResearchScopeProvider（D4/D5：Search/Chat/
 *   Compare/Insight/Transformation 共享；按用户+项目持久化）；Sources/
 *   Notes 面板的行首复选框是唯一项目选择入口，本组件只负责模式。
 * - `min-w-0 + flex-wrap`：桌面最小栏宽（1024px 视口、分隔条最窄
 *   280px）不隐藏标题、不产生横向页面滚动（AC：窄分栏位置）。
 */
export function ResearchScopeEditor({
  scopeEditRequest,
}: {
  /** 递增序号：右栏 `Edit scope` 请求聚焦本编辑面（含退出最大化后） */
  scopeEditRequest?: number
}) {
  const { t } = useTranslation()
  const { mode, selectedSourceIds, selectedNoteIds, setMode } = useResearchScope()
  const selectedCount = selectedSourceIds.length + selectedNoteIds.length
  const radioGroupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scopeEditRequest === undefined) return
    // RWV2-13：Edit scope 的键盘可达目标——聚焦首个模式单选，供后续
    // 方向键/读屏继续操作（编辑面在最大化态恢复后仍然可聚焦）
    radioGroupRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus()
  }, [scopeEditRequest])

  return (
    <div className="min-w-0 space-y-2 border-b pb-3" data-testid="research-scope-editor">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('research.layout.scope.modeLabel')}
      </p>
      <RadioGroup
        ref={radioGroupRef}
        value={mode}
        onValueChange={(value) => setMode(value as ResearchScopeMode)}
        className="flex min-w-0 flex-wrap gap-x-4 gap-y-2"
        aria-label={t('research.layout.scope.modeLabel')}
      >
        <label className="flex min-w-0 items-center gap-2 text-sm">
          <RadioGroupItem value="entire_project" data-testid="scope-entire-project" />
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
      {selectedCount === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="scope-selection-required">
          {t('research.layout.scope.selectItemRequired')}
        </p>
      )}
    </div>
  )
}
