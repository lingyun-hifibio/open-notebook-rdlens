'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  ResearchExecutionPreferences,
  ResearchModelOption,
} from '@/lib/research/types'

/**
 * 模型 / 三档上下文选择器（Issue #200 Phase 2b，§14.3）。
 *
 * 契约：
 * - 两个选择器分离（模型 ≠ 上下文档位）；
 * - 无已保存偏好时模型选择为空——绝不自动选中第一个模型；
 * - 偏好只能显式保存（Save → PUT execution-preferences）；
 * - 后端不从偏好隐式补 model_id：发起请求的 model_id 由本选择器的
 *   当前值显式提供。
 */
const CONTEXT_LEVELS = ['focused', 'document', 'workspace'] as const

export function ModelContextSelector({
  models,
  preferences,
  onSavePreference,
  saving = false,
}: {
  models: ResearchModelOption[]
  preferences: ResearchExecutionPreferences | null
  onSavePreference: (input: {
    default_context_level: 'focused' | 'document' | 'workspace'
    preferred_model_id: string | null
  }) => void
  saving?: boolean
}) {
  const { t } = useTranslation()
  const savedModelId = preferences?.preferred_model_id ?? ''
  const [selectedModelId, setSelectedModelId] = useState(savedModelId)
  const [selectedLevel, setSelectedLevel] = useState<
    (typeof CONTEXT_LEVELS)[number]
  >(preferences?.default_context_level ?? 'focused')

  // 已保存偏好变化（保存成功回读/项目切换）时同步本地选择
  useEffect(() => {
    setSelectedModelId(preferences?.preferred_model_id ?? '')
  }, [preferences?.preferred_model_id])

  useEffect(() => {
    if (preferences?.default_context_level) {
      setSelectedLevel(preferences.default_context_level)
    }
  }, [preferences?.default_context_level])

  const dirty =
    selectedModelId !== savedModelId ||
    selectedLevel !== (preferences?.default_context_level ?? 'focused')

  return (
    <div
      className="flex flex-wrap items-center gap-3 text-sm"
      data-testid="model-context-selector"
    >
      <label className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          {t('research.modelSelector')}
        </span>
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          data-testid="model-select"
          value={selectedModelId}
          onChange={(event) => setSelectedModelId(event.target.value)}
        >
          {/* 无已保存偏好时保持空选（不自动选第一个模型） */}
          <option value="">—</option>
          {models.map((model) => (
            <option key={model.model_id} value={model.model_id}>
              {model.display_name || model.model_id}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          {t('research.contextLevelSelector')}
        </span>
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          data-testid="context-select"
          value={selectedLevel}
          onChange={(event) =>
            setSelectedLevel(
              event.target.value as (typeof CONTEXT_LEVELS)[number],
            )
          }
        >
          {CONTEXT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>

      <Button
        variant="outline"
        size="sm"
        data-testid="save-preference"
        disabled={!dirty || !selectedModelId || saving}
        onClick={() =>
          onSavePreference({
            default_context_level: selectedLevel,
            preferred_model_id: selectedModelId,
          })
        }
      >
        {saving ? t('research.savingPreference') : t('research.savePreference')}
      </Button>
    </div>
  )
}
