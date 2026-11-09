import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, useResearchScope } from '@/lib/research/scope'
import { useTargetConversation } from './use-target-conversation'
import { TargetShell } from './TargetShell'
import type { ResearchSessionRef } from '@/lib/research/session-contract'

// F6（审查第 1 轮 HIGH）：目标壳最核心的 send/restore/scope 接线 hook 级测试。
// 只 mock 传输/数据层（session runtime、editor、chat controller、sessions、模型、
// sources），保留真实 hook 逻辑与真实 ScopeProvider，以覆盖 F1/F2/F3/F5/F12。

const SESSION_REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: 'proj_1',
  sessionId: 'sess_1',
  sourceId: null,
}
const SESSION_REF_2: ResearchSessionRef = { ...SESSION_REF, sessionId: 'sess_2' }

interface SessionCapabilitiesFixture {
  contract: string
  editorReady: boolean
  submissionReady: { global: boolean; source: boolean }
  degraded: boolean
  reason: null
}

const runtimeFixture = vi.hoisted(() => {
  const snapshot: {
    phase: 'booting' | 'masked' | 'ready' | 'error'
    projectId: string
    viewerUserId: string
    role: string
    authGeneration: number
    capabilities: SessionCapabilitiesFixture | null
  } = {
    phase: 'ready',
    projectId: 'proj_1',
    viewerUserId: '7',
    role: 'owner',
    authGeneration: 1,
    capabilities: {
      contract: 'research-session-v1',
      editorReady: true,
      submissionReady: { global: true, source: true },
      degraded: false,
      reason: null,
    },
  }
  const runtime = {
    getSnapshot: () => snapshot,
    subscribe: vi.fn(() => () => {}),
    activate: vi.fn(() => true),
    setDisplayPointer: vi.fn(),
    cacheScope: vi.fn(() => 'viewer:7'),
    cacheAuthority: vi.fn(() => 'gen:1'),
  }
  return { snapshot, runtime }
})

const displayFixture = vi.hoisted(() => ({
  display: null as null | { surface: 'global'; ref: ResearchSessionRef | null },
  globalPointer: null as null | { ref: ResearchSessionRef },
}))

const editorFixture = vi.hoisted(() => {
  const ref: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: 'proj_1',
    sessionId: 'sess_1',
    sourceId: null,
  }
  const snapshot = {
    ref,
    phase: 'ready',
    loading: false,
    revision: 3,
    intentHash: 'hash',
    draftText: 'Question',
    draftToken: 'tok_1',
    consumedToken: null,
    baseScope: { mode: 'all' as 'all' | 'selected', sourceIds: [] as string[], singleSourceId: null },
    singleSourceId: null as string | null,
    noteIds: [] as string[],
    chatAnchor: null,
    readerAnchor: null,
    dirty: false,
    saving: false,
    readOnly: false,
    blocked: false,
    unreadable: false,
    warnings: [],
    conflict: null,
    saveFailure: null,
    unsynced: false,
    localVersion: 1,
    confirmedLocalVersion: 1,
    writerId: 'w1',
    lastSavedAt: null,
    pendingMutations: 0,
    restoreCandidates: [],
    holds: [],
    transportAvailable: true,
    positionUnavailable: false,
    invalidated: false,
  }
  const applyEdit = (edit: Record<string, unknown>): void => {
    if (edit.mode === 'all') {
      snapshot.baseScope = { mode: 'all', sourceIds: [], singleSourceId: null }
      snapshot.singleSourceId = null
    } else if (edit.mode === 'selected') {
      snapshot.baseScope = {
        mode: 'selected',
        sourceIds: [...(edit.sourceIds as string[])],
        singleSourceId: null,
      }
      snapshot.singleSourceId = null
      if (Array.isArray(edit.noteIds)) snapshot.noteIds = [...(edit.noteIds as string[])]
    } else if (edit.mode === 'single') {
      snapshot.singleSourceId = (edit.sourceId as string | null) ?? null
    } else if (edit.mode === 'note') {
      snapshot.noteIds = [...(edit.noteIds as string[])]
    }
  }
  return {
    snapshot,
    reset(): void {
      snapshot.phase = 'ready'
      snapshot.loading = false
      snapshot.draftText = 'Question'
      snapshot.draftToken = 'tok_1'
      snapshot.baseScope = { mode: 'all', sourceIds: [], singleSourceId: null }
      snapshot.singleSourceId = null
      snapshot.noteIds = []
      snapshot.readOnly = false
      snapshot.invalidated = false
    },
    setScope: vi.fn((edit: Record<string, unknown>) => applyEdit(edit)),
    setDraftText: vi.fn((text: string) => {
      editorFixture.snapshot.draftText = text
    }),
    hold: vi.fn(),
    release: vi.fn(),
    flush: vi.fn(async () => 'saved' as const),
    retrySave: vi.fn(async () => 'saved' as const),
    clearAfterSubmission: vi.fn(async () => 'cleared' as const),
    controller: {
      getSnapshot: () => editorFixture.snapshot,
    },
  }
})

const controllerFixture = vi.hoisted(() => ({
  send: vi.fn(async (input: Record<string, unknown>) => {
    void input
    return { status: 'ok' as const, value: { turnId: 'turn_1' } }
  }),
  notifyClearSettled: vi.fn(),
  getSnapshot: vi.fn(() => ({ turn: null, history: [], detailCursor: null })),
  subscribe: vi.fn(() => () => {}),
  load: vi.fn(),
  loadMore: vi.fn(),
  detach: vi.fn(),
  reattach: vi.fn(),
}))

const globalModelFixture = vi.hoisted(() => ({
  canExecute: true,
  confirmedModelId: 'model_1' as string | null,
  blockedReason: null as string | null,
  // #1106：purpose 推断能力位（默认 false=fail-closed；用例可覆盖）
  purposeInferenceAvailable: false,
}))

const sessionsFixture = vi.hoisted(() => {
  const base = {
    sessions: [],
    loading: false,
    loadingMore: false,
    error: null as string | null,
    loadMoreError: null as string | null,
    unauthorized: false,
    sourceUnavailable: false,
    hasMore: false,
    capabilitiesReady: true,
    canList: true,
    canCreate: true,
    listDisabledReason: null as string | null,
    createDisabledReason: null as string | null,
    creating: false,
    createError: null as string | null,
    created: null as unknown,
    refresh: vi.fn(),
    loadMore: vi.fn(),
    create: vi.fn(async () => ({ ref: { ...SESSION_REF, sessionId: 'sess_new' } })),
  }
  return { result: base }
})

const chatFixture = vi.hoisted(() => ({
  lastOptions: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock('@/lib/hooks/research-session-runtime', () => ({
  useResearchSessionRuntimeOptional: () => runtimeFixture.runtime,
  useSessionSnapshot: () => runtimeFixture.snapshot,
}))

vi.mock('@/lib/hooks/use-research-sessions', () => ({
  useResearchSessions: () => sessionsFixture.result,
}))

vi.mock('@/lib/hooks/use-research-editor', () => ({
  useResearchEditor: () => ({
    snapshot: editorFixture.snapshot,
    controller: editorFixture.controller,
    transportWired: true,
    setDraftText: editorFixture.setDraftText,
    setScope: editorFixture.setScope,
    setChatAnchor: vi.fn(),
    setReaderAnchor: vi.fn(),
    flush: editorFixture.flush,
    hold: editorFixture.hold,
    release: editorFixture.release,
    retrySave: editorFixture.retrySave,
    adoptServerVersion: vi.fn(),
    saveLocalOverServer: vi.fn(),
    clearAfterSubmission: editorFixture.clearAfterSubmission,
    markTokenConsumed: vi.fn(),
    canSubmit: vi.fn(() => ({ allowed: true })),
    restoreDraft: vi.fn(),
    refreshDraftCandidates: vi.fn(),
    releaseDocument: vi.fn(),
  }),
}))

vi.mock('@/lib/hooks/use-research-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/use-research-chat')>()
  return {
    ...actual,
    useResearchChat: (options: Record<string, unknown>) => {
      chatFixture.lastOptions = options
      return {
        turns: [],
        isStreaming: false,
        backgroundNotice: null,
        send: vi.fn(),
        sendCoverage: vi.fn(),
        resolveChatOrigin: vi.fn(async () => null),
        getCurrentSessionId: vi.fn(() => null),
        conversation: controllerFixture,
        sessionMeta: null,
        sessionCards: [],
        submissionLookup: null,
        markerWriteFailed: false,
        refreshMarkerLookups: vi.fn(),
      }
    },
  }
})

vi.mock('@/lib/hooks/use-research-c05', () => ({
  useResearchC05: () => ({ dispatchReady: () => false }),
  // W2 #1077：TargetShell 的阅读能力位（本文件只渲染 shell 但不打开阅读器）。
  useResearchD1e: () => ({ capability: null, ready: false, loading: false }),
}))

vi.mock('@/lib/hooks/use-research-global-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/use-research-global-model')>()
  return {
    ...actual,
    useResearchGlobalModel: () => ({
      runGuarded: async (operation: (modelId: string) => Promise<boolean> | boolean) => {
        const result = await operation(globalModelFixture.confirmedModelId ?? '')
        return result === true
      },
      canExecute: globalModelFixture.canExecute,
      blockedReason: globalModelFixture.blockedReason,
      confirmedModelId: globalModelFixture.confirmedModelId,
      localModelUnavailableMessage: null,
      purposeInferenceAvailable: globalModelFixture.purposeInferenceAvailable,
    }),
  }
})

vi.mock('@/lib/hooks/use-research', () => ({
  useResearchSources: () => ({
    data: {
      items: [
        {
          source_id: 'src_1',
          document_id: 'doc_1',
          document_version: 'v1',
          status: 'ready',
          content_hash: null,
          synced_at: null,
          last_error: null,
        },
        {
          source_id: 'src_2',
          document_id: 'doc_2',
          document_version: 'v1',
          status: 'ready',
          content_hash: null,
          synced_at: null,
          last_error: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useResearchNotes: () => ({
    data: {
      items: [
        {
          note_id: 'note_1',
          project_id: 'proj_1',
          title: 'Note One',
          content: 'synthetic note',
          note_type: 'human',
          created_at: null,
          updated_at: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/lib/research/session-cache', () => ({
  readDisplayPointer: () => displayFixture.display,
  readPointer: () => displayFixture.globalPointer,
}))

vi.mock('@/lib/research/session-idempotency', () => ({
  buildSubmissionKey: () => 'sub_key_1',
}))

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return { ...actual, newIdempotencyKey: () => 'idem_1' }
})

// TargetShell 集成测试需要：Jobs controller、模型条、面板（消息面非发送路径）。
vi.mock('@/components/research/ResearchJobsProvider', () => ({
  ResearchJobsProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useResearchJobsController: () => ({
    jobs: [],
    isCreating: false,
    error: null,
    errorCode: null,
    createCompare: vi.fn(),
  }),
}))
vi.mock('@/components/research/ResearchGlobalModelBar', () => ({
  ResearchGlobalModelBar: () => <div data-testid="model-bar" />,
}))
vi.mock('@/components/research/ResearchChatPanel', () => ({
  ResearchChatPanel: () => <div data-testid="chat-panel" />,
}))
vi.mock('@/lib/embedded/shell', () => ({
  useRequestIngest: () => vi.fn(),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role="owner" userId="user_1">
        <ResearchScopeProvider userId="user_1" projectId="proj_1">
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

function useTargetHarness() {
  return {
    conversation: useTargetConversation({
      purposeInferenceAvailable: globalModelFixture.purposeInferenceAvailable,
    }),
    scope: useResearchScope(),
  }
}

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  displayFixture.display = null
  displayFixture.globalPointer = null
  runtimeFixture.snapshot.phase = 'ready'
  runtimeFixture.snapshot.capabilities = {
    contract: 'research-session-v1',
    editorReady: true,
    submissionReady: { global: true, source: true },
    degraded: false,
    reason: null,
  }
  editorFixture.reset()
  editorFixture.setScope.mockClear()
  editorFixture.hold.mockClear()
  editorFixture.release.mockClear()
  editorFixture.flush.mockClear()
  editorFixture.flush.mockResolvedValue('saved')
  editorFixture.clearAfterSubmission.mockClear()
  controllerFixture.send.mockClear()
  controllerFixture.send.mockResolvedValue({ status: 'ok', value: { turnId: 'turn_1' } })
  controllerFixture.notifyClearSettled.mockClear()
  sessionsFixture.result.create.mockClear()
  globalModelFixture.canExecute = true
  globalModelFixture.confirmedModelId = 'model_1'
  globalModelFixture.blockedReason = null
  globalModelFixture.purposeInferenceAvailable = false
  chatFixture.lastOptions = null
})

afterEach(() => {
  cleanup()
})

describe('useTargetConversation · F2 刷新恢复', () => {
  it('runtime 未 ready 时不恢复；phase→ready 后恢复 display 指针（依赖含 runtime 快照）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    runtimeFixture.snapshot.phase = 'masked'
    const { result, rerender } = renderHook(useTargetHarness, { wrapper })
    expect(result.current.conversation.activeRef).toBeNull()

    // runtime bootstrap 完成（phase → ready）；真实组件由 useSessionSnapshot
    // 驱动重渲染，这里显式 rerender 模拟同一变化。
    runtimeFixture.snapshot.phase = 'ready'
    act(() => rerender())
    await waitFor(() => expect(result.current.conversation.activeRef?.sessionId).toBe('sess_1'))
  })

  it('无 display 指针时回退 global 指针恢复', async () => {
    displayFixture.display = null
    displayFixture.globalPointer = { ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.activeRef?.sessionId).toBe('sess_1'))
  })
})

describe('useTargetConversation · F1/F12 selected/single 真实发送', () => {
  it('selected：左栏范围变更同步 editor.setScope，并真实派发 controller.send', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))

    act(() => result.current.scope.toggleSource('src_1'))
    await waitFor(() =>
      expect(editorFixture.setScope).toHaveBeenCalledWith({
        mode: 'selected',
        sourceIds: ['src_1'],
        noteIds: [],
      }),
    )

    let sent = false
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(true)
    expect(controllerFixture.send).toHaveBeenCalledTimes(1)
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.sourceIds).toEqual(['src_1'])
    expect((payload.scope as Record<string, unknown>).mode).toBe('selected')
    expect(result.current.conversation.sendError).toBeNull()
  })

  it('single：单篇 pin 同步到 editor（base+single）并真实派发', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))

    // MEDIUM-1：single 不得静默丢 note_ids——先带一个显式 Note 上下文。
    act(() => result.current.scope.toggleNote('note_1'))
    await waitFor(() => expect(editorFixture.snapshot.noteIds).toEqual(['note_1']))

    act(() => {
      expect(result.current.conversation.pinSingleSource('src_2')).toBe(true)
    })
    await waitFor(() => expect(editorFixture.setScope).toHaveBeenCalledWith({ mode: 'single', sourceId: 'src_2' }))

    let sent = false
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(true)
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    // H1 + MEDIUM-1：source_ids 归一为 []；note_ids 是显式上下文，必须保留。
    expect(payload.sourceIds).toEqual([])
    expect(payload.noteIds).toEqual(['note_1'])
    expect((payload.scope as Record<string, unknown>).mode).toBe('single')
    expect((payload.scope as Record<string, unknown>).sourceIds).toEqual([])
    expect((payload.scope as Record<string, unknown>).singleSourceId).toBe('src_2')
  })

  it('N1：selected 基础上 pin 单篇 → 真实派发成功（不再 scopeChanged）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))

    act(() => {
      result.current.scope.toggleSource('src_1')
      result.current.scope.toggleSource('src_2')
      result.current.scope.toggleNote('note_1')
    })
    await waitFor(() =>
      expect(editorFixture.snapshot.baseScope.sourceIds).toEqual(['src_1', 'src_2']),
    )
    await waitFor(() => expect(editorFixture.snapshot.noteIds).toEqual(['note_1']))
    act(() => {
      expect(result.current.conversation.pinSingleSource('src_2')).toBe(true)
    })
    await waitFor(() => expect(editorFixture.snapshot.singleSourceId).toBe('src_2'))

    let sent = false
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(true)
    expect(result.current.conversation.sendError).toBeNull()
    expect(controllerFixture.send).toHaveBeenCalledTimes(1)
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    // H1（第 3 轮审查）：raw base IDs 保留在 provider/editor 一致性比较，
    // **wire 选择**归一为互斥形态（source_ids=[]、single_source_id 正确）。
    expect((payload.scope as Record<string, unknown>).mode).toBe('single')
    expect((payload.scope as Record<string, unknown>).singleSourceId).toBe('src_2')
    expect((payload.scope as Record<string, unknown>).sourceIds).toEqual([])
    expect(payload.sourceIds).toEqual([])
    // MEDIUM-1：single 下 note 上下文原样保留（M04 不静默删上下文）。
    expect(payload.noteIds).toEqual(['note_1'])
  })

  it('MEDIUM-1：notes-only（selected 无 source）→ pin → send 保留 note_ids', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))

    act(() => result.current.scope.toggleNote('note_1'))
    await waitFor(() => expect(editorFixture.snapshot.noteIds).toEqual(['note_1']))

    act(() => {
      expect(result.current.conversation.pinSingleSource('note_1')).toBe(true)
    })
    await waitFor(() => expect(editorFixture.snapshot.singleSourceId).toBe('note_1'))

    let sent = false
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(true)
    expect(result.current.conversation.sendError).toBeNull()
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    expect((payload.scope as Record<string, unknown>).mode).toBe('single')
    expect((payload.scope as Record<string, unknown>).sourceIds).toEqual([])
    expect(payload.sourceIds).toEqual([])
    expect(payload.noteIds).toEqual(['note_1'])
    expect((payload.scope as Record<string, unknown>).singleSourceId).toBe('note_1')
  })

  it('F12：capabilities 缺失时 submissionReady=false（仅 === true 放行）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    runtimeFixture.snapshot.capabilities = null
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    expect(result.current.conversation.submissionReady).toBe(false)
  })
})

describe('useTargetConversation · F3 无活动会话 / F5 无模型', () => {
  it('F3：runtime 可用但无活动会话 → send 阻断且原因可见，绝不走 legacy', async () => {
    const { result } = renderHook(useTargetHarness, { wrapper })
    expect(result.current.conversation.runtimeAvailable).toBe(true)
    expect(result.current.conversation.noActiveSession).toBe(true)
    expect(result.current.conversation.sessionWired).toBe(false)

    let sent = true
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(false)
    expect(controllerFixture.send).not.toHaveBeenCalled()
    expect(result.current.conversation.sendError).toBe(
      'research.target.composer.noActiveSession',
    )
    // 单篇 pin 也不得在无会话时制造未绑定限定
    expect(result.current.conversation.pinSingleSource('src_1')).toBe(false)
  })

  it('F5：canExecute=false（无模型）→ send 阻断并给出原因', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    globalModelFixture.canExecute = false
    globalModelFixture.confirmedModelId = null
    globalModelFixture.blockedReason = 'no-model'
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))

    let sent = true
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(false)
    expect(controllerFixture.send).not.toHaveBeenCalled()
    expect(result.current.conversation.sendError).toBe('research.globalModel.selectModelHint')
  })
})

describe('useTargetConversation · 清稿 ACK / 切换会话', () => {
  it('清稿 ACK 结算给 controller（cleared）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(chatFixture.lastOptions?.session).toBeTruthy())
    const session = chatFixture.lastOptions?.session as {
      onClearAfterSubmission: (receipt: unknown, operationId: string) => void
    }
    act(() => {
      session.onClearAfterSubmission(
        { ref: SESSION_REF, draftToken: 'tok_1', editorRevision: 3 },
        'op_1',
      )
    })
    await waitFor(() =>
      expect(controllerFixture.notifyClearSettled).toHaveBeenCalledWith('op_1', 'cleared'),
    )
  })

  it('切换会话：openSession 激活新 ref 并写 display 指针', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    act(() => result.current.conversation.openSession(SESSION_REF_2))
    await waitFor(() =>
      expect(result.current.conversation.activeRef?.sessionId).toBe('sess_2'),
    )
    expect(runtimeFixture.runtime.activate).toHaveBeenCalledWith('global', SESSION_REF_2)
    expect(runtimeFixture.runtime.setDisplayPointer).toHaveBeenCalledWith({
      version: 1,
      surface: 'global',
      ref: SESSION_REF_2,
    })
  })
})

describe('TargetShell 集成（真实 hook + 真实 composer 发送路径，F6）', () => {
  it('selected 下 Ctrl/Cmd+Enter 经真实 hook 派发到 controller.send', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ResearchWorkspaceProvider projectId="proj_1" role="owner" userId="user_1">
          <ResearchScopeProvider userId="user_1" projectId="proj_1">
            <TargetShell />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )

    // 左栏勾选资料 → provider（同时由真实 hook 同步 editor）
    fireEvent.click(await screen.findByTestId('rdlens-target-source-select-src_1'))
    const textarea = screen.getByTestId('chat-input')
    fireEvent.change(textarea, { target: { value: 'Question' } })
    await waitFor(() => expect(screen.getByTestId('chat-send')).not.toBeDisabled())
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(controllerFixture.send).toHaveBeenCalledTimes(1))
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.query).toBe('Question')
    expect(payload.sourceIds).toEqual(['src_1'])
    expect((payload.scope as Record<string, unknown>).mode).toBe('selected')
  })

  it('发送失败（controller 非 ok）→ composer 显示可见原因（F1）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    controllerFixture.send.mockResolvedValue(
      { status: 'error', reason: 'rejected' } as unknown as { status: 'ok'; value: { turnId: string } },
    )
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ResearchWorkspaceProvider projectId="proj_1" role="owner" userId="user_1">
          <ResearchScopeProvider userId="user_1" projectId="proj_1">
            <TargetShell />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
    const textarea = screen.getByTestId('chat-input')
    fireEvent.change(textarea, { target: { value: 'Question' } })
    await waitFor(() => expect(screen.getByTestId('chat-send')).not.toBeDisabled())
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    await waitFor(() =>
      expect(screen.getByTestId('rdlens-target-send-error')).toHaveTextContent(
        'research.target.composer.sendFailed',
      ),
    )
  })
})

// #1106 PR-B：本次用途接线——显式 purpose 透传 controller.send、自动判断
// 省略（null）、能力关闭不发（防 426）、空 selected 放行（D5）、发送后复位。
describe('useTargetConversation #1106 本次用途', () => {
  it('显式 purpose 透传 controller.send；发送成功后回到自动判断', async () => {
    globalModelFixture.purposeInferenceAvailable = true
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    expect(result.current.conversation.workPurpose).toBeNull()

    act(() => result.current.conversation.setWorkPurpose('exploration'))
    let sent = false
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(true)
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.workPurpose).toBe('exploration')
    // D7/§9：显式用途只作用于刚派发的下一请求；成功后回到自动判断。
    expect(result.current.conversation.workPurpose).toBeNull()
  })

  it('自动判断：controller.send 收到 null（上游据此省略 wire 字段，绝不发 null）', async () => {
    globalModelFixture.purposeInferenceAvailable = true
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    await act(async () => {
      expect(await result.current.conversation.send('Question')).toBe(true)
    })
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.workPurpose).toBeNull()
  })

  it('能力位关闭：即使 state 有显式 purpose 也不发送（防后端 426）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    act(() => result.current.conversation.setWorkPurpose('writing'))
    await act(async () => {
      expect(await result.current.conversation.send('Question')).toBe(true)
    })
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.workPurpose).toBeNull()
  })

  it('D5：空 selected + 自动判断 + inference on → 可发送（交服务端推断，零本地阻断）', async () => {
    globalModelFixture.purposeInferenceAvailable = true
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    act(() => result.current.scope.toggleSource('src_1'))
    await waitFor(() =>
      expect(editorFixture.setScope).toHaveBeenCalledWith({
        mode: 'selected',
        sourceIds: ['src_1'],
        noteIds: [],
      }),
    )
    // BEH-03：清空最后一份必须用显式 removeSource（toggleSource 保留旧壳
    // 防误触「最后一份不可取消」语义）。
    act(() => result.current.scope.removeSource('src_1'))
    await waitFor(() => expect(editorFixture.snapshot.baseScope.sourceIds).toEqual([]))
    expect(result.current.conversation.scopeBlockedText).toBeNull()

    let sent = false
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(true)
    expect(controllerFixture.send).toHaveBeenCalledTimes(1)
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.workPurpose).toBeNull()
    expect(payload.sourceIds).toEqual([])
    expect((payload.scope as Record<string, unknown>).mode).toBe('selected')
  })

  it('空 selected + inference off → 保持现行本地阻断（不派发）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    act(() => result.current.scope.toggleSource('src_1'))
    await waitFor(() => expect(editorFixture.snapshot.baseScope.sourceIds).toEqual(['src_1']))
    act(() => result.current.scope.removeSource('src_1'))
    await waitFor(() => expect(editorFixture.snapshot.baseScope.sourceIds).toEqual([]))
    expect(result.current.conversation.scopeBlockedText).toBe('research.target.composer.scopeBlocked')

    let sent = true
    await act(async () => {
      sent = await result.current.conversation.send('Question')
    })
    expect(sent).toBe(false)
    expect(controllerFixture.send).not.toHaveBeenCalled()
    expect(result.current.conversation.sendError).toBe('research.target.composer.scopeBlocked')
  })

  it('D6：sendWithPurpose 以显式 exploration 重发同一 query（新请求）', async () => {
    globalModelFixture.purposeInferenceAvailable = true
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    await act(async () => {
      expect(
        await result.current.conversation.sendWithPurpose('Question', 'exploration'),
      ).toBe(true)
    })
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    expect(payload.query).toBe('Question')
    expect(payload.workPurpose).toBe('exploration')
    // 成功后 state 回到自动判断（下一请求默认）。
    expect(result.current.conversation.workPurpose).toBeNull()
  })

  it('发送失败保留显式 purpose（用户可重试/修正，不静默丢意图）', async () => {
    globalModelFixture.purposeInferenceAvailable = true
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    controllerFixture.send.mockResolvedValue({
      status: 'blocked',
      error: { code: 'session_busy', message: 'busy' },
    } as never)
    const { result } = renderHook(useTargetHarness, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    act(() => result.current.conversation.setWorkPurpose('writing'))
    await act(async () => {
      expect(await result.current.conversation.send('Question')).toBe(false)
    })
    expect(result.current.conversation.workPurpose).toBe('writing')
  })
})

// W2 #1077（BEH-11 / #1013 §2.11）：阅读器「讨论选段」只能经 shell 显式注入的
// getPendingSelection 读取；仅 target==='global' 时随提交写 selection_context，
// 且**不改变**范围/检索载荷（选段来源允许在 scope 外）。
const PENDING_SELECTION = {
  selection: {
    sourceId: 'src_1',
    documentId: 'doc_1',
    documentVersion: 'v1',
    chunkId: 'chunk_1',
    chunkOrdinal: 3,
    pageIdx: 1,
    startOffset: 0,
    endOffset: 5,
    quote: 'quote',
    quoteHash: 'quote_hash',
    contentHash: 'content_hash',
  },
  sourceId: 'src_1',
  sourceTitle: 'Paper One',
  pageIdx: 1,
  chunkOrdinal: 3,
  target: 'global' as const,
}

function usePendingHarness(getPendingSelection: () => unknown) {
  return {
    conversation: useTargetConversation({
      purposeInferenceAvailable: globalModelFixture.purposeInferenceAvailable,
      getPendingSelection: getPendingSelection as never,
    }),
    scope: useResearchScope(),
  }
}

describe('useTargetConversation · W2 #1077 选段 selection_context', () => {
  it('讨论选段后 getSelectionContext 返回 11 键 selection；发送不改变范围载荷', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(() => usePendingHarness(() => PENDING_SELECTION), { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    await waitFor(() => expect(chatFixture.lastOptions?.session).toBeTruthy())

    const session = chatFixture.lastOptions?.session as {
      getSelectionContext?: () => unknown
    }
    expect(session.getSelectionContext?.()).toMatchObject({
      sourceId: 'src_1',
      chunkId: 'chunk_1',
      chunkOrdinal: 3,
      pageIdx: 1,
      quote: 'quote',
    })

    await act(async () => {
      expect(await result.current.conversation.send('Question')).toBe(true)
    })
    const payload = controllerFixture.send.mock.calls[0][0] as Record<string, unknown>
    // 选段不并入范围/检索载荷：默认 all、无 source/note ids。
    expect(payload.sourceIds).toEqual([])
    expect(payload.noteIds).toEqual([])
    expect((payload.scope as Record<string, unknown>).mode).toBe('all')
  })

  it('getPendingSelection 变化后读取渲染时刻最新值（ref，不重建 controller）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    let pending: unknown = null
    const { rerender } = renderHook(() => usePendingHarness(() => pending), { wrapper })
    await waitFor(() => expect(chatFixture.lastOptions?.session).toBeTruthy())
    const session = chatFixture.lastOptions?.session as {
      getSelectionContext?: () => unknown
    }
    expect(session.getSelectionContext?.()).toBeNull()

    pending = PENDING_SELECTION
    act(() => rerender())
    await waitFor(() =>
      expect(session.getSelectionContext?.()).toMatchObject({ sourceId: 'src_1' }),
    )
  })

  it('target !== global（来源会话）→ 不携带 selection_context', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const sourcePending = { ...PENDING_SELECTION, target: 'source' as const }
    renderHook(() => usePendingHarness(() => sourcePending), { wrapper })
    await waitFor(() => expect(chatFixture.lastOptions?.session).toBeTruthy())
    const session = chatFixture.lastOptions?.session as {
      getSelectionContext?: () => unknown
    }
    expect(session.getSelectionContext?.()).toBeNull()
  })

  it('未注入 getPendingSelection → 旧行为不变（null）', async () => {
    displayFixture.display = { surface: 'global', ref: SESSION_REF }
    const { result } = renderHook(() => {
      return {
        conversation: useTargetConversation({
          purposeInferenceAvailable: false,
        }),
      }
    }, { wrapper })
    await waitFor(() => expect(result.current.conversation.sessionWired).toBe(true))
    const session = chatFixture.lastOptions?.session as {
      getSelectionContext?: () => unknown
    }
    expect(session.getSelectionContext?.()).toBeNull()
  })
})
