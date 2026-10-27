import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { ResearchSourceChatPanel } from './ResearchSourceChatPanel'
import { useResearchSourceChat } from '@/lib/hooks/use-research-source-chat'
import {
  resetGlobalModelStub,
  setGlobalModelStub,
} from '@/test/global-model-stub'

// Issue #182 Red：Source Chat 面板——新会话/会话选择、消息气泡、citation
// 点击高亮联动（onHighlightPage）、streaming 输入禁用、两类错误文案与重试。
// #243 §6.4：发送走顶层守卫，模型不再由本面板提供（测试替身提供快照）。

vi.mock('@/lib/hooks/use-research-source-chat', () => ({
  useResearchSourceChat: vi.fn(),
}))

// 被测对象不是全局模型本身
vi.mock('@/lib/hooks/use-research-global-model')

// PR-5b（D5）：source 面板直接消费 session runtime 的 source editor。
vi.mock('@/lib/hooks/research-session-runtime', () => ({
  useResearchSessionRuntimeOptional: vi.fn(() => null),
  useSessionSnapshot: vi.fn(() => ({ viewerUserId: '1' })),
}))
vi.mock('@/lib/hooks/use-research-editor', () => ({
  useResearchEditor: vi.fn(() => ({
    snapshot: null,
    controller: null,
    setDraftText: vi.fn(),
    flush: vi.fn(async () => 'saved'),
    hold: vi.fn(),
    release: vi.fn(),
    clearAfterSubmission: vi.fn(async () => 'cleared'),
  })),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.page ?? opts.count ?? '')}` : key,
  }),
}))

vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

import type { UseResearchSourceChatResult } from '@/lib/hooks/use-research-source-chat'
import { useResearchSessionRuntimeOptional } from '@/lib/hooks/research-session-runtime'
import { useResearchEditor } from '@/lib/hooks/use-research-editor'
import { createEditorState } from '@/lib/research/editor-machine'

function makeChatResult(overrides: Partial<UseResearchSourceChatResult> = {}): UseResearchSourceChatResult {
  return {
    turns: [],
    isStreaming: false,
    send: vi.fn(),
    sessions: [],
    activeSessionId: null,
    selectSession: vi.fn(),
    loadDetailError: null,
    retryableQuery: null,
    retry: vi.fn(),
    ...overrides,
  }
}

describe('ResearchSourceChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetGlobalModelStub()
    vi.mocked(useResearchSourceChat).mockReturnValue(makeChatResult())
    vi.mocked(useResearchSessionRuntimeOptional).mockReturnValue(null)
    vi.mocked(useResearchEditor).mockReturnValue({
      snapshot: null,
      controller: null,
      setDraftText: vi.fn(),
      flush: vi.fn(async () => 'saved'),
      hold: vi.fn(),
      release: vi.fn(),
      clearAfterSubmission: vi.fn(async () => 'cleared'),
    } as never)
  })

  function renderPanel(onHighlightPage = vi.fn()) {
    render(<ResearchSourceChatPanel projectId="proj_1" sourceId="src_1" onHighlightPage={onHighlightPage} />)
    return { onHighlightPage }
  }

  it('渲染标题与新会话按钮；空 turns 展示空态文案', () => {
    renderPanel()
    expect(screen.getByText('research.sourceChat.title')).toBeInTheDocument()
    expect(screen.getByTestId('srcchat-new-session')).toBeInTheDocument()
    expect(screen.getByText('research.sourceChat.emptyState')).toBeInTheDocument()
  })

  it('UIOPT-A：顶栏为展开按钮预留右侧空间（lg:pr-36；不靠 z-index 遮挡 New session）', () => {
    renderPanel()
    const topbar = screen.getByTestId('srcchat-topbar')
    // 预留与按钮可见性同条件：<1024px（compact）按钮隐藏，恢复原始 px-4（评审 M1）
    expect(topbar).toHaveClass('px-4', 'lg:pr-36')
    // New session 按钮仍可达（在预留区左侧）
    expect(screen.getByTestId('srcchat-new-session')).toBeInTheDocument()
  })

  it('新会话按钮触发 selectSession(null)', () => {
    const chat = makeChatResult()
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()
    fireEvent.click(screen.getByTestId('srcchat-new-session'))
    expect(chat.selectSession).toHaveBeenCalledWith(null)
  })

  it('会话列表展示 title 与 updated_at；点击选择历史会话', () => {
    const chat = makeChatResult({
      sessions: [
        {
          session_id: 'sess_a',
          title: '方法学讨论',
          source_id: 'src_1',
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-02T00:00:00Z',
        },
        {
          session_id: 'sess_b',
          title: null,
          source_id: 'src_1',
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-03T00:00:00Z',
        },
      ],
      activeSessionId: 'sess_b',
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    const list = screen.getByTestId('srcchat-sessions')
    expect(list).toHaveTextContent('方法学讨论')
    expect(list).toHaveTextContent('2026-08-03T00:00:00Z') // 无 title 回退 session_id 展示

    fireEvent.click(screen.getByTestId('srcchat-session-sess_a'))
    expect(chat.selectSession).toHaveBeenCalledWith('sess_a')
    // 活动会话标记 aria-current
    expect(screen.getByTestId('srcchat-session-sess_b')).toHaveAttribute('aria-current', 'true')
  })

  it('citation 点击回调 onHighlightPage(page_idx)；无页码的 citation 不回调', () => {
    const onHighlightPage = vi.fn()
    const chat = makeChatResult({
      turns: [
        { id: 'user_1', role: 'user', content: 'q', thinking: '', citations: [], usage: null, resolvedMode: null, degradationReasons: [], sourceRef: null, status: 'done', reconnectCount: 0, errorCode: null, errorMessage: null },
        {
          id: 'a1',
          role: 'assistant',
          content: '答',
          thinking: '',
          citations: [
            {
              citation_id: 'c_1',
              claim: '带页码声明',
              doc_id: 'doc_1',
              page_idx: 2,
            },
            {
              citation_id: 'c_2',
              claim: '无页码声明',
              doc_id: 'doc_1',
              page_idx: null,
            },
          ],
          usage: null,
          resolvedMode: null,
          degradationReasons: [],
          sourceRef: null,
          status: 'done',
          reconnectCount: 0,
          errorCode: null,
          errorMessage: null,
        },
      ],
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    render(<ResearchSourceChatPanel projectId="proj_1" sourceId="src_1" onHighlightPage={onHighlightPage} />)

    fireEvent.click(screen.getByTestId('research-citation-click-c_1'))
    expect(onHighlightPage).toHaveBeenCalledWith(2)

    // 无页码 citation 不渲染点击入口
    expect(screen.queryByTestId('research-citation-click-c_2')).toBeNull()
  })

  it('streaming 中输入与发送按钮禁用；结束后恢复', () => {
    const chat = makeChatResult({ isStreaming: true })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()
    const input = screen.getByTestId('srcchat-input')
    expect(input).toBeDisabled()
    expect(screen.getByTestId('srcchat-send')).toBeDisabled()
    expect(screen.getByText(/research\.sourceChat\.disconnected|research\.chatStreaming/)).toBeInTheDocument()
  })

  it('usage 元数据徽标：resolvedMode / degradationReasons / sourceRef.documentVersion', () => {
    const chat = makeChatResult({
      turns: [{
        id: 'a1',
        role: 'assistant',
        content: '答',
        thinking: '',
        citations: [],
        usage: { input_tokens: 100, output_tokens: 20 },
        resolvedMode: 'hybrid_rag',
        degradationReasons: ['source_over_direct_cap'],
        sourceRef: { sourceId: 'src_1', documentId: 'doc_1', documentVersion: 'v2' },
        status: 'done',
        reconnectCount: 0,
        errorCode: null,
        errorMessage: null,
      }],
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    const badges = screen.getByTestId('srcchat-turn-meta-a1')
    expect(badges).toHaveTextContent('hybrid_rag')
    expect(badges).toHaveTextContent('research.sourceChat.degradedBadge')
    expect(badges).toHaveTextContent('v2')
  })

  it('409 活动冲突终态：展示本地化 conflictBusy 文案与重试', () => {
    const chat = makeChatResult({
      turns: [{
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: '',
        citations: [],
        usage: null,
        resolvedMode: null,
        degradationReasons: [],
        sourceRef: null,
        status: 'error',
        reconnectCount: 0,
        errorCode: 'conflict_busy',
        errorMessage: 'another active turn',
      }],
      retryableQuery: 'q',
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    expect(screen.getByText('research.sourceChat.conflictBusy')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('srcchat-error-retry'))
    expect(chat.retry).toHaveBeenCalledTimes(1)
  })

  it('Gateway 不可用终态：展示 errorGatewayUnavailable 文案', () => {
    const chat = makeChatResult({
      turns: [{
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: '',
        citations: [],
        usage: null,
        resolvedMode: null,
        degradationReasons: [],
        sourceRef: null,
        status: 'error',
        reconnectCount: 0,
        errorCode: 'gateway_unavailable',
        errorMessage: '503',
      }],
      retryableQuery: 'q',
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    expect(screen.getByText('research.sourceChat.errorGatewayUnavailable')).toBeInTheDocument()
  })

  it('RWV2-42（M1）：未知错误码 → generic 主文案；raw code 不作主消息（仅诊断）', () => {
    const chat = makeChatResult({
      turns: [{
        id: 'a2',
        role: 'assistant',
        content: '',
        thinking: '',
        citations: [],
        usage: null,
        resolvedMode: null,
        degradationReasons: [],
        sourceRef: null,
        status: 'error',
        reconnectCount: 0,
        errorCode: 'project_deleted',
        errorMessage: '已删除',
      }],
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    // 主消息为 generic 文案 key（t 返回键名）；raw code 不出现为主消息
    expect(screen.getByText('research.errors.generic')).toBeInTheDocument()
    expect(screen.queryByText('project_deleted')).toBeNull()
    // 原文仅作次级诊断行
    expect(screen.getByText('已删除')).toBeInTheDocument()
  })

  it('RWV2-42（L1）：未知码且无 errorMessage → generic 主文案 + raw code 仅次级', () => {
    const chat = makeChatResult({
      turns: [{
        id: 'a3',
        role: 'assistant',
        content: '',
        thinking: '',
        citations: [],
        usage: null,
        resolvedMode: null,
        degradationReasons: [],
        sourceRef: null,
        status: 'error',
        reconnectCount: 0,
        errorCode: 'epoch_mismatch',
        errorMessage: null,
      }],
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    expect(screen.getByText('research.errors.generic')).toBeInTheDocument()
    // raw code 保留为次级诊断（不丢信息，同时不违反 AC8 主消息规则）
    expect(screen.getByText('epoch_mismatch')).toBeInTheDocument()
  })

  it('PR-5b（D5）：运行时接线后以 source editor 草稿发送（复用 DraftComposer 门禁）', () => {
    const ref = {
      domain: 'research' as const,
      kind: 'source' as const,
      projectId: 'proj_1',
      sessionId: 'sess_s1',
      sourceId: 'src_1',
    }
    vi.mocked(useResearchSessionRuntimeOptional).mockReturnValue({
      active: () => ref,
    } as never)
    const snapshot = {
      ...createEditorState({ ref, writerId: 'w-1', transportAvailable: true }),
      phase: 'ready' as const,
      loading: false,
      baseScope: { mode: 'selected' as const, sourceIds: ['src_1'], singleSourceId: 'src_1' },
      draftText: '固定来源的问题',
      dirty: true,
    }
    const setDraftText = vi.fn()
    vi.mocked(useResearchEditor).mockReturnValue({
      snapshot,
      setDraftText,
      flush: vi.fn(async () => true),
    } as never)
    const chat = makeChatResult()
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    // 固定来源范围可见；wired 路径用共享 composer（非 legacy 单行输入）
    expect(screen.getByTestId('srcchat-draft-scope')).toBeInTheDocument()
    expect(screen.getByTestId('research-draft-composer')).toBeInTheDocument()
    expect(screen.queryByTestId('srcchat-input')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('chat-send'))
    expect(chat.send).toHaveBeenCalledWith('固定来源的问题', 'm-local')
  })

  it('PR-5b（D5）：运行时缺失时保留 legacy 输入（中间 PR 入口不误开放）', () => {
    vi.mocked(useResearchSessionRuntimeOptional).mockReturnValue(null)
    renderPanel()
    expect(screen.getByTestId('srcchat-input')).toBeInTheDocument()
    expect(screen.queryByTestId('research-draft-composer')).not.toBeInTheDocument()
  })

  it('输入非空回车发送并清空输入框', () => {
    const chat = makeChatResult()
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    const input = screen.getByTestId('srcchat-input')
    fireEvent.change(input, { target: { value: '这篇论文的结论？' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // 模型来自顶层 confirmed 全局模型快照（替身值）
    expect(chat.send).toHaveBeenCalledWith('这篇论文的结论？', 'm-local')
    expect(input).toHaveValue('')

    // 空白不发送
    vi.mocked(chat.send).mockClear()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(chat.send).not.toHaveBeenCalled()
  })

  it('#243 §6.4：待确认/无模型时发送被守卫拦下，输入与 send 均无副作用', () => {
    const chat = makeChatResult()
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    // 外部模型待确认：守卫只登记不执行（不变量 9）
    const onGuardedOptions = vi.fn()
    setGlobalModelStub({ deferGuarded: true, onGuardedOptions })
    renderPanel()

    const input = screen.getByTestId('srcchat-input')
    fireEvent.change(input, { target: { value: '外发问题' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(chat.send).not.toHaveBeenCalled()
    expect(input).toHaveValue('外发问题')
    // RWV2-42（D5a）：派发携带固定来源摘要（consent Scope 行 = 该来源）
    expect(onGuardedOptions).toHaveBeenCalledTimes(1)
    expect(onGuardedOptions.mock.calls[0][0]?.scopeLabel).toContain(
      'research.scopeSummary.sourceOne',
    )
  })

  it('#243 §6.4：无 confirmed 模型时输入与发送按钮禁用（不变量 2/7）', () => {
    vi.mocked(useResearchSourceChat).mockReturnValue(makeChatResult())
    setGlobalModelStub({ confirmedModelId: null })
    renderPanel()
    expect(screen.getByTestId('srcchat-input')).toBeDisabled()
    expect(screen.getByTestId('srcchat-send')).toBeDisabled()
  })

  it('PR-5b（Codex P1-#3）：保存未确认（conflict）时不派发且不清会话草稿', async () => {
    const ref = {
      domain: 'research' as const,
      kind: 'source' as const,
      projectId: 'proj_1',
      sessionId: 'sess_src',
      sourceId: 'src_1',
    }
    vi.mocked(useResearchSessionRuntimeOptional).mockReturnValue({
      active: () => ref,
    } as never)
    const base = createEditorState({ ref, writerId: 'w-1', transportAvailable: true })
    const snapshot = {
      ...base,
      phase: 'ready' as const,
      loading: false,
      revision: 3,
      intentHash: 'hash-3',
      draftToken: 'draft_3',
      baseScope: { mode: 'selected' as const, sourceIds: ['src_1'], singleSourceId: 'src_1' },
      draftText: '未保存的问题',
      dirty: true,
    }
    const setDraftText = vi.fn()
    const release = vi.fn()
    const hold = vi.fn()
    vi.mocked(useResearchEditor).mockReturnValue({
      snapshot,
      controller: { getSnapshot: () => snapshot },
      setDraftText,
      flush: vi.fn(async () => 'conflict'),
      hold,
      release,
      clearAfterSubmission: vi.fn(async () => 'cleared'),
    } as never)
    const conversationSend = vi.fn(async () => ({ status: 'ok' }))
    const chat = makeChatResult({
      conversation: {
        send: conversationSend,
        getSnapshot: () => ({ turn: null, history: [] }),
        subscribe: () => () => {},
        notifyClearSettled: vi.fn(),
      } as never,
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-send'))
    })

    expect(hold).toHaveBeenCalledWith('submit', expect.any(String))
    expect(conversationSend).not.toHaveBeenCalled()
    expect(chat.send).not.toHaveBeenCalled()
    expect(setDraftText).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalled()
  })

  it('PR-5b（Codex 第 2 轮 P1-#3）：controller history 轮次必须渲染进消息区', () => {
    const archived = {
      identity: {
        authGeneration: 1,
        sessionKey: 'source:proj_1:src_1:sess_src',
        sessionId: 'sess_src',
        turnId: 'turn-old',
        draftToken: 'draft_old',
        attempt: 1,
        detached: false,
        terminal: 'done',
      },
      state: 'terminal',
      sse: {
        answer: '旧轮回答',
        thinking: '',
        citations: [],
        usage: null,
        resolvedMode: null,
        terminal: 'done',
        errorCode: null,
        errorMessage: null,
        contextReport: null,
        contextCoverage: null,
      },
      query: '旧轮问题',
      operationId: null,
      accepted: null,
      errorCode: null,
      errorMessage: null,
      gapDetected: false,
      lookup: null,
      clearPending: false,
      incomplete: false,
      external: false,
    }
    vi.mocked(useResearchSourceChat).mockReturnValue(
      makeChatResult({
        conversation: {
          getSnapshot: () => ({ turn: null, history: [archived] }),
          subscribe: () => () => {},
          send: vi.fn(),
        } as never,
      }),
    )
    renderPanel()
    expect(screen.getByText('旧轮问题')).toBeInTheDocument()
    expect(screen.getByText('旧轮回答')).toBeInTheDocument()
  })

  it('PR-5b（Lead 核对 P1-2）：新会话态点历史会话会重新 activate，editor 恢复且发送走 controller', async () => {
    let activeRef: {
      domain: 'research'
      kind: 'source'
      projectId: string
      sessionId: string
      sourceId: string
    } | null = null
    const activate = vi.fn((_surface: string, next: typeof activeRef) => {
      activeRef = next
      return true
    })
    vi.mocked(useResearchSessionRuntimeOptional).mockReturnValue({
      active: () => activeRef,
      activate,
    } as never)

    const ref = {
      domain: 'research' as const,
      kind: 'source' as const,
      projectId: 'proj_1',
      sessionId: 'sess_h',
      sourceId: 'src_1',
    }
    const snapshot = {
      ...createEditorState({ ref, writerId: 'w-1', transportAvailable: true }),
      phase: 'ready' as const,
      loading: false,
      revision: 2,
      intentHash: 'hash-2',
      draftToken: 'draft_2',
      baseScope: { mode: 'selected' as const, sourceIds: ['src_1'], singleSourceId: 'src_1' },
      draftText: '历史会话的问题',
      dirty: true,
    }
    const hold = vi.fn()
    const release = vi.fn()
    vi.mocked(useResearchEditor).mockImplementation((() =>
      activeRef === null
        ? {
            snapshot: null,
            controller: null,
            setDraftText: vi.fn(),
            flush: vi.fn(async () => 'saved'),
            hold,
            release,
            clearAfterSubmission: vi.fn(async () => 'cleared'),
          }
        : {
            snapshot,
            controller: { getSnapshot: () => snapshot },
            setDraftText: vi.fn(),
            flush: vi.fn(async () => 'saved'),
            hold,
            release,
            clearAfterSubmission: vi.fn(async () => 'cleared'),
          }) as never)

    const conversationSend = vi.fn(async (_input: Record<string, unknown>) => ({ status: 'ok' }))
    const chat = makeChatResult({
      sessions: [
        { session_id: 'sess_h', title: '历史会话', updated_at: '2026-01-01T00:00:00Z' } as never,
      ],
      conversation: {
        send: conversationSend,
        getSnapshot: () => ({ turn: null, history: [] }),
        subscribe: () => () => {},
        notifyClearSettled: vi.fn(),
      } as never,
    })
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)

    const { rerender } = render(
      <ResearchSourceChatPanel projectId="proj_1" sourceId="src_1" onHighlightPage={vi.fn()} />,
    )
    // 新会话态：legacy 输入可见
    expect(screen.getByTestId('srcchat-input')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('srcchat-session-sess_h'))
    expect(activate).toHaveBeenCalledWith('source', {
      domain: 'research',
      kind: 'source',
      projectId: 'proj_1',
      sessionId: 'sess_h',
      sourceId: 'src_1',
    })

    // runtime 快照变化 → 重渲染：editor/controller 恢复（wired composer）
    rerender(
      <ResearchSourceChatPanel projectId="proj_1" sourceId="src_1" onHighlightPage={vi.fn()} />,
    )
    expect(screen.getByTestId('research-draft-composer')).toBeInTheDocument()
    expect(screen.getByTestId('srcchat-draft-scope')).toBeInTheDocument()
    expect(screen.queryByTestId('srcchat-input')).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-send'))
    })
    expect(conversationSend).toHaveBeenCalledTimes(1)
    expect(conversationSend.mock.calls[0][0]).toMatchObject({
      query: '历史会话的问题',
      editorRevision: 2,
      draftToken: 'draft_2',
    })
    expect(chat.send).not.toHaveBeenCalled()
  })

  it('PR-5b（Codex 复核 P1）：source 重复提问不得消费历史答案，durable 元数据保留', () => {
    const liveTurn = {
      identity: {
        authGeneration: 1,
        sessionKey: 'source:proj_1:src_1:sess_src',
        sessionId: 'sess_src',
        turnId: 'turn-new',
        draftToken: 'draft_new',
        attempt: 1,
        detached: false,
        terminal: null,
        generationId: 'gen_new',
        observedRevision: null,
      },
      state: 'streaming',
      sse: {
        answer: '',
        thinking: '',
        citations: [],
        usage: null,
        resolvedMode: null,
        terminal: null,
        errorCode: null,
        errorMessage: null,
        contextReport: null,
        contextCoverage: null,
      },
      query: '重复问题',
      operationId: 'op-1',
      accepted: null,
      errorCode: null,
      errorMessage: null,
      gapDetected: false,
      lookup: null,
      clearPending: false,
      incomplete: false,
      external: false,
    }
    vi.mocked(useResearchSourceChat).mockReturnValue(
      makeChatResult({
        turns: [
          {
            id: 'old-user',
            role: 'user',
            content: '重复问题',
            thinking: '',
            citations: [],
            usage: null,
            resolvedMode: null,
            degradationReasons: [],
            sourceRef: null,
            status: 'done',
            reconnectCount: 0,
            errorCode: null,
            errorMessage: null,
          },
          {
            id: 'old-assistant',
            role: 'assistant',
            content: '旧答案',
            thinking: '',
            citations: [],
            usage: { input_tokens: 7, output_tokens: 3 },
            resolvedMode: null,
            degradationReasons: [],
            sourceRef: null,
            status: 'done',
            reconnectCount: 0,
            errorCode: null,
            errorMessage: null,
          },
        ],
        conversation: {
          getSnapshot: () => ({ turn: liveTurn, history: [] }),
          subscribe: () => () => {},
          send: vi.fn(),
        } as never,
      }),
    )
    renderPanel()
    expect(screen.getAllByText('旧答案')).toHaveLength(1)
    // 历史问句必须保留（不能只凭同 query 删除 durable user，破坏旧问答配对）
    expect(screen.getAllByText('重复问题')).toHaveLength(2)
    // 新轮空 answer 保持空占位（没有吞掉旧答案）
    expect(screen.getByText('research.chatNoAnswer')).toBeInTheDocument()
    // durable 行保留自身元数据（usage 徽标），且不伪造成新轮
    expect(screen.getByTestId('srcchat-turn-meta-old-assistant')).toBeInTheDocument()
    expect(screen.queryByTestId('srcchat-turn-meta-turn-new')).not.toBeInTheDocument()
  })
})