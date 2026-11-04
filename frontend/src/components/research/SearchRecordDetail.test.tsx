/**
 * 搜索记录详情六分区测试（Issue #1014 / D1-F 主单 §5.2/§2.8）。
 *
 * 覆盖：completed v2 六分区固定顺序与三区独立计数；命中「已引用/未引用」
 * 复合键标记；truncated 精确总数提示；模型核对；restricted 隐藏身份/片段/
 * conclusion；snippet_unavailable 不伪造；v1 行不渲染 v2 分区；failed/
 * no_generation 模型口径；跳转四闸与既有降级文案；无 Save/Continue/Rerun。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SearchRecordDetail } from './SearchRecordDetail'
import { parseSearchRecordDetail } from '@/lib/research/search-records'
import type { ResearchSource } from '@/lib/types/research'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts === undefined ? key : `${key}|${JSON.stringify(opts)}`,
  }),
}))

// MarkdownRenderer 依赖 window.matchMedia（jsdom 未实现），与本文断言无关
vi.mock('@/components/ui/markdown-renderer', () => ({
  MarkdownRenderer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

const SOURCES: ResearchSource[] = [
  {
    source_id: 'src_1',
    document_id: 'doc_a',
    document_version: 'v1',
    status: 'ready',
    content_hash: null,
    synced_at: null,
    last_error: null,
  },
  {
    source_id: 'src_2',
    document_id: 'doc_b',
    document_version: 'v2',
    status: 'ready',
    content_hash: null,
    synced_at: null,
    last_error: null,
  },
]

const COMPLETED_RAW = {
  schema_version: 'd1f-search-record-v2',
  record_id: 'gen_2',
  generation_id: 'gen_2',
  created_at: '2026-11-04T10:00:00+00:00',
  completed_at: '2026-11-04T10:00:06+00:00',
  query: 'what is ORR?',
  outcome: 'completed',
  outcome_detail: null,
  generation_state: 'completed',
  requested_mode: 'auto',
  resolved_mode: 'hybrid_rag',
  context_level: 'focused',
  hit_count: 3,
  scope: {
    schema_version: 'd1f-search-scope-v1',
    contract_version: 'c05-v1',
    resolution: 'accept_snapshot',
    mode: 'selected',
    requested_source_ids: ['src_1'],
    note_ids: ['note_9'],
    resolved_source_refs: [
      { document_id: 'doc_a', document_version: 'v1' },
      { document_id: 'doc_b', document_version: 'v2' },
    ],
    missing_source_ids: ['src_missing'],
    includes_exact_versions: true,
    contains_document_body: false,
    single_source_id: null,
    warnings: [],
    source_total: 3,
  },
  source_counts: { total: 3, visible: 3, restricted: 0 },
  sources: [
    { document_id: 'doc_a', document_version: 'v1', source_id: 'src_1', status: 'ready', warning: null },
    { document_id: 'doc_b', document_version: 'v2', source_id: 'src_2', status: 'ready', warning: null },
  ],
  conclusion: { text: 'Answer body', truncated: false },
  degradations: [
    {
      code: 'insufficient_context',
      scope: 'retrieval',
      severity: 'info',
      affects_answer: false,
      retryable: false,
      origin: 'recorded',
    },
  ],
  degradation_schema_version: 'd1c-degradation-v1',
  failure: null,
  coverage: { selected_full: 2, token_estimate: 120 },
  record_visibility: 'visible',
  warnings: [],
  result_available: true,
  model: { model_id: 'm-local', provider_id: 'prov-local' },
  hits: {
    total: 3,
    truncated: true,
    items: [
      {
        document_id: 'doc_a',
        document_version: 'v1',
        chunk_id: 'c1',
        page_idx: 0,
        source_id: 'src_1',
        snippet: 'hit snippet one',
        warning: null,
      },
      {
        document_id: 'doc_b',
        document_version: 'v2',
        chunk_id: 'c2',
        page_idx: 3,
        source_id: 'src_2',
        snippet: 'hit snippet two',
        warning: null,
      },
      {
        document_id: 'doc_b',
        document_version: 'v2',
        chunk_id: 'c3',
        page_idx: null,
        source_id: null,
        snippet: null,
        warning: 'snippet_unavailable',
      },
    ],
  },
  citations: {
    total: 2,
    truncated: false,
    items: [
      {
        citation_id: 1,
        chunk_id: 'c1',
        document_id: 'doc_a',
        document_version: 'v1',
        page_idx: 0,
        source_id: 'src_1',
        claim: 'claim one',
        snippet: 'hit snippet one',
        warning: null,
      },
      {
        citation_id: 2,
        chunk_id: 'c9',
        document_id: 'doc_b',
        document_version: 'v2',
        page_idx: 1,
        source_id: 'src_2',
        claim: 'claim two',
        snippet: null,
        warning: null,
      },
    ],
  },
}

function detailFrom(overrides: Record<string, unknown> = {}) {
  return parseSearchRecordDetail({ ...COMPLETED_RAW, ...overrides })
}

function renderDetail(
  overrides: Record<string, unknown> = {},
  props: {
    sources?: readonly ResearchSource[]
    onCitationJump?: (sourceId: string, pageIdx: number | null) => void
  } = {},
) {
  const onBack = vi.fn()
  const onClose = vi.fn()
  const onCitationJump = props.onCitationJump ?? vi.fn()
  const utils = render(
    <SearchRecordDetail
      record={detailFrom(overrides)}
      sources={'sources' in props ? props.sources : SOURCES}
      onBack={onBack}
      onClose={onClose}
      onCitationJump={onCitationJump}
    />,
  )
  return { ...utils, onBack, onClose, onCitationJump }
}

describe('SearchRecordDetail：completed v2 六分区', () => {
  it('固定顺序六分区，三区各自独立标题与计数', () => {
    const { container } = renderDetail()
    const sections = Array.from(container.querySelectorAll('section')).map(
      (section) => section.getAttribute('data-testid'),
    )
    expect(sections).toEqual([
      'search-record-section-context',
      'search-record-section-allowed-sources',
      'search-record-section-hits',
      'search-record-section-citations',
      'search-record-section-conclusion',
      'search-record-section-model',
    ])
    // 三区标题互不相同，且各自计数来自不同 wire 字段
    expect(screen.getByText('research.searchHistory.sections.allowedSources', { exact: false })).toBeTruthy()
    expect(screen.getByText('research.searchHistory.sections.hits', { exact: false })).toBeTruthy()
    expect(screen.getByText('research.searchHistory.sections.citations', { exact: false })).toBeTruthy()
    expect(screen.getByTestId('search-record-allowed-sources-count').textContent).toBe('3')
    expect(screen.getByTestId('search-record-section-hits').textContent).toContain(
      'research.searchHistory.fields.hitTotal|{"count":3}',
    )
    expect(screen.getByTestId('search-record-section-hits').textContent).toContain(
      'research.searchHistory.fields.hitShown|{"count":3}',
    )
    expect(screen.getByTestId('search-record-section-citations').textContent).toContain(
      'research.searchHistory.fields.citationTotal|{"count":2}',
    )
    expect(screen.getByTestId('search-record-section-citations').textContent).toContain(
      'research.searchHistory.fields.citationShown|{"count":2}',
    )
  })

  it('命中项按 (document_version, chunk_id) 标记已引用/未引用（不跨版本/不跨 chunk）', () => {
    renderDetail()
    expect(screen.getByTestId('search-record-hit-cited-0').textContent).toBe(
      'research.searchHistory.cited',
    )
    // c2 无引用 → 未引用
    expect(screen.getByTestId('search-record-hit-cited-1').textContent).toBe(
      'research.searchHistory.notCited',
    )
    // c3 同样未引用
    expect(screen.getByTestId('search-record-hit-cited-2').textContent).toBe(
      'research.searchHistory.notCited',
    )
  })

  it('citations 截断：未出现在已存窗口的命中显示「引用状态未确认」，不断言未引用', () => {
    const c1 = COMPLETED_RAW.citations.items[0]
    renderDetail({
      citations: { total: 250, truncated: true, items: [c1] },
    })
    // 复合键成员（c1，page 0）仍为已引用
    expect(screen.getByTestId('search-record-hit-cited-0').textContent).toBe(
      'research.searchHistory.cited',
    )
    // c2/c3 未出现在已存窗口：截断 → 第三态，不是「未引用」
    expect(screen.getByTestId('search-record-hit-cited-1').textContent).toBe(
      'research.searchHistory.citationUnknown',
    )
    expect(screen.getByTestId('search-record-hit-cited-2').textContent).toBe(
      'research.searchHistory.citationUnknown',
    )
    expect(screen.getByTestId('search-record-section-citations').textContent).toContain(
      'research.searchHistory.truncated|{"total":250,"shown":1}',
    )
  })

  it('truncated：显示 dispatch-time 精确总数与去重后展示数（不声称完整）', () => {
    renderDetail()
    expect(screen.getByTestId('search-record-hits-truncated').textContent).toBe(
      'research.searchHistory.truncated|{"total":3,"shown":3}',
    )
    expect(screen.queryByTestId('search-record-citations-truncated')).toBeNull()
  })

  it('snippet=null 显示「片段不可用」，不伪造文本', () => {
    renderDetail()
    expect(screen.getByTestId('search-record-hit-snippet-unavailable-2').textContent).toBe(
      'research.searchHistory.snippetUnavailable',
    )
    // claim 存在但 snippet 缺失：claim 照常展示
    expect(screen.getByTestId('search-record-citation-claim-1').textContent).toBe('claim two')
    expect(screen.queryByTestId('search-record-citation-snippet-1')).toBeNull()
  })

  it('claim 缺失但 snippet 可用：显示独立「未记录陈述」文案，片段照常展示', () => {
    renderDetail({
      citations: {
        total: 1,
        truncated: false,
        items: [
          {
            citation_id: 1,
            chunk_id: 'c1',
            document_id: 'doc_a',
            document_version: 'v1',
            page_idx: 0,
            source_id: 'src_1',
            claim: null,
            snippet: 'hit snippet one',
            warning: 'snippet_unavailable',
          },
        ],
      },
    })
    expect(
      screen.getByTestId('search-record-citation-claim-unavailable-0').textContent,
    ).toBe('research.searchHistory.claimUnavailable')
    // snippet 可用时照常展示（不因 claim 缺失被吞）
    expect(
      screen.getByTestId('search-record-citation-snippet-0').textContent,
    ).toBe('hit snippet one')
  })

  it('第六分区显示实际模型（model_id/provider_id，缺失成员显示未记录）', () => {
    renderDetail()
    expect(screen.getByTestId('search-record-model-id').textContent).toBe('m-local')
    expect(screen.getByTestId('search-record-provider-id').textContent).toBe('prov-local')

    renderDetail({ model: { model_id: 'm-local', provider_id: null } })
    expect(screen.getAllByTestId('search-record-provider-id')[1].textContent).toBe(
      'research.searchHistory.notRecorded',
    )
  })

  it('conclusion 经 Markdown 渲染；degradations 与 coverage 可读展示', () => {
    renderDetail()
    expect(screen.getByTestId('search-record-conclusion').textContent).toContain('Answer body')
    expect(screen.getByTestId('search-record-degradations').textContent).toContain(
      'insufficient_context',
    )
    expect(screen.getByTestId('search-record-coverage').textContent).toContain('token_estimate')
    expect(screen.getByTestId('search-record-coverage').textContent).toContain('120')
  })
})

describe('SearchRecordDetail：跳转四闸', () => {
  it('来源可用 + 版本一致 + 页码存在 → 启用并回传 (source_id, page_idx)', () => {
    const onCitationJump = vi.fn()
    renderDetail({}, { onCitationJump })
    const jump = screen.getByTestId('search-record-hit-jump-0') as HTMLButtonElement
    expect(jump.disabled).toBe(false)
    fireEvent.click(jump)
    expect(onCitationJump).toHaveBeenCalledWith('src_1', 0)
  })

  it('版本不一致 → 禁用并显示既有 degradedVersion 文案', () => {
    renderDetail(
      {},
      {
        sources: [
          {
            source_id: 'src_1',
            document_id: 'doc_a',
            document_version: 'v9',
            status: 'ready',
            content_hash: null,
            synced_at: null,
            last_error: null,
          },
        ],
      },
    )
    const jump = screen.getByTestId('search-record-hit-jump-0') as HTMLButtonElement
    expect(jump.disabled).toBe(true)
    expect(screen.getByTestId('search-record-hit-jump-0-degraded').textContent).toBe(
      'research.citation.degradedVersion',
    )
  })

  it('sources 缺省 → 显示 document_id/version 且禁用跳转（degradedSource）', () => {
    renderDetail({}, { sources: [] })
    const jump = screen.getByTestId('search-record-hit-jump-0') as HTMLButtonElement
    expect(jump.disabled).toBe(true)
    expect(screen.getByTestId('search-record-hit-jump-0-degraded').textContent).toBe(
      'research.citation.degradedSource',
    )
    const hit = screen.getByTestId('search-record-hit-0')
    expect(hit.textContent).toContain('doc_a')
    expect(hit.textContent).toContain('v1')
  })

  it('页码缺失（来源/版本可用）→ 禁用并显示既有 degradedPage 文案', () => {
    renderDetail({
      hits: {
        total: 1,
        truncated: false,
        items: [
          {
            document_id: 'doc_a',
            document_version: 'v1',
            chunk_id: 'c1',
            page_idx: null,
            source_id: 'src_1',
            snippet: 'x',
            warning: null,
          },
        ],
      },
    })
    const jump = screen.getByTestId('search-record-hit-jump-0') as HTMLButtonElement
    expect(jump.disabled).toBe(true)
    expect(screen.getByTestId('search-record-hit-jump-0-degraded').textContent).toBe(
      'research.citation.degradedPage',
    )
  })

  it('wire source_id=null / 页码缺失 → 禁用，不静默跳转', () => {
    renderDetail()
    const hit2 = screen.getByTestId('search-record-hit-jump-2') as HTMLButtonElement
    expect(hit2.disabled).toBe(true)
    // 引用 c9 page_idx=1 可跳；source_id src_2 版本一致 → 启用
    expect(
      (screen.getByTestId('search-record-citation-jump-1') as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('onCitationJump 未提供 → 始终禁用（不产生隐式跳转）', () => {
    const detail = detailFrom()
    render(
      <SearchRecordDetail
        record={detail}
        sources={SOURCES}
        onBack={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const jump = screen.getByTestId('search-record-hit-jump-0') as HTMLButtonElement
    expect(jump.disabled).toBe(true)
  })
})

describe('SearchRecordDetail：v1 行与模型口径', () => {
  it('no_hit = v1 + model：不渲染 v2 分区，但展示 model 与原因', () => {
    renderDetail({
      schema_version: 'd1f-search-record-v1',
      outcome: 'no_hit',
      outcome_detail: 'source_evidence_empty',
      result_available: undefined,
      hits: undefined,
      citations: undefined,
      model: { model_id: 'm-local', provider_id: null },
    })
    expect(screen.queryByTestId('search-record-section-hits')).toBeNull()
    expect(screen.queryByTestId('search-record-section-citations')).toBeNull()
    expect(screen.getByTestId('search-record-section-allowed-sources')).toBeTruthy()
    expect(screen.getByTestId('search-record-outcome-detail').textContent).toContain(
      'research.searchHistory.outcomeDetail.sourceEvidenceEmpty',
    )
    expect(screen.getByTestId('search-record-model-id').textContent).toBe('m-local')
    expect(screen.getByTestId('search-record-provider-id').textContent).toBe(
      'research.searchHistory.notRecorded',
    )
  })

  it('failed：显示 failure code/detail_safe 与「未记录实际模型」，无 v2 分区', () => {
    renderDetail({
      schema_version: 'd1f-search-record-v1',
      outcome: 'failed',
      outcome_detail: null,
      result_available: undefined,
      hits: undefined,
      citations: undefined,
      model: undefined,
      failure: { code: 'generation_failed', detail_safe: 'provider 500' },
    })
    expect(screen.queryByTestId('search-record-section-hits')).toBeNull()
    expect(screen.getByTestId('search-record-failure').textContent).toContain('generation_failed')
    expect(screen.getByTestId('search-record-failure').textContent).toContain('provider 500')
    expect(screen.getByTestId('search-record-model-unavailable').textContent).toBe(
      'research.searchHistory.modelNotRecorded',
    )
  })

  it('no_generation：显示「未调用模型（系统路由）」', () => {
    renderDetail({
      schema_version: 'd1f-search-record-v1',
      outcome: 'no_generation',
      outcome_detail: 'system_route',
      result_available: undefined,
      hits: undefined,
      citations: undefined,
      model: undefined,
    })
    expect(screen.getByTestId('search-record-model-unavailable').textContent).toBe(
      'research.searchHistory.noModelSystemRoute',
    )
    expect(screen.getByTestId('search-record-outcome-detail').textContent).toContain(
      'research.searchHistory.outcomeDetail.systemRoute',
    )
  })

  it('completed v2 缺 hits/citations/model 键 → 按空/未记录渲染（不崩溃、不伪造）', () => {
    renderDetail({
      hits: undefined,
      citations: undefined,
      model: undefined,
      result_available: true,
    })
    expect(screen.getByTestId('search-record-section-hits')).toBeTruthy()
    expect(screen.getByTestId('search-record-no-hits').textContent).toBe(
      'research.searchHistory.noHits',
    )
    expect(screen.getByTestId('search-record-no-citations').textContent).toBe(
      'research.searchHistory.noCitations',
    )
    expect(screen.getByTestId('search-record-model-unavailable').textContent).toBe(
      'research.searchHistory.modelNotRecorded',
    )
  })

  it('未知 outcome：通用「其他终态」+ 原始码次级展示，不崩溃', () => {
    renderDetail({
      schema_version: 'd1f-search-record-list-v9',
      outcome: 'future_outcome',
      result_available: undefined,
      hits: undefined,
      citations: undefined,
      model: undefined,
    })
    expect(screen.getByTestId('search-record-outcome').textContent).toContain(
      'research.searchHistory.outcome.unknown',
    )
    expect(screen.getByTestId('search-record-outcome-raw').textContent).toBe(
      'future_outcome',
    )
    expect(screen.getByTestId('search-record-model-unavailable').textContent).toBe(
      'research.searchHistory.modelNotRecorded',
    )
  })
})

describe('SearchRecordDetail：受限与缺失降级', () => {
  it('restricted：隐藏来源身份/片段/conclusion；保留 query/计数/模型与受限计数', () => {
    renderDetail({
      record_visibility: 'restricted',
      sources: [],
      source_counts: { total: 3, visible: 0, restricted: 3 },
      conclusion: { text: null, truncated: false },
      result_available: false,
      hits: { total: 3, truncated: true, items: [] },
      citations: { total: 2, truncated: false, items: [] },
      warnings: ['content_restricted'],
    })
    expect(screen.getByTestId('search-record-restricted').textContent).toContain(
      'research.searchHistory.restricted.title',
    )
    expect(screen.getByTestId('search-record-restricted-count').textContent).toBe(
      'research.searchHistory.restricted.count|{"count":3,"total":3}',
    )
    expect(screen.getByTestId('search-record-query').textContent).toBe('what is ORR?')
    // 不渲染任何来源身份/片段/conclusion
    expect(screen.queryByTestId('search-record-allowed-source-0')).toBeNull()
    expect(screen.queryByTestId('search-record-hit-0')).toBeNull()
    expect(screen.queryByTestId('search-record-conclusion')).toBeNull()
    expect(screen.queryByText('hit snippet one')).toBeNull()
    expect(screen.queryByText('Answer body')).toBeNull()
    // 计数与模型保留
    expect(screen.getByTestId('search-record-section-hits').textContent).toContain(
      'research.searchHistory.fields.hitTotal|{"count":3}',
    )
    expect(screen.getByTestId('search-record-model-id').textContent).toBe('m-local')
    // 受限时不给跳转入口
    expect(screen.queryByTestId('search-record-hit-jump-0')).toBeNull()
  })

  it('result_available=false：显示结果不可用提示且不伪造片段', () => {
    renderDetail({ result_available: false })
    expect(screen.getByTestId('search-record-result-unavailable').textContent).toBe(
      'research.searchHistory.resultUnavailable',
    )
    expect(screen.getByTestId('search-record-hit-snippet-unavailable-0').textContent).toBe(
      'research.searchHistory.snippetUnavailable',
    )
  })

  it('来源 warning=source_unavailable 显示来源不可用，跳转禁用', () => {
    renderDetail({
      hits: {
        total: 1,
        truncated: false,
        items: [
          {
            document_id: 'doc_a',
            document_version: 'v1',
            chunk_id: 'c1',
            page_idx: 0,
            source_id: 'src_1',
            snippet: 'x',
            warning: 'source_unavailable',
          },
        ],
      },
    })
    expect(
      screen.getByTestId('search-record-hit-source-unavailable-0').textContent,
    ).toBe('research.searchHistory.sourceUnavailable')
  })

  it('scope 缺失 → 服务端未返回范围详情（不猜测）', () => {
    renderDetail({ scope: undefined, sources: [] })
    expect(screen.getByTestId('search-record-scope-missing').textContent).toBe(
      'research.scopeDetails.projectionMissing',
    )
  })
})

describe('SearchRecordDetail：动作边界', () => {
  it('不提供 Save/Continue/Rerun；只提供返回/关闭/打开来源', () => {
    renderDetail()
    expect(screen.queryByText('research.resultActions.saveAsInsight')).toBeNull()
    expect(screen.queryByText('research.resultActions.saveAsNote')).toBeNull()
    expect(screen.queryByText('research.resultActions.continueResearch')).toBeNull()
    expect(screen.queryByTestId('rerun-btn')).toBeNull()
    expect(screen.getByTestId('search-history-back')).toBeTruthy()
    expect(screen.getByTestId('search-history-close')).toBeTruthy()
  })

  it('返回/关闭按钮回调父层', () => {
    const { onBack, onClose } = renderDetail()
    fireEvent.click(screen.getByTestId('search-history-back'))
    expect(onBack).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('search-history-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
