import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const mediaQueryMocks = vi.hoisted(() => ({
  hasUsableHeight: vi.fn(() => true),
  isDesktop: vi.fn(() => true),
}))

vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => mediaQueryMocks.hasUsableHeight(),
  useIsDesktop: () => mediaQueryMocks.isDesktop(),
}))

vi.mock('@/lib/embedded/shell', () => ({
  ResearchWorkspaceShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}))

interface WorkbenchPropsMock {
  displayMode: 'workbench' | 'source-focus'
  selectedSourceId: string | null
  highlightPageIdx: number | null
  highlightRequestId: number
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
      data-highlight-request-id={props.highlightRequestId}
      data-display-mode={props.displayMode}
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

// #243 §6.2：页面顶层新增 Research header（全局模型栏 + 导出）与根级外发
// 确认弹窗，二者依赖全局模型/工作区上下文；本文件被测对象是组合与布局，
// 因此用测试替身替换上下文，导出区也一并替身化
vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/components/research/ExportSection', () => ({
  ExportSection: () => <div data-testid="export-section" />,
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
  beforeEach(() => {
    mediaQueryMocks.hasUsableHeight.mockReturnValue(true)
    mediaQueryMocks.isDesktop.mockReturnValue(true)
  })

  it('使用稳定的全局横向布局槽位，工作台继续在内部裁剪溢出', () => {
    render(<ResearchPage />)
    const wrapper = screen.getByTestId('workbench').parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('h-full', 'min-h-0', 'overflow-hidden')
    expect(screen.getByTestId('research-layout')).toHaveAttribute('data-axis', 'horizontal')
    expect(screen.getByRole('separator', { name: 'research.layout.resizeWorkspace' })).toBeInTheDocument()
  })

  it('工作区占稳定次级槽位而非固定 h-1/2', () => {
    render(<ResearchPage />)
    const wrapper = screen.getByTestId('workspace').parentElement?.parentElement
    expect(wrapper).not.toBeNull()
    expect(wrapper).toHaveClass('h-full', 'min-h-0')
    expect(wrapper).not.toHaveClass('h-1/2')
  })
})

describe('/research Source 详情 + Source Chat 组合（Issue #182）', () => {
  beforeEach(() => {
    mediaQueryMocks.hasUsableHeight.mockReturnValue(true)
    mediaQueryMocks.isDesktop.mockReturnValue(true)
  })

  it('默认：下半屏渲染全局 Workspace，无 Source Chat 面板', () => {
    render(<ResearchPage />)
    expect(screen.getByTestId('workspace')).toBeInTheDocument()
    expect(screen.queryByTestId('source-chat-panel')).toBeNull()
    expect(workbenchEl().getAttribute('data-selected-source-id')).toBe('')
  })

  it('选源：下半屏切换为 Source Chat 面板，Workspace 保持挂载且被 hidden 包裹', () => {
    render(<ResearchPage />)
    const originalWorkbench = workbenchEl()
    const originalWorkspace = screen.getByTestId('workspace')
    const workspaceWrapper = originalWorkspace.parentElement
    fireEvent.click(screen.getByTestId('wb-open'))

    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('source-chat-panel').getAttribute('data-source-id')).toBe('src_1')

    // 保持挂载：同一个 DOM 节点由原生 hidden 属性包裹（chat/jobs 本地状态不丢失）
    const workspace = screen.getByTestId('workspace')
    expect(workspace).toBe(originalWorkspace)
    expect(workspace.parentElement).toBe(workspaceWrapper)
    expect(workspaceWrapper).toHaveAttribute('hidden')
    expect(workspaceWrapper).not.toHaveClass('hidden')
    expect(screen.getByTestId('research-layout')).toHaveAttribute('data-axis', 'horizontal')
    expect(workbenchEl()).toBe(originalWorkbench)
    expect(workbenchEl()).toHaveAttribute('data-display-mode', 'source-focus')
  })

  it('关闭来源：卸载面板并恢复 Workspace（无 hidden）', () => {
    render(<ResearchPage />)
    const originalWorkspace = screen.getByTestId('workspace')
    const workspaceWrapper = originalWorkspace.parentElement
    fireEvent.click(screen.getByTestId('wb-open'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(workspaceWrapper).toHaveAttribute('hidden')

    fireEvent.click(screen.getByTestId('wb-close'))
    expect(screen.queryByTestId('source-chat-panel')).toBeNull()
    expect(screen.getByTestId('workspace')).toBe(originalWorkspace)
    expect(originalWorkspace.parentElement).toBe(workspaceWrapper)
    expect(workspaceWrapper).not.toHaveAttribute('hidden')
    expect(workspaceWrapper).not.toHaveClass('hidden')
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

  it('紧凑 Source 模式两次点击同页 Citation 均切回正文并发出独立聚焦请求', () => {
    mediaQueryMocks.isDesktop.mockReturnValue(false)
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open'))

    const originalWorkbench = workbenchEl()
    const contentTab = screen.getByRole('tab', { name: 'research.layout.content' })
    const chatTab = screen.getByRole('tab', { name: 'research.layout.chat' })

    fireEvent.click(chatTab)
    expect(chatTab).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByTestId('panel-cite-page'))
    expect(contentTab).toHaveAttribute('aria-selected', 'true')
    expect(workbenchEl()).toHaveAttribute('data-highlight-page-idx', '7')
    expect(workbenchEl()).toHaveAttribute('data-highlight-request-id', '1')

    fireEvent.click(chatTab)
    expect(chatTab).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByTestId('panel-cite-page'))
    expect(contentTab).toHaveAttribute('aria-selected', 'true')
    expect(workbenchEl()).toHaveAttribute('data-highlight-page-idx', '7')
    expect(workbenchEl()).toHaveAttribute('data-highlight-request-id', '2')
    expect(workbenchEl()).toBe(originalWorkbench)
  })
})
