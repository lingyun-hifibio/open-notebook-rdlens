/**
 * Issue #200 Phase 2b：模型/三档上下文选择器（§14.3）。
 *
 * 契约：
 * - 模型选择器与三档上下文选择器分离；
 * - 无已保存偏好时模型选择为空（不得自动选第一个模型）；
 * - 上下文档位默认取偏好 default_context_level（初始 focused）；
 * - 偏好只能显式保存（Save 触发 PUT），不隐式提交。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ModelContextSelector } from './ModelContextSelector'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const MODELS = [
  { model_id: 'm-local', display_name: 'Local M', provider_id: 'local' },
  { model_id: 'm-ext', display_name: 'Ext M', provider_id: 'ext' },
]

describe('ModelContextSelector（§14.3）', () => {
  it('无已保存偏好时模型选择为空且不自动选中第一个', () => {
    render(
      <ModelContextSelector
        models={MODELS}
        preferences={{
          project_id: 'p1',
          default_context_level: 'focused',
          preferred_model_id: null,
          updated_by: null,
          updated_at: null,
        }}
        onSavePreference={vi.fn()}
      />,
    )
    const modelSelect = screen.getByTestId(
      'model-select',
    ) as HTMLSelectElement
    expect(modelSelect.value).toBe('')
    const contextSelect = screen.getByTestId(
      'context-select',
    ) as HTMLSelectElement
    expect(contextSelect.value).toBe('focused')
  })

  it('两个选择器相互独立渲染', () => {
    render(
      <ModelContextSelector
        models={MODELS}
        preferences={{
          project_id: 'p1',
          default_context_level: 'workspace',
          preferred_model_id: null,
          updated_by: null,
          updated_at: null,
        }}
        onSavePreference={vi.fn()}
      />,
    )
    expect(screen.getByTestId('model-select')).toBeTruthy()
    expect(screen.getByTestId('context-select')).toBeTruthy()
    const contextSelect = screen.getByTestId(
      'context-select',
    ) as HTMLSelectElement
    expect(contextSelect.value).toBe('workspace')
  })

  it('保存的偏好在下次进入时回显为当前选择', () => {
    render(
      <ModelContextSelector
        models={MODELS}
        preferences={{
          project_id: 'p1',
          default_context_level: 'document',
          preferred_model_id: 'm-ext',
          updated_by: 1,
          updated_at: '2026-08-26T00:00:00+00:00',
        }}
        onSavePreference={vi.fn()}
      />,
    )
    expect(
      (screen.getByTestId('model-select') as HTMLSelectElement).value,
    ).toBe('m-ext')
    expect(
      (screen.getByTestId('context-select') as HTMLSelectElement).value,
    ).toBe('document')
  })

  it('显式保存触发 PUT 回调并携带两档选择', () => {
    const onSave = vi.fn()
    render(
      <ModelContextSelector
        models={MODELS}
        preferences={{
          project_id: 'p1',
          default_context_level: 'focused',
          preferred_model_id: null,
          updated_by: null,
          updated_at: null,
        }}
        onSavePreference={onSave}
      />,
    )
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
    render(
      <ModelContextSelector
        models={MODELS}
        preferences={{
          project_id: 'p1',
          default_context_level: 'focused',
          preferred_model_id: null,
          updated_by: null,
          updated_at: null,
        }}
        onSavePreference={vi.fn()}
      />,
    )
    expect(
      (screen.getByTestId('save-preference') as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
