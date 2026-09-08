/**
 * ResearchGlobalModelBar 组件测试（Issue #243 GMOD-FE-01，评审 Minor-7）。
 *
 * RWV2-UIOPT-A（fork #57）：组件收敛为紧凑 Trigger + Popover 单一形态，
 * `layout` 参数删除。Trigger 是页面常驻摘要，只描述 **confirmed** 模型：
 * - Trigger 组成：confirmed display name（缺 display name 用 model ID）+
 *   显式 Local/External + 当前最高优先级状态；
 * - Trigger 永不读取 draft：draft 未保存时 Trigger 名称不变、仅状态行
 *   提示 Unsaved（计划 §6.3，防「未保存 draft 被当成正在使用」）；
 * - confirmed 模型从目录消失 → Trigger 显示原 ID + Unavailable，绝不因
 *   元数据缺失推断为 Local（不变量 7）；
 * - 未配置模型 → Trigger 显示 Select model，不出现虚假的 Local/External；
 * - 外发标识必须直接出现在 Trigger，不得只藏在 Tooltip/Popover 内
 *   （RWV2-42 D9/计划 §6.3）。
 *
 * 控件级行为（不变量 2/3/7、Admin readonly、Consent 入口）由 use
 * global-model-stub 替身隔离，用例先打开 Popover 再断言。
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

/** 打开紧凑 Trigger 的 Popover（控件只存在于浮层内）。 */
function openPopover() {
  fireEvent.click(screen.getByTestId('global-model-summary-trigger'))
}

describe('ResearchGlobalModelBar（RWV2-UIOPT-A 紧凑 Trigger）', () => {
  beforeEach(() => {
    resetGlobalModelStub()
  })

  it('Trigger 常驻：confirmed 模型名 + Local 标记；select 只在 Popover 内', () => {
    setGlobalModelStub({
      models: MODELS,
      confirmedModelId: GLOBAL_MODEL_STUB_ID,
      draftModelId: GLOBAL_MODEL_STUB_ID,
    })
    render(<ResearchGlobalModelBar />)

    const trigger = screen.getByTestId('global-model-summary-trigger')
    expect(trigger.textContent).toContain('Local M')
    expect(trigger.textContent).toContain('research.globalModel.local')
    // 控件收进 Popover，不在页面流中
    expect(screen.queryByTestId('global-model-select')).toBeNull()
    openPopover()
    expect(screen.getByTestId('global-model-select')).toBeTruthy()
  })

  it('Trigger 永远显示 confirmed；draft 改动后名称不变且出现 Unsaved 状态（不变量 2）', () => {
    setGlobalModelStub({
      models: MODELS,
      confirmedModelId: GLOBAL_MODEL_STUB_ID,
      draftModelId: 'm-other',
    })
    render(<ResearchGlobalModelBar />)

    const trigger = screen.getByTestId('global-model-summary-trigger')
    expect(trigger.textContent).toContain('Local M')
    // draft（Other M）绝不出现在摘要里
    expect(trigger.textContent).not.toContain('Other M')
    expect(trigger.textContent).toContain('research.globalModel.draftUnsaved')
  })

  it('confirmed 从目录消失 → Trigger 显示原 ID + Unavailable，不误标 Local（不变量 7）', () => {
    setGlobalModelStub({ confirmedModelId: 'm-gone' })
    render(<ResearchGlobalModelBar />)

    const trigger = screen.getByTestId('global-model-summary-trigger')
    expect(trigger.textContent).toContain('m-gone')
    expect(trigger.textContent).toContain('research.globalModel.unavailable')
    // 元数据缺失不得推断部署身份
    expect(trigger.textContent).not.toContain('research.globalModel.local')
    expect(trigger.textContent).not.toContain('research.globalModel.external')
  })

  it('External 模型在 Trigger 直接显示 External（外发标识不藏进 Popover）', () => {
    const external: ResearchModelOption[] = [
      {
        model_id: 'm-ext',
        display_name: 'Ext M',
        data_egress: true,
        interactive_context_levels: ['focused', 'document', 'workspace'],
      },
    ]
    setGlobalModelStub({
      models: external,
      confirmedModelId: 'm-ext',
      draftModelId: 'm-ext',
    })
    render(<ResearchGlobalModelBar />)

    const trigger = screen.getByTestId('global-model-summary-trigger')
    expect(trigger.textContent).toContain('Ext M')
    expect(trigger.textContent).toContain('research.globalModel.external')
    expect(trigger.textContent).not.toContain('research.globalModel.local')
  })

  it('未配置模型 → Trigger 显示 Select model，不出现虚假 Local/External', () => {
    setGlobalModelStub({ confirmedModelId: null, draftModelId: null })
    render(<ResearchGlobalModelBar />)

    const trigger = screen.getByTestId('global-model-summary-trigger')
    expect(trigger.textContent).toContain('research.globalModel.placeholder')
    expect(trigger.textContent).not.toContain('research.globalModel.local')
    expect(trigger.textContent).not.toContain('research.globalModel.external')
  })

  it('已保存模型从目录消失时在 Popover 内保留为 unavailable 条目并置顶（不变量 7）', () => {
    setGlobalModelStub({ confirmedModelId: 'm-gone' })
    render(<ResearchGlobalModelBar />)
    openPopover()

    const select = screen.getByTestId('global-model-select') as HTMLSelectElement
    const values = Array.from(select.options).map((option) => option.value)
    // placeholder 后的首位是消失模型（不可用），绝不自动改选
    expect(values[1]).toBe('m-gone')
    expect(select.value).toBe('m-gone')
    // 状态行提示不可用
    expect(screen.getByTestId('global-model-status').textContent).toContain(
      'research.globalModel.unavailable',
    )
  })

  it('无已保存偏好时保持空选，不自动选中第一个模型（不变量 7）', () => {
    setGlobalModelStub({ confirmedModelId: null, draftModelId: null })
    render(<ResearchGlobalModelBar />)
    openPopover()

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
    openPopover()

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
    openPopover()

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
    openPopover()

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

  it('本地与外部模型身份在 Popover 下拉选项中显式标记（RWV2-42）', () => {
    const mixed: ResearchModelOption[] = [
      { model_id: 'm-loc', display_name: 'Local M', data_egress: false },
      { model_id: 'm-ext', display_name: 'Ext M', data_egress: true },
    ]
    setGlobalModelStub({
      models: mixed,
      confirmedModelId: 'm-ext',
      draftModelId: 'm-ext',
    })
    render(<ResearchGlobalModelBar />)
    openPopover()

    const select = screen.getByTestId('global-model-select') as HTMLSelectElement
    const text = Array.from(select.options).map((option) => option.textContent ?? '')
    // t() 在测试中映射为 key：断言组件选择正确文案 key，而非猜测语言
    const extOption = text.find((t) => t.startsWith('Ext M'))
    expect(extOption).toContain('research.globalModel.external')
    const locOption = text.find((t) => t.startsWith('Local M'))
    expect(locOption).toContain('research.globalModel.local')
  })

  it('待确认时提供显式外发确认入口', () => {
    const onRunGuarded = vi.fn()
    setGlobalModelStub({
      needsConsent: true,
      deferGuarded: true,
      onRunGuarded,
    })
    render(<ResearchGlobalModelBar />)
    openPopover()

    fireEvent.click(screen.getByTestId('global-model-consent'))
    expect(onRunGuarded).toHaveBeenCalledTimes(1)
  })
})
