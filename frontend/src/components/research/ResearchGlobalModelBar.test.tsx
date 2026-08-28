/**
 * ResearchGlobalModelBar 组件测试（Issue #243 GMOD-FE-01，评审 Minor-7）。
 *
 * 用 global-model-stub 替身隔离 provider 逻辑（该逻辑由
 * use-research-global-model.test.tsx 覆盖），聚焦 UI 呈现：
 * - 不变量 7：目录中消失的已保存模型保留为 unavailable 条目并置顶，
 *   且无偏好时保持空选、绝不自动选中；
 * - draft 未保存状态与保存按钮可用性（不变量 2）；
 * - Admin readonly 禁用全部控件；
 * - 保存中冻结生成入口（不变量 3）；
 * - popover 布局提供窄屏等价入口（§6.10）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ResearchGlobalModelBar } from './ResearchGlobalModelBar'
import {
  GLOBAL_MODEL_STUB_ID,
  resetGlobalModelStub,
  setGlobalModelStub,
} from '@/test/global-model-stub'
import type { ResearchModelOption } from '@/lib/research/types'

vi.mock('@/lib/hooks/use-research-global-model')
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const MODELS: ResearchModelOption[] = [
  {
    model_id: GLOBAL_MODEL_STUB_ID,
    display_name: 'Local M',
    data_egress: false,
    interactive_context_levels: ['focused', 'document', 'workspace'],
  },
  {
    model_id: 'm-other',
    display_name: 'Other M',
    data_egress: false,
    interactive_context_levels: ['focused', 'document', 'workspace'],
  },
]

describe('ResearchGlobalModelBar', () => {
  beforeEach(() => {
    resetGlobalModelStub()
  })

  it('已保存模型从目录消失时保留为 unavailable 条目并置顶（不变量 7）', () => {
    setGlobalModelStub({ confirmedModelId: 'm-gone' })
    render(<ResearchGlobalModelBar />)

    const select = screen.getByTestId('global-model-select') as HTMLSelectElement
    const values = Array.from(select.options).map((option) => option.value)
    // placeholder 后的首位是消失模型（不可用），绝不自动改选
    expect(values[1]).toBe('m-gone')
    expect(values).toContain(GLOBAL_MODEL_STUB_ID)
    expect(select.value).toBe('m-gone')
    // 状态行提示不可用
    expect(screen.getByTestId('global-model-status').textContent).toContain(
      'research.globalModel.unavailable',
    )
  })

  it('无已保存偏好时保持空选，不自动选中第一个模型（不变量 7）', () => {
    setGlobalModelStub({ confirmedModelId: null, draftModelId: null })
    render(<ResearchGlobalModelBar />)

    const select = screen.getByTestId('global-model-select') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(screen.getByTestId('global-model-status').textContent).toContain(
      'research.globalModel.selectModelHint',
    )
    // 未选择时保存不可用
    expect((screen.getByTestId('global-model-save') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('draft 与 confirmed 不一致时提示「尚未保存」且保存可用（不变量 2）', () => {
    setGlobalModelStub({ models: MODELS, draftModelId: 'm-other' })
    render(<ResearchGlobalModelBar />)

    const select = screen.getByTestId('global-model-select') as HTMLSelectElement
    expect(select.value).toBe('m-other')
    expect(screen.getByTestId('global-model-status').textContent).toContain(
      'research.globalModel.draftUnsaved',
    )
    expect((screen.getByTestId('global-model-save') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('Admin readonly 禁用全部控件并提示', () => {
    setGlobalModelStub({ blockedReason: 'admin-readonly' })
    render(<ResearchGlobalModelBar />)

    const select = screen.getByTestId('global-model-select') as HTMLSelectElement
    const save = screen.getByTestId('global-model-save') as HTMLButtonElement
    const clear = screen.getByTestId('global-model-clear') as HTMLButtonElement
    expect(select.disabled).toBe(true)
    expect(save.disabled).toBe(true)
    expect(clear.disabled).toBe(true)
    expect(screen.getByTestId('global-model-status').textContent).toContain(
      'research.globalModel.adminReadonly',
    )
  })

  it('保存中冻结控件（不变量 3）', () => {
    setGlobalModelStub({ isSavingModel: true })
    render(<ResearchGlobalModelBar />)

    expect(
      (screen.getByTestId('global-model-select') as HTMLSelectElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByTestId('global-model-save') as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.getByTestId('global-model-status').textContent).toContain(
      'research.globalModel.saving',
    )
  })

  it('popover 布局提供窄屏等价入口（§6.10）', () => {
    render(<ResearchGlobalModelBar layout="popover" />)

    // 窄屏：模型控件收进设置触发器，不在页面流中
    expect(screen.getByTestId('global-model-settings-trigger')).toBeTruthy()
    expect(screen.queryByTestId('global-model-select')).toBeNull()
    // 展开后出现同一组控件
    fireEvent.click(screen.getByTestId('global-model-settings-trigger'))
    expect(screen.getByTestId('global-model-select')).toBeTruthy()
  })
})
