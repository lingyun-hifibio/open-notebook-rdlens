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
import type { TopicOverviewWire } from '@/lib/research/topic-overview'
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
    // #1125 round-1：是否有活动会话（`sessionWired`）——决定「继续讨论」
    // 是否接线草稿；默认 false 保持既有 50 例的 composer 语义不变。
    sessionWired: false,
    // #1106：用途能力位/当前显式 purpose（用例可覆盖）
    purposeInferenceAvailable: false,
    workPurpose: null as 'document_qa' | 'exploration' | 'writing' | null,
    setWorkPurpose: vi.fn(),
    // W2 #1077：活动会话（citation 返回目标/宿主态）与消息面 turns。
    activeRef: null as {
      domain: 'research'
      kind: 'global'
      projectId: string
      sessionId: string
      sourceId: null
    } | null,
    turns: [] as unknown[],
  },
  // shell 传给 useTargetConversation 的 options（getPendingSelection 断言用）。
  lastOptions: null as Record<string, unknown> | null,
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

// W2 #1077：阅读器数据层/UI/能力位替身（被测边界 = shell 接线）：
// - useResearchD1e：readerReady（fail-closed 入口禁用）；
// - useSourceMedia：不 fetch，回放可控媒体状态并记录入参（pageIdx/wantPageImage）；
// - TargetReaderFocus：捕获 props（request/return/answer/选段）并用最小假控件
//   触发 shell 回调（真实 reader 形态由 reader-ui 自己的测试覆盖）。
const d1eFixture = vi.hoisted(() => ({ ready: false }))
// #1017（D1-H）：C05 compare 能力位替身。默认 false = legacy 路径（既有用例
// 语义不变）；需要 target 壳 C05 父层装配的用例显式置 true。
const c05CompareFixture = vi.hoisted(() => ({ compareReady: false }))

vi.mock('@/lib/hooks/use-research-c05', () => ({
  useResearchD1e: () => ({
    capability: d1eFixture.ready ? { contract: 'd1e-roundtrip-v1', enabled: true } : null,
    ready: d1eFixture.ready,
    loading: false,
  }),
  useResearchC05: () => ({
    caps: null,
    loading: false,
    dispatchReady: (entry: string) => entry === 'compare' && c05CompareFixture.compareReady,
    unavailableReason: () => '',
    supportsMode: () => false,
    previewSupported: false,
  }),
}))

const sourceMediaFixture = vi.hoisted(() => {
  const result = {
    detail: {
      source_id: 'src_ready',
      document_id: 'doc_ready',
      document_version: 'v1',
      status: 'ready',
      content_hash: null,
      synced_at: null,
      last_error: null,
      title: 'Paper A',
      source_type: 'pdf',
      file_available: true,
      markdown_chunks: [
        { chunk_id: 'chunk_0', page_idx: 0, markdown: 'page zero' },
        { chunk_id: 'chunk_2', page_idx: 2, markdown: 'page two' },
      ],
    },
    detailStatus: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    detailFailure: null,
    retryDetail: vi.fn(),
    versionState: { kind: 'match' as const },
    sourceType: 'pdf' as string | null,
    restricted: false,
    pages: [0, 2],
    pageImage: { status: 'idle' as const, url: null, failure: null },
    retryPageImage: vi.fn(),
    file: { status: 'idle' as const, failure: null },
    openFile: vi.fn(),
  }
  return {
    result,
    calls: [] as Array<Record<string, unknown>>,
  }
})

vi.mock('@/lib/hooks/use-source-media', () => ({
  useSourceMedia: (input: Record<string, unknown>) => {
    sourceMediaFixture.calls.push(input)
    return sourceMediaFixture.result
  },
}))

/** 假阅读器触发的「讨论选段」载荷（真实 Body 产物形状）。 */
const pendingSelectionFixture = {
  selection: {
    sourceId: 'src_ready',
    documentId: 'doc_ready',
    documentVersion: 'v1',
    chunkId: 'chunk_2',
    chunkOrdinal: 2,
    pageIdx: 2,
    startOffset: 0,
    endOffset: 6,
    quote: 'page two',
    quoteHash: 'quote_hash',
    contentHash: 'content_hash',
  },
  sourceId: 'src_ready',
  sourceTitle: 'Paper A',
  pageIdx: 2,
  chunkOrdinal: 2,
  target: 'global' as const,
}

const readerFocusFixture = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}))

vi.mock('@/components/research/target/TargetReaderFocus', () => ({
  TargetReaderFocus: (props: Record<string, unknown>) => {
    readerFocusFixture.props = props
    return (
      <div data-testid="rdlens-target-reader" role="dialog" aria-modal="true">
        <span data-testid="fake-reader-origin">
          {(props.request as { origin?: string }).origin ?? ''}
        </span>
        <span data-testid="fake-reader-source">
          {(props.request as { sourceId?: string }).sourceId ?? ''}
        </span>
        <span data-testid="fake-reader-message-id">
          {String((props.request as { messageId?: string | null }).messageId ?? '')}
        </span>
        <span data-testid="fake-reader-page-idx">{String(props.pageIdx ?? '')}</span>
        <span data-testid="fake-reader-answer">{String(props.answerContext ?? '')}</span>
        <span data-testid="fake-reader-return-available">{String(props.returnAvailable)}</span>
        <span data-testid="fake-reader-return-unavailable">
          {String(props.returnUnavailableNotice)}
        </span>
        <button type="button" data-testid="fake-reader-close" onClick={props.onClose as () => void} />
        <button
          type="button"
          data-testid="fake-reader-return"
          onClick={props.onReturnToAnswer as () => void}
        />
        <button
          type="button"
          data-testid="fake-reader-ask-source"
          onClick={props.onAskThisSource as () => void}
        />
        <button
          type="button"
          data-testid="fake-reader-open-file"
          onClick={props.onOpenFile as () => void}
        />
        <button
          type="button"
          data-testid="fake-reader-discuss"
          onClick={() =>
            (props.onDiscussSelection as (pending: unknown) => void)(pendingSelectionFixture)
          }
        />
      </div>
    )
  },
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

// #1125（owner 2026-11-09「选A」）：主题概览入口接线的替身。默认
// `capability=false` ⇒ 目标壳既有布局零变化，且不发起任何概览请求；
// 需要验证接线的用例显式打开能力位并给出就绪 wire。
const overviewFixture = vi.hoisted(() => ({
  capability: false,
  data: null as unknown,
}))

vi.mock('@/lib/hooks/use-research-topic-overview', () => ({
  topicOverviewGenerateMutationKey: (projectId: string) => [
    'research',
    projectId,
    'topic-overview',
    'generate',
  ],
  useResearchTopicOverviewCapability: () => overviewFixture.capability,
  useResearchTopicOverview: () => ({
    data: overviewFixture.data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useGenerateTopicOverview: () => ({
    data: null,
    isPending: false,
    reset: vi.fn(),
    mutateAsync: vi.fn(),
  }),
}))

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

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
  // #1017：target 壳的 C05 父层装配入口（既有 createCompare 保持 legacy 语义）
  createCompareDeclaredScope: vi.fn(),
}))

vi.mock('@/components/research/ResearchJobsProvider', () => ({
  ResearchJobsProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useResearchJobsController: () => jobsFixture,
}))

vi.mock('@/lib/embedded/shell', () => ({
  useRequestIngest: () => ingest,
}))

const chatPanelFixture = vi.hoisted(() => ({
  scrollToMessage: null as Record<string, unknown> | null,
}))

vi.mock('@/components/research/ResearchChatPanel', () => ({
  ResearchChatPanel: (props: {
    onCitationReturn?: (citation: Record<string, unknown>, messageId: string | null) => void
    onSelectionJump?: (selection: Record<string, unknown>) => void
    scrollToMessage?: Record<string, unknown> | null
    hideComposer?: boolean
    showSessionScopeBar?: boolean
    showCoverageScopeSelector?: boolean
    showSessionHeader?: boolean
    suppressColdStartLookup?: boolean
  }) => {
    chatPanelFixture.scrollToMessage = props.scrollToMessage ?? null
    return (
      <div
        data-testid="chat-panel"
        data-hide-composer={props.hideComposer === true ? 'true' : undefined}
        data-show-scope-bar={props.showSessionScopeBar === true ? 'true' : undefined}
        data-show-coverage={props.showCoverageScopeSelector === true ? 'true' : undefined}
        data-suppress-cold-start={props.suppressColdStartLookup === true ? 'true' : undefined}
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
        <button
          type="button"
          data-testid="simulate-citation-unresolved"
          onClick={() =>
            props.onCitationReturn?.(
              {
                citation_id: 2,
                claim: 'Unknown claim',
                doc_id: 'doc_missing',
                page_idx: null,
                doc_version: null,
              },
              'msg_2',
            )
          }
        />
        <button
          type="button"
          data-testid="simulate-citation-no-message"
          onClick={() =>
            props.onCitationReturn?.(
              {
                citation_id: 3,
                claim: 'Live claim',
                doc_id: 'doc_ready',
                page_idx: 2,
                doc_version: 'v1',
              },
              null,
            )
          }
        />
        <button
          type="button"
          data-testid="simulate-selection-jump"
          onClick={() =>
            props.onSelectionJump?.({
              sourceId: 'src_ready',
              documentId: 'doc_ready',
              documentVersion: 'v1',
              chunkId: 'chunk_2',
              chunkOrdinal: 2,
              pageIdx: 2,
              startOffset: 0,
              endOffset: 6,
              quote: 'page two',
              quoteHash: 'quote_hash',
              contentHash: 'content_hash',
              visibility: 'visible',
              reasonCode: 'ok',
            })
          }
        />
      </div>
    )
  },
}))

vi.mock('./use-target-conversation', async () => {
  const scopeModule = await vi.importActual<typeof import('@/lib/research/scope')>(
    '@/lib/research/scope',
  )
  return {
    useTargetConversation: (options: Record<string, unknown> = {}): TargetConversationState => {
      conversationFixture.lastOptions = options
      const sessions = conversationFixture.sessions
      // 空 selected 的阻断文案与真实 hook 同源（BEH-03）：从 provider 快照推导。
      const snapshot = scopeModule.useResearchScope().getSnapshot()
      const scopeEmpty =
        snapshot.mode === 'selected' &&
        snapshot.sourceIds.length === 0 &&
        snapshot.noteIds.length === 0
      // #1106/D5：与真实 hook 同源——显式 exploration/writing 或
      // inference 能力可用时的自动判断（null）放行空 selected。
      const purpose = conversationFixture.flags.workPurpose
      const purposeAllowsEmpty =
        purpose === 'exploration' ||
        purpose === 'writing' ||
        (purpose === null && conversationFixture.flags.purposeInferenceAvailable)
      return {
        sessionWired: conversationFixture.flags.sessionWired,
        runtimeAvailable: sessions !== null,
        sessions,
        activeRef: conversationFixture.flags.activeRef,
        turns: conversationFixture.flags.turns as TargetConversationState['turns'],
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
        scopeBlockedText:
          scopeEmpty && !purposeAllowsEmpty ? 'research.target.composer.scopeBlocked' : null,
        noActiveSession: conversationFixture.flags.noActiveSession,
        sendError: conversationFixture.flags.sendError,
        clearSendError: vi.fn(),
        canPinSingleSource: conversationFixture.flags.canPinSingleSource,
        workPurpose: conversationFixture.flags.workPurpose,
        setWorkPurpose: conversationFixture.flags.setWorkPurpose,
        purposeInferenceAvailable: conversationFixture.flags.purposeInferenceAvailable,
        send: conversationFixture.send,
        sendWithPurpose: vi.fn(async () => true),
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

/**
 * #1125：已就绪主题概览 wire（最小完整形状）。引用指向左栏 fixture 中
 * ready/v1 的 `doc_ready`，用于验证「引用跳转 → 右栏来源预览」的目标壳
 * 既有链路。
 */
function readyOverviewFixture(): TopicOverviewWire {
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
        doc_id: 'doc_ready',
        doc_version: 'v1',
        page_idx: 2,
        chunk_id: 'chunk_1',
        source_id: 'src_ready',
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
      // 空数组 ⇒ Entry 不做资料变化比较（不误报 added/retired）。
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
          document_id: 'doc_ready',
          document_version: 'v1',
          chunk_count: 2,
          source_id: 'src_ready',
        },
      ],
      degradations: [],
      degradation_reason: null,
      evidence_degraded: null,
      full_text_read: false,
    },
    model: { model_id: 'model_1', provider_id: 'p_local' },
    purpose: null,
    limitations: ['full_text_not_read'],
    warnings: [],
  }
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
  conversationFixture.flags.purposeInferenceAvailable = false
  conversationFixture.flags.workPurpose = null
  conversationFixture.flags.sessionWired = false
  conversationFixture.flags.activeRef = null
  conversationFixture.flags.turns = []
  conversationFixture.lastOptions = null
  d1eFixture.ready = false
  sourceMediaFixture.calls.length = 0
  sourceMediaFixture.result.detailStatus = 'ready'
  sourceMediaFixture.result.versionState = { kind: 'match' }
  sourceMediaFixture.result.sourceType = 'pdf'
  sourceMediaFixture.result.pageImage = { status: 'idle', url: null, failure: null }
  readerFocusFixture.props = null
  chatPanelFixture.scrollToMessage = null
  conversationFixture.flags.setWorkPurpose.mockClear()
  conversationFixture.send.mockClear()
  conversationFixture.openSession.mockClear()
  conversationFixture.newSession.mockClear()
  conversationFixture.pinSingleSource.mockClear()
  conversationFixture.pinSingleSource.mockReturnValue(true)
  conversationFixture.editor.setDraftText.mockClear()
  overviewFixture.capability = false
  overviewFixture.data = null
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
    // A11Y-03：面板未渲染时不输出 aria-controls（不悬空）
    expect(tasks).not.toHaveAttribute('aria-controls')

    fireEvent.click(tasks)
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute('data-pane-kind', 'tasks'),
    )
    expect(screen.getByTestId('rdlens-target-tasks-trigger')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('rdlens-target-tasks-trigger')).toHaveAttribute(
      'aria-controls',
      'rdlens-target-right-pane',
    )
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
    // W2 #1077：能力位未就绪（fail-closed）→ 独立禁用原因（不再是 W1 的
    // openOriginalUnavailable 通用文案）。
    expect(screen.getByTestId('rdlens-target-open-original')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-open-original-reason')).toHaveTextContent(
      'research.target.reader.capabilityUnavailable',
    )
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

  it('#1017 capability true + all：target 壳按 C05 声明范围派发（不再被 legacy 空选阻断）', async () => {
    c05CompareFixture.compareReady = true
    jobsFixture.createCompareDeclaredScope.mockClear()
    jobsFixture.createCompare.mockClear()
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-secondary-compare'))
    const createButton = await screen.findByTestId('compare-create')
    await waitFor(() => expect(createButton).not.toBeDisabled())
    expect(screen.queryByTestId('compare-entire-project')).toBeNull()
    fireEvent.click(createButton)

    await waitFor(() => expect(jobsFixture.createCompareDeclaredScope).toHaveBeenCalledTimes(1))
    // 父层按 scope provider 快照装配：all → 空 source 集合，模型沿用 confirmed 快照
    expect(jobsFixture.createCompareDeclaredScope).toHaveBeenCalledWith(
      { mode: 'all', sourceIds: [] },
      'model_1',
      undefined,
    )
    expect(jobsFixture.createCompare).not.toHaveBeenCalled()
    c05CompareFixture.compareReady = false
  })

  it('#1017 capability false + all：target 壳保持 legacy 阻断（不发 C05）', async () => {
    c05CompareFixture.compareReady = false
    jobsFixture.createCompareDeclaredScope.mockClear()
    jobsFixture.createCompare.mockClear()
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-secondary-compare'))
    expect(await screen.findByTestId('compare-entire-project')).toBeInTheDocument()
    expect(screen.getByTestId('compare-create')).toBeDisabled()
    expect(jobsFixture.createCompareDeclaredScope).not.toHaveBeenCalled()
    expect(jobsFixture.createCompare).not.toHaveBeenCalled()
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

  it('打开资料预览（UI-17）显示版本/状态；能力位未就绪时「打开原文」禁用并显示独立原因', async () => {
    renderShell()
    fireEvent.click(screen.getAllByTestId('rdlens-target-source-open')[0])
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute('data-pane-kind', 'source'),
    )
    expect(screen.getByTestId('rdlens-target-source-preview-name')).toHaveTextContent('doc_ready')
    expect(screen.getByTestId('rdlens-target-source-open-original')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-source-open-original-reason')).toHaveTextContent(
      'research.target.reader.capabilityUnavailable',
    )
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

describe('审查 B 附条件修复（I18N/数量/说明/搜索档位/内边距）', () => {
  it('UI-04：资料列表显示数量，过滤时显示 visible/total', () => {
    renderShell()
    const count = screen.getByTestId('rdlens-target-sources-count')
    expect(count).toHaveAttribute('data-total', '4')
    expect(count).toHaveAttribute('data-visible', '4')
    expect(count).toHaveTextContent('research.target.sources.count')
    fireEvent.change(screen.getByTestId('rdlens-target-sources-search'), {
      target: { value: 'doc_ready' },
    })
    expect(count).toHaveAttribute('data-visible', '1')
    expect(count).toHaveAttribute('data-total', '4')
    expect(count).toHaveTextContent('research.target.sources.countFiltered')
  })

  it('UI-07：标题区有一句说明（muted，i18n）', () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-conversation-description')).toHaveTextContent(
      'research.target.conversation.description',
    )
  })

  it('笔记区入口（选用笔记继续讨论）常显标题/提示 + 空态', () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-notes-title')).toBeInTheDocument()
    expect(screen.getByTestId('rdlens-target-notes-entry-hint')).toBeInTheDocument()
  })

  it('证据搜索：隐藏可编辑档位但显示本次检索级别只读摘要（不静默）', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-secondary-search'))
    const summary = await screen.findByTestId('search-context-summary')
    expect(summary).toHaveAttribute('data-context-level')
    expect(summary).toHaveTextContent('research.target.secondary.searchLevel')
    // 可编辑档位控件在目标壳不渲染
    expect(screen.queryByTestId('search-context-selector')).toBeNull()
  })

  it('F10：资料栏/右栏滚动容器留 ≥6px 焦点环空间', async () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-sources-list').className).toContain('py-[6px]')
    fireEvent.click(screen.getByTestId('rdlens-target-tasks-trigger'))
    const body = await screen.findByTestId('rdlens-target-right-pane-body')
    expect(body.className).toContain('p-[6px]')
  })
})

describe('第 2 轮重审修复（N3 notes-only / N4 正文对齐）', () => {
  it('N3：notes-only 项目（sources 为空、notes 非空）仍渲染笔记区并可选择', () => {
    const hoisted = fixtureRows as { sources: unknown[] }
    const original = hoisted.sources
    hoisted.sources = []
    try {
      renderShell()
      expect(screen.getByTestId('rdlens-target-notes-title')).toBeInTheDocument()
      const checkbox = screen.getByTestId('rdlens-target-note-select-note_1')
      fireEvent.click(checkbox)
      expect(screen.getByTestId('scope-probe-mode')).toHaveTextContent('selected')
      expect(screen.getByTestId('scope-probe-note-count')).toHaveTextContent('1')
      expect(screen.getByTestId('rdlens-target-scope-summary')).toHaveTextContent(
        'research.scopeSummary.noteOne',
      )
    } finally {
      hoisted.sources = original
    }
  })

  it('N4：正文列与 header/composer 使用同一 clamp padding + 850 内宽', () => {
    renderShell()
    const padded = screen.getByTestId('rdlens-target-message-area-padded')
    expect(padded.getAttribute('style') ?? '').toContain('clamp(28px, 5vw, 84px)')
    const inner = screen.getByTestId('rdlens-target-message-area')
    expect(inner.getAttribute('style') ?? '').toContain('850px')
    // header 的内宽容器同样是 850（左缘与正文一致）
    const header = screen.getByTestId('rdlens-target-conversation-header')
    const innerHeader = header.firstElementChild as HTMLElement | null
    expect(innerHeader?.getAttribute('style') ?? '').toContain('850px')
  })
})

describe('真实 harness 发送缺陷回归（冷启动查回阻断发送）', () => {
  it('目标壳把 suppressColdStartLookup 传给消息面（外部 composer 草稿不查回）', () => {
    renderShell()
    expect(screen.getByTestId('chat-panel')).toHaveAttribute(
      'data-suppress-cold-start',
      'true',
    )
  })
})

// W1 #1106 PR-B（UI-11 / D5 / D6）：composer「本次用途」与空 selected 放行。
describe('#1106 本次用途（UI-11）', () => {
  it('能力可用：摘要+展开三选，选择回传显式 purpose', () => {
    conversationFixture.flags.purposeInferenceAvailable = true
    renderShell()
    const container = screen.getByTestId('rdlens-target-purpose')
    expect(container).toHaveAttribute('data-purpose-inference', 'true')
    expect(container).toHaveAttribute('data-purpose', 'auto')
    fireEvent.click(screen.getByTestId('rdlens-target-purpose-toggle'))
    for (const id of ['auto', 'document_qa', 'exploration', 'writing']) {
      expect(screen.getByTestId(`rdlens-target-purpose-option-${id}`)).toBeInTheDocument()
    }
    // 写作诚实标注 W3（不主张写作产物）
    expect(screen.getByTestId('rdlens-target-purpose-writing-hint')).toHaveTextContent(
      'research.target.composer.purpose.writingHint',
    )
    fireEvent.click(screen.getByTestId('rdlens-target-purpose-option-exploration'))
    expect(conversationFixture.flags.setWorkPurpose).toHaveBeenCalledWith('exploration')
  })

  it('能力关闭：显示「默认（资料问答）」静态摘要，不显示假控件/空 selected 纠正动作', () => {
    renderShell()
    expect(screen.getByTestId('rdlens-target-purpose')).toHaveAttribute(
      'data-purpose-inference',
      'false',
    )
    expect(screen.getByTestId('rdlens-target-purpose-default')).toHaveTextContent(
      'research.target.composer.purpose.defaultSummary',
    )
    expect(screen.queryByTestId('rdlens-target-purpose-toggle')).toBeNull()
    // 空 selected：仅原有两个动作，不渲染 exploration/writing
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    expect(screen.queryByTestId('rdlens-target-scope-blocked-exploration')).toBeNull()
  })

  it('D5：空 selected + 自动判断 + inference on → 可发送（交服务端推断），并提供改为探索讨论动作', () => {
    conversationFixture.flags.purposeInferenceAvailable = true
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('0')
    // 空 selected 的说明仍可见（BEH-03），但 composer 不再被本地阻断。
    expect(screen.getByTestId('rdlens-target-scope-blocked')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '我们讨论一个假设' } })
    expect(screen.getByTestId('chat-send')).not.toBeDisabled()
    expect(screen.queryByTestId('research-draft-gate-hint')).toBeNull()
    // 「改为探索讨论」显式动作（不静默换目的）：设置为显式 exploration。
    fireEvent.click(screen.getByTestId('rdlens-target-scope-blocked-exploration'))
    expect(conversationFixture.flags.setWorkPurpose).toHaveBeenCalledWith('exploration')
  })

  it('D5：空 selected + inference off → 保持现行本地阻断（不静默放行）', () => {
    renderShell()
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题' } })
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent(
      'research.target.composer.scopeBlocked',
    )
  })

  it('显式 exploration 作用下一请求：摘要与空 selected 放行同步（D5/D7）', () => {
    conversationFixture.flags.purposeInferenceAvailable = true
    conversationFixture.flags.workPurpose = 'exploration'
    renderShell()
    expect(screen.getByTestId('rdlens-target-purpose')).toHaveAttribute(
      'data-purpose',
      'exploration',
    )
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.click(screen.getByTestId('rdlens-target-source-select-src_ready'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '讨论' } })
    expect(screen.getByTestId('chat-send')).not.toBeDisabled()
  })
})

// #1125（owner 2026-11-09「选A」，defect 修复）：#1016 主题概览此前只在
// legacy 壳挂载，默认目标壳（/research 非 legacy）无入口 → UI 规格 v1
// BEH-12/§5.4/D-UI-04=A 在默认路径不可达。以下断言目标壳真实接线：
// 入口位于中央对话起始位置；Dialog 复用既有语义；引用跳转先关闭 Dialog
// 再打开右栏来源预览（HIGH-1：跳转对用户真实可见）；继续讨论写当前会话
// 草稿并关闭 Dialog，无活动会话时 fail-closed 隐藏（MEDIUM-1）；次级视图
// 不渲染入口（LOW-1）。
describe('#1125：主题概览入口接入默认目标壳（中央对话起始位置）', () => {
  it('能力位 true：入口在对话起始；引用跳转关闭 Dialog 后右栏来源预览可见（HIGH-1）', async () => {
    overviewFixture.capability = true
    overviewFixture.data = readyOverviewFixture()
    renderShell()

    const conversation = screen.getByTestId('rdlens-target-conversation')
    const slot = screen.getByTestId('rdlens-target-overview-slot')
    const entry = screen.getByTestId('topic-overview-entry')
    const messageArea = screen.getByTestId('rdlens-target-message-area')
    // 起始位置：标题区之下、消息区之上（不覆盖/不拦截消息面）。
    expect(conversation).toContainElement(slot)
    expect(slot).toContainElement(entry)
    expect(
      entry.compareDocumentPosition(messageArea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    // 已有概览 ⇒ 入口按钮为「查看」；点击打开既有 Dialog（四段正文）。
    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))
    expect(await screen.findByTestId('topic-overview-dialog')).toBeInTheDocument()
    expect(await screen.findByTestId('topic-overview-sections')).toBeInTheDocument()

    // HIGH-1（round-1 审查）：概览 Dialog 是 Radix modal（overlay z-50），
    // 目标壳右栏无 z-index；不关 Dialog 则右栏来源预览被遮住、用户不可见。
    // 断言 Dialog 消失 + 右栏 source 预览真实打开（用户可见/可交互）。
    fireEvent.click(await screen.findByTestId('topic-overview-citation-jump-0'))
    await waitFor(() => expect(screen.queryByTestId('topic-overview-dialog')).toBeNull())
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute(
        'data-pane-kind',
        'source',
      ),
    )
    expect(screen.getByTestId('rdlens-target-source-preview-name')).toHaveTextContent('doc_ready')
  })

  it('MEDIUM-1：有活动会话时「继续讨论」写草稿并关闭 Dialog（草稿用户可见）', async () => {
    overviewFixture.capability = true
    overviewFixture.data = readyOverviewFixture()
    // 真实语义：有活动会话才传 editor（shell 侧 fail-closed）。
    conversationFixture.flags.sessionWired = true
    renderShell()

    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))
    expect(await screen.findByTestId('topic-overview-sections')).toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('topic-overview-discuss'))

    // 写目标壳当前会话既有草稿（shell 传入 conversation.editor）。
    expect(conversationFixture.editor.setDraftText).toHaveBeenCalledTimes(1)
    // 写入后 Dialog 关闭：composer 在中央列底部可见（不是静默/被遮挡）。
    await waitFor(() => expect(screen.queryByTestId('topic-overview-dialog')).toBeNull())
  })

  it('MEDIUM-1：无活动会话（sessionWired=false）⇒「继续讨论」fail-closed 隐藏', async () => {
    overviewFixture.capability = true
    overviewFixture.data = readyOverviewFixture()
    // 默认 sessionWired=false：与真实 useTargetConversation 无活动会话同源。
    renderShell()

    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))
    expect(await screen.findByTestId('topic-overview-sections')).toBeInTheDocument()
    expect(screen.queryByTestId('topic-overview-discuss')).toBeNull()
    expect(conversationFixture.editor.setDraftText).not.toHaveBeenCalled()
  })

  it('LOW-1：次级视图不渲染概览入口（仅对话中心视图注入 slot），返回后恢复', async () => {
    overviewFixture.capability = true
    overviewFixture.data = readyOverviewFixture()
    renderShell()
    expect(screen.getByTestId('topic-overview-entry')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('rdlens-target-secondary-search'))
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-secondary-evidence-search')).toBeInTheDocument(),
    )
    // 次级视图：对话列 hidden 且概览入口**未挂载**（不残留 hidden 入口）。
    expect(screen.queryByTestId('rdlens-target-overview-slot')).toBeNull()
    expect(screen.queryByTestId('topic-overview-entry')).toBeNull()

    fireEvent.click(screen.getByTestId('rdlens-target-secondary-back'))
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-secondary-panel')).toBeNull())
    expect(await screen.findByTestId('topic-overview-entry')).toBeInTheDocument()
  })

  it('能力位 false（默认）：目标壳零变化，无概览入口/Dialog', () => {
    renderShell()
    expect(screen.queryByTestId('topic-overview-entry')).toBeNull()
    expect(screen.queryByTestId('topic-overview-dialog')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// W2 #1077：宽屏阅读器接线（DESIGN「reader-shell 接线契约」）。
// 真实 reader 形态/焦点陷阱由 reader-ui 测试覆盖；这里只验证 shell 的
// 入口启用与独立禁用原因、请求透传、返回原回答、选段 chip/发送、inert/焦点。
// ─────────────────────────────────────────────────────────────────────────────
const ACTIVE_GLOBAL_REF = {
  domain: 'research' as const,
  kind: 'global' as const,
  projectId: 'proj_1',
  sessionId: 'sess_1',
  sourceId: null,
}

async function openCitationReader(): Promise<void> {
  fireEvent.click(screen.getByTestId('simulate-citation'))
  const pane = await screen.findByTestId('rdlens-target-right-pane')
  expect(pane).toHaveAttribute('data-pane-kind', 'citation')
  fireEvent.click(screen.getByTestId('rdlens-target-open-original'))
  await screen.findByTestId('rdlens-target-reader')
}

describe('W2 #1077 阅读器入口（引用预览/资料预览「打开原文」）', () => {
  it('D1-E 能力未就绪：引用与资料入口均禁用，原因=capabilityUnavailable（fail-closed）', async () => {
    renderShell()
    fireEvent.click(screen.getByTestId('simulate-citation'))
    await screen.findByTestId('rdlens-target-right-pane')
    expect(screen.getByTestId('rdlens-target-open-original')).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-open-original-reason')).toHaveTextContent(
      'research.target.reader.capabilityUnavailable',
    )

    fireEvent.click(screen.getAllByTestId('rdlens-target-source-open')[0])
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute(
        'data-pane-kind',
        'source',
      ),
    )
    expect(screen.getByTestId('rdlens-target-source-open-original')).toBeDisabled()
    expect(
      screen.getByTestId('rdlens-target-source-open-original-reason'),
    ).toHaveTextContent('research.target.reader.capabilityUnavailable')
  })

  it('引用无法解析到来源：独立禁用原因 citationUnavailable（优先于能力位）', async () => {
    d1eFixture.ready = true
    renderShell()
    fireEvent.click(screen.getByTestId('simulate-citation-unresolved'))
    await screen.findByTestId('rdlens-target-right-pane')
    const button = screen.getByTestId('rdlens-target-open-original')
    expect(button).toBeDisabled()
    expect(screen.getByTestId('rdlens-target-open-original-reason')).toHaveTextContent(
      'research.target.reader.citationUnavailable',
    )
    // 未打开阅读器（不伪造原文）。
    expect(screen.queryByTestId('rdlens-target-reader')).toBeNull()
  })

  it('citation 入口：请求携带 citation page_idx/messageId 与解析后的来源；aside 回答上下文绑定 durable message', async () => {
    d1eFixture.ready = true
    conversationFixture.flags.activeRef = ACTIVE_GLOBAL_REF
    conversationFixture.flags.turns = [
      {
        id: 'turn_1',
        role: 'assistant',
        content: 'Durable answer body',
        serverMessageId: 'msg_1',
        citations: [],
      },
    ]
    renderShell()
    await openCitationReader()

    expect(readerFocusFixture.props?.request).toMatchObject({
      origin: 'citation',
      sourceId: 'src_ready',
      messageId: 'msg_1',
      initialPageIdx: 2,
    })
    expect(
      (readerFocusFixture.props?.request as { citation: { doc_id: string } }).citation.doc_id,
    ).toBe('doc_ready')
    expect(screen.getByTestId('fake-reader-answer')).toHaveTextContent('Durable answer body')
    // 初始页 = citation.page_idx（版本一致且属于可定位页集合）；页图按当前页单页请求。
    await waitFor(() => expect(screen.getByTestId('fake-reader-page-idx')).toHaveTextContent('2'))
    const lastMediaCall = sourceMediaFixture.calls[sourceMediaFixture.calls.length - 1]
    expect(lastMediaCall.pageIdx).toBe(2)
    expect(lastMediaCall.wantPageImage).toBe(true)
    // 右栏保持挂载（overlay 不销毁工作台）。
    expect(screen.getByTestId('rdlens-target-right-pane')).toBeInTheDocument()
  })

  it('引用跳转保留 page_idx：资料预览语义打开，再进 reader 时作为 initial_page_idx（§2.3-3）', async () => {
    d1eFixture.ready = true
    overviewFixture.capability = true
    overviewFixture.data = readyOverviewFixture()
    renderShell()
    fireEvent.click(screen.getByTestId('topic-overview-entry-open'))
    fireEvent.click(await screen.findByTestId('topic-overview-citation-jump-0'))
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute(
        'data-pane-kind',
        'source',
      ),
    )
    // 跳转页 = overview citation page_idx(2) 作为资料预览的初始页提示。
    fireEvent.click(screen.getByTestId('rdlens-target-source-open-original'))
    await screen.findByTestId('rdlens-target-reader')
    expect(readerFocusFixture.props?.request).toMatchObject({
      origin: 'source',
      sourceId: 'src_ready',
      initialPageIdx: 2,
    })
    await waitFor(() => expect(screen.getByTestId('fake-reader-page-idx')).toHaveTextContent('2'))
  })

  it('资料预览入口：source 请求按最新版（无 citation/messageId），初始页=可定位页集合首页', async () => {
    d1eFixture.ready = true
    renderShell()
    fireEvent.click(screen.getAllByTestId('rdlens-target-source-open')[0])
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-right-pane')).toHaveAttribute(
        'data-pane-kind',
        'source',
      ),
    )
    fireEvent.click(screen.getByTestId('rdlens-target-source-open-original'))
    await screen.findByTestId('rdlens-target-reader')
    expect(readerFocusFixture.props?.request).toMatchObject({
      origin: 'source',
      sourceId: 'src_ready',
      citation: null,
      messageId: null,
      documentRef: null,
    })
    await waitFor(() => expect(screen.getByTestId('fake-reader-page-idx')).toHaveTextContent('0'))
  })

  it('user turn 选段 chip（onSelectionJump）→ source 阅读器并定位选段页', async () => {
    d1eFixture.ready = true
    renderShell()
    fireEvent.click(screen.getByTestId('simulate-selection-jump'))
    await screen.findByTestId('rdlens-target-reader')
    expect(readerFocusFixture.props?.request).toMatchObject({
      origin: 'source',
      sourceId: 'src_ready',
      initialPageIdx: 2,
    })
    await waitFor(() => expect(screen.getByTestId('fake-reader-page-idx')).toHaveTextContent('2'))
  })
})

describe('W2 #1077 阅读器内「只问此来源」', () => {
  it('调用既有 single-pin 能力（BEH-02）并关闭阅读器/右栏，不制造未绑定 pin', async () => {
    d1eFixture.ready = true
    conversationFixture.flags.activeRef = ACTIVE_GLOBAL_REF
    conversationFixture.flags.canPinSingleSource = true
    renderShell()
    await openCitationReader()
    fireEvent.click(screen.getByTestId('fake-reader-ask-source'))
    expect(conversationFixture.pinSingleSource).toHaveBeenCalledWith('src_ready')
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-reader')).toBeNull())
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
  })
})

describe('W2 #1077 返回原回答', () => {
  it('navigate：关闭阅读器与右栏，并向对话下发 durable message 滚动请求', async () => {
    d1eFixture.ready = true
    conversationFixture.flags.activeRef = ACTIVE_GLOBAL_REF
    renderShell()
    await openCitationReader()
    // citation 点击即记录返回目标（sessionStorage + localStorage）。
    const keys = Object.keys(window.localStorage)
    expect(keys.some((key) => key.includes('rdlens.research.return-target.v1'))).toBe(true)
    expect(screen.getByTestId('fake-reader-return-available')).toHaveTextContent('true')

    fireEvent.click(screen.getByTestId('fake-reader-return'))
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-reader')).toBeNull())
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
    expect(chatPanelFixture.scrollToMessage).toMatchObject({
      sessionId: 'sess_1',
      messageId: 'msg_1',
    })
  })

  it('navigate：不把焦点送回 citation 触发控件（focus 滚动不得拉走目标回答）', async () => {
    d1eFixture.ready = true
    conversationFixture.flags.activeRef = ACTIVE_GLOBAL_REF
    renderShell()
    await openCitationReader()
    const citationTrigger = document.querySelector(
      '[data-testid="simulate-citation"]',
    ) as HTMLElement
    expect(citationTrigger).not.toBeNull()
    fireEvent.click(screen.getByTestId('fake-reader-return'))
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-reader')).toBeNull())
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-right-pane')).toBeNull())
    // 返回原回答的滚动定位由 scrollToMessage 负责；右栏关闭不得再把焦点
    // （及其浏览器 focus 滚动）送回 citation 触发控件。
    expect(document.activeElement).not.toBe(citationTrigger)
  })

  it('live citation 无 durable message_id：不记录返回目标、不显示返回入口', async () => {
    d1eFixture.ready = true
    conversationFixture.flags.activeRef = ACTIVE_GLOBAL_REF
    renderShell()
    fireEvent.click(screen.getByTestId('simulate-citation-no-message'))
    await screen.findByTestId('rdlens-target-right-pane')
    fireEvent.click(screen.getByTestId('rdlens-target-open-original'))
    await screen.findByTestId('rdlens-target-reader')
    expect(screen.getByTestId('fake-reader-return-available')).toHaveTextContent('false')
  })

  it('position_unavailable：目标不可用时只显示不可用提示（不跳最新、不关阅读器）', async () => {
    d1eFixture.ready = true
    // 无活动会话 ⇒ citation 点击无法记录返回目标。
    renderShell()
    await openCitationReader()
    expect(screen.getByTestId('fake-reader-return-available')).toHaveTextContent('false')
    fireEvent.click(screen.getByTestId('fake-reader-return'))
    await waitFor(() =>
      expect(screen.getByTestId('fake-reader-return-unavailable')).toHaveTextContent('true'),
    )
    expect(screen.getByTestId('rdlens-target-reader')).toBeInTheDocument()
    expect(chatPanelFixture.scrollToMessage).toBeNull()
  })
})

describe('W2 #1077 选段 → composer chip / selection_context', () => {
  it('讨论选段：关闭阅读器，composer 显示选段 chip，pending 供 hook 读取', async () => {
    d1eFixture.ready = true
    conversationFixture.flags.activeRef = ACTIVE_GLOBAL_REF
    renderShell()
    await openCitationReader()
    fireEvent.click(screen.getByTestId('fake-reader-discuss'))
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-reader')).toBeNull())

    const chip = screen.getByTestId('rdlens-target-selection-chip')
    expect(chip).toHaveTextContent('research.selection.chip')
    expect(screen.getByTitle('page two')).toBeInTheDocument()
    // 选段不改范围（provider 仍是 all）。
    expect(screen.getByTestId('scope-probe-mode')).toHaveTextContent('all')
    expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('0')

    const options = conversationFixture.lastOptions as {
      getPendingSelection?: () => unknown
    }
    expect(options.getPendingSelection?.()).toMatchObject({
      target: 'global',
      sourceId: 'src_ready',
      selection: { sourceId: 'src_ready', chunkId: 'chunk_2', pageIdx: 2 },
    })
  })

  it('移除 chip：pending 清空（后续请求不再携带 selection_context）', async () => {
    d1eFixture.ready = true
    conversationFixture.flags.activeRef = ACTIVE_GLOBAL_REF
    renderShell()
    await openCitationReader()
    fireEvent.click(screen.getByTestId('fake-reader-discuss'))
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-reader')).toBeNull())
    expect(screen.getByTestId('rdlens-target-selection-chip')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('rdlens-target-selection-chip-remove'))
    await waitFor(() =>
      expect(screen.queryByTestId('rdlens-target-selection-chip')).toBeNull(),
    )
    const options = conversationFixture.lastOptions as {
      getPendingSelection?: () => unknown
    }
    expect(options.getPendingSelection?.()).toBeNull()
  })

  it('发送成功：清空选段 chip；实际发送文本与范围不变', async () => {
    d1eFixture.ready = true
    conversationFixture.flags.activeRef = ACTIVE_GLOBAL_REF
    renderShell()
    await openCitationReader()
    fireEvent.click(screen.getByTestId('fake-reader-discuss'))
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-reader')).toBeNull())

    const textarea = screen.getByTestId('chat-input')
    fireEvent.change(textarea, { target: { value: 'Question' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(conversationFixture.send).toHaveBeenCalledWith('Question'))
    // 发送经 shell 包装：成功后清空 pending chip。
    await waitFor(() =>
      expect(screen.queryByTestId('rdlens-target-selection-chip')).toBeNull(),
    )
    expect(screen.getByTestId('scope-probe-mode')).toHaveTextContent('all')
    expect(screen.getByTestId('scope-probe-source-count')).toHaveTextContent('0')
  })
})

describe('W2 #1077 overlay 保活 / inert / 焦点', () => {
  it('打开阅读器：工作台 inert+aria-hidden 且对话/右栏/草稿保持；关闭后移除并回焦触发控件', async () => {
    d1eFixture.ready = true
    renderShell()
    const draft = screen.getByTestId('chat-input')
    fireEvent.change(draft, { target: { value: 'Draft stays' } })

    fireEvent.click(screen.getByTestId('simulate-citation'))
    await screen.findByTestId('rdlens-target-right-pane')
    const openOriginal = screen.getByTestId('rdlens-target-open-original')
    openOriginal.focus()
    fireEvent.click(openOriginal)
    await screen.findByTestId('rdlens-target-reader')

    const content = screen.getByTestId('rdlens-target-shell-content')
    expect(content).toHaveAttribute('inert')
    expect(content).toHaveAttribute('aria-hidden', 'true')
    // 工作台不卸载：右栏、对话与草稿仍在。
    expect(screen.getByTestId('rdlens-target-right-pane')).toBeInTheDocument()
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toHaveValue('Draft stays')

    fireEvent.click(screen.getByTestId('fake-reader-close'))
    await waitFor(() => expect(screen.queryByTestId('rdlens-target-reader')).toBeNull())
    expect(content).not.toHaveAttribute('inert')
    expect(content).not.toHaveAttribute('aria-hidden')
    expect(screen.getByTestId('chat-input')).toHaveValue('Draft stays')
    // 焦点回触发控件（「打开原文」按钮）。
    await waitFor(() => expect(document.activeElement).toBe(openOriginal))
  })
})
