/**
 * Issue #243 GMOD-FE-01 §6.3：Search 局部上下文选择器。
 *
 * - 不再提供模型选择——页面内唯一模型入口在 Research 顶层（不变量 1）；
 * - 保存只提交档位，不得携带模型字段（不变量 8）；
 * - 档位候选按当前模型 interactive_context_levels 收敛（服务端能力，
 *   不由前端按 provider/data_egress 猜测）。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import {
  SearchContextSelector,
  CONTEXT_LEVELS,
} from './SearchContextSelector'
import type { ResearchContextLevel } from '@/lib/research/types'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

/** 模拟父组件：持有局部档位（与 ResearchSearchPanel 同款布线）。 */
function Harness({
  contextDefault = 'focused',
  supportedLevels = [...CONTEXT_LEVELS],
  onSaveContext = vi.fn(),
}: {
  contextDefault?: ResearchContextLevel
  supportedLevels?: ResearchContextLevel[]
  onSaveContext?: (level: ResearchContextLevel) => void
}) {
  const [level, setLevel] = useState<ResearchContextLevel>(contextDefault)
  return (
    <SearchContextSelector
      contextDefault={contextDefault}
      supportedLevels={supportedLevels}
      selectedLevel={level}
      onSelectLevel={setLevel}
      onSaveContext={onSaveContext}
    />
  )
}

describe('SearchContextSelector（GMOD §6.3，上下文独立）', () => {
  it('不再渲染模型选择器（模型入口只在 Research 顶层）', () => {
    render(<Harness />)
    expect(screen.queryByTestId('model-select')).toBeNull()
    expect(screen.getByTestId('search-context-selector')).toBeTruthy()
    expect(screen.getByTestId('context-select')).toBeTruthy()
  })

  it('局部改选立即生效，无需保存即可被父组件读取执行', () => {
    render(<Harness />)
    fireEvent.change(screen.getByTestId('context-select'), {
      target: { value: 'workspace' },
    })
    expect(
      (screen.getByTestId('context-select') as HTMLSelectElement).value,
    ).toBe('workspace')
  })

  it('保存回调只携带档位，不含任何模型字段', () => {
    const onSaveContext = vi.fn()
    render(<Harness onSaveContext={onSaveContext} />)
    fireEvent.change(screen.getByTestId('context-select'), {
      target: { value: 'document' },
    })
    fireEvent.click(screen.getByTestId('save-search-context'))
    expect(onSaveContext).toHaveBeenCalledWith('document')
    // 回调签名只有一个参数：结构上不可能把 preferred_model_id 带上
    expect(onSaveContext.mock.calls[0]).toHaveLength(1)
  })

  it('与服务端默认值一致时保存禁用（不产生无差异 PATCH）', () => {
    render(<Harness contextDefault="focused" />)
    expect(
      (screen.getByTestId('save-search-context') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('模型不支持的档位被禁用；已选档位不受保存状态影响', () => {
    render(<Harness supportedLevels={['focused']} />)
    const options = screen.getAllByRole('option') as HTMLOptionElement[]
    const byValue = Object.fromEntries(options.map((o) => [o.value, o]))
    expect(byValue['focused']?.disabled).toBe(false)
    expect(byValue['document']?.disabled).toBe(true)
    expect(byValue['workspace']?.disabled).toBe(true)
  })

  it('saving 时按钮禁用（保存中冻结）', () => {
    function SavingHarness() {
      return (
        <SearchContextSelector
          contextDefault="focused"
          supportedLevels={[...CONTEXT_LEVELS]}
          selectedLevel="document"
          onSelectLevel={vi.fn()}
          onSaveContext={vi.fn()}
          saving
        />
      )
    }
    render(<SavingHarness />)
    expect(
      (screen.getByTestId('save-search-context') as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
