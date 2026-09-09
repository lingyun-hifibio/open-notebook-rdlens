import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { ResearchWorkspace } from './ResearchWorkspace'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchJobsProvider } from './ResearchJobsProvider'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope } from '@/lib/research/scope'
import { useResearchNotes, useResearchSources } from '@/lib/hooks/use-research'
import * as api from '@/lib/research/api'
import * as tokenStore from '@/lib/embedded/token-store'
import { QUERY_KEYS } from '@/lib/api/query-client'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'
import type { ResearchMainAction } from './research-main-action'
import {
  resetGlobalModelStub,
  setGlobalModelStub,
} from '@/test/global-model-stub'

// UI-03 Red：工作区组合（REQ-SCOPE-04）——无项目上下文 fail-closed 错误态；
// 有上下文时加载 Source/Note 并渲染四动作主区。
// RWV2-40（Fork #44）：主区 = evidence-search / research-chat / compare /
// run-template 四个动作（Jobs 迁 Header Activity，不再占用主区）。资源
// 查询与 reconcile 逻辑留在本组件（R8-1a，与 Header 同 key 共享缓存）；
// Scope Summary 已迁 Header，本组件不再渲染。

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>()
  return {
    ...actual,
    listSources: vi.fn(),
    listNotes: vi.fn(),
    getJob: vi.fn(),
    createCompare: vi.fn(),
    cancelJob: vi.fn(),
    openResearchChatStream: vi.fn(() => () => {}),
  }
})

// 被测对象不是全局模型本身：用测试替身提供 confirmed 模型（本地、可执行）
vi.mock('@/lib/hooks/use-research-global-model')

// 受控替身：SearchPanel 在本文件不承担真实 preview 逻辑（v1 测试覆盖）；
// 暴露 active prop + 保留一个本地输入，供 keep-alive/active 语义断言
vi.mock('./ResearchSearchPanel', () => ({
  ResearchSearchPanel: ({ active = true }: { projectId: string; active?: boolean }) => (
    <div data-testid="search-panel-stub" data-active={String(active)}>
      <input data-testid="search-panel-input" defaultValue="" />
    </div>
  ),
}))

// TransformationsPanel 受控替身：验证主区 run-template pane 只挂载一次、
// 保活 DOM 不卸载，并透出收到 onCitationJump/onEditScope（frozen 接线）；
// 面板自身 listTransformations 行为由其专属测试覆盖
vi.mock('./TransformationsPanel', () => ({
  TransformationsPanel: ({
    onCitationJump,
    onEditScope,
  }: {
    onCitationJump?: (citation: unknown) => void
    onEditScope?: () => void
  }) => (
    <div
      data-testid="transformations-panel-stub"
      data-has-jump={String(typeof onCitationJump === 'function')}
      data-has-edit={String(typeof onEditScope === 'function')}
    >
      <input data-testid="transformations-panel-input" defaultValue="" />
    </div>
  ),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function researchToken(): string {
  const payload = JSON.stringify({ sub: 'u1', project_id: 'proj_1', aud: 'research-workspace' })
  return `h.${b64url(payload)}.s`
}

const source: ResearchSource = {
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: null,
  synced_at: '2026-08-06T02:00:00Z',
  last_error: null,
}

const note: ResearchNote = {
  note_id: 'note_1',
  project_id: 'proj_1',
  title: 'Note One',
  content: 'body',
  note_type: 'human',
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function workspaceWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId="proj_1" role="owner">
        <ResearchJobsProvider>
          <ResearchScopeProvider userId="u1" projectId="proj_1">
            {children}
          </ResearchScopeProvider>
        </ResearchJobsProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

// 组合根替身：复刻 ResearchPageContent 对 Workspace 的受控 props 面
function WorkspaceHarness({
  initialAction = 'evidence-search',
  surfaceActive = true,
  onActionChange = () => {},
  onCitationJump = () => {},
  onEditScopeAllStates = () => {},
}: {
  initialAction?: ResearchMainAction
  surfaceActive?: boolean
  onActionChange?: (action: ResearchMainAction) => void
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
  onEditScopeAllStates?: () => void
}) {
  const [action, setAction] = useState<ResearchMainAction>(initialAction)
  return (
    <ResearchWorkspace
      activeAction={action}
      onActiveActionChange={(next) => {
        onActionChange(next)
        setAction(next)
      }}
      surfaceActive={surfaceActive}
      onCitationJump={onCitationJump}
      onEditScopeAllStates={onEditScopeAllStates}
    />
  )
}

function renderHarness(props: Parameters<typeof WorkspaceHarness>[0] = {}) {
  return render(<WorkspaceHarness {...props} />, { wrapper: workspaceWrapper })
}

function SharedQueryConsumer() {
  useResearchSources('proj_1')
  useResearchNotes('proj_1')
  return null
}

function ScopeProbe() {
  const { mode, selectedSourceIds, selectedNoteIds, validate } = useResearchScope()
  return (
    <output data-testid="scope-reconcile-probe">
      {`${mode}:${selectedSourceIds.join(',')}:${selectedNoteIds.join(',')}:${validate().valid}`}
    </output>
  )
}

function seedScope(mode: 'entire_project' | 'selected', sourceIds: string[] = [], noteIds: string[] = []) {
  localStorage.setItem(
    scopeStorageKey('u1', 'proj_1'),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds }),
  )
}

function switchTo(action: 'evidence-search' | 'research-chat' | 'compare' | 'run-template') {
  const labels: Record<ResearchMainAction, string> = {
    'evidence-search': 'research.tabSearch',
    'research-chat': 'research.tabChat',
    compare: 'research.tabCompare',
    'run-template': 'research.mainActions.runTemplate',
  }
  const tab = screen.getByRole('tab', { name: labels[action] })
  // Radix Tabs 在 jsdom 下按 mousedown+click 切换
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
  fireEvent.click(tab)
}

describe('ResearchWorkspace（RWV2-40 四动作主区）', () => {
  beforeEach(() => {
    localStorage.clear()
    queryClient.clear()
    vi.clearAllMocks()
    toastMock.mockClear()
    resetGlobalModelStub()
    vi.mocked(api.listSources).mockResolvedValue({ items: [source], next_cursor: null })
    vi.mocked(api.listNotes).mockResolvedValue({ items: [note], next_cursor: null })
  })

  afterEach(() => {
    cleanup()
    tokenStore.clearResearchToken()
  })

  it('认证 Shell 注入项目上下文后渲染四动作 Tab（无需 Token 二次解码）', async () => {
    tokenStore.clearResearchToken()
    renderHarness()
    expect(await screen.findByRole('tab', { name: 'research.tabChat' })).toBeInTheDocument()
  })

  it('渲染四个动作 Tab（Evidence Search / Chat / Compare / Run Template），无 Scope Summary 与复选框', async () => {
    renderHarness()
    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'research.tabSearch',
      'research.tabChat',
      'research.tabCompare',
      'research.mainActions.runTemplate',
    ])
    // Scope Summary 已迁 Header：本组件不再渲染
    expect(screen.queryByTestId('research-scope-summary')).toBeNull()
    expect(screen.queryByTestId('research-context-scope')).toBeNull()
    expect(screen.queryByTestId('scope-edit-button')).toBeNull()
    // 右栏动作区无任何完整选择器/复选框（唯一编辑面在左栏）
    expect(screen.queryByTestId('source-note-selector')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    // 资源查询留在本组件（R8-1a）：mount 即拉取，limit 100 服务端单页上限
    await waitFor(() => expect(api.listSources).toHaveBeenCalledTimes(1))
    expect(api.listSources).toHaveBeenCalledWith(
      'proj_1',
      { limit: 100 },
      expect.any(AbortSignal),
    )
    expect(api.listNotes).toHaveBeenCalledWith(
      'proj_1',
      { limit: 100 },
      expect.any(AbortSignal),
    )
  })

  it('UIOPT-A：主区 Tabs 行为展开按钮预留右侧空间（不靠 z-index 遮挡）', async () => {
    renderHarness()
    const reserve = await screen.findByTestId('workspace-expand-reserve')
    // 预留与按钮可见性同条件：<1024px（compact）按钮隐藏，预留同隐（评审 M1）
    expect(reserve).toHaveClass('hidden', 'w-36', 'lg:block')
    expect(reserve).toHaveAttribute('aria-hidden', 'true')
    // 四动作 Tab 本体不受预留影响
    expect(await screen.findByRole('tab', { name: 'research.mainActions.runTemplate' })).toBeInTheDocument()
  })

  it('issue59：#59 回归——预留为窄态收窄预留契约类（group-data 变体与 w-36 并存）', async () => {
    renderHarness()
    const reserve = await screen.findByTestId('workspace-expand-reserve')
    // 窄态下 ResearchLayout 根挂 data-narrow-secondary=true，reserve 经 group
    // 变体从 w-36(144px) 收窄为 w-11(44px)（≥ icon-only 按钮实宽 ~34px）。
    // 几何真断言由 RDLens smoke button.no_overlap 端到端兜底。
    expect(reserve).toHaveClass('group-data-[narrow-secondary=true]:w-11')
  })

  it('动作切换受控：点击 tab 触发 onActiveActionChange', async () => {
    const onActionChange = vi.fn()
    renderHarness({ onActionChange })
    switchTo('research-chat')
    await waitFor(() => expect(onActionChange).toHaveBeenCalledWith('research-chat'))
  })

  it('右栏与第二个消费者共享一次查询（单一查询缓存，Header 同 key 语义）', async () => {
    render(
      <>
        <WorkspaceHarness />
        <SharedQueryConsumer />
      </>,
      { wrapper: workspaceWrapper },
    )
    await waitFor(() => expect(api.listSources).toHaveBeenCalledTimes(1))
    expect(api.listNotes).toHaveBeenCalledTimes(1)
  })

  it('恢复时移除 missing/pending/failed IDs，保留 ready/stale 与 selected 模式并反馈', async () => {
    seedScope(
      'selected',
      ['src_1', 'src_stale', 'src_pending', 'src_failed', 'src_missing'],
      ['note_1', 'note_missing'],
    )
    vi.mocked(api.listSources).mockResolvedValue({
      items: [
        source,
        { ...source, source_id: 'src_stale', status: 'stale' },
        { ...source, source_id: 'src_pending', status: 'pending' },
        { ...source, source_id: 'src_failed', status: 'failed' },
      ],
      next_cursor: null,
    })
    render(
      <>
        <WorkspaceHarness />
        <ScopeProbe />
      </>,
      { wrapper: workspaceWrapper },
    )

    await waitFor(() => {
      expect(screen.getByTestId('scope-reconcile-probe')).toHaveTextContent(
        'selected:src_1,src_stale:note_1:true',
      )
    })
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'research.layout.scope.reconciled' }),
    )
  })

  it('全部持久 ID 失效时保留显式 selected 空范围并阻止执行，不扩大为 entire project', async () => {
    seedScope('selected', ['src_missing'], ['note_missing'])
    render(
      <>
        <WorkspaceHarness />
        <ScopeProbe />
      </>,
      { wrapper: workspaceWrapper },
    )

    await waitFor(() => {
      expect(screen.getByTestId('scope-reconcile-probe')).toHaveTextContent('selected:::false')
    })
  })

  it('已选 Source 从 ready 转为 failed 时清理 ID、保留 selected 并反馈', async () => {
    seedScope('selected', ['src_1'])
    render(
      <>
        <WorkspaceHarness />
        <ScopeProbe />
      </>,
      { wrapper: workspaceWrapper },
    )
    await waitFor(() => {
      expect(screen.getByTestId('scope-reconcile-probe')).toHaveTextContent(
        'selected:src_1::true',
      )
    })

    vi.mocked(api.listSources).mockResolvedValue({
      items: [{ ...source, status: 'failed', last_error: 'sync failed' }],
      next_cursor: null,
    })
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchSources('proj_1') })
    })

    await waitFor(() => {
      expect(screen.getByTestId('scope-reconcile-probe')).toHaveTextContent('selected:::false')
    })
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'research.layout.scope.reconciled' }),
    )
  })

  it('Notes 加载失败时仍独立清理已变为 failed 的 Source，并保留 Note IDs', async () => {
    seedScope('selected', ['src_1'], ['note_1'])
    vi.mocked(api.listNotes).mockRejectedValue(new Error('notes unavailable'))
    render(
      <>
        <WorkspaceHarness />
        <ScopeProbe />
      </>,
      { wrapper: workspaceWrapper },
    )
    await waitFor(() => {
      expect(screen.getByTestId('scope-reconcile-probe')).toHaveTextContent(
        'selected:src_1:note_1:true',
      )
    })

    vi.mocked(api.listSources).mockResolvedValue({
      items: [{ ...source, status: 'failed', last_error: 'sync failed' }],
      next_cursor: null,
    })
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.researchSources('proj_1') })
    })

    await waitFor(() => {
      expect(screen.getByTestId('scope-reconcile-probe')).toHaveTextContent(
        'selected::note_1:true',
      )
    })
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'research.layout.scope.reconciled' }),
    )
  })

  it('M1：notes 失败不应禁用 source-only Compare（Compare 守卫只看 sources 查询）', async () => {
    vi.mocked(api.listNotes).mockRejectedValue(new Error('notes unavailable'))
    renderHarness()
    switchTo('compare')

    // notes 失败 → Compare 仍可用（不出 compare-resources-error；等待
    // sources 查询成功把 compare-create 渲染出来）
    await waitFor(() => expect(screen.getByTestId('compare-create')).toBeInTheDocument())
    expect(screen.queryByTestId('compare-resources-error')).not.toBeInTheDocument()
    expect(api.createCompare).not.toHaveBeenCalled()
  })

  it('M1：sources 查询失败 → Compare 明确错误且不可创建（不回落 empty）', async () => {
    vi.mocked(api.listSources).mockRejectedValue(new Error('sources down'))
    renderHarness()
    switchTo('compare')
    await waitFor(() => expect(screen.getByTestId('compare-resources-error')).toBeInTheDocument())
    expect(screen.queryByTestId('compare-create')).toBeNull()
    expect(screen.queryByTestId('compare-empty')).toBeNull()
  })

  it('#243 §6.4：Chat 发送经顶层守卫——待确认/无模型时不打开流、不留 turn', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    setGlobalModelStub({ deferGuarded: true })
    renderHarness()
    switchTo('research-chat')
    fireEvent.change(await screen.findByTestId('chat-input'), { target: { value: '问题' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.chatSend' }))

    expect(api.openResearchChatStream).not.toHaveBeenCalled()
    // 输入未被清空：取消确认应零副作用
    expect(screen.getByTestId('chat-input')).toHaveValue('问题')

    // 守卫放行后同一条输入即被派发
    resetGlobalModelStub()
    fireEvent.click(screen.getByRole('button', { name: 'research.chatSend' }))
    await waitFor(() => expect(api.openResearchChatStream).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('chat-input')).toHaveValue('')
  })

  it('#243 §6.4：Compare 创建经顶层守卫——待确认时不发创建请求；放行后才创建', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    setGlobalModelStub({ deferGuarded: true })
    seedScope('selected', ['src_1'])
    vi.mocked(api.createCompare).mockResolvedValue({ job_id: 'job_1', status: 'queued' })
    vi.mocked(api.getJob).mockResolvedValue({
      job_id: 'job_1',
      project_id: 'proj_1',
      job_type: 'deep_compare',
      status: 'queued',
      stage: null,
      progress: 0,
      model_id: 'm-local',
      generation_epoch: 1,
      retry_count: 0,
      last_error: null,
      result_ref: null,
      created_at: '2026-08-06T02:00:00Z',
      updated_at: '2026-08-06T02:00:00Z',
    })
    renderHarness()
    switchTo('compare')
    // ComparePane 就绪（sources 已载入且映射非空）后才允许点击
    const createButton = await screen.findByTestId('compare-create')
    await waitFor(() => expect(createButton).not.toBeDisabled())
    fireEvent.click(createButton)

    // 守卫未放行：不创建 Job、不落 localStorage（不变量 9）
    expect(api.createCompare).not.toHaveBeenCalled()
    expect(localStorage.getItem('rdlens.research.jobs.proj_1')).toBeNull()
    expect(screen.queryByTestId('compare-submitted')).toBeNull()

    // 放行后再次点击 → 创建请求发出并登记到 Jobs 控制器（localStorage 前缀）
    resetGlobalModelStub()
    fireEvent.click(screen.getByTestId('compare-create'))
    await waitFor(() => expect(api.createCompare).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('compare-submitted')).toBeInTheDocument()
    await waitFor(() => {
      expect(localStorage.getItem('rdlens.research.jobs.proj_1')).toContain('job_1')
    })
  })

  it('#243：无可用全局模型时 Chat 输入/发送禁用并展示引导（评审 Important-2）', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    setGlobalModelStub({ confirmedModelId: null })
    renderHarness()
    switchTo('research-chat')

    expect(await screen.findByTestId('chat-input')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'research.chatSend' })).toBeDisabled()
    expect(screen.getByTestId('chat-model-blocked-hint')).toHaveTextContent(
      'research.globalModel.selectModelHint',
    )
    expect(api.openResearchChatStream).not.toHaveBeenCalled()
  })

  it('#243：无可用全局模型时 Compare 创建禁用并展示引导（评审 Important-2）', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    setGlobalModelStub({ confirmedModelId: null })
    seedScope('selected', ['src_1'])
    renderHarness()
    switchTo('compare')

    expect(await screen.findByTestId('compare-create')).toBeDisabled()
    expect(screen.getByTestId('compare-model-blocked-hint')).toHaveTextContent(
      'research.globalModel.selectModelHint',
    )
    expect(api.createCompare).not.toHaveBeenCalled()
  })

  it('run-template 首访才挂载（无空请求），访问后保活 DOM 不卸载', async () => {
    renderHarness()
    // 默认动作 evidence-search：run-template 未访问 → 不挂载内容
    expect(screen.queryByTestId('transformations-panel-stub')).toBeNull()

    switchTo('run-template')
    const input = await screen.findByTestId('transformations-panel-input')
    // frozen 接线：TransformationsPanel 收到 onCitationJump（解析后跳根级）与
    // onEditScope（组合根 Edit scope 链路）
    expect(screen.getByTestId('transformations-panel-stub')).toHaveAttribute('data-has-jump', 'true')
    expect(screen.getByTestId('transformations-panel-stub')).toHaveAttribute('data-has-edit', 'true')
    fireEvent.change(input, { target: { value: 'first-visit' } })
    expect(screen.getByTestId('transformations-panel-input')).toHaveValue('first-visit')

    // 切到 research-chat（真实 ChatPane 挂载）——run-template pane 保活保留
    switchTo('research-chat')
    expect(screen.queryByTestId('transformations-panel-input')).not.toBeNull()

    // 切回：同一 DOM 节点仍在、本地输入保留（未重挂载）
    switchTo('run-template')
    expect(screen.getByTestId('transformations-panel-input')).toBe(input)
    expect(screen.getByTestId('transformations-panel-input')).toHaveValue('first-visit')
  })

  it('evidence-search 首访后切走再切回：SearchPanel 本地输入保留（保活）', async () => {
    renderHarness()
    const input = await screen.findByTestId('search-panel-input')
    fireEvent.change(input, { target: { value: 'keep me' } })
    expect(input).toHaveValue('keep me')

    switchTo('research-chat')
    // evidence pane 已访问：切走保活（不卸载 DOM）
    expect(screen.queryByTestId('search-panel-input')).not.toBeNull()

    switchTo('evidence-search')
    expect(screen.getByTestId('search-panel-input')).toBe(input)
    expect(screen.getByTestId('search-panel-input')).toHaveValue('keep me')
  })

  it('SearchPanel active 语义：surfaceActive=false 时传入 active=false', async () => {
    renderHarness({ surfaceActive: false })
    expect(await screen.findByTestId('search-panel-stub')).toHaveAttribute('data-active', 'false')
  })

  it('SearchPanel active 语义：动作切走（surfaceActive 仍 true）→ active=false；切回恢复', async () => {
    renderHarness()
    expect(await screen.findByTestId('search-panel-stub')).toHaveAttribute('data-active', 'true')
    switchTo('research-chat')
    expect(screen.getByTestId('search-panel-stub')).toHaveAttribute('data-active', 'false')
    switchTo('evidence-search')
    expect(screen.getByTestId('search-panel-stub')).toHaveAttribute('data-active', 'true')
  })

  it('资源加载失败：错误 + 重试可见，Compare 不可创建且不回退为空 Scope', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    seedScope('selected', ['src_1'])
    vi.mocked(api.listSources).mockRejectedValue(new Error('network down'))
    renderHarness()
    switchTo('compare')

    expect(await screen.findByTestId('workspace-resources-error')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-resources-retry')).toBeInTheDocument()
    // ComparePane 资源失败守卫：不渲染创建入口（不得把失败当空 Scope）
    expect(screen.getByTestId('compare-resources-error')).toBeInTheDocument()
    expect(screen.queryByTestId('compare-create')).toBeNull()
    expect(screen.queryByTestId('compare-empty')).toBeNull()
    expect(api.createCompare).not.toHaveBeenCalled()

    // 重试刷新同一资源缓存
    fireEvent.click(screen.getByTestId('workspace-resources-retry'))
    await waitFor(() => expect(vi.mocked(api.listSources).mock.calls.length).toBeGreaterThanOrEqual(2))
  })
})
