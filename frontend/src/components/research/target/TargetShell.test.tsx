import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    language: 'zh-CN',
    setLanguage: vi.fn(),
  }),
}))

import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchHostProvider } from '@/lib/embedded/host-context'
import { ResearchScopeProvider, useResearchScope } from '@/lib/research/scope'
import { TargetShell } from './TargetShell'
import type { TargetConversationState } from './use-target-conversation'
import type { UseResearchSessionsResult } from '@/lib/hooks/use-research-sessions'
import type { ResearchJob } from '@/lib/research/types'

// W1 #1104（UI 规格 v1 §3/§5/§7）：目标工作台壳。
// 被测边界：TargetShell 的布局/顶栏入口/右栏开关与焦点/左栏收起与恢复/
// composer 交互。对话数据接线（session/editor/SSE）在 use-target-conversation
// 单测与集成层验证；本文件对其替身化。

const fixtureRows = vi.hoisted(() => ({
  sources: [
    { source_id: 'src_ready', document_id: 'doc_ready', document_version: 'v1', status: 'ready', content_hash: null, synced_at: null, last_error: null },
    { source_id: 'src_stale', document_id: 'doc_stale', document_version: 'v2', status: 'stale', content_hash: null, synced_at: null, last_error: null },
    { source_id: 'src_pending', document_id: 'doc_pending', document_version: 'v1', status: 'pending', content_hash: null, synced_at: null, last_error: null },
    { source_id: 'src_failed', document_id: 'doc_failed', document_version: 'v1', status: 'failed', content_hash: null, synced_at: null, last_error: 'boom' },
  ],
  notes: [
    {
      note_id: 'note_1',
      project_id: 'proj_1',
      title: 'Outcome note',
      content: 'content',
      note_type: 'human',
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
    },
  ],
}))

const media = vi.hoisted(() => ({ wide: false }))
const conversationFixture = vi.hoisted(() => ({
  send: vi.fn(async () => true),
  openSession: vi.fn(),
  newSession: vi.fn(async () => {}),
  pinSingleSource: vi.fn(() => true),
  flags: {
    canExecute: true,
    noActiveSession: false,
    canPinSingleSource: false,
    sendError: null as string | null,
  },
  editor: {
    snapshot: null,
    controller: null,
    transportWired: false,
    setDraftText: vi.fn(),
    setScope: vi.fn(),
    setChatAnchor: vi.fn(),
    setReaderAnchor: vi.fn(),
    flush: vi.fn(async () => 'skipped' as const),
    hold: vi.fn(),
    release: vi.fn(),
    retrySave: vi.fn(async () => 'skipped' as const),
    adoptServerVersion: vi.fn(async () => 'skipped' as const),
    saveLocalOverServer: vi.fn(async () => 'skipped' as const),
    clearAfterSubmission: vi.fn(async () => 'cleared' as const),
    markTokenConsumed: vi.fn(),
    canSubmit: vi.fn(() => ({ allowed: true as const })),
    restoreDraft: vi.fn(),
    refreshDraftCandidates: vi.fn(),
    releaseDocument: vi.fn(),
  },
  sessions: null as UseResearchSessionsResult | null,
}))

const ingest = vi.hoisted(() => vi.fn())

vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => media.wide,
  useIsDesktop: () => true,
}))

vi.mock('@/lib/hooks/use-research', () => ({
  useResearchSources: () => ({
    data: { items: fixtureRows.sources, total: fixtureRows.sources.length },
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useResearchNotes: () => ({
    data: { items: fixtureRows.notes, total: fixtureRows.notes.length },
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/lib/hooks/use-research-global-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/use-research-global-model')>()
  return {
    ...actual,
    useResearchGlobalModel: () => ({
      runGuarded: async (operation: (modelId: string) => Promise<boolean> | boolean) => {
        const result = await operation('model_1')
        return result === true
      },
      canExecute: true,
      blockedReason: null,
      confirmedModelId: 'model_1',
      localModelUnavailableMessage: null,
    }),
  }
})

vi.mock('@/components/research/ResearchGlobalModelBar', () => ({
  ResearchGlobalModelBar: () => <div data-testid="model-bar" />,
}))

const jobsFixture = vi.hoisted(() => ({
  jobs: [
    {
      job_id: 'job_1',
      project_id: 'proj_1',
      job_type: 'deep_compare',
      status: 'running',
      stage: null,
      progress: 0,
      model_id: 'model_1',
      generation_epoch: 1,
      retry_count: 0,
      last_error: null,
      result_ref: null,
      created_at: '2026-11-06T10:00:00Z',
      updated_at: '2026-11-06T10:00:00Z',
    },
    {
      job_id: 'job_2',
      project_id: 'proj_1',
      job_type: 'deep_compare',
      status: 'completed',
      stage: null,
      progress: 100,
      model_id: 'model_1',
      generation_epoch: 1,
      retry_count: 0,
      last_error: null,
      result_ref: null,
      created_at: '2026-11-05T10:00:00Z',
      updated_at: '2026-11-05T10:05:00Z',
    },
  ] as ResearchJob[],
  isCreating: false,
  error: null as string | null,
  errorCode: null as string | null,
  createCompare: vi.fn(),
}))

vi.mock('@/components/research/ResearchJobsProvider', () => ({
  ResearchJobsProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useResearchJobsController: () => jobsFixture,
}))

vi.mock('@/lib/embedded/shell', () => ({
  useRequestIngest: () => ingest,
}))

vi.mock('@/components/research/ResearchChatPanel', () => ({
  ResearchChatPanel: (props: {
    onCitationReturn?: (citation: Record<string, unknown>, messageId: string | null) => void
    hideComposer?: boolean
    showSessionScopeBar?: boolean
    showCoverageScopeSelector?: boolean
    showSessionHeader?: boolean
  }) => (
    <div
      data-testid="chat-panel"
      data-hide-composer={props.hideComposer === true ? 'true' : undefined}
      data-show-scope-bar={props.showSessionScopeBar === true ? 'true' : undefined}
      data-show-coverage={props.showCoverageScopeSelector === true ? 'true' : undefined}
    >
      <button
        type="button"
        data-testid="simulate-citation"
        onClick={() =>
          props.onCitationReturn?.(
            {
              citation_id: 1,
              claim: 'Evidence claim text',
              doc_id: 'doc_ready',
              page_idx: 2,
              doc_version: 'v1',
            },
            'msg_1',
          )
        }
      />
    </div>
  ),
}))

vi.mock('./use-target-conversation', async () => {
  const scopeModule = await vi.importActual<typeof import('@/lib/research/scope')>(
    '@/lib/research/scope',
  )
  return {
    useTargetConversation: (): TargetConversationState => {
      const sessions = conversationFixture.sessions
      // 空 selected 的阻断文案与真实 hook 同源（BEH-03）：从 provider 快照推导。
      const snapshot = scopeModule.useResearchScope().getSnapshot()
      const scopeEmpty =
        snapshot.mode === 'selected' &&
        snapshot.sourceIds.length === 0 &&
        snapshot.noteIds.length === 0
      return {
        sessionWired: false,
        runtimeAvailable: sessions !== null,
        sessions,
        activeRef: null,
        turns: [],
        isStreaming: false,
        backgroundNotice: null,
        resolveChatOrigin: async () => null,
        conversation: null,
        sessionMeta: null,
        sessionCards: [],
        submissionLookup: null,
        markerWriteFailed: false,
        refreshMarkerLookups: undefined,
        editor: conversationFixture.editor as unknown as TargetConversationState['editor'],
        editorSnapshot: null,
        submissionReady: undefined,
        canExecute: conversationFixture.flags.canExecute,
        blockedHint: conversationFixture.flags.canExecute
          ? ''
          : 'research.globalModel.selectModelHint',
        scopeBlockedText: scopeEmpty ? 'research.target.composer.scopeBlocked' : null,
        noActiveSession: conversationFixture.flags.noActiveSession,
        sendError: conversationFixture.flags.sendError,
        clearSendError: vi.fn(),
        canPinSingleSource: conversationFixture.flags.canPinSingleSource,
        send: conversationFixture.send,
        openSession: conversationFixture.openSession,
        newSession: conversationFixture.newSession,
        pinSingleSource: conversationFixture.pinSingleSource,
      }
    },
  }
})

function sessionFixture(options: {
  hasMore?: boolean
  loading?: boolean
  loadingMore?: boolean
  loadMoreError?: 'list_failed' | null
} = {}): UseResearchSessionsResult {
  return {
    sessions: [
      {
        ref: { domain: 'research', kind: 'global', projectId: 'proj_1', sessionId: 'sess_1', sourceId: null },
        title: 'Conversation A',
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-02T00:00:00Z',
        visibility: 'visible',
        hasDraft: null,
        legacy: false,
        visibilityDegraded: false,
      },
      {
        ref: { domain: 'research', kind: 'global', projectId: 'proj_1', sessionId: 'sess_2', sourceId: null },
        title: null,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
        visibility: 'visible',
        hasDraft: null,
        legacy: false,
        visibilityDegraded: false,
      },
    ],
    loading: options.loading ?? false,
    loadingMore: options.loadingMore ?? false,
    error: null,
    loadMoreError: options.loadMoreError ?? null,
    unauthorized: false,
    sourceUnavailable: false,
    hasMore: options.hasMore ?? false,
    capabilitiesReady: true,
    canList: true,
    canCreate: true,
    listDisabledReason: null,
    createDisabledReason: null,
    creating: false,
    createError: null,
    created: null,
    refresh: vi.fn(),
    loadMore: vi.fn(),
    create: vi.fn(async () => null),
  } as unknown as UseResearchSessionsResult
}

function ScopeProbe() {
  const { mode, selectedSourceIds, selectedNoteIds } = useResearchScope()
  return (
    <div>
      <span data-testid="scope-probe-mode">{mode}</span>
      <span data-testid="scope-probe-source-count">{selectedSourceIds.length}</span>
      <span data-testid="scope-probe-note-count">{selectedNoteIds.length}</span>
    </div>
  )
}

function renderShell(projectName: string | null = 'Project Alpha') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner" userId="user_1">
        <ResearchScopeProvider userId="user_1" projectId="proj_1">
          <ResearchHostProvider projectName={projectName}>
            <TargetShell />
            <ScopeProbe />
          </ResearchHostProvider>
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  media.wide = false
  conversationFixture.sessions = sessionFixture()
  conversationFixture.flags.canExecute = true
  conversationFixture.flags.noActiveSession = false
  conversationFixture.flags.canPinSingleSource = false
  conversationFixture.flags.sendError = null
  conversationFixture.send.mockClear()
  conversationFixture.openSession.mockClear()
  conversationFixture.newSession.mockClear()
  conversationFixture.pinSingleSource.mockClear()
  conversationFixture.pinSingleSource.mockReturnValue(true)
  ingest.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('目标壳布局与地标（§3）', () => {
  it('渲染顶栏/左资料栏/中央对话与 skip link', () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-topbar')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-sources-aside')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-main')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-conversation')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'research.target.a11y.skipToComposer' })).toHaveAttribute(
      'href',
      '#rdlens-target-composer',
    )
    // 右栏默认收起
    expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull()
  })

  it('1024–1279 + 右栏打开：左栏临时收起但不卸载；关闭后恢复且状态保留', async () => {
    media.wide = false
    renderShell()
    expect(screen.getByTestId('rdlens-target-shell')).toHaveAttribute('data-breakpoint', 'compact')

    const search = screen.getByTestId('rdlens-target-sources-search')
    fireEvent.change(search, { target: { value: 'doc_ready' } })
    expect(search).toHaveValue('doc_ready')

    fireEvent.click(screen.getByTestId('rdlens-target-tasks-trigger'))
    await waitFor(() => expect(screen.getByTestId('rdlens-target-right-pane')).toBeInTheDocument())
    expect(screen.getByTestId('rdlens-target-shell')).toHaveAttribute('data-left-pane-collapsed', 'true')
    // 保持挂载（display:none），搜索状态不丢
    expect(screen.getByTestId('rdlens-target-sources-aside')).toHaveClass('hidden')
    expect(screen.getByTestId('rdlens-target-sources-search')).toHaveValue('doc_ready')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
    expect(screen.getByTestId('rdlens-target-sources-aside')).toHaveClass('flex')
    expect(screen.getByTestId('rdlens-target-sources-search')).toHaveValue('doc_ready')
  })

  it('≥1280 + 右栏打开：三栏并排，左栏不收起', async () => {
    media.wide = true
    renderShell()
    expect(screen.getByTestId('rdlens-target-shell')).toHaveAttribute('data-breakpoint', 'wide')
    fireEvent.click(screen.getByTestId('rdlens-target-tasks-trigger'))
    await waitFor(() => expect(screen.getByTestId('rdlens-target-right-pane')).toBeInTheDocument())
    expect(screen.getByTestId('rdlens-target-shell')).not.toHaveAttribute('data-left-pane-collapsed')
    expect(screen.getByTestId('rdlens-target-sources-aside')).toHaveClass('flex')
  })
})

describe('UI-02 顶栏（§5.2 / D-UI-01）', () => {
  it('宿主项目名显示为唯一项目身份：1 行省略 + 完整 aria-label', () => {
    renderShell('Project Alpha')
    const name = screen.getByTestId('rdlens-target-project-name')
    expect(name).toHaveTextContent('Project Alpha')
    expect(name).toHaveAttribute('title', 'Project Alpha')
    expect(name).toHaveAttribute('aria-label', 'research.target.topbar.projectLabel')
    expect(name).toHaveAttribute('data-project-source', 'host')
  })

  it('宿主未提供项目名：回退通用 Research，不伪造项目身份', () => {
    renderShell(null)
    const name = screen.getByTestId('rdlens-target-project-name')
    expect(name).toHaveTextContent('research.target.topbar.projectFallback')
    expect(name).toHaveAttribute('data-project-source', 'fallback')
  })

  it('任务入口显示未完成计数并打开任务历史；成果入口打开成果目录', async () => {
    renderShell()
    const tasks = screen.getByTestId('rdlens-target-tasks-trigger')
    // 未完成计数：queued/running/cancelling（completed 不计）
    expect(screen.getByTestId('rdlens-target-tasks-badge')).toHaveTextContent('1')
    expect(tasks).toHaveAttribute('aria-expanded', 'false')
    expect(tasks).toHaveAttribute('aria-controls', 'rdlens-target-right-pane')

    fireEvent.click(tasks)
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute('data-pane-kind', 'tasks'),
    )
    expect(screen.getByTestId('rdlens-target-tasks-trigger')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByTestId('rdlens-target-task-item')).toHaveLength(2)

    fireEvent.click(screen.getByTestId('rdlens-target-outcomes-trigger'))
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute('data-pane-kind', 'outcomes'),
    )
    expect(screen.getByTestId('rdlens-target-outcome-item')).toBeInTheDocument()
    expect(screen.getByText('research.target.rightPane.outcomesReadOnly')).toBeInTheDocument()
  })
})

describe('UI-12 右栏焦点与 Esc（§5.6 / A11Y-02）', () => {
  it('打开时焦点进入面板关闭按钮；Esc 关闭后焦点回到触发控件', async () => {
    renderShell()
    const trigger = screen.getByTestId('rdlens-target-tasks-trigger')
    trigger.focus()
    fireEvent.click(trigger)
    const close = await screen.findByTestId('rdlens-target-right-pane-close')
    await waitFor(() => expect(document.activeElement).toBe(close))

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
    // F7：关闭后焦点回到触发控件（close 通过 effect 在恢复左栏可见后执行）
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('关闭按钮同样把焦点还给触发控件', async () => {
    renderShell()
    const trigger = screen.getByTestId('rdlens-target-outcomes-trigger')
    fireEvent.click(trigger)
    const close = await screen.findByTestId('rdlens-target-right-pane-close')
    fireEvent.click(close)
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('同一时刻只承担一项辅助内容：打开另一项即替换', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-tasks-trigger'))
    await waitFor(() => expect(screen.getByTestId('rdlens-target-tasks-panel')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('rdlens-target-outcomes-trigger'))
    await waitFor(() => expect(screen.getByTestId('rdlens-target-outcomes-panel')).toBeInTheDocument())
    expect(screen.queryByTestId('rdlens-target-tasks-panel')).toBeNull()
  })
})

describe('UI-07 对话标题区与历史入口（§5.4 / UI-16）', () => {
  it('历史打开右栏对话历史；点击会话/新对话调用既有 session 能力', async () => {
    renderShell()
    const history = screen.getByTestId('rdlens-target-history-trigger')
    expect(history).not.toBeDisabled()
    fireEvent.click(history)
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute('data-pane-kind', 'conversations'),
    )
    const items = screen.getAllByTestId('rdlens-target-conversation-item')
    expect(items).toHaveLength(2)
    // 未命名会话渲染占位（真实 i18n 下为 research.session.unnamed 译文）
    expect(items[1]).toHaveTextContent('Untitled conversation')
    fireEvent.click(items[0])
    expect(conversationFixture.openSession).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('rdlens-target-conversation-new'))
    expect(conversationFixture.newSession).toHaveBeenCalledTimes(1)
  })

  it('会话能力缺失时历史/新对话为明确不可用（disabled + 原因），不造假控件', () => {
    conversationFixture.sessions = null
    renderShell()
    expect(screen.getByTestId('rdlens-target-history-trigger')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-new-conversation')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-history-unavailable')).toBeInTheDocument()
  })
})

describe('引用点击 → 右栏引用预览（W1 最小可用）', () => {
  it('citation 点击打开引用预览并显示来源/定位/摘录', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('simulate-citation'))
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute('data-pane-kind', 'citation'),
    )
    expect(screen.getByTestId('rdlens-target-citation-source')).toHaveTextContent('doc_ready')
    expect(screen.getByTestId('rdlens-target-citation-locator')).toHaveTextContent(
      'research.target.rightPane.locatorPage',
    )
    expect(screen.getByTestId('rdlens-target-citation-excerpt')).toHaveTextContent('Evidence claim text')
    // W2 前原文阅读明确不可用
    expect(screen.getByTestId('rdlens-target-open-original')).toBeDisabled()
    expect(screen.getByText('research.target.rightPane.openOriginalUnavailable')).toBeInTheDocument()
  })

  it('只问此来源：调用既有 single-pin 能力并关闭右栏', async () => {
    conversationFixture.flags.canPinSingleSource = true
    renderShell()
    fireEvent.click(screen.getByTestId('simulate-citation'))
    const ask = await screen.findByTestId('rdlens-target-ask-this-source')
    fireEvent.click(ask)
    expect(conversationFixture.pinSingleSource).toHaveBeenCalledWith('src_ready')
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
  })
})

describe('composer（UI-10，§5.5）', () => {
  it('空输入不可提交；输入后 Ctrl/Cmd+Enter 提交，Enter 仅换行', async () => {
    renderShell()
    const textarea = screen.getByTestId('chat-input')
    const send = screen.getByTestId('chat-send')
    expect(send).toBeDisabled()

    fireEvent.change(textarea, { target: { value: 'What changed?' } })
    expect(send).not.toBeDisabled()

    // Enter 不提交（目标壳快捷键为 Ctrl/Cmd+Enter）
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(conversationFixture.send).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(conversationFixture.send).toHaveBeenCalledWith('What changed?')
  })

  it('次级操作行：证据搜索/比较资料可用，深入研究明确不可用', () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-secondary-search')).not.toBeDisabled()
    expect(screen.getByTestId('rdlens-target-secondary-compare')).not.toBeDisabled()
    expect(screen.getByTestId('rdlens-target-secondary-deep-research')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-deep-research-reason')).toHaveTextContent(
      'research.target.secondary.deepResearchUnavailable',
    )
  })

  it('证据搜索打开既有面板作为中央次级视图并可返回对话', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-secondary-search'))
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-secondary-evidence-search')).toBeInTheDocument(),
    )
    // 对话保持挂载（隐藏不卸载）
    expect(screen.getByTestId('rdlens-target-conversation')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('rdlens-target-secondary-back'))
    await waitFor(() =>
      expect(screen.queryByTestId('rdlens-target-secondary-panel')).toBeNull(),
    )
  })
})

describe('左资料栏（UI-04，§5.3）', () => {
  it('搜索过滤资料；无匹配显示空态与清除搜索', () => {
    renderShell()
    const search = screen.getByTestId('rdlens-target-sources-search')
    fireEvent.change(search, { target: { value: 'doc_ready' } })
    expect(screen.getAllByTestId('rdlens-target-source-row')).toHaveLength(1)

    fireEvent.change(search, { target: { value: 'nothing-matches' } })
    expect(screen.getByTestId('rdlens-target-sources-search-empty')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('rdlens-target-sources-search-empty-clear'))
    expect(search).toHaveValue('')
    expect(screen.getAllByTestId('rdlens-target-source-row')).toHaveLength(4)
  })

  it('状态六值映射为文字（不只靠颜色），不可选状态复选框 disabled 且有原因', () => {
    renderShell()
    expect(screen.getAllByTestId('rdlens-target-source-status').length).toBeGreaterThan(0)
    const pendingCheckbox = screen.getByTestId('rdlens-target-source-select-src_pending')
    expect(pendingCheckbox).toBeDisabled()
    expect(pendingCheckbox).toHaveAttribute('title', 'research.target.sources.notSelectable')
    const failedCheckbox = screen.getByTestId('rdlens-target-source-select-src_failed')
    expect(failedCheckbox).toBeDisabled()
  })

  it('勾选资料切换到 selected 范围（唯一范围权威仍是既有 provider）', () => {
    renderShell()
    // 默认 all
    expect(screen.getByTestId('rdlens-target-scope-all')).toHaveAttribute('data-state', 'checked')
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    expect(screen.getByTestId('rdlens-target-scope-selected')).toHaveAttribute(
      'data-state',
      'checked',
    )
    // 底部范围摘要反映既有 scope 语义
    expect(screen.getByTestId('rdlens-target-scope-summary')).toHaveTextContent(
      'research.scopeSummary.sourceOne',
    )
  })

  it('selected 可清空到空：取消最后一份后范围仍为 selected（不回退 all）并显示阻断说明', () => {
    renderShell()
    // all → 勾选两份 → selected 2
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_stale'))
    expect(screen.getByTestId('scope-probe-mode')).toHaveTextContent('selected')
    expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('2')
    expect(screen.queryByTestId('rdlens-target-scope-blocked')).toBeNull()

    // 取消第一份（仍有 1 份）
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('1')
    expect(screen.queryByTestId('rdlens-target-scope-blocked')).toBeNull()

    // 有草稿时先确认可提交（对照组：非阻断态不被 composer 门禁挡）
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Next question' } })
    expect(screen.getByTestId('chat-send')).not.toBeDisabled()

    // 取消最后一份：checkbox 必须可用（旧实现会禁用导致空 selected 不可达），
    // 且保留稳定可访问名（含资料名）。
    const lastCheckbox = screen.getByTestId('rdlens-target-source-select-src_stale')
    expect(lastCheckbox).not.toBeDisabled()
    expect(lastCheckbox).toHaveAccessibleName('research.target.sources.selectAria')
    fireEvent.click(lastCheckbox)
    expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('0')
    // BEH-01：selected 为空**不回退 all**（不静默扩大范围）
    expect(screen.getByTestId('scope-probe-mode')).toHaveTextContent('selected')
    // BEH-03：左栏阻断说明 + 下一步动作可见
    const blocked = screen.getByTestId('rdlens-target-scope-blocked')
    expect(blocked).toBeInTheDocument()
    expect(within(blocked).getByText('research.target.sources.scopeEmptySelected')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-scope-blocked-choose')).toBeInTheDocument()
    // composer 同源阻断：提交门禁关闭 + 原因可见（不是只显示文案）
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent(
      'research.target.composer.scopeBlocked',
    )

    // 明确动作才扩大到 all（用户主动，而非静默）
    fireEvent.click(screen.getByTestId('rdlens-target-scope-blocked-all'))
    expect(screen.getByTestId('scope-probe-mode')).toHaveTextContent('all')
    expect(screen.queryByTestId('rdlens-target-scope-blocked')).toBeNull()
  })

  it('打开资料预览（UI-17）显示版本/状态，原文阅读明确 W2 不可用', async () => {
    renderShell()
    fireEvent.click(screen.getAllByTestId('rdlens-target-source-open')[0])
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute('data-pane-kind', 'source'),
    )
    expect(screen.getByTestId('rdlens-target-source-preview-name')).toHaveTextContent('doc_ready')
    expect(screen.getByTestId('rdlens-target-source-open-original')).toBeDisabled()
  })
})

describe('审查第 1 轮修复回归（F3/F4/F5/F7/F9/F10/F11/F15/F18/F19/F21）', () => {
  it('F4：空 selected 同时阻断证据搜索/比较，并显示与 composer 同源的阻断原因', () => {
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_stale'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_stale'))
    expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('0')
    expect(screen.getByTestId('rdlens-target-secondary-search')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-secondary-compare')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-secondary-blocked')).toHaveTextContent(
      'research.target.composer.scopeBlocked',
    )
  })

  it('F4：次级视图已打开后 range 变空 → 不渲染搜索面板，fail-closed 显示阻断', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-secondary-search'))
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-secondary-panel')).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-secondary-scope-blocked')).toBeInTheDocument(),
    )
    expect(screen.queryByTestId('rdlens-target-secondary-panel')).toBeNull()
  })

  it('F5：无可用模型 → composer 提交禁用且原因可见（不是可点后静默失败）', () => {
    conversationFixture.flags.canExecute = false
    renderShell()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello' } })
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent(
      'research.globalModel.selectModelHint',
    )
  })

  it('F3：runtime 可用但无活动会话 → 显示新建/选择会话说明并禁用发送', () => {
    conversationFixture.flags.noActiveSession = true
    renderShell()
    expect(screen.getByTestId('rdlens-target-no-session')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'Hello' } })
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent(
      'research.target.composer.noActiveSession',
    )
  })

  it('F1/F5：发送被阻断/失败的可视原因（sendError）', () => {
    conversationFixture.flags.sendError = 'research.target.composer.scopeChanged'
    renderShell()
    expect(screen.getByTestId('rdlens-target-send-error')).toHaveTextContent(
      'research.target.composer.scopeChanged',
    )
  })

  it('F7：引用预览关闭后焦点回到引用按钮（citation 触发元素被记录）', async () => {
    renderShell()
    const cite = screen.getByTestId('simulate-citation')
    cite.focus()
    fireEvent.click(cite)
    const close = await screen.findByTestId('rdlens-target-right-pane-close')
    fireEvent.click(close)
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(cite))
  })

  it('F7：compact 下资料预览关闭后焦点回到资料行按钮（左栏恢复可见后）', async () => {
    media.wide = false
    renderShell()
    const open = screen.getAllByTestId('rdlens-target-source-open')[0]
    fireEvent.click(open)
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute(
        'data-pane-kind',
        'source',
      ),
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(open))
  })

  it('F9/F10：笔记区可选入同一 Scope；notes-only 摘要包含笔记（formatScopeLabel）', () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-notes-title')).toBeInTheDocument()
    expect(screen.getAllByTestId('rdlens-target-note-row')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('rdlens-target-note-select-note_1'))
    expect(screen.getByTestId('scope-probe-mode')).toHaveTextContent('selected')
    expect(screen.getByTestId('scope-probe-note-count')).toHaveTextContent('1')
    expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('0')
    expect(screen.getByTestId('rdlens-target-scope-summary')).toHaveTextContent(
      'research.scopeSummary.noteOne',
    )
  })

  it('F10：笔记区空态（无笔记）有明确说明', () => {
    // 通过清空 notes fixture 验证空态（vi.mock 工厂读取同一 hoisted 对象）
    const hoisted = fixtureRows as { notes: unknown[] }
    const original = hoisted.notes
    hoisted.notes = []
    renderShell()
    expect(screen.getByTestId('rdlens-target-notes-empty')).toBeInTheDocument()
    hoisted.notes = original
  })

  it('F11：>1 页会话历史显示「加载更多」并调用 loadMore', async () => {
    const loadMore = vi.fn()
    conversationFixture.sessions = {
      ...sessionFixture({ hasMore: true }),
      loadMore,
    }
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-history-trigger'))
    const button = await screen.findByTestId('rdlens-target-conversation-load-more')
    fireEvent.click(button)
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('F15：历史加载中显示 loading 原因；新对话不可用原因常显（aria-describedby 不悬空）', () => {
    conversationFixture.sessions = sessionFixture({ loading: true })
    renderShell()
    const history = screen.getByTestId('rdlens-target-history-trigger')
    expect(history).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-history-unavailable')).toHaveTextContent(
      'research.target.conversation.loading',
    )
    expect(history).toHaveAttribute('aria-describedby', 'rdlens-target-history-reason')
    const create = screen.getByTestId('rdlens-target-new-conversation')
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute('aria-describedby', 'rdlens-target-new-reason')
    expect(screen.getByTestId('rdlens-target-new-unavailable')).toBeInTheDocument()
  })

  it('F18：资料/笔记 checkbox 有 24×24 点击区包装（A11Y-04）', () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-source-select-src_ready').parentElement).toHaveClass(
      'h-6',
      'w-6',
    )
    expect(screen.getByTestId('rdlens-target-note-select-note_1').parentElement).toHaveClass(
      'h-6',
      'w-6',
    )
  })

  it('F19：1440 视口 + 右栏打开 → 中央列宽按真实视口推导（>=720）', async () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    media.wide = true
    try {
      renderShell()
      fireEvent.click(screen.getByTestId('rdlens-target-tasks-trigger'))
      await waitFor(() =>
        expect(screen.getByTestId('rdlens-target-right-pane')).toBeInTheDocument(),
      )
      // 1440 − 282 − 355 = 803
      expect(screen.getByTestId('rdlens-target-shell')).toHaveAttribute('data-center-width', '803')
      // 关闭右栏 → 焦点回到触发控件（1440/wide 焦点返回也覆盖）
      const trigger = screen.getByTestId('rdlens-target-tasks-trigger')
      fireEvent.click(trigger)
      await waitFor(() =>
        expect(screen.getByTestId('rdlens-target-right-pane')).toBeInTheDocument(),
      )
      fireEvent.click(screen.getByTestId('rdlens-target-right-pane-close'))
      await waitFor(() => expect(document.activeElement).toBe(trigger))
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    }
  })

  it('F21：任务计数徽标不小于 11px 可见文字', () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-tasks-badge').className).toContain('text-[11px]')
  })
})

describe('审查第 1 轮 LOW 修复（F8/F17/F22）', () => {
  it('F8：对话历史时间按 locale 格式化（zh-CN 下不是 ISO 裸串）', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-history-trigger'))
    await waitFor(() =>
      expect(screen.getAllByTestId('rdlens-target-conversation-item').length).toBeGreaterThan(0),
    )
    const item = screen.getAllByTestId('rdlens-target-conversation-item')[0]
    expect(item.textContent ?? '').toContain('2026')
    expect(item.textContent ?? '').not.toContain('2026-11-02T00:00:00Z')
  })

  it('F17：空 selected 的「选择资料」聚焦第一个未 disabled 的复选（跳过 pending/failed）', () => {
    const hoisted = fixtureRows as { sources: unknown[] }
    const original = hoisted.sources
    // 首行不可选（pending），第二行可选：聚焦必须落到第二行
    hoisted.sources = [original[2], original[0], original[1], original[3]]
    try {
      renderShell()
      fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
      fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
      expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('0')
      fireEvent.click(screen.getByTestId('rdlens-target-scope-blocked-choose'))
      expect(document.activeElement).toBe(
        screen.getByTestId('rdlens-target-source-select-src_ready'),
      )
    } finally {
      hoisted.sources = original
    }
  })
})
