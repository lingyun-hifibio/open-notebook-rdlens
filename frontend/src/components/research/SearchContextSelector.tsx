'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { ResearchContextLevel } from '@/lib/research/types'

/**
 * Search 局部上下文选择器（Issue #243 GMOD-FE-01，计划 §6.3）。
 *
 * Issue #200 时期这里同时承载模型与上下文两个选择器；全局模型改造后：
 *
 * - **不再提供模型选择**——模型来自 Research 顶层控件（页面内唯一入口）；
 * - 只负责 Search 的 `focused/document/workspace` 局部档位；
 * - 初始值来自服务端 `default_context_level`，但用户可在本次搜索前使用
 *   尚未保存的局部档位（局部选择 = 显示什么就执行什么）；
 * - 保存只 PATCH `default_context_level`，绝不携带 `preferred_model_id`
 *   （不变量 8：保存 Search 上下文不得改变顶层模型）；
 * - 档位候选来自当前模型的 `interactive_context_levels`（服务端能力），
 *   不按 provider 名或 data_egress 猜测。
 */
export const CONTEXT_LEVELS = ['focused', 'document', 'workspace'] as const

export function SearchContextSelector({
  contextDefault,
  supportedLevels,
  selectedLevel,
  onSelectLevel,
  onSaveContext,
  saving = false,
  disabled = false,
}: {
  /** 服务端已保存的默认档位（用于判断是否 dirty） */
  contextDefault: ResearchContextLevel
  /** 当前模型支持的交互式档位；缺省时按全档位呈现 */
  supportedLevels: ResearchContextLevel[]
  selectedLevel: ResearchContextLevel
  onSelectLevel: (level: ResearchContextLevel) => void
  /** 只保存档位，不触碰模型 */
  onSaveContext: (level: ResearchContextLevel) => void
  saving?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const dirty = selectedLevel !== contextDefault

  return (
    <div
      className="flex flex-wrap items-center gap-3 text-sm"
      data-testid="search-context-selector"
    >
      <label className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          {t('research.searchContext.label')}
        </span>
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          data-testid="context-select"
          aria-label={t('research.searchContext.label')}
          value={selectedLevel}
          disabled={disabled}
          onChange={(event) => onSelectLevel(event.target.value as ResearchContextLevel)}
        >
          {CONTEXT_LEVELS.map((level) => (
            <option key={level} value={level} disabled={!supportedLevels.includes(level)}>
              {level}
            </option>
          ))}
        </select>
      </label>

      <Button
        variant="outline"
        size="sm"
        data-testid="save-search-context"
        disabled={!dirty || saving || disabled}
        onClick={() => onSaveContext(selectedLevel)}
      >
        {saving
          ? t('research.searchContext.saving')
          : t('research.searchContext.save')}
      </Button>
    </div>
  )
}
