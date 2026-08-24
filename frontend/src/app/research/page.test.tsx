import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// /research 组合层（Issue #182 Red）：selectedSourceId/highlightPageIdx 提升。
// 上半屏 Workbench 受控化；选中 Source 后下半屏切换为 Source Chat 面板，
// 全局 Workspace 以 hidden 包裹保持挂载（chat/jobs 状态不丢失）；
// 关闭来源恢复 Workspace tabs；onSelectSource 默认重置高亮。

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}))

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: () => true,
}))

vi.mock('@/lib/embedded/shell', () => ({
  ResearchWorkspaceShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}))

interface WorkbenchPropsMock {
  selectedSourceId: string | null
  highlightPageIdx: number | null
  onSelectSource: (sourceId: string, opts?: { highlightPageIdx?: number | null }) => void
  onCloseSource: () => void
}

// Workbench 测试替身：暴露受控 props 与回调触发按钮，断言组合层接线
vi.mock('@/components/research/ResearchWorkbench', () => ({
  ResearchWorkbench: (props: WorkbenchPropsMock) => (
    <div
      data-testid="workbench"
      data-selected-source-id={props.selectedSourceId ?? ''}
      data-highlight-page-idx={props.highlightPageIdx ?? ''}
    >
      <button data-testid="wb-open" onClick={() => props.onSelectSource('src_1')} />
      <button
        data-testid="wb-open-at-page"
        onClick={() => props.onSelectSource('src_9', { highlightPageIdx: 4 })}
      />
      <button data-testid="wb-close" onClick={() => props.onCloseSource()} />
    </div>
  ),
}))

vi.mock('@/components/research/ResearchWorkspace', () => ({
  ResearchWorkspace: () => <div data-testid="workspace" />,
}))

vi.mock('@/components/research/ResearchSourceChatPanel', () => ({
  ResearchSourceChatPanel: ({
    sourceId,
    onHighlightPage,
  }: {
    sourceId: string
    onHighlightPage: (pageIdx: number) => void
  }) => (
    <div data-testid="source-chat-panel" data-source-id={sourceId}>
      <button data-testid="panel-cite-page" onClick={() => onHighlightPage(7)} />
    </div>
  ),
}))

import ResearchPage from './page'

function workbenchEl(): HTMLElement {
  return screen.getByTestId('workbench')
}

describe('/research 页面骨架', () => {
  it('上半屏包裹层固定半屏高且裁剪溢出（overflow-hidden）', () => {
    render(<ResearchPage />)
    const wrapper = screen.getByTestId('workbench').parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('h-1/2', 'min-h-0', 'overflow-hidden')
  })

  it('下半屏包裹层固定半屏高（与上半屏各占 50%，无剩余可分配空间）', () => {
    render(<ResearchPage />)
    // Workspace 外层是保持挂载的 h-full 槽位，再外层才是固定半屏高包裹层
    const wrapper = screen.getByTestId('workspace').parentElement?.parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('h-1/2', 'min-h-0')
  })
})

describe('/research Source 详情 + Source Chat 组合（Issue #182）', () => {
  it('默认：下半屏渲染全局 Workspace，无 Source Chat 面板', () => {
    render(<ResearchPage />)
    expect(screen.getByTestId('workspace')).toBeInTheDocument()
    expect(screen.queryByTestId('source-chat-panel')).toBeNull()
    expect(workbenchEl().getAttribute('data-selected-source-id')).toBe('')
  })

  it('选源：下半屏切换为 Source Chat 面板，Workspace 保持挂载且被 hidden 包裹', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open'))

    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('source-chat-panel').getAttribute('data-source-id')).toBe('src_1')

    // 保持挂载：hidden 类包裹而非卸载（chat/jobs 本地状态不丢失）
    const workspace = screen.getByTestId('workspace')
    expect(workspace.parentElement).toHaveClass('hidden')
  })

  it('关闭来源：卸载面板并恢复 Workspace（无 hidden）', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('wb-close'))
    expect(screen.queryByTestId('source-chat-panel')).toBeNull()
    expect(screen.getByTestId('workspace')).toBeInTheDocument()
    expect(screen.getByTestId('workspace').parentElement).not.toHaveClass('hidden')
  })

  it('onSelectSource 携带页码时设置高亮；再次普通选源重置高亮为空', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open-at-page'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('4')

    fireEvent.click(screen.getByTestId('wb-open'))
    expect(workbenchEl().getAttribute('data-selected-source-id')).toBe('src_1')
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('')
  })

  it('面板内 citation 点击 → highlightPageIdx 回传上半屏 Workbench', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open'))
    fireEvent.click(screen.getByTestId('panel-cite-page'))
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('7')
  })
})
