import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// /research 组合层（Issue #182 + RWV2-40 Red）：组合根接线——
// 分离 selectedSourceId/sourceFocusActive；唯一 keyed Source Chat；
// Back 仅退出 focus 且 Source Chat 保活隐藏；highlight 线程同页重跳；
// Header/JobsProvider 在本文件替身化（各自有独立测试文件），被测点是
// 组合与布局。

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

// Issue #1013 F01：选段讨论载荷（source focus/global target 接线断言）。
const discussSelectionMock = vi.hoisted(() => ({
  payload: {
    selection: {
      sourceId: 'src_1',
      documentId: 'doc_1',
      documentVersion: 'v3',
      chunkId: 'chunk_1',
      chunkOrdinal: 0,
      pageIdx: 0,
      startOffset: 6,
      endOffset: 11,
      quote: 'world',
      quoteHash: '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7',
      contentHash: 'a'.repeat(64),
    },
    sourceId: 'src_1',
    sourceTitle: 'Source 1',
    pageIdx: 0,
    chunkOrdinal: 0,
  },
}))

interface WorkbenchPropsMock {
  focusedSourceId: string | null
  highlightPageIdx: number | null
  highlightRequestId: number
  onOpenSource: (sourceId: string, pageIdx?: number | null) => void
  onExitSourceFocus: () => void
  scopeEditRequest?: number
  onDiscussSelection?: (payload: typeof discussSelectionMock.payload) => void
}

// Workbench 测试替身：暴露冻结受控 props 与回调触发按钮
// （UIOPT-A：根页面不再有 researchTemplatesActive/onOpenResearchTemplates）
vi.mock('@/components/research/ResearchWorkbench', () => ({
  ResearchWorkbench: (props: WorkbenchPropsMock) => (
    <div
      data-testid="workbench"
      data-focused-source-id={props.focusedSourceId ?? ''}
      data-highlight-page-idx={props.highlightPageIdx ?? ''}
      data-highlight-request-id={props.highlightRequestId}
    >
      <button data-testid="wb-open" onClick={() => props.onOpenSource('src_1')} />
      <button
        data-testid="wb-open-at-page"
        onClick={() => props.onOpenSource('src_9', 4)}
      />
      <button data-testid="wb-back" onClick={() => props.onExitSourceFocus()} />
      <button
        data-testid="wb-discuss-selection"
        onClick={() => props.onDiscussSelection?.(discussSelectionMock.payload)}
      />
    </div>
  ),
}))

interface WorkspacePropsMock {
  activeAction: string
  surfaceActive: boolean
  onActiveActionChange: (action: string) => void
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
  onEditScopeAllStates: () => void
  onCitationReturn?: (
    citation: { citation_id: number; claim: string; doc_id: string; page_idx: number | null; confidence: null },
    messageId: string | null,
    sourceId: string,
  ) => void
  pendingSelection?: { target: 'global' | 'source'; sourceId: string } | null
  selectionChip?: { label: string } | null
  onSelectionConsumed?: () => void
}

vi.mock('@/components/research/ResearchWorkspace', () => ({
  ResearchWorkspace: (props: WorkspacePropsMock) => (
    <div
      data-testid="workspace"
      data-active-action={props.activeAction}
      data-surface-active={props.surfaceActive ? 'true' : ''}
      data-pending-target={props.pendingSelection?.target ?? ''}
      data-pending-source={props.pendingSelection?.sourceId ?? ''}
      data-has-selection-chip={props.selectionChip === null || props.selectionChip === undefined ? 'false' : 'true'}
      data-has-selection-consumed={props.onSelectionConsumed === undefined ? 'false' : 'true'}
    >
      <button
        data-testid="ws-run-template"
        onClick={() => props.onActiveActionChange('run-template')}
      />
      <button
        data-testid="ws-cite"
        onClick={() => props.onCitationJump('src_9', 7)}
      />
      <button data-testid="ws-edit-scope" onClick={() => props.onEditScopeAllStates()} />
      <button data-testid="ws-cite-live"
        onClick={() => props.onCitationReturn?.(
          { citation_id: 1, claim: 'live claim', doc_id: 'doc_live', page_idx: 7, confidence: null },
          null,
          'src_9',
        )} />
      <button data-testid="ws-consume-selection" onClick={() => props.onSelectionConsumed?.()} />
    </div>
  ),
}))

vi.mock('@/lib/hooks/use-research-global-model')

// ResearchHeader / ResearchJobsProvider 各自有独立测试，组合层用替身：
// Header 被本文件替身化，避免 page.test 引入查询/上下文依赖。
vi.mock('@/components/research/ResearchJobsProvider', () => ({
  ResearchJobsProvider: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="jobs-provider">{children}</div>
  ),
}))

vi.mock('@/components/research/ResearchHeader', () => ({
  ResearchHeader: () => <div data-testid="research-header" />,
}))

vi.mock('@/components/research/ExportSection', () => ({
  ExportSection: () => <div data-testid="export-section" />,
}))

vi.mock('@/components/research/ResearchSourceChatPanel', () => ({
  ResearchSourceChatPanel: ({
    sourceId,
    onHighlightPage,
    onCitationReturn,
    selectionContext,
    selectionChip,
    onSelectionConsumed,
  }: {
    sourceId: string
    onHighlightPage: (pageIdx: number) => void
    onCitationReturn?: (
      citation: { citation_id: number; claim: string; doc_id: string; page_idx: number | null; confidence: null },
      messageId: string | null,
    ) => void
    selectionContext?: { sourceId: string; quote: string } | null
    selectionChip?: { label: string } | null
    onSelectionConsumed?: () => void
  }) => (
    <div
      data-testid="source-chat-panel"
      data-source-id={sourceId}
      data-selection-source={selectionContext?.sourceId ?? ''}
      data-selection-quote={selectionContext?.quote ?? ''}
      data-has-selection-chip={
        selectionChip === null || selectionChip === undefined ? 'false' : 'true'
      }
      data-has-selection-consumed={onSelectionConsumed === undefined ? 'false' : 'true'}
    >
      <button data-testid="panel-cite-page" onClick={() => onHighlightPage(7)} />
      <button data-testid="panel-cite-live"
        onClick={() => onCitationReturn?.(
          { citation_id: 2, claim: 'live claim', doc_id: 'doc_live', page_idx: 7, confidence: null },
          null,
        )} />
      <button
        data-testid="panel-consume-selection"
        onClick={() => onSelectionConsumed?.()}
      />
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

  it('Header/JobsProvider 接入组合根', () => {
    render(<ResearchPage />)
    expect(screen.getByTestId('research-header')).toBeInTheDocument()
    expect(screen.getByTestId('jobs-provider')).toBeInTheDocument()
    expect(screen.queryByTestId('export-section')).toBeNull()
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

describe('/research Source 专注 + Source Chat 组合（Issue #182 + RWV2-40）', () => {
  beforeEach(() => {
    mediaQueryMocks.hasUsableHeight.mockReturnValue(true)
    mediaQueryMocks.isDesktop.mockReturnValue(true)
  })

  it('默认：主区渲染全局 Workspace（surfaceActive），无 Source Chat；Workbench 无焦点来源', () => {
    render(<ResearchPage />)
    expect(screen.getByTestId('workspace')).toBeInTheDocument()
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-surface-active', 'true')
    expect(screen.queryByTestId('source-chat-panel')).toBeNull()
    expect(workbenchEl().getAttribute('data-focused-source-id')).toBe('')
  })

  it('选源：进入 Source focus——Chat 出现且 keyed；Workspace 保活隐藏（surfaceActive=false）；Workbench 收 focusedSourceId', () => {
    render(<ResearchPage />)
    const originalWorkbench = workbenchEl()
    const originalWorkspace = screen.getByTestId('workspace')
    const workspaceWrapper = originalWorkspace.parentElement
    fireEvent.click(screen.getByTestId('wb-open'))

    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('source-chat-panel').getAttribute('data-source-id')).toBe('src_1')
    const workspace = screen.getByTestId('workspace')
    expect(workspace).toBe(originalWorkspace)
    expect(workspace.parentElement).toBe(workspaceWrapper)
    expect(workspaceWrapper).toHaveAttribute('hidden')
    expect(workspaceWrapper).not.toHaveClass('hidden')
    expect(workspace).toHaveAttribute('data-surface-active', '')
    expect(workbenchEl()).toBe(originalWorkbench)
    expect(workbenchEl()).toHaveAttribute('data-focused-source-id', 'src_1')
  })

  it('Back（退出 focus）：Workspace 恢复可见，Source Chat 保活隐藏（不卸载）；Workbench 无焦点来源', () => {
    render(<ResearchPage />)
    const originalWorkspace = screen.getByTestId('workspace')
    const workspaceWrapper = originalWorkspace.parentElement
    fireEvent.click(screen.getByTestId('wb-open'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(workspaceWrapper).toHaveAttribute('hidden')

    fireEvent.click(screen.getByTestId('wb-back'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('source-chat-panel').parentElement).toHaveAttribute('hidden')
    expect(workbenchEl().getAttribute('data-focused-source-id')).toBe('')
    expect(screen.getByTestId('workspace')).toBe(originalWorkspace)
    expect(originalWorkspace.parentElement).toBe(workspaceWrapper)
    expect(workspaceWrapper).not.toHaveAttribute('hidden')
    expect(workspaceWrapper).not.toHaveClass('hidden')
  })

  it('openSource 携带页码时设置高亮；再次普通选源重置高亮为空', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open-at-page'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('4')

    fireEvent.click(screen.getByTestId('wb-open'))
    expect(workbenchEl().getAttribute('data-focused-source-id')).toBe('src_1')
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('')
  })

  it('面板内 citation 点击 → highlightPageIdx 回传 Workbench（不退出 focus）', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open'))
    fireEvent.click(screen.getByTestId('panel-cite-page'))
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('7')
    expect(workbenchEl().getAttribute('data-focused-source-id')).toBe('src_1')
  })

  it('F52：live citation（message_id=null）仍打开/高亮来源（global）', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('ws-cite-live'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('source-chat-panel').getAttribute('data-source-id')).toBe('src_9')
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('7')
  })

  it('F52：live citation（message_id=null）仍高亮来源页（source，不退出 focus）', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open'))
    fireEvent.click(screen.getByTestId('panel-cite-live'))
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('7')
    expect(workbenchEl().getAttribute('data-focused-source-id')).toBe('src_1')
  })

  it('跨区 Citation（Workspace 报告）→ 选源并进入 Source focus + 高亮', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('ws-cite'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('source-chat-panel').getAttribute('data-source-id')).toBe('src_9')
    expect(workbenchEl().getAttribute('data-focused-source-id')).toBe('src_9')
    expect(workbenchEl().getAttribute('data-highlight-page-idx')).toBe('7')
  })

  it('主区动作切换（Workspace 内 onActiveActionChange）→ 组合根状态回传', () => {
    render(<ResearchPage />)
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-active-action', 'evidence-search')
    fireEvent.click(screen.getByTestId('ws-run-template'))
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-active-action', 'run-template')
  })

  it('UIOPT-A：根页面不再持有跨区模板 handler——Workbench 无模板触发按钮，主区动作切换仍可激活 run-template', () => {
    render(<ResearchPage />)
    // 旧快捷入口删除：Workbench 替身不再收到/渲染模板命令
    expect(screen.queryByTestId('wb-templates')).toBeNull()
    expect(workbenchEl().getAttribute('data-templates-active')).toBeNull()
    // 主区 Run Template 仍是正式且唯一的模板入口（经主区动作切换可达）
    fireEvent.click(screen.getByTestId('ws-run-template'))
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-active-action', 'run-template')
  })

  it('Edit scope 统一链路（Header/Workspace 共用）→ 退出 Source focus 并递增聚焦请求', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open'))
    fireEvent.click(screen.getByTestId('ws-edit-scope'))
    expect(workbenchEl().getAttribute('data-focused-source-id')).toBe('')
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-surface-active', 'true')
  })

  it('紧凑 Source 模式两次点击同页 Citation 均回正文并发出独立聚焦请求', () => {
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

// ---------------------------------------------------------------------------
// Issue #1013 F01（复审 BLOCKING）：选段 target 随活动 surface，且选段真的
// 到达 source 面板的 getter（selectionContext prop）；清除只发生在携带它的
// surface 路径上（global 发送不得清 source chip，反之亦然）。
// ---------------------------------------------------------------------------

describe('/research · Issue #1013 F01 选段 surface 接线', () => {
  beforeEach(() => {
    mediaQueryMocks.hasUsableHeight.mockReturnValue(true)
    mediaQueryMocks.isDesktop.mockReturnValue(true)
  })

  it('global 讨论 → target=global 且 source 面板无选段；source focus 讨论 → target=source 且 selectionContext 进入面板', () => {
    render(<ResearchPage />)

    // 全局 surface：pending 目标必须是 global（不是写死的 source）。
    fireEvent.click(screen.getByTestId('wb-discuss-selection'))
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-pending-target', 'global')
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-pending-source', 'src_1')
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-has-selection-chip', 'true')
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-has-selection-consumed', 'true')

    // 进入 source focus 后再讨论：target=source，且面板收到真实选段对象
    // （面板把它注入 headed hook 的 getSelectionContext）。
    fireEvent.click(screen.getByTestId('wb-open'))
    expect(screen.queryByTestId('source-chat-panel')).not.toBeNull()
    // pending 仍是 global target：source 面板不得拿到选段。
    expect(screen.getByTestId('source-chat-panel')).toHaveAttribute('data-selection-source', '')
    expect(screen.getByTestId('source-chat-panel')).toHaveAttribute('data-has-selection-consumed', 'false')

    fireEvent.click(screen.getByTestId('wb-discuss-selection'))
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-pending-target', 'source')
    const panel = screen.getByTestId('source-chat-panel')
    expect(panel).toHaveAttribute('data-selection-source', 'src_1')
    expect(panel).toHaveAttribute('data-selection-quote', 'world')
    expect(panel).toHaveAttribute('data-has-selection-chip', 'true')
    expect(panel).toHaveAttribute('data-has-selection-consumed', 'true')
    // global 面板不得获得清除 source chip 的回调（避免静默清掉）。
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-has-selection-consumed', 'false')

    // source 面板受理后清除（page 侧只在 source 匹配时传入回调）。
    fireEvent.click(screen.getByTestId('panel-consume-selection'))
    expect(screen.getByTestId('source-chat-panel')).toHaveAttribute('data-selection-source', '')
    expect(screen.getByTestId('source-chat-panel')).toHaveAttribute('data-has-selection-chip', 'false')
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-pending-target', '')
  })

  it('source-target pending 不会被 global surface 的清除路径消费', () => {
    render(<ResearchPage />)
    fireEvent.click(screen.getByTestId('wb-open'))
    fireEvent.click(screen.getByTestId('wb-discuss-selection'))
    expect(screen.getByTestId('source-chat-panel')).toHaveAttribute('data-has-selection-chip', 'true')

    // global 面板的清除回调必须不存在；点击替身按钮不得清掉 source chip。
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-has-selection-consumed', 'false')
    fireEvent.click(screen.getByTestId('ws-consume-selection'))
    expect(screen.getByTestId('source-chat-panel')).toHaveAttribute('data-has-selection-chip', 'true')
    expect(screen.getByTestId('source-chat-panel')).toHaveAttribute('data-selection-source', 'src_1')
  })
})
