/**
 * #1125（owner 2026-11-09「选A」defect 修复）目标壳主题概览接入测试。
 *
 * 被测边界：新接线组件 `TargetTopicOverview`（入口 + Dialog 的 open state 与
 * props 接线）挂在真实 `TargetConversation` 的 `overviewSlot` 上——即默认
 * 目标壳中央对话的**起始位置**；及可选 `overviewSlot` 的加性（不传不改
 * 既有结构）。TopicOverviewEntry/Dialog 的内部状态机已由 #1016 的
 * `TopicOverviewEntry.test.tsx` / `TopicOverviewDialog.test.tsx` 覆盖，本文件
 * 不重复，只验证「目标壳接线」：
 * - 能力位 fail-closed：`false` ⇒ 无入口、概览读面不发起；
 * - 能力位 `true` ⇒ 入口位于标题区之下、消息区之上（中央对话起始位置），
 *   与正文列同最大宽度（850）对齐；
 * - 点击入口打开既有 Dialog（复用 #1016 四段正文语义）；
 * - 继续讨论 → 目标壳既有 `editor.setDraftText`（当前会话草稿）**并关闭
 *   Dialog**（草稿用户可见，MEDIUM-1）；无活动会话 → 动作 fail-closed 隐藏；
 * - 引用跳转 → **先关闭 Dialog** 再调用目标壳既有
 *   `onCitationJump(sourceId, pageIdx)`（右栏来源预览不被 modal 遮挡，HIGH-1）；
 * - Admin 只读即便能力位 true 也不渲染入口（与 legacy 一致）；
 * - 不传 `overviewSlot` 时对话列结构不变（加性 prop）。
 *
 * 替身：`use-research-topic-overview` hooks（能力位/读面/生成 mutation 输入）
 * 与 `useResearchSources`、全局模型（Dialog 的执行守卫来源）；被测
 * Entry/Dialog/TargetConversation 组件真实。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider } from '@/lib/research/scope'
import { resetGlobalModelStub } from '@/test/global-model-stub'
import { topicOverviewDiscussionText } from '@/lib/research/topic-overview'
import type { TopicOverviewWire } from '@/lib/research/topic-overview'
import type { ResearchSource } from '@/lib/types/research'
import { TargetConversation } from './TargetConversation'
import { TargetTopicOverview } from './TargetTopicOverview'
import type { TargetConversationState } from './use-target-conversation'

const PROJECT_ID = 'proj_1'
const LOCALIZED_DISCUSSION_GUIDE = 'Continue the discussion based on this topic overview: '

const h = vi.hoisted(() => ({
  capability: false,
  overviewData: null as unknown,
  enabledCalls: [] as Array<{ enabled?: boolean } | undefined>,
  refetch: vi.fn(),
  sources: [] as unknown[],
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'research.topicOverview.dialog.continueDraft'
        ? 'Continue the discussion based on this topic overview: '
        : opts === undefined
          ? key
          : `${key}|${JSON.stringify(opts)}`,
  }),
}))

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

// Dialog 的执行守卫来源（生成/更新与 Chat 同一条 runGuarded 链）；替身
// 默认「本地已选模型、可执行」，与生产本地模型场景一致。
vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/lib/hooks/use-research-topic-overview', () => ({
  topicOverviewGenerateMutationKey: (projectId: string) => [
    'research',
    projectId,
    'topic-overview',
    'generate',
  ],
  useResearchTopicOverviewCapability: () => h.capability,
  useResearchTopicOverview: vi.fn(
    (_projectId: string, options?: { enabled?: boolean }) => {
      h.enabledCalls.push(options)
      return {
        data: h.overviewData,
        isLoading: false,
        isError: false,
        error: null,
        refetch: h.refetch,
      }
    },
  ),
  useGenerateTopicOverview: () => ({
    data: null,
    isPending: false,
    reset: vi.fn(),
    mutateAsync: vi.fn(),
  }),
}))

vi.mock('@/lib/hooks/use-research', () => ({
  useResearchSources: () => ({
    data: { items: h.sources, total: h.sources.length },
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useResearchNotes: () => ({
    data: { items: [], total: 0 },
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}))

// 对话列的重型子节点与用例无关：只保留位置结构（标题区/消息区/composer）。
vi.mock('../ResearchChatPanel', () => ({
  ResearchChatPanel: () => <div data-testid="chat-panel" />,
}))

vi.mock('./TargetComposer', () => ({
  TargetComposer: () => <div data-testid="target-composer" />,
}))

function source(overrides: Partial<ResearchSource> = {}): ResearchSource {
  return {
    source_id: 'src_1',
    document_id: 'doc_1',
    document_version: 'v1',
    status: 'ready',
    content_hash: null,
    synced_at: '2026-11-05T09:00:00+00:00',
    last_error: null,
    ...overrides,
  }
}

function readyOverview(overrides: Partial<TopicOverviewWire> = {}): TopicOverviewWire {
  return {
    overview_id: 'ovw_1',
    generation_id: 'gen_1',
    generated_at: '2026-11-05T10:00:00+00:00',
    generation_created_at: '2026-11-05T09:55:00+00:00',
    focus: null,
    visibility: 'ready',
    content_markdown: 'Overview markdown',
    sections: {
      main_questions: 'Main questions',
      findings: 'Findings',
      disagreements: 'Disagreements',
      reading_priorities: 'Reading priorities',
    },
    citations: [
      {
        citation_id: 1,
        claim: 'claim-one',
        doc_id: 'doc_1',
        doc_version: 'v1',
        page_idx: 2,
        chunk_id: 'chunk_1',
        source_id: 'src_1',
        warning: null,
      },
    ],
    scope: {
      mode: 'selected',
      contract_version: 'c05-v1',
      includes_exact_versions: true,
      captured_at: '2026-11-05T09:55:00+00:00',
      source_count: 1,
      refs_truncated: false,
      sources: [],
      missing_source_ids: [],
      single_source_id: null,
    },
    processing: {
      resolved_mode: 'hybrid_rag',
      evidence_chunk_count: 3,
      citation_count: 1,
      citations_total: 1,
      citations_dropped: 0,
      evidence_modalities: { text: 3, table: 0, figure: 0, mixed: 0 },
      coverage: { trimmed: 1, missing: 0 },
      included_sources: [
        {
          document_id: 'doc_1',
          document_version: 'v1',
          chunk_count: 2,
          source_id: 'src_1',
        },
      ],
      degradations: [],
      degradation_reason: null,
      evidence_degraded: null,
      full_text_read: false,
    },
    model: { model_id: 'm-local', provider_id: 'p_local' },
    purpose: null,
    limitations: ['full_text_not_read'],
    warnings: [],
    ...overrides,
  }
}

let queryClient: QueryClient
let onCitationJump: Mock<(sourceId: string, pageIdx: number | null) => void>
let setDraftText: Mock<(text: string) => void>

function conversationState(
  overrides: Partial<TargetConversationState> = {},
): TargetConversationState {
  const state = {
    sessionWired: true,
    runtimeAvailable: true,
    noActiveSession: false,
    sessions: null,
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
    editor: {
      snapshot: null,
      controller: null,
      transportWired: false,
      setDraftText,
      setScope: vi.fn(),
      setChatAnchor: vi.fn(),
      setReaderAnchor: vi.fn(),
      flush: vi.fn(async () => 'skipped'),
      hold: vi.fn(),
      release: vi.fn(),
      retrySave: vi.fn(async () => 'skipped'),
      adoptServerVersion: vi.fn(async () => 'skipped'),
      saveLocalOverServer: vi.fn(async () => 'skipped'),
      clearAfterSubmission: vi.fn(async () => 'cleared'),
      markTokenConsumed: vi.fn(),
      canSubmit: vi.fn(() => ({ allowed: true })),
      restoreDraft: vi.fn(),
      refreshDraftCandidates: vi.fn(),
      releaseDocument: vi.fn(),
    },
    editorSnapshot: null,
    submissionReady: undefined,
    canExecute: true,
    blockedHint: '',
    scopeBlockedText: null,
    sendError: null,
    canPinSingleSource: false,
    workPurpose: null,
    setWorkPurpose: vi.fn(),
    purposeInferenceAvailable: false,
    send: async () => true,
    sendWithPurpose: async () => true,
    clearSendError: vi.fn(),
    openSession: vi.fn(),
    newSession: async () => {},
    pinSingleSource: vi.fn(() => true),
    ...overrides,
  }
  return state as unknown as TargetConversationState
}

function Harness({
  role = 'owner',
  withSlot = true,
  sessionWired = true,
}: {
  role?: 'owner' | 'admin_readonly'
  withSlot?: boolean
  sessionWired?: boolean
}) {
  const conversation = conversationState({ sessionWired })
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId={PROJECT_ID} role={role} userId="user_1">
        <ResearchScopeProvider userId="user_1" projectId={PROJECT_ID}>
          <TargetConversation
            conversation={conversation}
            onOpenHistory={vi.fn()}
            onNewConversation={vi.fn()}
            onOpenCitation={vi.fn()}
            rightPane={null}
            onOpenRightPane={vi.fn()}
            onOpenSearch={vi.fn()}
            onOpenCompare={vi.fn()}
            searchAvailable
            compareAvailable
            secondaryBlockedReason={null}
            compactScopeChip={null}
            onCompactScopeChipActivate={vi.fn()}
            overviewSlot={
              withSlot ? (
                <TargetTopicOverview
                  projectId={PROJECT_ID}
                  onCitationJump={onCitationJump}
                  // 与 TargetShell 同源：无活动会话 → null（动作 fail-closed 隐藏）。
                  editorHandle={conversation.sessionWired ? conversation.editor : null}
                  canExecute={conversation.canExecute}
                  blockedHint={conversation.blockedHint}
                  isAdminReadonly={role === 'admin_readonly'}
                  confirmedModelIsExternal={false}
                />
              ) : undefined
            }
          />
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

function renderHarness(
  options: { role?: 'owner' | 'admin_readonly'; withSlot?: boolean; sessionWired?: boolean } = {},
) {
  return render(<Harness {...options} />)
}

/** 断言 a 在 DOM 顺序上位于 b 之前。 */
function expectBefore(a: HTMLElement, b: HTMLElement): void {
  expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  h.capability = false
  h.overviewData = null
  h.enabledCalls = []
  h.refetch.mockReset()
  h.sources = [source()]
  onCitationJump = vi.fn<(sourceId: string, pageIdx: number | null) => void>()
  setDraftText = vi.fn<(text: string) => void>()
  resetGlobalModelStub()
})

afterEach(() => {
  cleanup()
})

describe('#1125：目标壳中央对话起始位置的主题概览入口', () => {
  it('能力位 false ⇒ 无入口（fail-closed），概览读面不发起', () => {
    h.capability = false
    renderHarness()

    expect(screen.queryByTestId('topic-overview-entry')).toBeNull()
    expect(screen.queryByTestId('topic-overview-dialog')).toBeNull()
    // LOW-2（round-1 审查）：Dialog 关闭时也会调用同一 mocked hook，`at(-1)`
    // 是同义反复；这里断言**全部**调用都关断（Entry 首个调用 + Dialog 的
    // closed query）——即真实概览读面从未以 enabled 运行。
    expect(h.enabledCalls.length).toBeGreaterThan(0)
    expect(h.enabledCalls.every((options) => options?.enabled === false)).toBe(true)
  })

  it('能力位 true ⇒ 入口位于标题区之下、消息区之上（中央对话起始位置），与正文列对齐', () => {
    h.capability = true
    renderHarness()

    const conversation = screen.getByTestId('rdlens-target-conversation')
    const header = screen.getByTestId('rdlens-target-conversation-header')
    const slot = screen.getByTestId('rdlens-target-overview-slot')
    const entry = screen.getByTestId('topic-overview-entry')
    const messageArea = screen.getByTestId('rdlens-target-message-area')

    expect(conversation).toContainElement(slot)
    expect(slot).toContainElement(entry)
    // 位置＝对话起始：标题区 → 入口 → 消息区（不覆盖、不拦截消息面）。
    expectBefore(header, slot)
    expectBefore(slot, messageArea)
    // 与正文列同最大宽度（850）居中，不引入第二套列宽。
    const aligned = slot.firstElementChild as HTMLElement
    expect(aligned.style.maxWidth).toBe('850px')
    // LOW-2：Entry 的读面调用是首个 hook 调用（Dialog 在 Entry 之后渲染），
    // 能力位 true 且非 Admin ⇒ 读面以 enabled 运行。
    expect(h.enabledCalls[0]).toEqual({ enabled: true })
  })

  it('点击入口打开既有主题概览 Dialog（复用 #1016 四段正文）', async () => {
    h.capability = true
    h.overviewData = readyOverview()
    renderHarness()

    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))

    expect(await screen.findByTestId('topic-overview-dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('topic-overview-sections')).toBeInTheDocument()
    expect(screen.getByTestId('topic-overview-section-findings')).toBeInTheDocument()
  })

  it('继续讨论 ⇒ 写入目标壳既有会话草稿并关闭 Dialog（用户可见草稿），不新增 wire', async () => {
    h.capability = true
    const overview = readyOverview()
    h.overviewData = overview
    renderHarness()

    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))
    fireEvent.click(await screen.findByTestId('topic-overview-discuss'))

    expect(setDraftText).toHaveBeenCalledTimes(1)
    expect(setDraftText).toHaveBeenCalledWith(
      topicOverviewDiscussionText(overview, LOCALIZED_DISCUSSION_GUIDE),
    )
    // MEDIUM-1（round-1 审查）：草稿写入后 Dialog 关闭，composer 可见。
    expect(screen.queryByTestId('topic-overview-dialog')).toBeNull()
  })

  it('无活动会话（sessionWired=false）⇒ 「继续讨论」fail-closed 隐藏（不是静默 no-op）', async () => {
    h.capability = true
    h.overviewData = readyOverview()
    renderHarness({ sessionWired: false })

    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))
    expect(await screen.findByTestId('topic-overview-sections')).toBeInTheDocument()
    expect(screen.queryByTestId('topic-overview-discuss')).toBeNull()
    expect(setDraftText).not.toHaveBeenCalled()
  })

  it('引用跳转 ⇒ 先关闭 Dialog 再调用目标壳既有跳转回调（右栏可见，HIGH-1）', async () => {
    h.capability = true
    h.overviewData = readyOverview()
    renderHarness()

    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))
    fireEvent.click(await screen.findByTestId('topic-overview-citation-jump-0'))

    expect(onCitationJump).toHaveBeenCalledWith('src_1', 2)
    // HIGH-1（round-1 审查）：modal Dialog 必须先关闭，否则目标壳右栏来源
    // 预览被 overlay 遮住、用户不可见；Dialog 自身的 onCitationJump 不关闭。
    expect(screen.queryByTestId('topic-overview-dialog')).toBeNull()
  })

  it('Admin 只读：能力位 true 也不渲染入口，且不发起概览读请求', () => {
    h.capability = true
    renderHarness({ role: 'admin_readonly' })

    expect(screen.queryByTestId('topic-overview-entry')).toBeNull()
    // LOW-2：Entry（首个调用）按工作区角色关断，Dialog closed query 亦关断。
    expect(h.enabledCalls.length).toBeGreaterThan(0)
    expect(h.enabledCalls.every((options) => options?.enabled === false)).toBe(true)
  })

  it('可选 overviewSlot：不传时对话列既有结构不变（无概览槽位）', () => {
    h.capability = true
    renderHarness({ withSlot: false })

    expect(screen.queryByTestId('rdlens-target-overview-slot')).toBeNull()
    expect(screen.queryByTestId('topic-overview-entry')).toBeNull()
    expect(screen.getByTestId('rdlens-target-conversation-header')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-message-area')).toBeInTheDocument()
  })
})
