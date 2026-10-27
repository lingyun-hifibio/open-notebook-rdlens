import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  ResearchChatPanel,
  type BackgroundJobSubmitResult,
} from './ResearchChatPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope, type ResearchScopeSnapshot } from '@/lib/research/scope'
import type { CoverageSubmitOutcome } from '@/lib/hooks/use-research-chat'
import { createEditorState } from '@/lib/research/editor-machine'
import type { WireChatAnchor } from '@/lib/research/session-contract'
import type {
  EditorSnapshot,
  ResearchConversationSnapshot,
} from '@/lib/research/types'
import type { ResearchSessionRef } from '@/lib/research/session-contract'
import { Profiler, useState } from 'react'
import type { ResearchBackgroundNotice, ResearchChatSelection, ResearchChatTurn } from '@/lib/hooks/use-research-chat'
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
// Coverage 只允许 selected 模式 1..50 Source；all 显示专属说明。

/** PR-5b：Coverage 受理结果为判别对象（202 + 标识 + 登记状态）。 */
const ACCEPTED_OUTCOME: CoverageSubmitOutcome = {
  status: 'accepted',
  jobId: 'job_1',
  generationId: 'gen_1',
  registration: 'registered',
}

const USER_ID = 'u1'
const PROJECT_ID = 'p1'
const SCOPE_A: ResearchScopeSnapshot = { mode: 'selected', sourceIds: ['src_1'], noteIds: [], singleSourceId: null }

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

function seedScope(scope: ResearchScopeSnapshot | { mode: 'all' | 'selected'; sourceIds: readonly string[]; noteIds: readonly string[] }): void {
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
    onSendCoverage: (q: string, snapshot: ResearchScopeSnapshot) => Promise<CoverageSubmitOutcome>
    scope: { mode: 'all' | 'selected'; sourceIds: string[]; noteIds: string[] }
    // #358：后端 Coverage 能力（默认 true 保 happy-path；能力关闭用例显式传 false）
    coverageEnabled: boolean
    coverageJobs: ResearchJob[]
    onCoverageRetry: (jobId: string) => Promise<boolean>
    resolveChatOrigin: (turnId: string) => Promise<{ messageId: string; generationId: string } | null>
    onRunAsBackgroundJob: (
      query: string,
      snapshot: ResearchScopeSnapshot,
      turnKey: string,
    ) => Promise<BackgroundJobSubmitResult>
    /** PR5（D-26）：后台 CTA 所在入口是否要求显式资料集合 */
    backgroundJobRequiresSelection: boolean
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
        onSendCoverage={overrides.onSendCoverage ?? vi.fn(async () => ACCEPTED_OUTCOME)}
        coverageEnabled={overrides.coverageEnabled ?? true}
        coverageJobs={overrides.coverageJobs}
        onCoverageRetry={overrides.onCoverageRetry ?? vi.fn(async () => true)}
        resolveChatOrigin={overrides.resolveChatOrigin}
        onRunAsBackgroundJob={overrides.onRunAsBackgroundJob}
        backgroundJobRequiresSelection={overrides.backgroundJobRequiresSelection ?? false}
      />
      <SinglePinControl />
    </ResearchScopeProvider>
    </ResearchWorkspaceProvider>
    </QueryClientProvider>,
  )
}

/**
 * PR5（T5）：把限定 pin 的设置与观察放进测试树——用于断言"提交派发**不**清除
 * 限定"（评审 LOW-13：只在 provider 层读两次快照测不到派发路径的清键行为）。
 */
function SinglePinControl() {
  const { setSingle, singlePin } = useResearchScope()
  return (
    <div>
      <button type="button" data-testid="ctl-set-single" onClick={() => setSingle('src_9', 'sess_1')}>
        single
      </button>
      <output data-testid="ctl-single-pin">{singlePin?.sourceId ?? 'none'}</output>
    </div>
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
            onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
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
            onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
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

  it('#439：persistent_job_required 不可重试，提供后台任务 CTA 并回显 job id', async () => {
    const onRunAsBackgroundJob = vi.fn(
      async (): Promise<BackgroundJobSubmitResult> => ({
        status: 'queued',
        jobId: 'job_bg_0439',
      }),
    )
    renderPanel(
      [
        turn({
          id: 'u1',
          role: 'user',
          content: 'Which biomarkers show response?',
          scopeSnapshot: SCOPE_A,
        }),
        turn({
          id: 'a1',
          status: 'error',
          errorCode: 'persistent_job_required',
          errorMessage: 'request requires a persistent job: extra_long_persistent_job',
          scopeSnapshot: SCOPE_A,
        }),
      ],
      vi.fn(),
      { onRunAsBackgroundJob },
    )
    // 主文案来自 #439 新映射（不得再显示“容量不足，稍后重试”）
    expect(screen.getByText('research.errors.persistentJobRequired')).toBeInTheDocument()
    expect(screen.queryByText('research.errors.admissionCapacity')).toBeNull()
    // 不可重试：无 Retry 按钮，只有后台任务 CTA
    expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull()
    fireEvent.click(screen.getByTestId('chat-persistent-job-submit'))
    await waitFor(() =>
      expect(onRunAsBackgroundJob).toHaveBeenCalledWith(
        'Which biomarkers show response?',
        SCOPE_A,
        'a1',
      ),
    )
    expect(await screen.findByTestId('chat-persistent-job-queued')).toHaveTextContent(
      'job_bg_0439',
    )
  })

  it('#439 评审修复：前序 user turn 非紧邻时仍取到提问；确认被取消不报失败', async () => {
    const onRunAsBackgroundJob = vi.fn(
      async (): Promise<BackgroundJobSubmitResult> => ({ status: 'not_dispatched' }),
    )
    renderPanel(
      [
        turn({ id: 'u1', role: 'user', content: '原问题', scopeSnapshot: SCOPE_A }),
        turn({ id: 'mid', status: 'done', content: '中间轮' }),
        turn({
          id: 'a1',
          status: 'error',
          errorCode: 'persistent_job_required',
          scopeSnapshot: SCOPE_A,
        }),
      ],
      vi.fn(),
      { onRunAsBackgroundJob },
    )
    fireEvent.click(screen.getByTestId('chat-persistent-job-submit'))
    await waitFor(() =>
      // 不假设紧邻：向前找到真正的 user turn
      expect(onRunAsBackgroundJob).toHaveBeenCalledWith('原问题', SCOPE_A, 'a1'),
    )
    // not_dispatched（确认弹窗取消）→ 不报失败、按钮保持可用
    expect(screen.queryByTestId('chat-persistent-job-error')).toBeNull()
    expect(screen.getByTestId('chat-persistent-job-submit')).not.toBeDisabled()
  })

  it('#439 评审修复：job_id 缺失仍按已受理展示，且成功后禁止重复提交', async () => {
    const onRunAsBackgroundJob = vi.fn(
      async (): Promise<BackgroundJobSubmitResult> => ({
        status: 'queued',
        jobId: null,
      }),
    )
    renderPanel(
      [
        turn({ id: 'u1', role: 'user', content: '原问题', scopeSnapshot: SCOPE_A }),
        turn({
          id: 'a1',
          status: 'error',
          errorCode: 'persistent_job_required',
          scopeSnapshot: SCOPE_A,
        }),
      ],
      vi.fn(),
      { onRunAsBackgroundJob },
    )
    fireEvent.click(screen.getByTestId('chat-persistent-job-submit'))
    // 测试环境 t() 回显 key（既有用例同款），断言受理提示的来源键
    expect(await screen.findByTestId('chat-persistent-job-queued')).toHaveTextContent(
      /research\.backgroundQueued/,
    )
    expect(screen.queryByTestId('chat-persistent-job-error')).toBeNull()
    // 受理后按钮禁用：再次点击不得产生第二个 Job
    const button = screen.getByTestId('chat-persistent-job-submit')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onRunAsBackgroundJob).toHaveBeenCalledTimes(1)
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

  it('all 模式：专属说明（不命中旧 noSourcesHint）+ 提交禁用（R4/W4）', () => {
    renderPanel([], vi.fn(), { scope: { mode: 'all', sourceIds: [], noteIds: [] } })
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
    const onSendCoverage = vi.fn(async () => ACCEPTED_OUTCOME)
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
      singleSourceId: null,
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
      singleSourceId: null,
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

  // ── #358：Coverage 能力门禁（§17.2） ──

  it('#358：能力关闭 → all_selected 禁用 + 能力说明（fail-closed）', () => {
    renderPanel([], vi.fn(), {
      coverageEnabled: false,
      scope: { mode: 'selected', sourceIds: ['src-1'], noteIds: [] },
    })
    expect(screen.getByTestId('scope-all-selected-option')).toBeDisabled()
    expect(screen.getByTestId('coverage-scope-notice')).toHaveTextContent(
      'research.coverage.capabilityDisabled',
    )
  })

  it('#358：能力关闭时已选 all_selected 也不发创建请求（提交闸门）', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    const onSendCoverage = vi.fn(async () => ACCEPTED_OUTCOME)
    // 预置 selected 范围（1 个 Source）——all_selected 仅适用于显式选择范围
    seedScope({ mode: 'selected', sourceIds: ['src-1'], noteIds: [], singleSourceId: null })
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            <ResearchChatPanel
              turns={[]}
              isStreaming={false}
              onSend={vi.fn(async () => true)}
              onSendCoverage={onSendCoverage}
              coverageEnabled
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
    // 能力开启时切到 all_selected 并输入（模拟开关翻转前已选中的用户）
    fireEvent.click(screen.getByTestId('scope-all-selected-option'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '覆盖全部所选来源' } })
    expect(screen.getByTestId('chat-send')).not.toBeDisabled()
    // 后端开关翻转 → 能力关闭：选项禁用 + 说明；提交被闸门拦截
    rerender(
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            <ResearchChatPanel
              turns={[]}
              isStreaming={false}
              onSend={vi.fn(async () => true)}
              onSendCoverage={onSendCoverage}
              coverageEnabled={false}
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('scope-all-selected-option')).toBeDisabled()
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    fireEvent.click(screen.getByTestId('chat-send'))
    expect(onSendCoverage).not.toHaveBeenCalled()
  })

  it('#358：能力关闭后既有 Coverage Job 仍展示并轮询（准入开关非终止开关）', () => {
    renderPanel(
      [
        { ...turn({ role: 'user', content: '覆盖全部所选来源', id: 'u1' }) },
        turn({ status: 'done', coverageJobId: 'job_cov' }),
      ],
      vi.fn(),
      { coverageEnabled: false, coverageJobs: [coverageJob()] },
    )
    expect(screen.getByTestId('coverage-job-details')).toBeInTheDocument()
    expect(screen.getByTestId('coverage-target-coverage')).toHaveTextContent('requested: 2')
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

  it('#358：coverage_not_enabled 展示明确本地化文案，后端 message 作诊断行', () => {
    renderPanel([
      turn({
        status: 'error',
        errorCode: 'coverage_not_enabled',
        errorMessage: 'research coverage is not enabled; relevant synthesis remains available',
      }),
    ])
    expect(screen.getByText('research.chatErrorCoverageNotEnabled')).toBeInTheDocument()
    // 裸 code 不作主提示；后端结构化 message 保留为诊断行
    expect(screen.queryByText('coverage_not_enabled')).toBeNull()
    expect(
      screen.getByText('research coverage is not enabled; relevant synthesis remains available'),
    ).toBeInTheDocument()
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
              onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
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
              onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
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
              onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
              prefill={{ text: 'draft v2', seq: 2 }}
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
    expect((screen.getByTestId('chat-input') as HTMLInputElement).value).toBe('draft v2')
  })
})

/**
 * PR5：T9（历史范围不得被冒充 / 范围不可用）+ D-26（后台 CTA 的 D-11 门禁与
 * 文案）。单列一个 describe 是因为这两条都是"呈现与门禁"的语义断言，
 * 而既有用例集中在流式渲染与 Save 链路。
 */
describe('ResearchChatPanel · 范围呈现与后台 CTA 门禁（T9 / D-26）', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
  })

  it('T5：提交派发不清除 single 限定，且派发载荷带 single（同会话连续两轮）', async () => {
    const send = vi.fn(async (_query: string, _selection?: ResearchChatSelection) => true)
    renderPanel([], send, { scope: { mode: 'selected', sourceIds: [], noteIds: [] } })

    fireEvent.click(screen.getByTestId('ctl-set-single'))
    expect(screen.getByTestId('ctl-single-pin')).toHaveTextContent('src_9')

    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题一' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.chatSend' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    // 派发载荷携带 single 与限定来源
    expect(send.mock.calls[0][1]).toMatchObject({ mode: 'single', singleSourceId: 'src_9' })
    // **提交本身不清除限定**（第二次派发仍带 single）
    expect(screen.getByTestId('ctl-single-pin')).toHaveTextContent('src_9')
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题二' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.chatSend' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1][1]).toMatchObject({ mode: 'single', singleSourceId: 'src_9' })
  })

  it('T9：恢复的历史轮无法证明范围 → 显式标注"范围不可用"，不回填当前选择', () => {
    // 当前范围是 selected(src_2)，但恢复轮 scopeSnapshot=null
    renderPanel(
      [turn({ id: 'u1', role: 'user', content: '历史提问', scopeSnapshot: null })],
      vi.fn(),
      { scope: { mode: 'selected', sourceIds: ['src_2'], noteIds: [] } },
    )

    expect(screen.getByTestId('chat-turn-scope-unavailable')).toHaveTextContent(
      'research.scopeDetails.turnScopeUnavailable',
    )
    // 不得把当前选择冒充成历史范围
    expect(screen.queryByTestId('chat-turn-scope-badge')).toBeNull()
  })

  it('T9 对照：本轮派发的轮显示真实冻结范围', () => {
    renderPanel(
      [turn({ id: 'u2', role: 'user', content: '本次提问', scopeSnapshot: SCOPE_A })],
      vi.fn(),
    )

    expect(screen.getByTestId('chat-turn-scope-badge')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-turn-scope-unavailable')).toBeNull()
  })

  /**
   * #439 后台 CTA 的完整形态：**前一条 user 提问 + 出错的 assistant 轮**
   * （`queryForTurn` 向前找最近的法律提问；缺它 CTA 恒禁用，测不到门禁）。
   */
  const persistentTurns = (mode: 'all' | 'selected'): ResearchChatTurn[] => {
    const scopeSnapshot: ResearchScopeSnapshot = {
      mode,
      sourceIds: mode === 'selected' ? ['src_1'] : [],
      noteIds: [],
      singleSourceId: null,
    }
    return [
      turn({ id: 'u1', role: 'user', content: 'Which biomarkers show response?', scopeSnapshot }),
      turn({
        id: 'a1',
        status: 'error',
        errorCode: 'persistent_job_required',
        scopeSnapshot,
      }),
    ]
  }

  it('D-26：all + 入口要求显式集合 → CTA 就近阻断（D-11 文案）且不可点击派发', async () => {
    const submit = vi.fn(async (
      _query: string,
      _snapshot: ResearchScopeSnapshot,
      _turnKey: string,
    ): Promise<BackgroundJobSubmitResult> => ({ status: 'queued', jobId: 'j1' }))
    renderPanel(persistentTurns('all'), vi.fn(), {
      onRunAsBackgroundJob: submit,
      backgroundJobRequiresSelection: true,
    })

    const blocked = screen.getByTestId('chat-persistent-job-blocked-scope')
    // D-11 禁用"无可用资料"式措辞，必须引导"先选择资料"
    expect(blocked).toHaveTextContent('research.errors.backgroundJobBlockedScope')
    const button = screen.getByTestId('chat-persistent-job-submit')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 绝不发空 ID 集
    expect(submit).not.toHaveBeenCalled()
  })

  it('D-26：selected → CTA 正常可用（阻断只针对无法表达的 all）', async () => {
    const submit = vi.fn(async (
      _query: string,
      _snapshot: ResearchScopeSnapshot,
      _turnKey: string,
    ): Promise<BackgroundJobSubmitResult> => ({ status: 'queued', jobId: 'j2' }))
    renderPanel(persistentTurns('selected'), vi.fn(), {
      onRunAsBackgroundJob: submit,
      backgroundJobRequiresSelection: true,
    })

    expect(screen.queryByTestId('chat-persistent-job-blocked-scope')).toBeNull()
    const button = screen.getByTestId('chat-persistent-job-submit')
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit.mock.calls[0][1]).toMatchObject({ mode: 'selected', sourceIds: ['src_1'] })
  })

  it('D-26：C-05 就绪（入口可表达 all）→ 不阻断，走 source_scope 分支', async () => {
    const submit = vi.fn(async (
      _query: string,
      _snapshot: ResearchScopeSnapshot,
      _turnKey: string,
    ): Promise<BackgroundJobSubmitResult> => ({ status: 'queued', jobId: 'j3' }))
    renderPanel(persistentTurns('all'), vi.fn(), {
      onRunAsBackgroundJob: submit,
      backgroundJobRequiresSelection: false,
    })

    expect(screen.queryByTestId('chat-persistent-job-blocked-scope')).toBeNull()
    fireEvent.click(screen.getByTestId('chat-persistent-job-submit'))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  it('D-26：组合根返回 blocked_scope → 呈现 D-11 文案，而不是通用提交失败', async () => {
    const submit = vi.fn(async (): Promise<BackgroundJobSubmitResult> => ({ status: 'blocked_scope' }))
    renderPanel(persistentTurns('selected'), vi.fn(), {
      onRunAsBackgroundJob: submit,
    })

    fireEvent.click(screen.getByTestId('chat-persistent-job-submit'))
    await waitFor(() => {
      expect(screen.getByTestId('chat-persistent-job-error')).toHaveTextContent(
        'research.errors.backgroundJobBlockedScope',
      )
    })
    expect(screen.getByTestId('chat-persistent-job-error')).not.toHaveTextContent(
      'research.errors.persistentJobSubmitFailed',
    )
  })
})


// PR-4（#602 第三批）：会话 editor 接线的最小集成证据——草稿真源为 editor
// `draftText`，发送不清稿（清稿归 PR-5a 原子提交协议），运行时缺失时门禁
// 原因必须出现在输入区（§6.1/§8.2/§9.6）。
describe('ResearchChatPanel · PR-4 会话 editor 接线', () => {
  const REF: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: PROJECT_ID,
    sessionId: 'sess-1',
    sourceId: null,
  }
  const CONVERSATION: ResearchConversationSnapshot = {
    isBusy: false,
    isStreaming: false,
    activeTurnId: null,
    phase: 'idle',
  }

  function WiredPanel({
    onSend,
    snapshotOverrides,
    turns = [],
    submissionReady,
    anchor,
    onChatAnchorChange,
  }: {
    onSend: (query: string, selection?: ResearchChatSelection) => Promise<boolean>
    snapshotOverrides?: Partial<EditorSnapshot>
    turns?: ResearchChatTurn[]
    submissionReady?: boolean
    anchor?: WireChatAnchor | null
    onChatAnchorChange?: (anchor: WireChatAnchor | null) => void
  }) {
    const [snapshot, setSnapshot] = useState<EditorSnapshot>(() => ({
      ...createEditorState({ ref: REF, writerId: 'writer-1', transportAvailable: true }),
      phase: 'ready',
      loading: false,
      baseScope: { mode: 'selected', sourceIds: ['src_1'], singleSourceId: null },
      ...snapshotOverrides,
    }))
    return (
      <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
        <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
          <ResearchChatPanel
            turns={turns}
            isStreaming={false}
            onSend={onSend}
            onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
            editorSnapshot={
              anchor === undefined ? snapshot : { ...snapshot, chatAnchor: anchor }
            }
            submissionReady={submissionReady}
            onChatAnchorChange={onChatAnchorChange}
            conversationSnapshot={CONVERSATION}
            scopeSources={[{ sourceId: 'src_1', title: 'Paper One' }]}
            scopeNotes={[]}
            onChangeScope={vi.fn()}
            onDraftChange={(text) => setSnapshot(prev => ({ ...prev, draftText: text, dirty: text.length > 0 }))}
            onRetrySave={vi.fn()}
          />
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    )
  }

  it('接线后以 editor 草稿发送且不清稿；范围条可见', async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    const onSend = vi.fn<(query: string) => Promise<boolean>>(async () => true)
    render(
      <QueryClientProvider client={queryClient}>
        <WiredPanel onSend={onSend} />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('research-session-scope-bar')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '  保留空白的问题  ' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    // 不 trim 覆盖、不在发送后本地清空草稿（§5.4/§5.8）
    expect(onSend.mock.calls[0][0]).toBe('  保留空白的问题  ')
    expect(screen.getByTestId('chat-input')).toHaveValue('  保留空白的问题  ')
  })

  it('运行时缺失：发送按钮禁用且门禁原因可见（不只靠 disabled）', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            <ResearchChatPanel
              turns={[]}
              isStreaming={false}
              onSend={vi.fn(async () => true)}
              onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
              editorSnapshot={null}
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toBeInTheDocument()
  })

  it('single 范围按 mode=single 派发并携带 singleSourceId（执行范围编码 §5.3）', async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    const onSend = vi.fn<(query: string, selection?: ResearchChatSelection) => Promise<boolean>>(
      async () => true,
    )
    render(
      <QueryClientProvider client={queryClient}>
        <WiredPanel onSend={onSend} snapshotOverrides={{ singleSourceId: 'src_1' }} />
      </QueryClientProvider>,
    )
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '仅问此来源的问题' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][1]).toMatchObject({
      mode: 'single',
      sourceIds: [],
      singleSourceId: 'src_1',
    })
  })

  it('锚点目标缺失时显示 position_unavailable 稳定原因（§5.7.1）', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    render(
      <QueryClientProvider client={queryClient}>
        <WiredPanel
          onSend={vi.fn<(query: string) => Promise<boolean>>(async () => true)}
          snapshotOverrides={{
            chatAnchor: { messageId: 'msg-missing', offsetPx: 20, followTail: false },
          }}
          turns={[turn({ id: 't1', role: 'user', content: 'hello' })]}
        />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('chat-position-unavailable')).toBeInTheDocument()
  })

  it('submission capability 未就绪时发送被禁用且原因可见（§6.1 条件 2）', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    render(
      <QueryClientProvider client={queryClient}>
        <WiredPanel
          onSend={vi.fn<(query: string, selection?: ResearchChatSelection) => Promise<boolean>>(
            async () => true,
          )}
          submissionReady={false}
        />
      </QueryClientProvider>,
    )
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题' } })
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent(
      'research.errors.admissionUnavailable',
    )
  })

  it('消息锚点使用稳定 message id（serverMessageId），不持久化本地 turn id', () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <WiredPanel
          onSend={vi.fn<(query: string, selection?: ResearchChatSelection) => Promise<boolean>>(
            async () => true,
          )}
          turns={[
            turn({
              id: 'local-turn-1',
              serverMessageId: 'msg-42',
              role: 'user',
              content: 'hello',
            }),
          ]}
        />
      </QueryClientProvider>,
    )
    expect(container.querySelector('[data-message-id="msg-42"]')).not.toBeNull()
    expect(container.querySelector('[data-message-id="local-turn-1"]')).toBeNull()
  })

  it('E1（review round 3/4）：抑制窗口内用户接管后，稳定 ID 回填不把位置打回旧锚点', () => {
    const onSend = vi.fn(async () => true)
    const userTurn = turn({ id: 'local-user-1', role: 'user', content: 'q' })
    const anchor: WireChatAnchor = {
      messageId: 'msg-42',
      offsetPx: 100,
      followTail: false,
    }
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    let chatScroll: HTMLElement | null = null
    HTMLElement.prototype.getBoundingClientRect = function mockRect(this: HTMLElement) {
      if (this.dataset?.messageId === 'msg-42') {
        return { top: 100 - (chatScroll?.scrollTop ?? 0), height: 80 } as DOMRect
      }
      if (this.dataset?.testid === 'chat-messages') {
        return { top: 0, height: 400 } as DOMRect
      }
      return { top: 0, height: 0 } as DOMRect
    }
    try {
      const view = render(
        <WiredPanel
          onSend={onSend}
          turns={[userTurn]}
          anchor={anchor}
          onChatAnchorChange={vi.fn()}
        />,
      )
      chatScroll = screen.getByTestId('chat-messages')
      Object.defineProperty(chatScroll, 'clientHeight', { value: 400, configurable: true })
      Object.defineProperty(chatScroll, 'scrollHeight', { value: 2000, configurable: true })
      // 首次恢复失败（目标未加载），随后两帧内处于抑制窗口。
      expect(screen.getByTestId('chat-position-unavailable')).toBeTruthy()

      // 抑制窗口内用户滚动到 300 —— 必须被识别为接管，不能被当成程序化滚动。
      chatScroll.scrollTop = 300
      fireEvent.scroll(chatScroll)

      // live assistant 回填稳定 ID → 稳定 ID 签名变化；若未识别接管，按
      // 有符号公式会得到 300 + (100-300) - 100 = 0，把用户打回顶部。
      view.rerender(
        <WiredPanel
          onSend={onSend}
          turns={[userTurn, turn({ id: 'a-1', role: 'assistant', serverMessageId: 'msg-42' })]}
          anchor={anchor}
          onChatAnchorChange={vi.fn()}
        />,
      )
      expect(chatScroll.scrollTop).toBe(300)
      expect(screen.queryByTestId('chat-position-unavailable')).toBeNull()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it('E2（review round 4）：用户未接管时，失败恢复可在稳定 ID 回填后重试成功', () => {
    const onSend = vi.fn(async () => true)
    const userTurn = turn({ id: 'local-user-1', role: 'user', content: 'q' })
    const anchor: WireChatAnchor = {
      messageId: 'msg-42',
      offsetPx: 50,
      followTail: false,
    }
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    let chatScroll: HTMLElement | null = null
    HTMLElement.prototype.getBoundingClientRect = function mockRect(this: HTMLElement) {
      if (this.dataset?.messageId === 'msg-42') {
        return { top: 100 - (chatScroll?.scrollTop ?? 0), height: 80 } as DOMRect
      }
      if (this.dataset?.testid === 'chat-messages') {
        return { top: 0, height: 400 } as DOMRect
      }
      return { top: 0, height: 0 } as DOMRect
    }
    try {
      const view = render(
        <WiredPanel
          onSend={onSend}
          turns={[userTurn]}
          anchor={anchor}
          onChatAnchorChange={vi.fn()}
        />,
      )
      chatScroll = screen.getByTestId('chat-messages')
      Object.defineProperty(chatScroll, 'clientHeight', { value: 400, configurable: true })
      Object.defineProperty(chatScroll, 'scrollHeight', { value: 2000, configurable: true })
      expect(screen.getByTestId('chat-position-unavailable')).toBeTruthy()

      view.rerender(
        <WiredPanel
          onSend={onSend}
          turns={[userTurn, turn({ id: 'a-1', role: 'assistant', serverMessageId: 'msg-42' })]}
          anchor={anchor}
          onChatAnchorChange={vi.fn()}
        />,
      )
      // 目标 top=100、savedOffset=50 → newScrollTop = 0 + 100 - 50 = 50。
      expect(chatScroll.scrollTop).toBe(50)
      expect(screen.queryByTestId('chat-position-unavailable')).toBeNull()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })
})
// PR-4 修复轮（Lead 独立核对 P1-1/P1-2/F3/F4）：Coverage 草稿与门禁完全独立
// 于会话 editor；发送成功写 follow_tail 并滚底；切 tab/隐藏前 flush 位置；
// 范围条禁用原因由 editor 门禁派生。
describe('ResearchChatPanel · PR-4 修复轮（P1-1/P1-2/F3/F4）', () => {
  const REF2: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: PROJECT_ID,
    sessionId: 'sess-2',
    sourceId: null,
  }
  const CONV2: ResearchConversationSnapshot = {
    isBusy: false,
    isStreaming: false,
    activeTurnId: null,
    phase: 'idle',
  }

  function Harness({
    onSend = vi.fn(async () => true),
    onSendCoverage = vi.fn(async () => ACCEPTED_OUTCOME),
    onSessionDraftChange = vi.fn(),
    onChatAnchorChange = vi.fn(),
    onFlushPosition = vi.fn(),
    snapshotOverrides,
    anchor,
    turns = [],
    surfaceActive = true,
    sendDisabled = false,
    blockedHint,
    nullSnapshot = false,
  }: {
    onSend?: (query: string) => Promise<boolean>
    onSendCoverage?: (query: string, snapshot: ResearchScopeSnapshot) => Promise<CoverageSubmitOutcome>
    onSessionDraftChange?: (text: string) => void
    onChatAnchorChange?: (anchor: WireChatAnchor | null) => void
    onFlushPosition?: () => void
    snapshotOverrides?: Partial<EditorSnapshot>
    anchor?: WireChatAnchor | null
    turns?: ResearchChatTurn[]
    surfaceActive?: boolean
    sendDisabled?: boolean
    blockedHint?: string
    nullSnapshot?: boolean
  }) {
    const [snapshot, setSnapshot] = useState<EditorSnapshot>(() => ({
      ...createEditorState({ ref: REF2, writerId: 'writer-2', transportAvailable: true }),
      phase: 'ready',
      loading: false,
      baseScope: { mode: 'selected', sourceIds: ['src_1'], singleSourceId: null },
      ...snapshotOverrides,
    }))
    return (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })}
      >
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            <ResearchChatPanel
              turns={turns}
              isStreaming={false}
              onSend={onSend}
              onSendCoverage={onSendCoverage}
              coverageEnabled
              sendDisabled={sendDisabled}
              blockedHint={blockedHint}
              editorSnapshot={
                nullSnapshot
                  ? null
                  : anchor === undefined
                    ? snapshot
                    : { ...snapshot, chatAnchor: anchor }
              }
              conversationSnapshot={CONV2}
              scopeSources={[{ sourceId: 'src_1', title: 'Paper One' }]}
              scopeNotes={[]}
              onChangeScope={vi.fn()}
              onDraftChange={(text) => {
                onSessionDraftChange(text)
                setSnapshot(prev => ({ ...prev, draftText: text, dirty: text.length > 0 }))
              }}
              onRetrySave={vi.fn()}
              onChatAnchorChange={onChatAnchorChange}
              onFlushPosition={onFlushPosition}
              surfaceActive={surfaceActive}
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>
    )
  }

  function enterCoverageMode(): void {
    fireEvent.click(screen.getByTestId('scope-all-selected-option'))
  }

  it('P1-1 Coverage 使用独立本地草稿：不写会话 editor 草稿、切回 relevant 不互串', () => {
    seedScope(SCOPE_A)
    const onSessionDraftChange = vi.fn()
    render(
      <Harness onSessionDraftChange={onSessionDraftChange} snapshotOverrides={{ draftText: '会话草稿' }} />,
    )
    expect(screen.getByTestId('chat-input')).toHaveValue('会话草稿')
    enterCoverageMode()
    expect(screen.getByTestId('chat-input')).toHaveValue('')
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'coverage 问题' } })
    expect(screen.getByTestId('chat-input')).toHaveValue('coverage 问题')
    // 不触发会话草稿写入（不写 editor、不触发保存）
    expect(onSessionDraftChange).not.toHaveBeenCalled()
    // 切回 relevant：会话草稿原样，coverage 文本不串入
    fireEvent.click(screen.getByLabelText('research.coverage.scopeRelevant'))
    expect(screen.getByTestId('chat-input')).toHaveValue('会话草稿')
    // 再切回 all_selected：coverage 本地文本保留
    enterCoverageMode()
    expect(screen.getByTestId('chat-input')).toHaveValue('coverage 问题')
  })

  it('P1-1 Coverage 发送只清同版本 Coverage 文本，会话草稿与会话派发不受影响', async () => {
    seedScope(SCOPE_A)
    const onSend = vi.fn(async () => true)
    const onSendCoverage = vi.fn(async (_query: string, _snapshot: ResearchScopeSnapshot) => ACCEPTED_OUTCOME)
    const onSessionDraftChange = vi.fn()
    render(
      <Harness
        onSend={onSend}
        onSendCoverage={onSendCoverage}
        onSessionDraftChange={onSessionDraftChange}
        snapshotOverrides={{ draftText: '会话草稿' }}
      />,
    )
    enterCoverageMode()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'coverage 问题' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSendCoverage).toHaveBeenCalledTimes(1))
    expect(onSendCoverage.mock.calls[0][0]).toBe('coverage 问题')
    expect(onSend).not.toHaveBeenCalled()
    expect(onSessionDraftChange).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveValue(''))
    fireEvent.click(screen.getByLabelText('research.coverage.scopeRelevant'))
    expect(screen.getByTestId('chat-input')).toHaveValue('会话草稿')
  })

  it('P1-1 Coverage 发送期间文本已变（版本不匹配）→ 不清新文本', async () => {
    seedScope(SCOPE_A)
    let resolveSend: (value: CoverageSubmitOutcome) => void = () => {}
    const onSendCoverage = vi.fn(
      () => new Promise<CoverageSubmitOutcome>((resolve) => { resolveSend = resolve }),
    )
    render(<Harness onSendCoverage={onSendCoverage} />)
    enterCoverageMode()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '第一版' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSendCoverage).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '第二版' } })
    resolveSend(ACCEPTED_OUTCOME)
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveValue('第二版'))
  })

  it('P1-1 会话 editor blocked/readonly 时 Coverage 仍可用（范围合法）', () => {
    seedScope(SCOPE_A)
    render(<Harness snapshotOverrides={{ blocked: true, phase: 'blocked' }} />)
    enterCoverageMode()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'coverage 问题' } })
    expect(screen.getByTestId('chat-send')).not.toBeDisabled()
    expect(screen.queryByTestId('research-draft-gate-hint')).not.toBeInTheDocument()
  })

  it('P1-2 发送成功后写 follow_tail=true 并把消息容器滚到底部', async () => {
    const onChatAnchorChange = vi.fn()
    const onSend = vi.fn(async () => true)
    render(
      <Harness
        onSend={onSend}
        onChatAnchorChange={onChatAnchorChange}
        anchor={{ messageId: 'm1', offsetPx: 40, followTail: false }}
        snapshotOverrides={{ draftText: '问题' }}
        turns={[turn({ id: 't1', role: 'assistant', content: '历史回答', serverMessageId: 'm1' })]}
      />,
    )
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(onChatAnchorChange).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm1', followTail: true }),
      ),
    )
  })

  it('P1-2 无稳定 message_id 时先 pending，ID 回填后落盘 follow_tail', async () => {
    const onChatAnchorChange = vi.fn()
    const onSend = vi.fn(async () => true)
    const view = render(
      <Harness
        onSend={onSend}
        onChatAnchorChange={onChatAnchorChange}
        snapshotOverrides={{ draftText: '问题' }}
        turns={[]}
      />,
    )
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onChatAnchorChange).not.toHaveBeenCalled()
    // 新回答落稳定 ID（rerender 模拟 ack/新消息 ID 回填）
    view.rerender(
      <Harness
        onSend={onSend}
        onChatAnchorChange={onChatAnchorChange}
        snapshotOverrides={{ draftText: '问题' }}
        turns={[turn({ id: 't-new', role: 'assistant', content: '答', serverMessageId: 'm-new' })]}
      />,
    )
    await waitFor(() =>
      expect(onChatAnchorChange).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm-new', followTail: true }),
      ),
    )
  })

  it('P1-3 发送不伪装恢复：position_unavailable 时保留提示且不写锚点（02 §4 关闭位置保存）', async () => {
    const onSend = vi.fn(async () => true)
    const onChatAnchorChange = vi.fn()
    render(
      <Harness
        onSend={onSend}
        onChatAnchorChange={onChatAnchorChange}
        snapshotOverrides={{ draftText: '问题', positionUnavailable: true }}
        anchor={{ messageId: 'm-missing', offsetPx: 0, followTail: false }}
        turns={[turn({ id: 't1', role: 'assistant', content: '历史回答', serverMessageId: 'm1' })]}
      />,
    )
    expect(screen.getByTestId('chat-position-unavailable')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onChatAnchorChange).not.toHaveBeenCalled())
    expect(screen.getByTestId('chat-position-unavailable')).toBeInTheDocument()
  })

  it('P1-4 稳定 ID 先回填、发送后 resolve：结算读最新 turns，不永久 pending', async () => {
    let resolveSend: (value: boolean) => void = () => {}
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve }))
    const onChatAnchorChange = vi.fn()
    const view = render(
      <Harness
        onSend={onSend}
        onChatAnchorChange={onChatAnchorChange}
        snapshotOverrides={{ draftText: '问题' }}
        turns={[]}
      />,
    )
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    view.rerender(
      <Harness
        onSend={onSend}
        onChatAnchorChange={onChatAnchorChange}
        snapshotOverrides={{ draftText: '问题' }}
        turns={[turn({ id: 't-new', role: 'assistant', content: '答', serverMessageId: 'm-new' })]}
      />,
    )
    resolveSend(true)
    await waitFor(() =>
      expect(onChatAnchorChange).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm-new', followTail: true }),
      ),
    )
  })

  it('N9 隐藏期间发送成功不写锚点；回到可见后结算 follow_tail', async () => {
    let resolveSend: (value: boolean) => void = () => {}
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { resolveSend = resolve }))
    const onChatAnchorChange = vi.fn()
    const turns = [turn({ id: 't1', role: 'assistant', content: '历史回答', serverMessageId: 'm1' })]
    const view = render(
      <Harness
        onSend={onSend}
        onChatAnchorChange={onChatAnchorChange}
        snapshotOverrides={{ draftText: '问题' }}
        surfaceActive={false}
        anchor={{ messageId: 'm1', offsetPx: 40, followTail: false }}
        turns={turns}
      />,
    )
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    resolveSend(true)
    await waitFor(() => expect(onChatAnchorChange).not.toHaveBeenCalled())
    view.rerender(
      <Harness
        onSend={onSend}
        onChatAnchorChange={onChatAnchorChange}
        snapshotOverrides={{ draftText: '问题' }}
        anchor={{ messageId: 'm1', offsetPx: 40, followTail: false }}
        turns={turns}
      />,
    )
    await waitFor(() =>
      expect(onChatAnchorChange).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm1', followTail: true }),
      ),
    )
  })

  it('F3 滚动后 <1000ms 切走：先缓存新位置，隐藏不可度量时用缓存写锚点再 flush', async () => {
    const onChatAnchorChange = vi.fn()
    const onFlushPosition = vi.fn()
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const turns = [turn({ id: 't1', role: 'assistant', content: '历史回答', serverMessageId: 'm1' })]
    const view = render(
      <Harness
        onChatAnchorChange={onChatAnchorChange}
        onFlushPosition={onFlushPosition}
        snapshotOverrides={{ draftText: '问题' }}
        turns={turns}
      />,
    )
    const chatScroll = screen.getByTestId('chat-messages')
    HTMLElement.prototype.getBoundingClientRect = function mockRect(this: HTMLElement) {
      if (this.dataset.messageId !== undefined) {
        return {
          top: 100 - chatScroll.scrollTop, bottom: 180, height: 80,
          left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect
      }
      if (this === chatScroll) {
        return {
          top: 0, bottom: 400, height: 400,
          left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect
      }
      return originalRect.call(this)
    }
    try {
      Object.defineProperty(chatScroll, 'scrollHeight', { value: 2000, configurable: true })
      Object.defineProperty(chatScroll, 'clientHeight', { value: 400, configurable: true })
      chatScroll.scrollTop = 150
      fireEvent.scroll(chatScroll)
      // F3：可见时下一帧（16ms 节流）先缓存最近锚点。
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
      })
      // 切 tab 后容器 display:none（clientHeight=0），flush 时无法再测量几何，
      // 必须退回 16ms 缓存的锚点，否则 <1s 的滚动位置会被静默丢弃。
      Object.defineProperty(chatScroll, 'clientHeight', { value: 0, configurable: true })
      view.rerender(
        <Harness
          onChatAnchorChange={onChatAnchorChange}
          onFlushPosition={onFlushPosition}
          snapshotOverrides={{ draftText: '问题' }}
          surfaceActive={false}
          turns={turns}
        />,
      )
      expect(onChatAnchorChange).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'm1', offsetPx: -50 }),
      )
      expect(onFlushPosition).toHaveBeenCalledTimes(1)
      expect(onChatAnchorChange.mock.invocationCallOrder[0]).toBeLessThan(
        onFlushPosition.mock.invocationCallOrder[0],
      )
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it('F3 缓存不跨会话：切换会话后隐藏不写上一会话的锚点', async () => {
    const onChatAnchorChange = vi.fn()
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const turns = [turn({ id: 't1', role: 'assistant', content: '历史回答', serverMessageId: 'm1' })]
    let chatScroll: HTMLElement | null = null
    HTMLElement.prototype.getBoundingClientRect = function mockRect(this: HTMLElement) {
      if (this.dataset.messageId !== undefined) {
        return {
          top: 100 - (chatScroll?.scrollTop ?? 0), bottom: 180, height: 80,
          left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect
      }
      if (this.dataset.testid === 'chat-messages') {
        return {
          top: 0, bottom: 400, height: 400,
          left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect
      }
      return originalRect.call(this)
    }
    try {
      const view = render(
        <Harness
          onChatAnchorChange={onChatAnchorChange}
          snapshotOverrides={{ draftText: '问题' }}
          turns={turns}
        />,
      )
      chatScroll = screen.getByTestId('chat-messages')
      Object.defineProperty(chatScroll, 'scrollHeight', { value: 2000, configurable: true })
      Object.defineProperty(chatScroll, 'clientHeight', { value: 400, configurable: true })
      chatScroll.scrollTop = 150
      fireEvent.scroll(chatScroll)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
      })
      // 切到另一个（空）会话：缓存里的 m1 已不在当前 DOM。
      view.rerender(
        <Harness
          onChatAnchorChange={onChatAnchorChange}
          snapshotOverrides={{ draftText: '问题' }}
          turns={[]}
          surfaceActive={false}
        />,
      )
      Object.defineProperty(chatScroll, 'clientHeight', { value: 0, configurable: true })
      expect(onChatAnchorChange).not.toHaveBeenCalled()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it('P2-6 无会话快照时 Coverage 仍由本地草稿受控（发送成功清空自身文本）', async () => {
    seedScope(SCOPE_A)
    const onSendCoverage = vi.fn(async () => ACCEPTED_OUTCOME)
    render(<Harness onSendCoverage={onSendCoverage} nullSnapshot />)
    enterCoverageMode()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'coverage 问题' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSendCoverage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveValue(''))
    expect(screen.getByTestId('chat-send')).toBeDisabled()
  })

  it('P2-7 全局执行门禁同样约束 Coverage（禁用并显示外部稳定原因）', () => {
    seedScope(SCOPE_A)
    render(<Harness sendDisabled blockedHint="模型不可用" />)
    enterCoverageMode()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'coverage 问题' } })
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent('模型不可用')
  })

  it('P1-3 服务端净化锚点（position_unavailable）不恢复、不伪装，并显示提示', () => {
    const onChatAnchorChange = vi.fn()
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    const turns = [turn({ id: 't1', role: 'assistant', content: '历史回答', serverMessageId: 'm1' })]
    const turnsAfterBackfill = [
      ...turns,
      turn({ id: 't2', role: 'assistant', content: '新回答', serverMessageId: 'm2' }),
    ]
    let chatScroll: HTMLElement | null = null
    HTMLElement.prototype.getBoundingClientRect = function mockRect(this: HTMLElement) {
      if (this.dataset.messageId !== undefined) {
        return {
          top: 100 - (chatScroll?.scrollTop ?? 0), bottom: 180, height: 80,
          left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect
      }
      if (this.dataset.testid === 'chat-messages') {
        return {
          top: 0, bottom: 400, height: 400,
          left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect
      }
      return originalRect.call(this)
    }
    try {
      const view = render(
        <Harness
          onChatAnchorChange={onChatAnchorChange}
          snapshotOverrides={{ draftText: '问题', positionUnavailable: true }}
          anchor={{ messageId: 'm1', offsetPx: -50, followTail: false }}
          turns={turns}
        />,
      )
      chatScroll = screen.getByTestId('chat-messages')
      Object.defineProperty(chatScroll, 'scrollHeight', { value: 2000, configurable: true })
      Object.defineProperty(chatScroll, 'clientHeight', { value: 400, configurable: true })
      chatScroll.scrollTop = 777
      // 稳定 ID 集变化会触发一次恢复尝试；服务端已净化锚点时不得恢复/写回。
      view.rerender(
        <Harness
          onChatAnchorChange={onChatAnchorChange}
          snapshotOverrides={{ draftText: '问题', positionUnavailable: true }}
          anchor={{ messageId: 'm1', offsetPx: -50, followTail: false }}
          turns={turnsAfterBackfill}
        />,
      )
      expect(chatScroll.scrollTop).toBe(777)
      expect(screen.getByTestId('chat-position-unavailable')).toBeInTheDocument()
      expect(onChatAnchorChange).not.toHaveBeenCalled()
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  it('F3 从可见切到隐藏（切 tab）时调用 flush("position")', () => {
    const onFlushPosition = vi.fn()
    const view = render(<Harness onFlushPosition={onFlushPosition} />)
    view.rerender(<Harness onFlushPosition={onFlushPosition} surfaceActive={false} />)
    expect(onFlushPosition).toHaveBeenCalledTimes(1)
  })

  it('F4 会话只读时范围条禁用并显示稳定原因（不是 null 静默禁用）', () => {
    render(<Harness snapshotOverrides={{ readOnly: true, phase: 'readonly' }} />)
    expect(screen.getByTestId('scope-disabled-reason')).toHaveTextContent(
      'research.workbench.adminWriteDenied',
    )
    expect(screen.getByTestId('scope-mode-all')).toBeDisabled()
  })
})

// ── PR-5b（§4.2-4/§6.7/§6.9/§7.3/§9.6）：会话头部、解释 UI 与 Coverage 隔离 ──

import type { ConversationController } from '@/lib/research/session-runtime'
import type { ConversationTurn } from '@/lib/research/conversation-machine'
import { messageRowToTurn } from '@/lib/hooks/use-research-chat'
import type {
  ResearchChatSessionMeta,
  ResearchSubmissionLookupSnapshot,
} from '@/lib/hooks/use-research-chat'

describe('ResearchChatPanel PR-5b：会话接线与解释 UI', () => {
  const REF: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: PROJECT_ID,
    sessionId: 'sess-1',
    sourceId: null,
  }

  function conversationStub(
    turn: ConversationTurn | null = null,
    history: ConversationTurn[] = [],
  ): ConversationController {
    return {
      getSnapshot: () => ({
        version: 1,
        sessionKey: 'global:p1:sess-1',
        authGeneration: 1,
        turn,
        history,
        detailMessages: [],
        detailCursor: null,
      }),
      subscribe: () => () => {},
      load: vi.fn(async () => ({ status: 'ok' })),
      lookupSubmission: vi.fn(async () => ({ status: 'ok' })),
      refreshStatus: vi.fn(async () => ({ status: 'ok' })),
    } as unknown as ConversationController
  }

  function renderSessionPanel({
    sessionMeta = null,
    submissionLookup = null,
    turns = [],
    markerWriteFailed = false,
    onSendCoverage = vi.fn(async () => ACCEPTED_OUTCOME),
    conversation = conversationStub(),
    wrapPanel,
  }: {
    sessionMeta?: ResearchChatSessionMeta | null
    submissionLookup?: ResearchSubmissionLookupSnapshot | null
    turns?: ResearchChatTurn[]
    markerWriteFailed?: boolean
    onSendCoverage?: (q: string, snapshot: ResearchScopeSnapshot) => Promise<CoverageSubmitOutcome>
    conversation?: ConversationController
    /** 可选的 React 包装（如 Profiler），用于断言每次 commit 的 DOM 状态。 */
    wrapPanel?: (node: React.ReactNode) => React.ReactNode
  }) {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            {(wrapPanel ?? ((node: React.ReactNode) => node))(
              <ResearchChatPanel
              turns={turns}
              isStreaming={false}
              onSend={vi.fn(async () => true)}
              onSendCoverage={onSendCoverage}
              coverageEnabled
              editorSnapshot={{
                ...createEditorState({ ref: REF, writerId: 'w-1', transportAvailable: true }),
                phase: 'ready',
                loading: false,
                baseScope: { mode: 'selected' as const, sourceIds: ['src_1'], singleSourceId: null },
              }}
              conversation={conversation}
              sessionRef={REF}
              sessionMeta={sessionMeta}
              submissionLookup={submissionLookup}
              markerWriteFailed={markerWriteFailed}
              onSendSession={vi.fn(async () => true)}
              scopeSources={[{ sourceId: 'src_1', title: 'Paper One' }]}
              scopeNotes={[]}
              onChangeScope={vi.fn()}
              onDraftChange={vi.fn()}
              onRetrySave={vi.fn()}
              />
            )}
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>,
    )
  }

  beforeEach(() => {
    localStorage.clear()
    seedScope({ mode: 'selected', sourceIds: ['src_1'], noteIds: [], singleSourceId: null })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('§4.2-4：detail 同响应到达即渲染真实标题，整段渲染 never 出现占位/加载态', async () => {
    // Lead 核对（Codex 复核 P2）：用 React.Profiler 在**每次 commit** 后检查
    // DOM，而不是 MutationObserver 收集时的节点（节点属性后续被改会假绿）。
    const placeholderCommits: string[] = []
    renderSessionPanel({
      sessionMeta: { title: '真实会话标题', recordVisibility: 'visible' },
      wrapPanel: (node) => (
        <Profiler
          id="header-commit"
          onRender={() => {
            if (document.querySelector('[data-testid="chat-session-title-loading"]')) {
              placeholderCommits.push('loading')
            }
            if (document.querySelector('[data-testid="chat-session-title-unknown"]')) {
              placeholderCommits.push('unknown')
            }
          }}
        >
          {node}
        </Profiler>
      ),
    })
    await act(async () => {})
    expect(placeholderCommits).toEqual([])
    expect(screen.getByTestId('chat-session-title')).toHaveTextContent('真实会话标题')
    expect(screen.queryByTestId('chat-session-title-loading')).not.toBeInTheDocument()
    expect(screen.queryByText('research.session.visibility.restricted')).not.toBeInTheDocument()
  })

  it('§4.2-4/§4.6：restricted 会话只显示固定占位，标题不进入 DOM', () => {
    renderSessionPanel({
      sessionMeta: { title: '绝密标题', recordVisibility: 'restricted' },
    })
    expect(screen.getByTestId('chat-session-restricted')).toBeInTheDocument()
    expect(screen.queryByText('绝密标题')).not.toBeInTheDocument()
    expect(screen.queryByTestId('chat-session-title')).not.toBeInTheDocument()
  })

  it('§6.9：受限消息不渲染正文气泡，只显示固定受限卡片', () => {
    renderSessionPanel({
      turns: [turn({ role: 'assistant', content: '受限正文', recordVisibility: 'restricted' })],
    })
    expect(screen.getByTestId('chat-restricted-message')).toBeInTheDocument()
    expect(screen.queryByText('受限正文')).not.toBeInTheDocument()
  })

  it('§7.3：assistant 消息的 context_report 渲染为上下文说明', () => {
    renderSessionPanel({
      turns: [
        turn({
          content: '回答',
          contextReport: {
            status: 'trimmed',
            history: { availableTurns: 10, includedTurns: 4, omittedTurns: 6 },
            evidence: { includedChunks: 3, omittedChunks: 2 },
            reasonCodes: ['history_window'],
          } as never,
        }),
      ],
    })
    const report = screen.getByTestId('research-context-report')
    expect(report).toHaveAttribute('data-status', 'trimmed')
  })

  it('§6.7：查回 accepted 时显示提交状态卡', () => {
    renderSessionPanel({
      submissionLookup: {
        token: 'draft_1',
        acceptance: 'accepted',
        generationId: 'gen_1',
        generationState: 'running',
        submittedDraftText: null,
        contextReport: null,
        lookupFailed: false,
      },
    })
    expect(screen.getByTestId('research-submission-status')).toHaveAttribute(
      'data-kind',
      'accepted',
    )
  })

  it('§9.6 Q1/Q2：202 返回时若输入已变为 Q2，不得清空 Q2', async () => {
    let resolveSend: (outcome: CoverageSubmitOutcome) => void = () => {}
    const onSendCoverage = vi.fn(
      () => new Promise<CoverageSubmitOutcome>((resolve) => { resolveSend = resolve }),
    )
    renderSessionPanel({ onSendCoverage })
    fireEvent.click(screen.getByTestId('scope-all-selected-option'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题 Q1' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(onSendCoverage).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题 Q2' } })
    await act(async () => { resolveSend(ACCEPTED_OUTCOME) })
    expect(screen.getByTestId('chat-input')).toHaveValue('问题 Q2')
  })

  it('§9.6：consent 取消（not_dispatched）零副作用，保留输入且不显示受理/错误', async () => {
    renderSessionPanel({ onSendCoverage: vi.fn(async () => ({ status: 'not_dispatched' as const })) })
    fireEvent.click(screen.getByTestId('scope-all-selected-option'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '覆盖问题' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    // 等 promise 结算与状态刷新：not_dispatched 绝不触发清稿
    await act(async () => {})
    expect(screen.getByTestId('chat-input')).toHaveValue('覆盖问题')
    expect(screen.queryByTestId('coverage-accepted')).not.toBeInTheDocument()
    expect(screen.queryByTestId('coverage-submit-error')).not.toBeInTheDocument()
  })

  it('§9.6：202 已受理但 Jobs 登记失败 → 显示“任务登记待刷新”，不得伪装未受理', async () => {
    renderSessionPanel({
      onSendCoverage: vi.fn(async () => ({
        ...ACCEPTED_OUTCOME,
        registration: 'failed' as const,
      })),
    })
    fireEvent.click(screen.getByTestId('scope-all-selected-option'))
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '覆盖问题' } })
    fireEvent.click(screen.getByTestId('chat-send'))
    await waitFor(() => expect(screen.getByTestId('coverage-registration-pending')).toBeInTheDocument())
    expect(screen.getByTestId('coverage-registration-pending')).toHaveTextContent(
      'research.coverage.registrationPending',
    )
  })

  it('PR-5b（Codex P1-#6）：controller 归档到 history 的上一轮不会消失', () => {
    const archived = {
      identity: {
        authGeneration: 1,
        sessionKey: 'global:p1:sess-1',
        sessionId: 'sess-1',
        turnId: 'turn-old',
        draftToken: 'draft_old',
        attempt: 1,
        detached: false,
        terminal: 'done',
      },
      state: 'terminal',
      sse: {
        answer: '上一轮回答',
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
      query: '上一轮问题',
      operationId: null,
      accepted: null,
      errorCode: null,
      errorMessage: null,
      gapDetected: false,
      lookup: null,
      clearPending: false,
      incomplete: false,
      external: false,
    } as unknown as ConversationTurn
    renderSessionPanel({ conversation: conversationStub(null, [archived]) })
    expect(screen.getByText('上一轮问题')).toBeInTheDocument()
    expect(screen.getByText('上一轮回答')).toBeInTheDocument()
  })

  it('PR-5b（Lead 核对 P1-1 / F10）：冷启动 terminal 查回不得把 durable 完整答案去重成空 assistant', () => {
    const durableUser = turn({
      id: 'msg_u1',
      role: 'user',
      content: '冷启动问题',
      serverMessageId: 'msg_u1',
    })
    const durableAssistant = turn({
      id: 'msg_gen_1_assistant',
      role: 'assistant',
      content: '完整答案（来自 durable 行）',
      generationId: 'gen_1',
      serverMessageId: 'msg_gen_1_assistant',
      status: 'done',
    })
    const externalTerminal = {
      identity: {
        authGeneration: 1,
        sessionKey: 'global:p1:sess-1',
        sessionId: 'sess-1',
        turnId: 'external-1',
        draftToken: 'draft_1',
        attempt: 1,
        detached: false,
        terminal: 'done',
        generationId: 'gen_1',
      },
      state: 'terminal',
      sse: {
        answer: '',
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
      query: '冷启动问题',
      operationId: null,
      accepted: null,
      errorCode: null,
      errorMessage: null,
      gapDetected: false,
      lookup: null,
      clearPending: false,
      incomplete: true,
      external: true,
    } as unknown as ConversationTurn
    renderSessionPanel({
      turns: [durableUser, durableAssistant],
      conversation: conversationStub(externalTerminal),
    })
    // durable user 行必须保留其 message_id（身份不丢）
    expect(document.querySelector('[data-message-id="msg_u1"]')).not.toBeNull()
    // 完整答案只渲染一次（不出现空 assistant / “暂无答案”占位）
    expect(screen.getAllByText('完整答案（来自 durable 行）')).toHaveLength(1)
    expect(screen.queryByText('research.chatNoAnswer')).not.toBeInTheDocument()
    expect(screen.getAllByText('冷启动问题')).toHaveLength(1)
    expect(screen.getByTestId('research-submission-status')).toHaveAttribute(
      'data-kind',
      'terminal',
    )
  })

  it('PR-5b（Lead 复核新增 P1）：generation 不一致时不得用同 query 旧答案兜底', () => {
    const durableUser = turn({
      id: 'msg_u_old',
      role: 'user',
      content: '重复问题',
      serverMessageId: 'msg_u_old',
    })
    const durableAssistant = turn({
      id: 'msg_old_assistant',
      role: 'assistant',
      content: '旧答案',
      generationId: 'gen_old',
      serverMessageId: 'msg_old_assistant',
    })
    const liveTurn = {
      identity: {
        authGeneration: 1,
        sessionKey: 'global:p1:sess-1',
        sessionId: 'sess-1',
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
    } as unknown as ConversationTurn
    renderSessionPanel({
      turns: [durableUser, durableAssistant],
      conversation: conversationStub(liveTurn),
    })
    // 旧 user/assistant 必须保留 message_id 且相邻（旧问答配对不被破坏）
    const oldUserEl = document.querySelector('[data-message-id="msg_u_old"]')
    expect(oldUserEl).not.toBeNull()
    const oldAssistantEl = document.querySelector('[data-message-id="msg_old_assistant"]')
    expect(oldAssistantEl).toHaveTextContent('旧答案')
    expect(oldUserEl?.nextElementSibling).toBe(oldAssistantEl)
    expect(screen.getAllByText('旧答案')).toHaveLength(1)
    // 新 generation 的空 assistant 不插入空占位（新问题独立呈现）
    expect(screen.queryByText('research.chatNoAnswer')).not.toBeInTheDocument()
  })

  it('PR-5b（Codex 复核 P1）：热恢复时 durable 与 controller history 同轮不得重复', () => {
    const durableUser = turn({
      id: 'msg_u1',
      role: 'user',
      content: '第一轮问题',
      serverMessageId: 'msg_u1',
    })
    const durableAssistant = turn({
      id: 'msg_gen_1_assistant',
      role: 'assistant',
      content: '第一轮答案',
      generationId: 'gen_1',
      serverMessageId: 'msg_gen_1_assistant',
    })
    const roundOne = {
      identity: {
        authGeneration: 1,
        sessionKey: 'global:p1:sess-1',
        sessionId: 'sess-1',
        turnId: 'turn-old',
        draftToken: 'draft_old',
        attempt: 1,
        detached: false,
        terminal: 'done',
        generationId: 'gen_1',
        observedRevision: null,
      },
      state: 'terminal',
      sse: {
        answer: '第一轮答案',
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
      query: '第一轮问题',
      operationId: null,
      accepted: null,
      errorCode: null,
      errorMessage: null,
      gapDetected: false,
      lookup: null,
      clearPending: false,
      incomplete: false,
      external: false,
    } as unknown as ConversationTurn
    const liveTurn = {
      ...roundOne,
      identity: {
        authGeneration: 1,
        sessionKey: 'global:p1:sess-1',
        sessionId: 'sess-1',
        turnId: 'turn-new',
        draftToken: 'draft_new',
        attempt: 1,
        detached: false,
        terminal: null,
        generationId: 'gen_2',
        observedRevision: null,
      },
      state: 'streaming',
      sse: { ...roundOne.sse, answer: '', terminal: null },
      query: '第二轮问题',
      operationId: 'op-2',
    } as unknown as ConversationTurn
    renderSessionPanel({
      turns: [durableUser, durableAssistant],
      conversation: {
        getSnapshot: () => ({
          version: 2,
          sessionKey: 'global:p1:sess-1',
          authGeneration: 1,
          turn: liveTurn,
          history: [roundOne],
          detailMessages: [],
          detailCursor: null,
        }),
        subscribe: () => () => {},
        load: vi.fn(async () => ({ status: 'ok' })),
        lookupSubmission: vi.fn(async () => ({ status: 'ok' })),
        refreshStatus: vi.fn(async () => ({ status: 'ok' })),
      } as unknown as ConversationController,
    })
    // durable 第一轮保留一次；controller 同 generation 轮被跳过
    expect(screen.getAllByText('第一轮问题')).toHaveLength(1)
    expect(screen.getAllByText('第一轮答案')).toHaveLength(1)
    // 第二轮独立呈现（空 assistant 不投影空占位）
    expect(screen.getAllByText('第二轮问题')).toHaveLength(1)
    expect(screen.queryByText('research.chatNoAnswer')).not.toBeInTheDocument()
  })

  it('PR-5b（Codex 复核覆盖缺口）：真实 mapper 的 msg_<gen> 身份也能驱动热恢复去重', () => {
    const generationId = 'gen_a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6'
    const durableUser = messageRowToTurn({
      message_id: 'msg_u_real',
      role: 'user',
      content: '第一轮问题',
    } as never)
    const durableAssistant = messageRowToTurn({
      message_id: `msg_${generationId}_assistant`,
      role: 'assistant',
      content: '第一轮答案',
    } as never)
    expect(durableUser?.serverMessageId).toBe('msg_u_real')
    expect(durableAssistant?.generationId).toBe(generationId)
    const historyTurn = {
      identity: {
        authGeneration: 1,
        sessionKey: 'global:p1:sess-1',
        sessionId: 'sess-1',
        turnId: 'turn-real',
        draftToken: 'draft_real',
        attempt: 1,
        detached: false,
        terminal: 'done',
        generationId,
        observedRevision: null,
      },
      state: 'terminal',
      sse: {
        answer: '第一轮答案',
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
      query: '第一轮问题',
      operationId: null,
      accepted: null,
      errorCode: null,
      errorMessage: null,
      gapDetected: false,
      lookup: null,
      clearPending: false,
      incomplete: false,
      external: false,
    } as unknown as ConversationTurn
    renderSessionPanel({
      turns: [durableUser!, durableAssistant!],
      conversation: conversationStub(null, [historyTurn]),
    })
    expect(screen.getAllByText('第一轮问题')).toHaveLength(1)
    expect(screen.getAllByText('第一轮答案')).toHaveLength(1)
    expect(document.querySelector('[data-message-id="msg_u_real"]')).not.toBeNull()
  })
})
// PR-6（3E）：布局结构（§8.4）、切换后焦点（§8.2）、锚点不抢焦点（§8.3）。
describe('ResearchChatPanel · PR-6 布局与切换焦点（§8.2/§8.3/§8.4）', () => {
  const REF_A: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: PROJECT_ID,
    sessionId: 'sess-pr6-a',
    sourceId: null,
  }
  const REF_B: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: PROJECT_ID,
    sessionId: 'sess-pr6-b',
    sourceId: null,
  }
  const REF_C: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: PROJECT_ID,
    sessionId: 'sess-pr6-c',
    sourceId: null,
  }
  const LONG_TITLE = 'A very long research conversation title that must not overflow the panel header'

  function conversationStub(): ConversationController {
    return {
      getSnapshot: () => ({
        version: 1,
        sessionKey: 'global:p1:sess-pr6',
        authGeneration: 1,
        turn: null,
        history: [],
        detailMessages: [],
        detailCursor: null,
      }),
      subscribe: () => () => {},
      load: vi.fn(async () => ({ status: 'ok' })),
      lookupSubmission: vi.fn(async () => ({ status: 'ok' })),
      refreshStatus: vi.fn(async () => ({ status: 'ok' })),
    } as unknown as ConversationController
  }

  function panelUi(
    ref: ResearchSessionRef,
    options: {
      turns?: ResearchChatTurn[]
      anchor?: WireChatAnchor | null
      editorPhase?: 'ready' | 'loading' | 'missing'
      /** 模拟父层尚未切到目标 session 的旧 editor 快照。 */
      editorRefOverride?: ResearchSessionRef
      surfaceActive?: boolean
    } = {},
  ) {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
    const editorPhase = options.editorPhase ?? 'ready'
    const editorSnapshot =
      editorPhase === 'missing'
        ? null
        : {
            ...createEditorState({
              ref: options.editorRefOverride ?? ref,
              writerId: 'writer-pr6',
              transportAvailable: true,
            }),
            phase: editorPhase,
            loading: editorPhase === 'loading',
            draftText: 'hello',
            baseScope: { mode: 'selected' as const, sourceIds: ['src_1'], singleSourceId: null },
            chatAnchor: options.anchor ?? null,
          }
    return (
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
          <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
            <ResearchChatPanel
              turns={options.turns ?? []}
              isStreaming={false}
              onSend={vi.fn(async () => true)}
              onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
              editorSnapshot={editorSnapshot}
              conversation={conversationStub()}
              sessionRef={ref}
              surfaceActive={options.surfaceActive ?? true}
              sessionMeta={{ title: LONG_TITLE, recordVisibility: 'visible' }}
              onSendSession={vi.fn(async () => true)}
              scopeSources={[{ sourceId: 'src_1', title: 'Paper One' }]}
              scopeNotes={[]}
              onChangeScope={vi.fn()}
              onDraftChange={vi.fn()}
              onRetrySave={vi.fn()}
            />
          </ResearchScopeProvider>
        </ResearchWorkspaceProvider>
      </QueryClientProvider>
    )
  }

  beforeEach(() => {
    localStorage.clear()
    seedScope({ mode: 'selected', sourceIds: ['src_1'], noteIds: [], singleSourceId: null })
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('滚动容器 min-h-0 flex-1 overflow-y-auto；输入区 shrink-0（§8.4）', () => {
    render(panelUi(REF_A))
    const messages = screen.getByTestId('chat-messages')
    expect(messages.className).toContain('min-h-0')
    expect(messages.className).toContain('flex-1')
    expect(messages.className).toContain('overflow-y-auto')
    const composer = screen.getByTestId('research-draft-composer')
    expect(composer.className).toContain('shrink-0')
  })

  it('长标题 truncate 且保留可访问全称（title）', () => {
    render(panelUi(REF_A))
    const title = screen.getByTestId('chat-session-title')
    expect(title.className).toContain('truncate')
    expect(title).toHaveAttribute('title', LONG_TITLE)
  })

  it('切换会话：此前焦点在输入框时，加载完成后焦点回到输入框（§8.2）', () => {
    const view = render(panelUi(REF_A))
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    input.focus()
    expect(input).toHaveFocus()

    view.rerender(panelUi(REF_B))
    expect(screen.getByTestId('chat-input')).toHaveFocus()
  })

  it('切换会话：此前焦点不在输入框时焦点落到面板标题（§8.1，不抢输入框）', () => {
    const view = render(panelUi(REF_A))
    const send = screen.getByTestId('chat-send') as HTMLButtonElement
    send.focus()
    expect(send).toHaveFocus()

    view.rerender(panelUi(REF_B))
    expect(screen.getByTestId('chat-session-header')).toHaveFocus()
    expect(screen.getByTestId('chat-input')).not.toHaveFocus()
  })

  it('焦点从输入框移到面板外普通元素后切换：不抢回输入框（§8.2）', () => {
    const external = document.createElement('button')
    external.setAttribute('data-testid', 'outside-plain')
    document.body.appendChild(external)
    try {
      const view = render(panelUi(REF_A))
      const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
      input.focus()
      expect(input).toHaveFocus()
      external.focus()
      expect(external).toHaveFocus()

      view.rerender(panelUi(REF_B))
      expect(screen.getByTestId('chat-session-header')).toHaveFocus()
      expect(screen.getByTestId('chat-input')).not.toHaveFocus()
    } finally {
      external.remove()
    }
  })

  it('ready→ready 切换（真实导航：焦点在触发按钮）也会回焦输入框（P1 回归）', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'session-switcher-trigger')
    document.body.appendChild(trigger)
    try {
      const view = render(panelUi(REF_A))
      const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
      input.focus()
      // 用户从输入框直接打开历史抽屉（焦点到触发按钮，意图保留）。
      trigger.focus()
      expect(trigger).toHaveFocus()

      view.rerender(panelUi(REF_B, { editorPhase: 'ready' }))
      expect(screen.getByTestId('chat-input')).toHaveFocus()
    } finally {
      trigger.remove()
    }
  })

  it('连续切换（B loading → C ready）沿用挂起回焦请求（P1 回归）', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'session-switcher-trigger')
    document.body.appendChild(trigger)
    try {
      const view = render(panelUi(REF_A))
      ;(screen.getByTestId('chat-input') as HTMLTextAreaElement).focus()
      trigger.focus()

      view.rerender(panelUi(REF_B, { editorPhase: 'loading' }))
      expect(trigger).toHaveFocus()
      view.rerender(panelUi(REF_C, { editorPhase: 'loading' }))
      expect(trigger).toHaveFocus()

      view.rerender(panelUi(REF_C, { editorPhase: 'ready' }))
      expect(screen.getByTestId('chat-input')).toHaveFocus()
    } finally {
      trigger.remove()
    }
  })

  it('挂起回焦期间焦点被外部元素接管后失效（P1-4 回归）', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'session-switcher-trigger')
    const external = document.createElement('button')
    external.setAttribute('data-testid', 'outside-plain')
    document.body.append(trigger, external)
    try {
      const view = render(panelUi(REF_A))
      ;(screen.getByTestId('chat-input') as HTMLTextAreaElement).focus()
      trigger.focus()

      view.rerender(panelUi(REF_B, { editorPhase: 'loading' }))
      expect(trigger).toHaveFocus()
      // 挂起期间用户把焦点移到面板外普通元素：挂起请求必须失效。
      external.focus()
      trigger.focus()

      view.rerender(panelUi(REF_B, { editorPhase: 'ready' }))
      expect(screen.getByTestId('chat-input')).not.toHaveFocus()
      expect(trigger).toHaveFocus()
    } finally {
      trigger.remove()
      external.remove()
    }
  })

  it('surface 隐藏时挂起回焦失效，重新显示不执行旧请求（P1 回归）', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'session-switcher-trigger')
    document.body.appendChild(trigger)
    try {
      const view = render(panelUi(REF_A))
      ;(screen.getByTestId('chat-input') as HTMLTextAreaElement).focus()
      trigger.focus()

      view.rerender(panelUi(REF_B, { editorPhase: 'loading' }))
      // 隐藏期间（身份不变）挂起请求必须失效，重新显示后不得执行。
      view.rerender(panelUi(REF_B, { editorPhase: 'loading', surfaceActive: false }))
      view.rerender(panelUi(REF_B, { editorPhase: 'ready', surfaceActive: true }))
      expect(screen.getByTestId('chat-input')).not.toHaveFocus()
      expect(screen.getByTestId('chat-session-header')).not.toHaveFocus()
    } finally {
      trigger.remove()
    }
  })

  it('过期意图：输入框→入口→外部控件→入口→切换不回焦输入框（P1 回归）', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'session-switcher-trigger')
    const external = document.createElement('button')
    external.setAttribute('data-testid', 'outside-plain')
    document.body.append(trigger, external)
    try {
      const view = render(panelUi(REF_A))
      ;(screen.getByTestId('chat-input') as HTMLTextAreaElement).focus()
      trigger.focus()
      external.focus()
      trigger.focus()

      view.rerender(panelUi(REF_B, { editorPhase: 'ready' }))
      expect(screen.getByTestId('chat-input')).not.toHaveFocus()
      expect(screen.getByTestId('chat-session-header')).toHaveFocus()
    } finally {
      trigger.remove()
      external.remove()
    }
  })

  it('目标 editor 未就绪时不提前抢焦，就绪后才回焦输入框（§8.2）', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'session-switcher-trigger')
    document.body.appendChild(trigger)
    try {
      const view = render(panelUi(REF_A))
      const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
      input.focus()
      // 用户打开历史抽屉：焦点从输入框移到导航触发按钮（意图保留）。
      trigger.focus()
      expect(trigger).toHaveFocus()

      view.rerender(panelUi(REF_B, { editorPhase: 'loading' }))
      // editor 加载期间不得抢焦。
      expect(trigger).toHaveFocus()

      view.rerender(panelUi(REF_B, { editorPhase: 'ready' }))
      expect(screen.getByTestId('chat-input')).toHaveFocus()
    } finally {
      trigger.remove()
    }
  })

  it('旧会话 editor 快照（身份不匹配）不回焦，目标快照就绪后才回焦（P2 回归）', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'session-switcher-trigger')
    document.body.appendChild(trigger)
    try {
      const view = render(panelUi(REF_A))
      ;(screen.getByTestId('chat-input') as HTMLTextAreaElement).focus()
      trigger.focus()

      // 父层尚未切到 B：仍传 A 的 ready 快照 → 身份不匹配，不得回焦。
      view.rerender(panelUi(REF_B, { editorPhase: 'ready', editorRefOverride: REF_A }))
      expect(screen.getByTestId('chat-input')).not.toHaveFocus()
      expect(trigger).toHaveFocus()

      view.rerender(panelUi(REF_B, { editorPhase: 'ready' }))
      expect(screen.getByTestId('chat-input')).toHaveFocus()
    } finally {
      trigger.remove()
    }
  })

  it('blur relatedTarget=null 清除挂起回焦（P2 回归）', () => {
    const trigger = document.createElement('button')
    trigger.setAttribute('data-testid', 'session-switcher-trigger')
    document.body.appendChild(trigger)
    try {
      const view = render(panelUi(REF_A))
      ;(screen.getByTestId('chat-input') as HTMLTextAreaElement).focus()
      trigger.focus()

      view.rerender(panelUi(REF_B, { editorPhase: 'loading' }))
      expect(trigger).toHaveFocus()

      // 程序化把焦点放回输入框后失焦（窗口失焦/点击不可聚焦背景 →
      // relatedTarget=null），挂起请求应失效。
      act(() => {
        const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
        input.focus()
        input.blur()
      })

      view.rerender(panelUi(REF_B, { editorPhase: 'ready' }))
      expect(screen.getByTestId('chat-input')).not.toHaveFocus()
    } finally {
      trigger.remove()
    }
  })

  it('锚点恢复只写 scrollTop，不抢焦点（§8.3）', () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    let chatScroll: HTMLElement | null = null
    HTMLElement.prototype.getBoundingClientRect = function mockRect(this: HTMLElement) {
      if (this.dataset?.messageId === 'msg-pr6') {
        return { top: 100 - (chatScroll?.scrollTop ?? 0), height: 80 } as DOMRect
      }
      if (this.dataset?.testid === 'chat-messages') {
        return { top: 0, height: 400 } as DOMRect
      }
      return { top: 0, height: 0 } as DOMRect
    }
    try {
      const anchor: WireChatAnchor = { messageId: 'msg-pr6', offsetPx: 20, followTail: false }
      const view = render(panelUi(REF_A, { anchor }))
      chatScroll = screen.getByTestId('chat-messages')
      Object.defineProperty(chatScroll, 'clientHeight', { value: 400, configurable: true })
      Object.defineProperty(chatScroll, 'scrollHeight', { value: 2000, configurable: true })
      // 目标消息随历史加载出现 → 稳定 ID 集合变化触发一次恢复。
      view.rerender(
        panelUi(REF_A, {
          anchor,
          turns: [turn({ id: 't-pr6', role: 'assistant', serverMessageId: 'msg-pr6' })],
        }),
      )
      // 公式：0 + 100 - 20 = 80。
      expect(chatScroll.scrollTop).toBe(80)
      // 恢复只设置滚动位置：活动焦点仍在 body，未被 focus()/scrollIntoView() 抢走。
      expect(document.activeElement).toBe(document.body)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })
})

// ── PR-10（#602 6b 真实接入 P0）：冷启动草稿查回只对“加载时的持久非空草稿” ──
//
// 根因：此前的查回 effect 以“草稿非空”为唯一条件。新建会话里用户新输入的
// 草稿也满足该条件 → `refreshMarkerLookups(newToken)` 对一个从未提交过的
// token 查回 → `not_observed` → 控制器产出一个 `external` turn → 随后首次
// 真实发送被 `replay_snapshot_unavailable` 阻断（点 Send 无 POST /chat）。
// 本组用例钉死：①新建空会话后用户输入不查回；②加载时已存在的持久非空
// 草稿仍查回一次（F10 不回退）；③结束后控制器无 not_observed turn。
import { createConversationController } from '@/lib/research/session-runtime'

describe('ResearchChatPanel PR-10：冷启动草稿查回守卫（新建会话不查回）', () => {
  const REF: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: PROJECT_ID,
    sessionId: 'sess-pr10',
    sourceId: null,
  }

  /**
   * 真实 controller + 可控 transport：查回返回 `not_observed`（新 token 在服务端
   * 没有任何提交，这正是线上触发路径），并记录是否发生过查回。
   */
  function mountCase(options: {
    /** 首次挂载时的 editor 草稿（模拟“加载时已存在的持久草稿”）。 */
    initialDraftText?: string
    initialDraftToken?: string
    /** 面板是否提供 refreshMarkerLookups（sessionMode 才提供）。 */
    withLookup?: boolean
  } = {}) {
    const submissionCalls: string[] = []
    const controller = createConversationController({
      ref: REF,
      authGeneration: 1,
      transport: {
        openStream: () => ({ abort: () => {} }),
        getSubmission: (input) => {
          submissionCalls.push(input.token)
          // 冷启动查回：该 token 无提交记录 → not_observed（与后端一致）。
          return {
            session_ref: {
              domain: 'research',
              kind: 'global',
              project_id: PROJECT_ID,
              session_id: 'sess-pr10',
              source_id: null,
            },
            draft_token: input.token,
            idempotency_key: `s1_${'b'.repeat(64)}`,
            acceptance_state: 'not_observed',
            generation_id: null,
            generation_state: null,
            accepted_editor_revision: null,
            editor_intent_hash: null,
            submitted_draft_text: null,
            context_report: null,
          }
        },
        releaseHold: () => {},
      },
    })
    const refreshMarkerLookups = vi.fn(async (token?: string | null) => {
      const result = await controller.lookupSubmission(token ?? undefined)
      return result.status === 'ok' ? 1 : 0
    })
    const onSendSession = vi.fn(async () => true)

    function Case(): React.ReactElement {
      const [snapshot, setSnapshot] = useState<EditorSnapshot>(() => ({
        ...createEditorState({
          ref: REF,
          writerId: 'writer-pr10',
          transportAvailable: true,
          draftToken: options.initialDraftToken ?? 'draft_initial',
        }),
        phase: 'ready',
        loading: false,
        draftText: options.initialDraftText ?? '',
        baseScope: { mode: 'selected' as const, sourceIds: ['src_1'], singleSourceId: null },
      }))
      return (
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })}>
          <ResearchWorkspaceProvider userId={USER_ID} projectId={PROJECT_ID} role="owner">
            <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
              <ResearchChatPanel
                turns={[]}
                isStreaming={false}
                onSend={vi.fn(async () => true)}
                onSendCoverage={vi.fn(async () => ACCEPTED_OUTCOME)}
                editorSnapshot={snapshot}
                conversation={controller}
                sessionRef={REF}
                onSendSession={onSendSession}
                refreshMarkerLookups={options.withLookup === false ? undefined : refreshMarkerLookups}
                scopeSources={[{ sourceId: 'src_1', title: 'Paper One' }]}
                scopeNotes={[]}
                onChangeScope={vi.fn()}
                // 模拟真实接线：输入经 editor 生成新 token（文本变化即换 token）。
                onDraftChange={(text) => setSnapshot((prev) => ({
                  ...prev,
                  draftText: text,
                  draftToken: `${'draft_input'}_${text.length}`,
                  dirty: text.length > 0,
                }))}
                onRetrySave={vi.fn()}
              />
            </ResearchScopeProvider>
          </ResearchWorkspaceProvider>
        </QueryClientProvider>
      )
    }

    render(<Case />)
    return { controller, refreshMarkerLookups, submissionCalls, onSendSession }
  }

  /** 控制器当前是否有 not_observed turn（= 会把首次发送挡在 replay 校验上）。 */
  function hasNotObservedTurn(controller: ReturnType<typeof createConversationController>): boolean {
    const snapshot = controller.getSnapshot()
    const turns = [snapshot.turn, ...snapshot.history].filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    )
    return turns.some((entry) => entry.state === 'not_observed')
  }

  it('①新建空会话初次 ready 为空 → 用户输入 → 不调用 refreshMarkerLookups', async () => {
    const { refreshMarkerLookups } = mountCase()
    // 初始空稿：不查回。
    expect(refreshMarkerLookups).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '新会话第一问' } })
    // 用户输入后即使换 token、草稿非空，也不得查回。
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveValue('新会话第一问'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(refreshMarkerLookups).not.toHaveBeenCalled()
  })

  it('②加载时已存在的非空持久草稿 → 仍查回一次（F10 不回退）', async () => {
    const { refreshMarkerLookups } = mountCase({
      initialDraftText: '持久草稿',
      initialDraftToken: 'draft_persisted',
    })
    await waitFor(() => expect(refreshMarkerLookups).toHaveBeenCalledTimes(1))
    expect(refreshMarkerLookups).toHaveBeenCalledWith('draft_persisted')
  })

  it('③新建会话输入并挂载后：控制器无 not_observed turn（首次发送不会被 replay 校验阻断）', async () => {
    const { controller, submissionCalls } = mountCase()
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '新会话第一问' } })
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveValue('新会话第一问'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(submissionCalls).toEqual([])
    expect(hasNotObservedTurn(controller)).toBe(false)
    expect(controller.getSnapshot().turn).toBeNull()
  })

  it('对照：持久草稿查回后控制器确有 not_observed turn（说明 ③ 的断言可证伪）', async () => {
    const { controller } = mountCase({
      initialDraftText: '持久草稿',
      initialDraftToken: 'draft_persisted',
    })
    await waitFor(() => expect(hasNotObservedTurn(controller)).toBe(true))
    // 该 turn 是 external（不绑定编辑器快照），与 §6.7 冷启动语义一致。
    expect(controller.getSnapshot().turn?.external).toBe(true)
  })

  it('无 refreshMarkerLookups（未接线查回）时不产生 turn', async () => {
    const { controller } = mountCase({
      initialDraftText: '持久草稿',
      initialDraftToken: 'draft_persisted',
      withLookup: false,
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(controller.getSnapshot().turn).toBeNull()
  })
})
