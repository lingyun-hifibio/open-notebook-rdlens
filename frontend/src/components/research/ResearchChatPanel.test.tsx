import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ResearchChatPanel } from './ResearchChatPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope, type ResearchScopeSnapshot } from '@/lib/research/scope'
import type { ResearchBackgroundNotice, ResearchChatTurn } from '@/lib/hooks/use-research-chat'
import type { ResearchCitation, ResearchJob } from '@/lib/research/types'

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return { ...actual, saveResultFromResult: vi.fn() }
})
import { saveResultFromResult } from '@/lib/research/api'

// UI-03 Red：Chat 面板展示（REQ-ENG-04）——thinking/answer/citation/usage/
// resolved_mode 流式渲染；重连提示；错误可重试标记；Citation 页码按
// page_idx + 1 展示（契约 §13.2，page_idx 0-based）。
// RWV2-11（K7/K8/K12）：面板直接消费共享 ResearchScopeProvider——测试经
// localStorage 预置范围；retry 复用 turn.scopeSnapshot（null 不渲染重试）；
// Coverage 只允许 selected 模式 1..50 Source；entire_project 显示专属说明。

const USER_ID = 'u1'
const PROJECT_ID = 'p1'
const SCOPE_A: ResearchScopeSnapshot = { mode: 'selected', sourceIds: ['src_1'], noteIds: [] }

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
    // RWV2-11（W5）：必填字段——测试工厂默认 null（恢复轮形态）
    scopeSnapshot: null,
    // RWV2-23（D2）：默认未解析（live 轮形态）；用例需要恢复轮时显式传
    // serverMessageId/generationId
    serverMessageId: null,
    generationId: null,
    ...overrides,
  }
}

function seedScope(scope: { mode: 'entire_project' | 'selected'; sourceIds: readonly string[]; noteIds: readonly string[] }): void {
  localStorage.setItem(
    scopeStorageKey(USER_ID, PROJECT_ID),
    JSON.stringify({ version: 1, ...scope }),
  )
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
    onSendCoverage: (q: string, snapshot: ResearchScopeSnapshot) => Promise<boolean>
    scope: { mode: 'entire_project' | 'selected'; sourceIds: string[]; noteIds: string[] }
    coverageJobs: ResearchJob[]
    onCoverageRetry: (jobId: string) => Promise<boolean>
    resolveChatOrigin: (turnId: string) => Promise<{ messageId: string; generationId: string } | null>
  }> = {},
) {
  if (overrides.scope) seedScope(overrides.scope)
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
  return render(
    <QueryClientProvider client={queryClient}>
    <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
    <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
      <ResearchChatPanel
        turns={turns}
        isStreaming={false}
        onSend={send}
        onSendCoverage={overrides.onSendCoverage ?? vi.fn(async () => true)}
        coverageJobs={overrides.coverageJobs}
        onCoverageRetry={overrides.onCoverageRetry ?? vi.fn(async () => true)}
        resolveChatOrigin={overrides.resolveChatOrigin}
      />
    </ResearchScopeProvider>
    </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
}

function renderPanelWithNotice(notice: ResearchBackgroundNotice) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
        <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
          <ResearchChatPanel
            turns={[]}
            isStreaming={false}
            onSend={vi.fn()}
            onSendCoverage={vi.fn(async () => true)}
            backgroundNotice={notice}
          />
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
}

/**
 * RWV2-11（P1-2）：面板旁挂一个真实驱动 Provider 的 toggle——测试必须通过
 * Provider 方法改变当前 Scope（localStorage 预置只在挂载时生效，挂载后再写
 * localStorage 对已挂载 Provider 无效，无法制造「当前 Scope ≠ turn 快照」）。
 */
function ToggleNoteHarness() {
  const { toggleNote } = useResearchScope()
  return (
    <button type="button" data-testid="add-note" onClick={() => toggleNote('n1')}>
      add note n1
    </button>
  )
}

function renderPanelWithNoteHarness(turns: ResearchChatTurn[], send = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
        <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
          <ResearchChatPanel
            turns={turns}
            isStreaming={false}
            onSend={send}
            onSendCoverage={vi.fn(async () => true)}
          />
          <ToggleNoteHarness />
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
}

describe('ResearchChatPanel', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

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

  it('会话内 turn 显示派发 Scope 徽标；恢复 turn（null 快照）不显示', () => {
    renderPanel([
      { ...turn({ role: 'user', content: '问题', id: 'u1', scopeSnapshot: SCOPE_A }) },
      turn({ status: 'done' }),
    ])
    // P2-③：徽标外层 key 在此文件平 mock 下直接可见；标签内容（"1 source"）
    // 的正确性由 formatScopeLabel 单测覆盖（scope.test.tsx）
    expect(screen.getByTestId('chat-turn-scope-badge')).toHaveTextContent(
      'research.chatScopeBadge',
    )
    // 恢复轮（scopeSnapshot null）不显示徽标
    cleanup()
    renderPanel([
      { ...turn({ role: 'user', content: '恢复问题', id: 'u2' }) },
      turn({ status: 'done' }),
    ])
    expect(screen.queryAllByTestId('chat-turn-scope-badge')).toHaveLength(0)
  })

  it('重连中显示重连徽标与次数', () => {
    renderPanel([turn({ status: 'reconnecting', reconnectCount: 2 })])
    expect(screen.getByText(/reconnect/i)).toBeInTheDocument()
  })

  it('错误终态显示 code 与可重试标记；重试按钮用 turn 快照重新发送（R1）', () => {
    const send = vi.fn()
    const turns = [
      { ...turn({ role: 'user', content: '原问题', id: 'u1' }) },
      turn({
        status: 'error',
        errorCode: 'admission_unavailable',
        errorMessage: '容量不足',
        scopeSnapshot: SCOPE_A,
      }),
    ]
    // P1-2：先按 turn 快照 A（src_1）预置，再通过真实 Provider toggle 加入
    // note n1 ——当前 Scope 变为 {src_1, n1} ≠ turn 快照 A。旧实现（重试读
    // 当前 Provider）会发送 {src_1, n1}，新实现（读 turn 快照）发送 A——
    // 断言可真实区分 K12 行为。
    seedScope(SCOPE_A)
    renderPanelWithNoteHarness(turns, send)
    // RWV2-42：主提示为集中映射文案（t() 返回键名），raw code 不作主消息；
    // errorMessage 保留为诊断行
    expect(
      screen.getByText('research.errors.admissionUnavailable'),
    ).toBeInTheDocument()
    expect(screen.queryByText('admission_unavailable')).toBeNull()
    expect(screen.getByText('容量不足')).toBeInTheDocument()
    expect(screen.getByText(/retryable/i)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('add-note'))
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(send).toHaveBeenCalledWith('原问题', {
      mode: 'selected',
      sourceIds: ['src_1'],
      noteIds: [],
    })
  })

  it('可重试错误但 turn 快照为 null（恢复轮）不渲染重试按钮（R5/K12）', () => {
    renderPanel([
      { ...turn({ role: 'user', content: '原问题', id: 'u1' }) },
      turn({ status: 'error', errorCode: 'admission_unavailable', errorMessage: 'x' }),
    ])
    expect(screen.getByTestId('chat-error')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('非可重试错误（project_deleted）不显示重试按钮', () => {
    renderPanel([turn({ status: 'error', errorCode: 'project_deleted', errorMessage: '已删除' })])
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('流式状态显示进行中标记', () => {
    renderPanel([turn({ status: 'streaming', content: '半截答案' })])
    expect(screen.getByText('半截答案')).toBeInTheDocument()
  })

  it('#302：恢复后在途后台轮显示静态提示，不渲染假「进行中」', () => {
    renderPanelWithNotice({ kind: 'running', count: 1, failureCode: null })
    const notice = screen.getByTestId('chat-restore-notice')
    // 测试环境 i18n 渲染原始 key（既有用例同款约定）
    expect(notice).toHaveTextContent('research.chatRestoreRunning')
    expect(screen.queryByTestId('chat-streaming')).toBeNull()
  })

  it('#302：恢复后失败后台轮显示 failure_code（诚实呈现未完成）', () => {
    renderPanelWithNotice({
      kind: 'failed',
      count: 1,
      failureCode: 'delivery_dead_letter',
    })
    expect(screen.getByTestId('chat-restore-notice')).toHaveTextContent(
      /research\.chatRestoreFailed · delivery_dead_letter/,
    )
  })

  it('#302：未传 backgroundNotice（默认/无在途轮）不渲染提示', () => {
    renderPanel([])
    expect(screen.queryByTestId('chat-restore-notice')).toBeNull()
  })
})

// ── COV-09：合成范围选择与 Coverage 任务卡（§12.3） ──

describe('ResearchChatPanel coverage scope（COV-09 + RWV2-11 K3）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

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
    renderPanel([], vi.fn(), { scope: { mode: 'selected', sourceIds: [], noteIds: ['n1'] } })
    const option = screen.getByTestId('scope-all-selected-option')
    expect(option).toBeDisabled()
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.notesNotSupported')
  })

  it('entire_project 模式：专属说明（不命中旧 noSourcesHint）+ 提交禁用（R4/W4）', () => {
    renderPanel([], vi.fn(), { scope: { mode: 'entire_project', sourceIds: [], noteIds: [] } })
    const notice = screen.getByTestId('coverage-scope-notice')
    expect(notice).toHaveTextContent('research.coverage.entireProjectNotice')
    expect(notice).not.toHaveTextContent('research.coverage.noSourcesHint')
    // 切到 all_selected 后提交仍被模式闸门禁用
    fireEvent.click(screen.getByTestId('scope-all-selected-option'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '覆盖全部' } })
    expect(screen.getByTestId('chat-send')).toBeDisabled()
  })

  it('selected 51+ Source：前端预检文案且不可提交', () => {
    renderPanel([], vi.fn(), {
      scope: {
        mode: 'selected',
        sourceIds: Array.from({ length: 51 }, (_, i) => `src-${i}`),
        noteIds: [],
      },
    })
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent('research.coverage.tooManySources')
    expect(screen.getByTestId('chat-send')).toBeDisabled()
  })

  it('all_selected 提交：经 onSendCoverage 携带派发快照（202 受理后清空输入）', async () => {
    const onSendCoverage = vi.fn(async () => true)
    renderPanel([], vi.fn(), {
      onSendCoverage,
      scope: { mode: 'selected', sourceIds: ['src-1'], noteIds: [] },
    })
    fireEvent.click(screen.getByTestId('scope-all-selected-option'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '覆盖全部所选来源' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    expect(onSendCoverage).toHaveBeenCalledWith('覆盖全部所选来源', {
      mode: 'selected',
      sourceIds: ['src-1'],
      noteIds: [],
    })
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveValue(''))
  })

  it('relevant 提交：仍然走 onSend（快照 selection 携带 mode）', () => {
    const onSend = vi.fn(async () => true)
    renderPanel([], onSend, { scope: { mode: 'selected', sourceIds: ['src-1'], noteIds: [] } })
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '普通问题' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    expect(onSend).toHaveBeenCalledWith('普通问题', {
      mode: 'selected',
      sourceIds: ['src-1'],
      noteIds: [],
    })
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

// ── #292 P0：错误呈现——error 空正文不再显示「暂无答案」；稳定码展示
// 面向用户的本地化文案（测试环境 t() 返回键名），errorMessage 仅作诊断行 ──

describe('ResearchChatPanel #292 P0 错误呈现', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('error 且空正文：不渲染「暂无答案」占位，仅错误卡片', () => {
    renderPanel([
      turn({ status: 'error', errorCode: 'daily_limit_exceeded', errorMessage: 'external generation failed' }),
    ])
    expect(screen.queryByText('research.chatNoAnswer')).toBeNull()
    expect(screen.getByTestId('chat-error')).toBeInTheDocument()
  })

  it('非 error 空正文仍显示占位（done/streaming 不受影响）', () => {
    renderPanel([turn({ status: 'done', content: '' })])
    expect(screen.getByText('research.chatNoAnswer')).toBeInTheDocument()
  })

  it('daily_limit_exceeded：主提示为本地化用户文案，原始消息仅作诊断行', () => {
    renderPanel([
      turn({ status: 'error', errorCode: 'daily_limit_exceeded', errorMessage: 'external generation failed' }),
    ])
    expect(screen.getByText('research.chatErrorDailyLimitExceeded')).toBeInTheDocument()
    // 原始 code 不再作为主提示；errorMessage 保留为诊断信息
    expect(screen.queryByText('daily_limit_exceeded')).toBeNull()
    expect(screen.getByText('external generation failed')).toBeInTheDocument()
  })

  it('superseded：展示本地化用户文案，不展示裸 code 主提示', () => {
    renderPanel([
      turn({ status: 'error', errorCode: 'superseded', errorMessage: 'Superseded by a newer request' }),
    ])
    expect(screen.getByText('research.chatErrorSuperseded')).toBeInTheDocument()
    expect(screen.queryByText('superseded')).toBeNull()
  })

  it('error 但已有部分正文：正文与错误卡片共存', () => {
    renderPanel([
      turn({ status: 'error', content: '半截答案', errorCode: 'stream_lost', errorMessage: 'Connection lost' }),
    ])
    expect(screen.getByText('半截答案')).toBeInTheDocument()
    expect(screen.getByTestId('chat-error')).toBeInTheDocument()
    expect(screen.queryByText('research.chatNoAnswer')).toBeNull()
  })
})
describe('ResearchChatPanel RWV2-23 result actions', () => {
  const GEN = 'gen_' + 'a'.repeat(32)

  it('完成的 Chat 答案（有 generationId）提供 Save as Insight/Note 与 Copy', () => {
    renderPanel([
      turn({ role: 'user', content: 'q?', id: 'user_t1' }),
      turn({ id: 't1', content: 'answer', status: 'done', generationId: GEN }),
    ])
    expect(screen.getByTestId('save-as-insight')).toBeTruthy()
    expect(screen.getByTestId('save-as-note')).toBeTruthy()
    expect(screen.getByTestId('copy-result')).toBeTruthy()
  })

  it('live 轮未解析：点击 Save 先 resolve 再保存（成功显示已保存态）', async () => {
    const GEN2 = 'gen_' + 'b'.repeat(32)
    const api = vi.mocked(saveResultFromResult)
    api.mockResolvedValue({
      note_id: 'note_x', project_id: PROJECT_ID, title: 'Saved chat result',
      content: 'answer', note_type: 'human', created_at: null, updated_at: null,
      citations: [], provenance: { envelope_version: 1, kind: 'save_from_result', origin_kind: 'chat', origin_id: GEN2, destination_kind: 'note', scope: { source_ids: [], note_ids: [] }, model_id: 'm', response_language: 'en', saved_at: 'x', saved_by_user_id: 1, source_timestamps: {} },
    })
    const resolve = vi.fn(async () => ({ messageId: `msg_${GEN2}_assistant`, generationId: GEN2 }))
    renderPanel([
      turn({ role: 'user', content: 'q?', id: 'user_t1' }),
      turn({ id: 't1', content: 'answer', status: 'done' }),
    ], vi.fn(), { resolveChatOrigin: resolve })
    // live 未解析（serverMessageId/generationId null）：经 resolveOriginId 惰性解析
    fireEvent.click(screen.getByTestId('save-as-note'))
    await waitFor(() => expect(screen.getByTestId('saved-note')).toBeTruthy())
    expect(resolve).toHaveBeenCalledWith('t1')
    expect(api).toHaveBeenCalledWith(PROJECT_ID, {
      origin_kind: 'chat',
      origin_id: GEN2,
      destination_kind: 'note',
    })
  })

  it('恢复行但 message_id 不可解析：Save 禁用并显示英文原因文案（不猜测）', () => {
    renderPanel([
      turn({ role: 'user', content: 'q?', id: 'user_t1' }),
      turn({
        id: 't1', content: 'answer', status: 'done',
        serverMessageId: `msg_req_${'1'.repeat(16)}_assistant`, generationId: null,
      }),
    ])
    expect((screen.getByTestId('save-as-insight') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('save-as-note') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('result-action-status')).toHaveTextContent(
      'research.resultActions.chatSaveUnavailable',
    )
  })

  it('coverage turn / streaming / error 轮不渲染结果动作', () => {
    renderPanel([
      turn({ role: 'user', content: 'q', id: 'u0' }),
      turn({ id: 't0', content: '', status: 'streaming' }),
      turn({ id: 't1', content: 'err', status: 'error', errorCode: 'http_error' }),
      turn({ id: 't2', content: 'cov', status: 'done', coverageJobId: 'j1' }),
    ])
    expect(screen.queryAllByTestId('result-actions')).toHaveLength(0)
  })
})

describe('ResearchChatPanel continue-research prefill（RWV2-23 AC4）', () => {
  it('无 prefill：composer 保持空', () => {
    renderPanel([])
    expect((screen.getByTestId('chat-input') as HTMLInputElement).value).toBe('')
  })

  it('带 prefill 的渲染会预填 composer 文本', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            <ResearchChatPanel
              turns={[]}
              isStreaming={false}
              onSend={vi.fn(async () => true)}
              onSendCoverage={vi.fn(async () => true)}
              prefill={{ text: 'Continue from this result: excerpt', seq: 1 }}
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
    expect((screen.getByTestId('chat-input') as HTMLInputElement).value).toBe(
      'Continue from this result: excerpt',
    )
    // 不自动派发
    expect(screen.getByTestId('chat-send')).toBeTruthy()
  })

  it('prefill seq 递增更新 composer（keep-alive 轮）', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            <ResearchChatPanel
              turns={[]}
              isStreaming={false}
              onSend={vi.fn(async () => true)}
              onSendCoverage={vi.fn(async () => true)}
              prefill={{ text: 'draft v1', seq: 1 }}
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
    rerender(
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            <ResearchChatPanel
              turns={[]}
              isStreaming={false}
              onSend={vi.fn(async () => true)}
              onSendCoverage={vi.fn(async () => true)}
              prefill={{ text: 'draft v2', seq: 2 }}
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
    expect((screen.getByTestId('chat-input') as HTMLInputElement).value).toBe('draft v2')
  })
})
