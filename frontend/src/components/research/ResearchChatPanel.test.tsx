import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ResearchChatPanel } from './ResearchChatPanel'
import type { ResearchChatTurn } from '@/lib/hooks/use-research-chat'
import type { ResearchCitation, ResearchJob } from '@/lib/research/types'

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
    coverageJobId: null,
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

function renderPanel(
  turns: ResearchChatTurn[],
  send = vi.fn(),
  overrides: Partial<{
    onSendCoverage: (q: string) => Promise<boolean>
    selectedSourceIds: string[]
    selectedNoteIds: string[]
    coverageJobs: ResearchJob[]
    onCoverageRetry: (jobId: string) => Promise<boolean>
  }> = {},
) {
  return render(
    <ResearchChatPanel
      turns={turns}
      isStreaming={false}
      onSend={send}
      onSendCoverage={overrides.onSendCoverage ?? vi.fn(async () => true)}
      selectedSourceIds={overrides.selectedSourceIds ?? []}
      selectedNoteIds={overrides.selectedNoteIds ?? []}
      coverageJobs={overrides.coverageJobs}
      onCoverageRetry={overrides.onCoverageRetry ?? vi.fn(async () => true)}
    />,
  )
}

describe('ResearchChatPanel', () => {
  afterEach(cleanup)

  it('渲染 thinking/answer/citation/usage/resolved_mode（REQ-ENG-04；COV-09 raw Thinking 防御性丢弃）', () => {
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
    // COV-09：raw thinking 内容绝不进入用户内容——只展示固定进度摘要
    expect(screen.queryByText('思考过程')).not.toBeInTheDocument()
    expect(screen.getByText('research.chatThinkingNotice')).toBeInTheDocument()
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

// ── COV-09：合成范围选择与 Coverage 任务卡（§12.3） ──

describe('ResearchChatPanel coverage scope（COV-09）', () => {
  afterEach(cleanup)

  function coverageJob(): ResearchJob {
    return {
      job_id: 'job_cov',
      project_id: 'proj_1',
      job_type: 'research_coverage',
      status: 'running',
      stage: 'per_doc_analysis',
      progress: 0.5,
      model_id: 'm-local',
      generation_epoch: 1,
      retry_count: 0,
      last_error: null,
      result_ref: null,
      created_at: '2026-08-06T02:00:00Z',
      updated_at: '2026-08-06T02:00:00Z',
      coverage: {
        synthesis_scope: 'all_selected',
        contract_version: 'v1',
        execution_plan_version: 'v2',
        prompt_bundle_version: 'v1',
        generation_id: 'gen_1',
        target_coverage: { requested: 2, analyzed: 1, failed: 1, status: 'partial' },
        target_results: [
          { target_kind: 'source', document_id: 'doc-1', document_revision: 'v1', status: 'analyzed', failure_code: null },
          { target_kind: 'source', document_id: 'doc-2', document_revision: 'v1', status: 'failed', failure_code: 'document_unit_terminal' },
        ],
      },
    }
  }

  it('显式展示相关证据回答与覆盖全部所选来源（REQ-COV-01 不依赖意图猜测）', () => {
    renderPanel([])
    expect(screen.getByText('research.coverage.scopeRelevant')).toBeInTheDocument()
    expect(screen.getByText('research.coverage.scopeAllSelected')).toBeInTheDocument()
  })

  it('选择 Notes 时 all_selected 选项禁用 + 可访问文字说明（不只颜色）', () => {
    renderPanel([], vi.fn(), { selectedNoteIds: ['n1'] })
    const option = screen.getByTestId('scope-all-selected-option')
    expect(option).toBeDisabled()
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.notesNotSupported')
  })

  it('0 Source：提示选择来源；51+ Source：前端预检文案且不可提交', () => {
    renderPanel([], vi.fn(), {})
    // 0 个 Source：hint 可见
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.noSourcesHint')
    // 51 个 Source：预检错误文案
    cleanup()
    renderPanel([], vi.fn(), { selectedSourceIds: Array.from({ length: 51 }, (_, i) => `src-${i}`) })
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.tooManySources')
    expect(screen.getByTestId('chat-send')).toBeDisabled()
  })

  it('all_selected 提交：调用 onSendCoverage（202 受理后清空输入）', async () => {
    const onSendCoverage = vi.fn(async () => true)
    renderPanel([], vi.fn(), {
      onSendCoverage,
      selectedSourceIds: ['src-1'],
    })
    fireEvent.click(screen.getByTestId('scope-all-selected-option'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '覆盖全部所选来源' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    expect(onSendCoverage).toHaveBeenCalledWith('覆盖全部所选来源')
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveValue(''))
  })

  it('relevant 提交：仍然走 onSend（旧路径不变）', () => {
    const onSend = vi.fn(async () => true)
    renderPanel([], onSend, { selectedSourceIds: ['src-1'] })
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '普通问题' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    expect(onSend).toHaveBeenCalledWith('普通问题', { sourceIds: ['src-1'], noteIds: [] })
  })

  it('coverage turn：渲染 CoverageJobDetails（逐文档状态）', () => {
    renderPanel(
      [
        { ...turn({ role: 'user', content: '覆盖全部所选来源', id: 'u1' }) },
        turn({ status: 'done', coverageJobId: 'job_cov' }),
      ],
      vi.fn(),
      { coverageJobs: [coverageJob()] },
    )
    expect(screen.getByTestId('coverage-job-details')).toBeInTheDocument()
    expect(screen.getByTestId('coverage-target-coverage')).toHaveTextContent('requested: 2')
    expect(screen.getByTestId('coverage-target-doc-2')).toHaveTextContent('document_unit_terminal')
  })
})
