import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchWorkspace } from './ResearchWorkspace'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope } from '@/lib/research/scope'
import { useResearchNotes, useResearchSources } from '@/lib/hooks/use-research'
import * as api from '@/lib/research/api'
import * as tokenStore from '@/lib/embedded/token-store'
import { QUERY_KEYS } from '@/lib/api/query-client'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'
import {
  resetGlobalModelStub,
  setGlobalModelStub,
} from '@/test/global-model-stub'

// UI-03 Red：工作区组合（REQ-SCOPE-04）——无项目上下文 fail-closed 错误态；
// 有上下文时加载 Source/Note 并渲染四个面板 Tab。
// RWV2-13（Issue #34）：右栏顶部的完整 Sources/Notes 选择器替换为紧凑
// Scope Summary + Edit scope；模式与选择编辑迁移到左栏（唯一编辑面）。

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

function workspaceWrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId="u1" projectId="proj_1" role="owner">
        <ResearchScopeProvider userId="u1" projectId="proj_1">
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
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

describe('ResearchWorkspace', () => {
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

  it('认证 Shell 注入项目上下文后不再依赖 Token 二次解码', async () => {
    tokenStore.clearResearchToken()
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    expect(await screen.findByRole('tab', { name: 'research.tabChat' })).toBeInTheDocument()
  })

  it('右栏渲染紧凑 Scope Summary（无完整选择器）与四个 Tab；entire_project 显式可见', async () => {
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    // 摘要常驻（不再折叠）：首次显式显示 Entire project（D2 不隐式推导）
    expect(await screen.findByTestId('research-context-scope')).toHaveTextContent('research.layout.scope.entireProject')
    // 右栏无完整选择器：无模式单选、无来源/笔记复选框列表
    expect(screen.queryByTestId('source-note-selector')).toBeNull()
    expect(screen.queryByTestId('source-selection-list')).toBeNull()
    expect(screen.queryByTestId('note-selection-list')).toBeNull()
    expect(screen.queryByTestId('scope-entire-project')).toBeNull()
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual([
      'research.tabSearch',
      'research.tabChat',
      'research.tabCompare',
      'research.tabJobs',
    ])
    expect(api.listSources).toHaveBeenCalledWith('proj_1', { limit: 100 })
    expect(api.listNotes).toHaveBeenCalledWith('proj_1', { limit: 100 })
  })

  it('selected 模式摘要显示来源与笔记计数（来自共享 provider）', async () => {
    seedScope('selected', ['src_1'], ['note_1'])
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    expect(await screen.findByTestId('research-context-scope')).toHaveTextContent(
      'research.layout.scope.selectedSummary',
    )
  })

  it('Edit scope 触发组合层回调（退出最大化回到左栏编辑面，不持有第二套状态）', async () => {
    const onEditScope = vi.fn()
    render(<ResearchWorkspace onEditScope={onEditScope} />, { wrapper: workspaceWrapper })
    fireEvent.click(await screen.findByTestId('scope-edit-button'))
    expect(onEditScope).toHaveBeenCalledTimes(1)
  })

  it('右栏不渲染任何复选框（唯一编辑面在左栏 Sources/Notes）', async () => {
    seedScope('selected', ['src_1'], ['note_1'])
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    await screen.findByTestId('research-context-scope')
    // Chat/Search 面板在未派发时不渲染局部复选框；工作区顶层无 checkbox
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('右栏与第二个消费者共享一次查询（单一查询缓存）', async () => {
    render(
      <>
        <ResearchWorkspace />
        <SharedQueryConsumer />
      </>,
      { wrapper: workspaceWrapper },
    )
    await screen.findByTestId('research-context-scope')
    expect(api.listSources).toHaveBeenCalledTimes(1)
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
        <ResearchWorkspace />
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
        <ResearchWorkspace />
        <ScopeProbe />
      </>,
      { wrapper: workspaceWrapper },
    )

    await waitFor(() => {
      expect(screen.getByTestId('scope-reconcile-probe')).toHaveTextContent('selected:::false')
    })
    expect(screen.getByTestId('research-context-scope')).toHaveTextContent(
      'research.layout.scope.selectedSummary',
    )
  })

  it('已选 Source 从 ready 转为 failed 时清理 ID、保留 selected 并反馈', async () => {
    seedScope('selected', ['src_1'])
    render(
      <>
        <ResearchWorkspace />
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

  it('#243 §6.4：Chat 发送经顶层守卫——待确认/无模型时不打开流、不留 turn', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    // 外部模型待确认：守卫登记但不执行（不变量 9）
    setGlobalModelStub({ deferGuarded: true })
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    // Radix Tabs 在 jsdom 下按 mousedown 切换（fireEvent.click 不触发）
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'research.tabChat' }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题' } })
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

  it('#243 §6.4：Compare 创建经顶层守卫——待确认时不发创建请求', async () => {
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
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    // Compare 从共享 Scope 快照取 selected source（左栏编辑面已选中 src_1）
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'research.tabCompare' }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'research.compareCreate' }))

    // 守卫未放行：不创建 Job、不落 localStorage（不变量 9）
    expect(api.createCompare).not.toHaveBeenCalled()
    expect(localStorage.getItem('rdlens.research.jobs.proj_1')).toBeNull()
    // 评审 MEDIUM-1：未派发时不显示「已创建」提示（取消不误报成功）
    expect(screen.queryByTestId('compare-submitted')).toBeNull()
  })

  it('#243：无可用全局模型时 Chat 输入/发送禁用并展示引导（评审 Important-2）', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    setGlobalModelStub({ confirmedModelId: null })
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'research.tabChat' }), {
      button: 0,
      ctrlKey: false,
    })

    expect(screen.getByTestId('chat-input')).toBeDisabled()
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
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'research.tabCompare' }), {
      button: 0,
      ctrlKey: false,
    })

    expect(screen.getByTestId('compare-create')).toBeDisabled()
    expect(screen.getByTestId('compare-model-blocked-hint')).toHaveTextContent(
      'research.globalModel.selectModelHint',
    )
    expect(api.createCompare).not.toHaveBeenCalled()
  })

  it('加载失败显示错误与重试按钮', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    vi.mocked(api.listSources).mockRejectedValue(new Error('network down'))
    render(<ResearchWorkspace />, { wrapper: workspaceWrapper })
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
