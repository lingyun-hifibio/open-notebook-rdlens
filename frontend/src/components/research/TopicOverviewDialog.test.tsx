/**
 * Issue #1016（D1-G）主题概览 Dialog 组件测试（计划 §5.2 F-03/F-03b/F-04/
 * F-05/F-06/F-07/F-08/F-09）。
 *
 * 替身位置：**api 函数级**（`getTopicOverview`/`createTopicOverview`），hooks
 * 走真实实现 -> 同时验证「组件 → hook → 专用 builder → api」的请求契约：
 * - 生成/更新经既有 `runGuarded`（外部模型不派发；守卫未放行不派发）；
 * - 请求体含 `focus`、不含 `query`；`source_scope` 来自
 *   `useResearchScope().getSnapshot()`（唯一 scope 真源）；`note_ids: []`；
 *   `Idempotency-Key` 每次新键；
 * - 空 selected / Admin 只读 / 外部模型禁用并显示原因；
 * - 四段/降级 Markdown/限制/声明范围 vs 实际纳入证据/模型/时间/引用跳转/
 *   继续讨论；409 换键提示、stale_generation_ignored 提示、受限不渲染正文。
 */
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { ResearchScopeProvider, scopeStorageKey } from '@/lib/research/scope'
import { topicOverviewDiscussionText } from '@/lib/research/topic-overview'
import type { TopicOverviewWire } from '@/lib/research/topic-overview'
import type { ResearchSource } from '@/lib/types/research'
import { GLOBAL_MODEL_STUB_ID, resetGlobalModelStub, setGlobalModelStub } from '@/test/global-model-stub'
import {
  TopicOverviewDialog,
  type TopicOverviewDialogProps,
} from './TopicOverviewDialog'

const h = vi.hoisted(() => ({
  state: { sources: [] as unknown[] },
  getTopicOverview: vi.fn(),
  createTopicOverview: vi.fn(),
  listSources: vi.fn(),
  useResearchSources: vi.fn(),
}))

const LOCALIZED_DISCUSSION_GUIDE = 'Continue the discussion based on this topic overview: '

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

vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/lib/hooks/use-research', () => ({
  useResearchSources: h.useResearchSources,
}))

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...actual,
    getTopicOverview: h.getTopicOverview,
    createTopicOverview: h.createTopicOverview,
    listSources: h.listSources,
  }
})

const PROJECT_ID = 'proj_1'

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
    content_markdown: '概览全文 Markdown',
    sections: {
      main_questions: '主要问题段落',
      findings: '主要发现段落',
      disagreements: '分歧段落',
      reading_priorities: '建议优先细读段落',
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
      source_count: 2,
      refs_truncated: false,
      sources: [
        { document_id: 'doc_1', document_version: 'v1', source_id: 'src_1' },
        { document_id: 'doc_2', document_version: 'v1', source_id: 'src_2' },
      ],
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
        { document_id: 'doc_1', document_version: 'v1', chunk_count: 2, source_id: 'src_1' },
      ],
      degradations: [],
      degradation_reason: null,
      evidence_degraded: null,
      full_text_read: false,
    },
    model: { model_id: 'm-local', provider_id: 'p_local' },
    purpose: null,
    limitations: [
      'full_text_not_read',
      'section_citation_mapping_not_verified',
      'body_chunks_only',
    ],
    warnings: [],
    ...overrides,
  }
}

function restrictedOverview(overrides: Partial<TopicOverviewWire> = {}): TopicOverviewWire {
  return {
    ...readyOverview(),
    visibility: 'restricted',
    content_markdown: null,
    sections: null,
    citations: [],
    scope: {
      mode: 'selected',
      contract_version: 'c05-v1',
      includes_exact_versions: true,
      captured_at: '2026-11-05T09:55:00+00:00',
      source_count: 2,
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
      coverage: null,
      included_sources: [],
      degradations: [],
      degradation_reason: null,
      evidence_degraded: null,
      full_text_read: false,
    },
    limitations: ['content_restricted'],
    warnings: ['content_restricted'],
    ...overrides,
  }
}

function httpDetailError(status: number, detail: Record<string, unknown>): Error {
  const error = new Error(`http_${status}`) as Error & { response?: unknown }
  error.response = {
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    data: { detail },
    config: {},
  }
  return error
}

function seedScope(
  mode: 'all' | 'selected' | 'single',
  sourceIds: string[] = [],
  noteIds: string[] = [],
) {
  localStorage.setItem(
    scopeStorageKey('u1', PROJECT_ID),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds }),
  )
}

let queryClient: QueryClient
let onCitationJump: Mock<(sourceId: string, pageIdx: number | null) => void>
let setDraftText: Mock<(text: string) => void>

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ResearchScopeProvider userId="u1" projectId={PROJECT_ID}>
        {children}
      </ResearchScopeProvider>
    </QueryClientProvider>
  )
}

function DialogHarness(props: Partial<TopicOverviewDialogProps> = {}) {
  const [open, setOpen] = useState(props.open ?? true)
  return (
    <TopicOverviewDialog
      projectId={PROJECT_ID}
      open={open}
      onOpenChange={setOpen}
      onCitationJump={onCitationJump}
      canExecute
      isAdminReadonly={false}
      confirmedModelIsExternal={false}
      {...props}
    />
  )
}

function renderDialog(props: Partial<TopicOverviewDialogProps> = {}) {
  return render(<DialogHarness {...props} />, { wrapper })
}

beforeEach(() => {
  localStorage.clear()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  onCitationJump = vi.fn<(sourceId: string, pageIdx: number | null) => void>()
  setDraftText = vi.fn<(text: string) => void>()
  h.state.sources = [
    source(),
    source({ source_id: 'src_2', document_id: 'doc_2' }),
  ]
  h.getTopicOverview.mockReset()
  h.getTopicOverview.mockResolvedValue(null)
  h.createTopicOverview.mockReset()
  h.listSources.mockReset()
  h.listSources.mockResolvedValue({ items: [source()], next_cursor: null })
  h.useResearchSources.mockReset()
  h.useResearchSources.mockImplementation(() => ({
    data: { items: h.state.sources },
    isLoading: false,
    isError: false,
    error: null,
  }))
  resetGlobalModelStub()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('F-04：概览展示（四段/降级/限制/范围与覆盖/模型）', () => {
  it('四段齐全时渲染四段、声明范围 vs 实际证据、限制与模型', async () => {
    h.getTopicOverview.mockResolvedValue(readyOverview())
    renderDialog()

    await screen.findByTestId('topic-overview-sections')
    expect(screen.getByTestId('topic-overview-section-main-questions')).toHaveTextContent(
      'research.topicOverview.sections.mainQuestions',
    )
    expect(screen.getByTestId('topic-overview-section-findings')).toHaveTextContent(
      '主要发现段落',
    )
    expect(screen.getByTestId('topic-overview-section-disagreements')).toBeInTheDocument()
    expect(screen.getByTestId('topic-overview-section-reading-priorities')).toBeInTheDocument()

    // 声明范围 vs 实际纳入证据：绝不把「实际纳入」写成「已处理全部资料」。
    expect(screen.getByTestId('topic-overview-scope-declared')).toHaveTextContent(
      'research.topicOverview.scope.declared',
    )
    expect(screen.getByTestId('topic-overview-scope-declared')).toHaveTextContent(
      '"count":2',
    )
    expect(screen.getByTestId('topic-overview-scope-actual')).toHaveTextContent('"chunks":2')
    expect(screen.getByTestId('topic-overview-scope-resolved')).toHaveTextContent(
      '"mode":"hybrid_rag"',
    )
    expect(screen.getByTestId('topic-overview-scope-coverage')).toHaveTextContent('"trimmed":1')
    expect(screen.getByTestId('topic-overview-scope-honesty')).toHaveTextContent(
      'research.topicOverview.scope.notAllRead',
    )

    // 限制按码映射（恒含 section_citation_mapping_not_verified）
    expect(
      screen.getByTestId('topic-overview-limitation-full_text_not_read'),
    ).toHaveTextContent('research.topicOverview.limitations.fullTextNotRead')
    expect(
      screen.getByTestId('topic-overview-limitation-section_citation_mapping_not_verified'),
    ).toHaveTextContent(
      'research.topicOverview.limitations.sectionCitationMappingNotVerified',
    )
    expect(screen.getByTestId('topic-overview-model')).toHaveTextContent(
      'research.topicOverview.model|{"model":"m-local"}',
    )
    // 时间可见（生成时间 + 范围快照时间）
    expect(screen.getByTestId('topic-overview-generated')).toHaveTextContent(
      'research.topicOverview.generatedAt',
    )
    expect(screen.getByTestId('topic-overview-captured')).toHaveTextContent(
      'research.topicOverview.capturedAt',
    )
    // focus 未返回（null）→ 不渲染 focus 行，不伪造
    expect(screen.queryByTestId('topic-overview-focus-value')).toBeNull()
  })

  it('sections 缺失时回落到整篇 Markdown 并提示结构不完整；未知 limitation 码不崩溃', async () => {
    h.getTopicOverview.mockResolvedValue(
      readyOverview({
        sections: null,
        content_markdown: '整篇 Markdown 正文',
        limitations: ['full_text_not_read', 'future_unknown_code'],
        model: null,
      }),
    )
    renderDialog()

    const markdown = await screen.findByTestId('topic-overview-markdown')
    expect(markdown).toHaveTextContent('research.topicOverview.sections.incomplete')
    expect(markdown).toHaveTextContent('整篇 Markdown 正文')
    expect(screen.queryByTestId('topic-overview-sections')).toBeNull()
    expect(
      screen.getByTestId('topic-overview-limitation-future_unknown_code'),
    ).toHaveTextContent('research.topicOverview.limitations.unknown|{"code":"future_unknown_code"}')
    // 模型未记录 → 明确说明，不伪造
    expect(screen.getByTestId('topic-overview-model')).toHaveTextContent(
      'research.topicOverview.modelNotRecorded',
    )
  })

  it('coverage 缺失时不出覆盖行；未返回的可选字段不渲染', async () => {
    const overview = readyOverview()
    overview.processing = { ...overview.processing!, coverage: null }
    h.getTopicOverview.mockResolvedValue(overview)
    renderDialog()
    await screen.findByTestId('topic-overview-sections')
    expect(screen.queryByTestId('topic-overview-scope-coverage')).toBeNull()
  })
})

describe('MEDIUM-1：Dialog 就绪态资料变化提示（计划 §2.9 :491）', () => {
  it('ready 且当前资料与范围不同 → 显示新增/版本变化/退役计数', async () => {
    // 概览范围：doc_1/v1 + doc_2/v1；当前：doc_1/v2（版本变化）+ doc_3/v1（新增），
    // doc_2 退役。
    h.state.sources = [
      source({ source_id: 'src_1', document_id: 'doc_1', document_version: 'v2' }),
      source({ source_id: 'src_3', document_id: 'doc_3', document_version: 'v1' }),
    ]
    h.getTopicOverview.mockResolvedValue(readyOverview())
    renderDialog()

    const notice = await screen.findByTestId('topic-overview-dialog-changes')
    expect(notice).toHaveTextContent('research.topicOverview.dialog.changesNotice')
    expect(notice).toHaveTextContent('"added":1')
    expect(notice).toHaveTextContent('"versionChanged":1')
    expect(notice).toHaveTextContent('"retired":1')
  })

  it('范围与当前资料一致 → 不显示提示', async () => {
    h.getTopicOverview.mockResolvedValue(readyOverview())
    renderDialog()
    await screen.findByTestId('topic-overview-sections')
    expect(screen.queryByTestId('topic-overview-dialog-changes')).toBeNull()
  })

  it('restricted → 不显示提示（scope.sources=[] 不参与比较）', async () => {
    h.state.sources = [
      source({ source_id: 'src_1', document_id: 'doc_1', document_version: 'v9' }),
      source({ source_id: 'src_9', document_id: 'doc_9', document_version: 'v1' }),
    ]
    h.getTopicOverview.mockResolvedValue(restrictedOverview())
    renderDialog()
    await screen.findByTestId('topic-overview-restricted')
    expect(screen.queryByTestId('topic-overview-dialog-changes')).toBeNull()
  })
})

describe('F-05：引用跳转（四闸）', () => {
  it('来源可用时点击跳转调用 onCitationJump(sourceId, pageIdx)', async () => {
    h.getTopicOverview.mockResolvedValue(readyOverview())
    renderDialog()
    const jump = await screen.findByTestId('topic-overview-citation-jump-0')
    fireEvent.click(jump)
    expect(onCitationJump).toHaveBeenCalledWith('src_1', 2)
  })

  it('source_id 为 null → 禁用并使用既有降级文案', async () => {
    const overview = readyOverview()
    overview.citations = [{ ...overview.citations[0], source_id: null }]
    h.getTopicOverview.mockResolvedValue(overview)
    renderDialog()
    expect(
      await screen.findByTestId('topic-overview-citation-degraded-0'),
    ).toHaveTextContent('research.citation.degradedSource')
    expect(screen.queryByTestId('topic-overview-citation-jump-0')).toBeNull()
  })

  it('页码缺失 → 禁用并显示既有降级文案', async () => {
    const overview = readyOverview()
    overview.citations = [{ ...overview.citations[0], page_idx: null }]
    h.getTopicOverview.mockResolvedValue(overview)
    renderDialog()
    expect(
      await screen.findByTestId('topic-overview-citation-degraded-0'),
    ).toHaveTextContent('research.citation.degradedPage')
    expect(screen.queryByTestId('topic-overview-citation-jump-0')).toBeNull()
  })

  it('版本不符 → 禁用并显示既有版本降级文案（绝不静默打开另一版本）', async () => {
    const overview = readyOverview()
    overview.citations = [{ ...overview.citations[0], doc_version: 'v0' }]
    h.getTopicOverview.mockResolvedValue(overview)
    renderDialog()
    expect(
      await screen.findByTestId('topic-overview-citation-degraded-0'),
    ).toHaveTextContent('research.citation.degradedVersion')
    expect(screen.queryByTestId('topic-overview-citation-jump-0')).toBeNull()
  })

  it('来源不可用（stale）→ 禁用并显示既有降级文案', async () => {
    h.state.sources = [source({ status: 'stale' })]
    h.getTopicOverview.mockResolvedValue(readyOverview())
    renderDialog()
    expect(
      await screen.findByTestId('topic-overview-citation-degraded-0'),
    ).toHaveTextContent('research.citation.degradedSource')
    expect(screen.queryByTestId('topic-overview-citation-jump-0')).toBeNull()
  })
})

describe('F-06：继续讨论（editorHandle.setDraftText）', () => {
  it('editorHandle 可用时显示动作，点击写入固定引导草稿', async () => {
    const overview = readyOverview()
    h.getTopicOverview.mockResolvedValue(overview)
    renderDialog({ editorHandle: { setDraftText } })
    fireEvent.click(await screen.findByTestId('topic-overview-discuss'))
    expect(setDraftText).toHaveBeenCalledTimes(1)
    expect(setDraftText).toHaveBeenCalledWith(
      topicOverviewDiscussionText(overview, LOCALIZED_DISCUSSION_GUIDE),
    )
    // en-US 不再向草稿写中文引导句（MEDIUM-3）
    const draft = setDraftText.mock.calls[0][0]
    expect(draft.startsWith(LOCALIZED_DISCUSSION_GUIDE)).toBe(true)
    expect(draft).not.toContain('基于当前主题概览')
  })

  it('editorHandle 不可用时不显示动作', async () => {
    h.getTopicOverview.mockResolvedValue(readyOverview())
    renderDialog({ editorHandle: null })
    await screen.findByTestId('topic-overview-sections')
    expect(screen.queryByTestId('topic-overview-discuss')).toBeNull()
  })
})

describe('F-08：受限概览', () => {
  it('restricted 不渲染正文/引用/来源身份，显示受限说明，不显示「无命中」空态', async () => {
    h.getTopicOverview.mockResolvedValue(restrictedOverview())
    renderDialog()

    expect(await screen.findByTestId('topic-overview-restricted')).toHaveTextContent(
      'research.topicOverview.restricted.title',
    )
    expect(screen.queryByTestId('topic-overview-sections')).toBeNull()
    expect(screen.queryByTestId('topic-overview-markdown')).toBeNull()
    expect(screen.queryByTestId('topic-overview-citations')).toBeNull()
    expect(screen.queryByTestId('topic-overview-citations-empty')).toBeNull()
    expect(screen.queryByTestId('topic-overview-scope')).toBeNull()
    expect(screen.queryByTestId('topic-overview-limitations')).toBeNull()
    // 执行元数据（时间/模型）仍保留
    expect(screen.getByTestId('topic-overview-generated')).toBeInTheDocument()
    expect(screen.getByTestId('topic-overview-model')).toHaveTextContent('m-local')
  })
})

describe('F-03/F-03b：生成请求契约与禁用条件', () => {
  it('生成经 runGuarded：请求体含 focus、不含 query，source_scope 来自 scope 快照、note_ids=[]、模型为 confirmed', async () => {
    seedScope('selected', ['src_1'])
    h.createTopicOverview.mockResolvedValue(readyOverview())
    renderDialog()

    const focusInput = await screen.findByTestId('topic-overview-focus')
    fireEvent.change(focusInput, { target: { value: '这批资料的争议点？' } })
    fireEvent.click(screen.getByTestId('topic-overview-submit'))

    await waitFor(() => expect(h.createTopicOverview).toHaveBeenCalledTimes(1))
    const [projectId, body, options] = h.createTopicOverview.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { idempotencyKey: string },
    ]
    expect(projectId).toBe(PROJECT_ID)
    expect(body.focus).toBe('这批资料的争议点？')
    expect('query' in body).toBe(false)
    expect(body.source_scope).toEqual({
      mode: 'selected',
      source_ids: ['src_1'],
      single_source_id: null,
    })
    expect(body.note_ids).toEqual([])
    // 旧 v1 顶层字段不得混入（NORMATIVE 31）
    expect('source_ids' in body).toBe(false)
    expect('mode' in body).toBe(false)
    expect('context_level' in body).toBe(false)
    // C-01：若携带 work_purpose 只允许 document_qa
    if ('work_purpose' in body) expect(body.work_purpose).toBe('document_qa')
    expect(body.model_id).toBe(GLOBAL_MODEL_STUB_ID)
    expect(typeof options.idempotencyKey).toBe('string')
    expect((options.idempotencyKey as string).length).toBeGreaterThan(0)
  })

  it('守卫未放行（consent 待确认）→ 不派发请求', async () => {
    seedScope('selected', ['src_1'])
    setGlobalModelStub({ deferGuarded: true })
    renderDialog({ canExecute: true })
    fireEvent.click(await screen.findByTestId('topic-overview-submit'))
    expect(h.createTopicOverview).not.toHaveBeenCalled()
  })

  it.each([
    [{ canExecute: false, blockedHint: 'research.globalModel.selectModelHint' }, 'research.globalModel.selectModelHint'],
    [{ confirmedModelIsExternal: true }, 'research.topicOverview.dialog.externalModelBlocked'],
  ])('禁用条件：%o', async (props, expectedCopy) => {
    seedScope('selected', ['src_1'])
    renderDialog(props as Partial<TopicOverviewDialogProps>)
    const submit = await screen.findByTestId('topic-overview-submit')
    expect(submit).toBeDisabled()
    expect(screen.getByTestId('topic-overview-blocked')).toHaveTextContent(expectedCopy)
    fireEvent.click(submit)
    expect(h.createTopicOverview).not.toHaveBeenCalled()
  })

  it('空 selected fail-closed（提示先选择资料，不扩大为 all）', async () => {
    seedScope('selected', [])
    renderDialog()
    const submit = await screen.findByTestId('topic-overview-submit')
    expect(submit).toBeDisabled()
    expect(screen.getByTestId('topic-overview-blocked')).toHaveTextContent(
      'research.topicOverview.dialog.emptyScope',
    )
    fireEvent.click(submit)
    expect(h.createTopicOverview).not.toHaveBeenCalled()
  })

  it('Admin 只读不显示生成/更新（只显示只读说明）', async () => {
    seedScope('selected', ['src_1'])
    renderDialog({ isAdminReadonly: true })
    await screen.findByTestId('topic-overview-empty')
    expect(screen.queryByTestId('topic-overview-form')).toBeNull()
    expect(screen.queryByTestId('topic-overview-submit')).toBeNull()
    expect(screen.getByTestId('topic-overview-admin-readonly')).toHaveTextContent(
      'research.topicOverview.dialog.adminReadonly',
    )
  })
})

describe('F-07：更新概览（新幂等键/失败保留旧概览/409/换键提示/stale）', () => {
  it('更新成功：新幂等键；结果替换展示内容；不自动重试', async () => {
    const initial = readyOverview()
    h.getTopicOverview.mockResolvedValue(initial)
    const updated = readyOverview({
      generation_id: 'gen_2',
      sections: {
        main_questions: '更新后的问题',
        findings: '更新后的发现',
        disagreements: '更新后的分歧',
        reading_priorities: '更新后的阅读重点',
      },
    })
    h.createTopicOverview.mockResolvedValue(updated)
    renderDialog()

    fireEvent.click(await screen.findByTestId('topic-overview-update'))
    fireEvent.click(screen.getByTestId('topic-overview-submit'))
    await waitFor(() => expect(h.createTopicOverview).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('topic-overview-section-findings')).toHaveTextContent(
      '更新后的发现',
    )

    // 再来一次更新 → 新幂等键（不与上一次复用）
    fireEvent.click(await screen.findByTestId('topic-overview-update'))
    fireEvent.click(screen.getByTestId('topic-overview-submit'))
    await waitFor(() => expect(h.createTopicOverview).toHaveBeenCalledTimes(2))
    const firstKey = (
      h.createTopicOverview.mock.calls[0][2] as { idempotencyKey: string }
    ).idempotencyKey
    const secondKey = (
      h.createTopicOverview.mock.calls[1][2] as { idempotencyKey: string }
    ).idempotencyKey
    expect(secondKey).not.toBe(firstKey)
    expect(h.createTopicOverview).toHaveBeenCalledTimes(2)
  })

  it('写前失败（503 store_unavailable）：显示错误、保留旧概览、提示刷新确认', async () => {
    h.getTopicOverview.mockResolvedValue(readyOverview())
    h.createTopicOverview.mockRejectedValue(
      httpDetailError(503, {
        code: 'topic_overview_store_unavailable',
        message: 'store unavailable',
      }),
    )
    renderDialog()
    fireEvent.click(await screen.findByTestId('topic-overview-update'))
    fireEvent.click(screen.getByTestId('topic-overview-submit'))

    const error = await screen.findByTestId('topic-overview-submit-error')
    expect(error).toHaveTextContent('research.topicOverview.errors.storeUnavailable')
    // 旧概览仍在展示（不因失败清空）
    expect(screen.getByTestId('topic-overview-section-findings')).toHaveTextContent(
      '主要发现段落',
    )
    expect(screen.getByTestId('topic-overview-write-after-hint')).toHaveTextContent(
      'research.topicOverview.dialog.refreshToConfirm',
    )
  })

  it('409 requires_job 同键重放：提示换新键（不自动重试），手动重试用新键', async () => {
    h.getTopicOverview.mockResolvedValue(readyOverview())
    h.createTopicOverview.mockRejectedValueOnce(
      httpDetailError(409, {
        code: 'topic_overview_scope_exceeds_limit',
        message: 'scope exceeds limit',
        retry_with_original_idempotency_key: true,
      }),
    )
    h.createTopicOverview.mockResolvedValueOnce(readyOverview({ generation_id: 'gen_3' }))
    renderDialog()
    fireEvent.click(await screen.findByTestId('topic-overview-update'))
    fireEvent.click(screen.getByTestId('topic-overview-submit'))

    const error = await screen.findByTestId('topic-overview-submit-error')
    expect(error).toHaveTextContent('research.topicOverview.errors.scopeExceedsLimit')
    expect(screen.getByTestId('topic-overview-new-key-hint')).toHaveTextContent(
      'research.topicOverview.dialog.retryWithNewKey',
    )
    // 不自动重试：仍然只有第一次请求
    expect(h.createTopicOverview).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('topic-overview-submit-retry'))
    await waitFor(() => expect(h.createTopicOverview).toHaveBeenCalledTimes(2))
    const firstKey = (
      h.createTopicOverview.mock.calls[0][2] as { idempotencyKey: string }
    ).idempotencyKey
    const secondKey = (
      h.createTopicOverview.mock.calls[1][2] as { idempotencyKey: string }
    ).idempotencyKey
    expect(secondKey).not.toBe(firstKey)
  })

  it('stale_generation_ignored：显示「已保留较新概览」提示', async () => {
    h.getTopicOverview.mockResolvedValue(readyOverview())
    h.createTopicOverview.mockResolvedValue(
      readyOverview({
        generation_id: 'gen_2',
        warnings: ['stale_generation_ignored'],
      }),
    )
    renderDialog()
    fireEvent.click(await screen.findByTestId('topic-overview-update'))
    fireEvent.click(screen.getByTestId('topic-overview-submit'))
    expect(await screen.findByTestId('topic-overview-stale-notice')).toHaveTextContent(
      'research.topicOverview.dialog.staleGenerationIgnored',
    )
  })
})

describe('F-09：读面错误映射与手动重试', () => {
  it.each([
    ['topic_overview_not_enabled', 'research.topicOverview.errors.notEnabled'],
    ['topic_overview_store_unavailable', 'research.topicOverview.errors.storeUnavailable'],
    ['topic_overview_output_invalid', 'research.topicOverview.errors.outputInvalid'],
    ['topic_overview_insufficient_evidence', 'research.topicOverview.errors.insufficientEvidence'],
    ['unknown_future_code', 'research.errors.generic'],
  ])('GET 错误码 %s → %s（不自动重试）', async (code, expectedKey) => {
    h.getTopicOverview.mockRejectedValue(httpDetailError(503, { code, message: code }))
    renderDialog()
    expect(await screen.findByTestId('topic-overview-error')).toHaveTextContent(expectedKey)
    expect(h.getTopicOverview).toHaveBeenCalledTimes(1)

    h.getTopicOverview.mockResolvedValue(null)
    fireEvent.click(screen.getByTestId('topic-overview-error-retry'))
    await waitFor(() => expect(h.getTopicOverview).toHaveBeenCalledTimes(2))
  })

  it('关闭时不请求概览', () => {
    renderDialog({ open: false })
    expect(h.getTopicOverview).not.toHaveBeenCalled()
  })

  it('生成错误（422 无证据）→ 映射稳定码文案', async () => {
    seedScope('selected', ['src_1'])
    h.getTopicOverview.mockResolvedValue(null)
    h.createTopicOverview.mockRejectedValue(
      httpDetailError(422, {
        code: 'topic_overview_insufficient_evidence',
        message: 'no evidence',
      }),
    )
    renderDialog()
    fireEvent.click(await screen.findByTestId('topic-overview-submit'))
    const error = await screen.findByTestId('topic-overview-submit-error')
    expect(error).toHaveTextContent('research.topicOverview.errors.insufficientEvidence')
    // 无 409 换键提示；失败不自动重试
    expect(screen.queryByTestId('topic-overview-new-key-hint')).toBeNull()
    expect(h.createTopicOverview).toHaveBeenCalledTimes(1)
  })
})
