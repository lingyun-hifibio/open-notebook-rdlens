import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ResearchScopeProvider, useResearchScope } from '@/lib/research/scope'

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

interface WorkbenchPropsMock {
  focusedSourceId: string | null
  highlightPageIdx: number | null
  highlightRequestId: number
  onOpenSource: (sourceId: string, pageIdx?: number | null) => void
  onExitSourceFocus: () => void
  scopeEditRequest?: number
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
    </div>
  ),
}))

interface WorkspacePropsMock {
  activeAction: string
  surfaceActive: boolean
  onActiveActionChange: (action: string) => void
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
  onEditScopeAllStates: () => void
}

vi.mock('@/components/research/ResearchWorkspace', () => ({
  ResearchWorkspace: (props: WorkspacePropsMock) => (
    <div
      data-testid="workspace"
      data-active-action={props.activeAction}
      data-surface-active={props.surfaceActive ? 'true' : ''}
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

// Issue #1011 F11：记录组合根传给 source chat 的**全部 props**（断言不含
// global 单篇限定/scope 输入）。
const sourceChatProps = vi.hoisted(() => ({
  latest: null as Record<string, unknown> | null,
}))

vi.mock('@/components/research/ResearchSourceChatPanel', () => ({
  ResearchSourceChatPanel: (props: {
    sourceId: string
    onHighlightPage: (pageIdx: number) => void
  }) => {
    sourceChatProps.latest = props as unknown as Record<string, unknown>
    return (
      <div data-testid="source-chat-panel" data-source-id={props.sourceId}>
        <button data-testid="panel-cite-page" onClick={() => props.onHighlightPage(7)} />
      </div>
    )
  },
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
// Issue #1011 F10/F11（计划 §2.7 I1/I3、NORMATIVE 13/14/15）：
// 组合根进入/退出 Source focus 不得改变会话 scope provider 快照，也不得
// 调用 setSingle/clearSingle；source chat surface 不接收 global 单篇限定/
// scope 输入（source kind 会话 scope 固定绑定 URL source，由 host 强制）。
// ---------------------------------------------------------------------------


/** 把 scope provider 的真实快照渲染成可断言文本（不经 mock）。 */
function ScopeSnapshotProbe() {
  const { getSnapshot, singlePin } = useResearchScope()
  const snapshot = getSnapshot()
  return (
    <div
      data-testid="scope-snapshot"
      data-mode={snapshot.mode}
      data-source-ids={snapshot.sourceIds.join(',')}
      data-note-ids={snapshot.noteIds.join(',')}
      data-single-source={snapshot.singleSourceId ?? ''}
      data-single-pin={singlePin?.sourceId ?? ''}
    />
  )
}

/** 只暴露「会话 Scope 编辑面」同款写入口（模拟用户设置单篇限定）。 */
function ScopeSetter() {
  const { setSingle } = useResearchScope()
  return (
    <button
      type="button"
      data-testid="test-set-global-pin"
      onClick={() => setSingle('src_9', 'sess_g')}
    >
      limit
    </button>
  )
}

function renderPageWithScope() {
  return render(
    <ResearchScopeProvider userId="u1" projectId="proj_1">
      <ScopeSetter />
      <ScopeSnapshotProbe />
      <ResearchPage />
    </ResearchScopeProvider>,
  )
}

function snapshotEl(): HTMLElement {
  return screen.getByTestId('scope-snapshot')
}

describe('/research · Issue #1011 F10 Source focus 进出不改 scope 快照', () => {
  beforeEach(() => {
    mediaQueryMocks.hasUsableHeight.mockReturnValue(true)
    mediaQueryMocks.isDesktop.mockReturnValue(true)
    localStorage.clear()
  })

  it('进入/退出 Source focus 不改变 scope snapshot（mode/sourceIds/noteIds/singleSourceId）', () => {
    renderPageWithScope()
    const before = snapshotEl().dataset
    const beforeSnapshot = `${before.mode}|${before.sourceIds}|${before.noteIds}|${before.singleSource}`

    fireEvent.click(screen.getByTestId('wb-open'))
    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    const focused = snapshotEl().dataset
    expect(`${focused.mode}|${focused.sourceIds}|${focused.noteIds}|${focused.singleSource}`).toBe(
      beforeSnapshot,
    )

    fireEvent.click(screen.getByTestId('wb-open-at-page'))
    fireEvent.click(screen.getByTestId('wb-back'))
    const after = snapshotEl().dataset
    expect(`${after.mode}|${after.sourceIds}|${after.noteIds}|${after.singleSource}`).toBe(
      beforeSnapshot,
    )
  })

  it('已生效的全局单篇限定在进入/退出 Source focus 后仍保留（不被 clearSingle/setSingle 改写）', () => {
    renderPageWithScope()
    fireEvent.click(screen.getByTestId('test-set-global-pin'))
    expect(snapshotEl()).toHaveAttribute('data-single-source', 'src_9')
    expect(snapshotEl()).toHaveAttribute('data-single-pin', 'src_9')

    fireEvent.click(screen.getByTestId('wb-open'))
    expect(snapshotEl()).toHaveAttribute('data-mode', 'single')
    expect(snapshotEl()).toHaveAttribute('data-single-source', 'src_9')

    fireEvent.click(screen.getByTestId('wb-back'))
    expect(snapshotEl()).toHaveAttribute('data-single-source', 'src_9')
  })
})

describe('/research · Issue #1011 F11 source chat 不接收 global 单篇限定/scope', () => {
  beforeEach(() => {
    mediaQueryMocks.hasUsableHeight.mockReturnValue(true)
    mediaQueryMocks.isDesktop.mockReturnValue(true)
    localStorage.clear()
    sourceChatProps.latest = null
  })

  it('source chat surface 的 props 不含 scope/singleSourceId/单篇限定输入', () => {
    renderPageWithScope()
    fireEvent.click(screen.getByTestId('test-set-global-pin'))
    fireEvent.click(screen.getByTestId('wb-open'))

    expect(screen.getByTestId('source-chat-panel')).toBeInTheDocument()
    const props = sourceChatProps.latest
    expect(props).not.toBeNull()
    const keys = Object.keys(props ?? {})
    // 组合根不向 source surface 传任何 scope 输入：source kind 会话的
    // scope 由 host 固定绑定 URL source（editor_state base_scope=null）
    for (const key of keys) {
      expect(key).not.toMatch(/scope|single|pin|sourceIds|noteIds/i)
    }
    expect(props?.sourceId).toBe('src_1')
    // 全局限定仍是全局的：未被消费、未被带入 source surface
    expect(snapshotEl()).toHaveAttribute('data-single-source', 'src_9')
  })
})
