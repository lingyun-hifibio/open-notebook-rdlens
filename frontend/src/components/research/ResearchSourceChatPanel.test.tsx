import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ResearchSourceChatPanel } from './ResearchSourceChatPanel'
import { useResearchSourceChat } from '@/lib/hooks/use-research-source-chat'

// Issue #182 Red：Source Chat 面板——新会话/会话选择、消息气泡、citation
// 点击高亮联动（onHighlightPage）、streaming 输入禁用、两类错误文案与重试。

vi.mock('@/lib/hooks/use-research-source-chat', () => ({
  useResearchSourceChat: vi.fn(),
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
    vi.mocked(useResearchSourceChat).mockReturnValue(makeChatResult())
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

  it('输入非空回车发送并清空输入框', () => {
    const chat = makeChatResult()
    vi.mocked(useResearchSourceChat).mockReturnValue(chat)
    renderPanel()

    const input = screen.getByTestId('srcchat-input')
    fireEvent.change(input, { target: { value: '这篇论文的结论？' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(chat.send).toHaveBeenCalledWith('这篇论文的结论？')

    // 空白不发送
    vi.mocked(chat.send).mockClear()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(chat.send).not.toHaveBeenCalled()
  })
})
