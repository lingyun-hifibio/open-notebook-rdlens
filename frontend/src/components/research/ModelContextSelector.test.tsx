/**
 * Issue #200 Phase 2b：模型/三档上下文选择器（§14.3）。
 *
 * 契约：
 * - 模型选择器与三档上下文选择器分离；
 * - 无已保存偏好时模型选择为空（不得自动选第一个模型）；
 * - 受控组件：当前选择由父组件持有（显示什么就执行什么，不要求先
 *   保存偏好才能 Run）；Save 仅显式持久化。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import {
  ModelContextSelector,
  type ContextLevel,
} from './ModelContextSelector'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const MODELS = [
  { model_id: 'm-local', display_name: 'Local M', provider_id: 'local' },
  { model_id: 'm-ext', display_name: 'Ext M', provider_id: 'ext' },
]

const NO_PREFS = {
  project_id: 'p1',
  default_context_level: 'focused' as const,
  preferred_model_id: null,
  updated_by: null,
  updated_at: null,
}

const SAVED_PREFS = {
  project_id: 'p1',
  default_context_level: 'document' as const,
  preferred_model_id: 'm-ext',
  updated_by: 1,
  updated_at: '2026-08-26T00:00:00+00:00',
}

/** 模拟父组件：持有受控状态（与 ResearchSearchPanel 同款布线）。 */
function Harness({
  preferences,
  onSavePreference,
}: {
  preferences: typeof NO_PREFS
  onSavePreference: (input: {
    default_context_level: ContextLevel
    preferred_model_id: string | null
  }) => void
}) {
  const [modelId, setModelId] = useState(
    preferences.preferred_model_id ?? '',
  )
  const [level, setLevel] = useState<ContextLevel>(
    preferences.default_context_level,
  )
  return (
    <ModelContextSelector
      models={MODELS}
      preferences={preferences}
      selectedModelId={modelId}
      selectedLevel={level}
      onSelectModel={setModelId}
      onSelectLevel={setLevel}
      onSavePreference={onSavePreference}
    />
  )
}

describe('ModelContextSelector（§14.3，受控）', () => {
  it('无已保存偏好时模型选择为空且不自动选中第一个', () => {
    render(<Harness preferences={NO_PREFS} onSavePreference={vi.fn()} />)
    expect(
      (screen.getByTestId('model-select') as HTMLSelectElement).value,
    ).toBe('')
    expect(
      (screen.getByTestId('context-select') as HTMLSelectElement).value,
    ).toBe('focused')
  })

  it('两个选择器相互独立渲染', () => {
    render(<Harness preferences={NO_PREFS} onSavePreference={vi.fn()} />)
    expect(screen.getByTestId('model-select')).toBeTruthy()
    expect(screen.getByTestId('context-select')).toBeTruthy()
  })

  it('改选当前值立即生效（无需保存即可被父组件读取执行）', () => {
    const onSave = vi.fn()
    render(<Harness preferences={NO_PREFS} onSavePreference={onSave} />)
    fireEvent.change(screen.getByTestId('model-select'), {
      target: { value: 'm-local' },
    })
    fireEvent.change(screen.getByTestId('context-select'), {
      target: { value: 'workspace' },
    })
    expect(
      (screen.getByTestId('model-select') as HTMLSelectElement).value,
    ).toBe('m-local')
    expect(
      (screen.getByTestId('context-select') as HTMLSelectElement).value,
    ).toBe('workspace')
  })

  it('显式保存触发回调并携带两档当前值', () => {
    const onSave = vi.fn()
    render(<Harness preferences={NO_PREFS} onSavePreference={onSave} />)
    fireEvent.change(screen.getByTestId('model-select'), {
      target: { value: 'm-local' },
    })
    fireEvent.change(screen.getByTestId('context-select'), {
      target: { value: 'document' },
    })
    fireEvent.click(screen.getByTestId('save-preference'))
    expect(onSave).toHaveBeenCalledWith({
      default_context_level: 'document',
      preferred_model_id: 'm-local',
    })
  })

  it('未选模型时保存被禁用（后端不隐式补值的 UI 对应）', () => {
    render(<Harness preferences={NO_PREFS} onSavePreference={vi.fn()} />)
    expect(
      (screen.getByTestId('save-preference') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('与已保存偏好一致时 Save 禁用（不产生无差异 PUT）', () => {
    function SavedHarness() {
      return (
        <ModelContextSelector
          models={MODELS}
          preferences={SAVED_PREFS}
          selectedModelId={SAVED_PREFS.preferred_model_id ?? ''}
          selectedLevel={SAVED_PREFS.default_context_level}
          onSelectModel={vi.fn()}
          onSelectLevel={vi.fn()}
          onSavePreference={vi.fn()}
        />
      )
    }
    render(<SavedHarness />)
    expect(
      (screen.getByTestId('save-preference') as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
