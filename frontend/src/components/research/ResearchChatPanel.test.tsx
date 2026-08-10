import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ResearchChatPanel } from './ResearchChatPanel'
import type { ResearchChatTurn } from '@/lib/hooks/use-research-chat'
import type { ResearchCitation } from '@/lib/research/types'

// UI-03 Red：Chat 面板展示（REQ-ENG-04）——thinking/answer/citation/usage/
// resolved_mode 流式渲染；重连提示；错误可重试标记；Citation 页码按
// page_idx + 1 展示（契约 §13.2，page_idx 0-based）。

function turn(overrides: Partial<ResearchChatTurn>): ResearchChatTurn {
  return {
    id: 't1',
    role: 'assistant',
    content: '',
    thinking: '',
    citations: [],
    usage: null,
    resolvedMode: null,
    status: 'done',
    reconnectCount: 0,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  }
}

const citation: ResearchCitation = {
  citation_id: 1,
  claim: 'claim-text',
  doc_id: 'doc_1',
  doc_version: 'v3',
  chunk_id: 'chunk_1',
  page_idx: 3,
  original_text: 'original-text',
  citation_type: 'direct',
  confidence: 'high',
}

function renderPanel(turns: ResearchChatTurn[], send = vi.fn()) {
  return render(
    <ResearchChatPanel
      turns={turns}
      isStreaming={false}
      onSend={send}
      selectedSourceIds={[]}
      selectedNoteIds={[]}
    />,
  )
}

describe('ResearchChatPanel', () => {
  afterEach(cleanup)

  it('渲染 thinking/answer/citation/usage/resolved_mode（REQ-ENG-04）', () => {
    const turns = [
      { ...turn({ role: 'user', content: '问题', id: 'u1' }) },
      turn({
        thinking: '思考过程',
        content: '最终答案',
        citations: [citation],
        usage: { input_tokens: 1200, thinking_tokens: 400, output_tokens: 300 },
        resolvedMode: 'hybrid_rag',
        status: 'done',
      }),
    ]
    renderPanel(turns)
    expect(screen.getByText('问题')).toBeInTheDocument()
    expect(screen.getByText('最终答案')).toBeInTheDocument()
    expect(screen.getByText('思考过程')).toBeInTheDocument()
    expect(screen.getByText('claim-text')).toBeInTheDocument()
    // page_idx 0-based → 展示 4
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('hybrid_rag')).toBeInTheDocument()
    expect(screen.getByText(/1200/)).toBeInTheDocument()
  })

  it('重连中显示重连徽标与次数', () => {
    renderPanel([turn({ status: 'reconnecting', reconnectCount: 2 })])
    expect(screen.getByText(/reconnect/i)).toBeInTheDocument()
  })

  it('错误终态显示 code 与可重试标记；重试按钮重新发送', () => {
    const send = vi.fn()
    const turns = [
      { ...turn({ role: 'user', content: '原问题', id: 'u1' }) },
      turn({ status: 'error', errorCode: 'admission_unavailable', errorMessage: '容量不足' }),
    ]
    renderPanel(turns, send)
    expect(screen.getByText('admission_unavailable')).toBeInTheDocument()
    expect(screen.getByText(/retryable/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(send).toHaveBeenCalledWith('原问题', expect.anything())
  })

  it('非可重试错误（project_deleted）不显示重试按钮', () => {
    renderPanel([turn({ status: 'error', errorCode: 'project_deleted', errorMessage: '已删除' })])
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('流式状态显示进行中标记', () => {
    renderPanel([turn({ status: 'streaming', content: '半截答案' })])
    expect(screen.getByText('半截答案')).toBeInTheDocument()
  })
})
