import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope } from '@/lib/research/scope'
import { ResearchScopeEditor } from './ResearchScopeEditor'

/**
 * PR5（C4 / D-04 / D-10 / T5）：Scope 编辑面三档控件的行为与键盘可达性。
 *
 * 为什么单列（而不是并入 `ResearchScopeEditor.test.tsx`）：既有文件只覆盖
 * `all`/`selected` 两档；PR5 新增的**临时单篇限定**（会话级「只问此来源」
 * + 「取消限定」）与 `all` 反推提示此前没有任何断言。
 */

const USER_ID = 'u1'
const PROJECT_ID = 'proj_1'

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
      {children}
    </ResearchScopeProvider>
  )
}

/** 把 provider 的写入口暴露成按钮，便于在测试里驱动三档状态 */
function ScopeControls() {
  const { toggleSource, setSingle, singlePin } = useResearchScope()
  return (
    <div>
      <button type="button" data-testid="ctl-toggle-source" onClick={() => toggleSource('src_1')}>
        toggle
      </button>
      <button
        type="button"
        data-testid="ctl-set-single"
        onClick={() => setSingle('src_9', 'sess_1')}
      >
        single
      </button>
      <output data-testid="ctl-single-pin">{singlePin?.sourceId ?? 'none'}</output>
    </div>
  )
}

function renderEditor(scopeEditRequest?: number) {
  return render(
    <div>
      <ScopeControls />
      <ResearchScopeEditor scopeEditRequest={scopeEditRequest} />
    </div>,
    { wrapper },
  )
}

describe('ResearchScopeEditor · 三档与限定（C4）', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('默认 all：单选可见、all 反推提示可见、selected 在 0 选择时禁用', () => {
    renderEditor()

    expect(screen.getByTestId('scope-entire-project')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('scope-all-hint')).toHaveTextContent('research.layout.scope.allHint')
    expect(screen.getByTestId('scope-selected')).toBeDisabled()
    expect(screen.getByTestId('scope-selection-required')).toBeInTheDocument()
    // single 不是模式单选里的第三档（它是会话级临时限定）
    expect(screen.queryByTestId('scope-single')).toBeNull()
  })

  it('D-10 反推：勾选任一资料 → 切到 selected，all 提示消失', () => {
    renderEditor()

    fireEvent.click(screen.getByTestId('ctl-toggle-source'))

    expect(screen.getByTestId('scope-selected')).toHaveAttribute('data-state', 'checked')
    expect(screen.queryByTestId('scope-all-hint')).toBeNull()
    expect(screen.queryByTestId('scope-selection-required')).toBeNull()
  })

  it('D-04：限定生效时显示被限定来源 + 「取消限定」按钮，并可清除回基础范围', () => {
    renderEditor()

    fireEvent.click(screen.getByTestId('ctl-set-single'))

    const pin = screen.getByTestId('scope-single-pin')
    // 测试替身的 t() 不做插值 → 断言文案键；来源 id 由 provider 侧输出验证
    expect(pin).toHaveTextContent('research.layout.scope.singleActive')
    expect(screen.getByTestId('ctl-single-pin')).toHaveTextContent('src_9')
    expect(screen.getByTestId('scope-single-clear')).toHaveTextContent(
      'research.layout.scope.singleClear',
    )
    // single 生效 → 模式单选不再有选中项（它是叠加态，不是第三档）
    expect(screen.queryByTestId('scope-all-hint')).toBeNull()

    fireEvent.click(screen.getByTestId('scope-single-clear'))

    expect(screen.queryByTestId('scope-single-pin')).toBeNull()
    expect(screen.getByTestId('scope-entire-project')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('scope-all-hint')).toBeInTheDocument()
  })

  it('键盘可达：单选组有 radio 语义，取消限定是普通可 Tab 到的按钮', () => {
    renderEditor()
    fireEvent.click(screen.getByTestId('ctl-set-single'))

    expect(screen.getAllByRole('radio').length).toBeGreaterThanOrEqual(2)
    const clear = screen.getByTestId('scope-single-clear')
    expect(clear.tagName).toBe('BUTTON')
    expect(clear).not.toBeDisabled()
  })

  it('a11y：scopeEditRequest 递增时才聚焦，初始挂载不抢焦点', () => {
    const { rerender } = renderEditor(0)
    const firstRadio = screen.getAllByRole('radio')[0]
    expect(document.activeElement).not.toBe(firstRadio)

    rerender(
      <div>
        <ScopeControls />
        <ResearchScopeEditor scopeEditRequest={1} />
      </div>,
    )
    expect(document.activeElement).toBe(firstRadio)
  })

  it('持久化：勾选写入本用户/本项目键，且写回的是新档位语义', () => {
    renderEditor()
    fireEvent.click(screen.getByTestId('ctl-toggle-source'))

    const persisted = JSON.parse(localStorage.getItem(scopeStorageKey(USER_ID, PROJECT_ID)) ?? '{}')
    expect(persisted).toMatchObject({ version: 1, mode: 'selected', sourceIds: ['src_1'] })
  })
})
