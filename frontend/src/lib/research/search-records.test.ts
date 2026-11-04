/**
 * 搜索记录 wire 容错解析测试（Issue #1014 / D1-F 主单 §5.2）。
 *
 * 覆盖：列表 v1、详情 v1（no_generation/failed）、v1＋model（no_hit）、
 * v2（completed）、未知 outcome/warning、null snippet/claim、缺失加性键、
 * 能力位严格 true、错误分类与「已引用」复合键比对。
 */
import { describe, expect, it } from 'vitest'
import {
  classifySearchRecordError,
  hasSearchRecordResultProjection,
  hitCitationStatus,
  isHitCited,
  isSearchRecordErrorRetryable,
  isSearchRecordRestricted,
  parseSearchRecordDetail,
  parseSearchRecordListPage,
  readSearchHistoryCapability,
  searchRecordErrorCopyKey,
  searchRecordOutcomeDetailKey,
  searchRecordOutcomeLabelKey,
  searchRecordScopeModeLabelKey,
} from './search-records'

const SCOPE = {
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
  warnings: ['excluded_source'],
  source_total: 3,
}

const COMPLETED_DETAIL = {
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
  hit_count: 2,
  scope: SCOPE,
  source_counts: { total: 3, visible: 3, restricted: 0 },
  sources: [
    { document_id: 'doc_a', document_version: 'v1', source_id: 'src_1', status: 'ready', warning: null },
    { document_id: 'doc_b', document_version: 'v2', source_id: null, status: 'stale', warning: 'source_unavailable' },
  ],
  conclusion: { text: 'Answer **bold**', truncated: false },
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
  coverage: { selected_full: 2, token_estimate: 100 },
  record_visibility: 'visible',
  warnings: [],
  result_available: true,
  model: { model_id: 'm-local', provider_id: 'prov-local' },
  hits: {
    total: 2,
    truncated: true,
    items: [
      {
        document_id: 'doc_a',
        document_version: 'v1',
        chunk_id: 'c1',
        page_idx: 0,
        source_id: 'src_1',
        snippet: 'snippet one',
        warning: null,
      },
      {
        document_id: 'doc_b',
        document_version: 'v2',
        chunk_id: 'c2',
        page_idx: null,
        source_id: null,
        snippet: null,
        warning: 'snippet_unavailable',
      },
    ],
  },
  citations: {
    total: 1,
    truncated: false,
    items: [
      {
        citation_id: 7,
        chunk_id: 'c1',
        document_id: 'doc_a',
        document_version: 'v1',
        page_idx: 0,
        source_id: 'src_1',
        claim: 'claim one',
        snippet: 'snippet one',
        warning: null,
      },
    ],
  },
}

const NO_GENERATION_DETAIL = {
  schema_version: 'd1f-search-record-v1',
  record_id: 'gen_3',
  generation_id: 'gen_3',
  created_at: '2026-11-04T11:00:00+00:00',
  completed_at: null,
  query: 'system routed question',
  outcome: 'no_generation',
  outcome_detail: 'system_route',
  generation_state: 'completed',
  requested_mode: 'auto',
  resolved_mode: 'system',
  context_level: 'focused',
  hit_count: 0,
  scope: SCOPE,
  source_counts: { total: 3, visible: 3, restricted: 0 },
  sources: [],
  conclusion: { text: 'No generation was needed.', truncated: false },
  degradations: [],
  degradation_schema_version: 'd1c-degradation-v1',
  failure: null,
  coverage: null,
  record_visibility: 'visible',
  warnings: [],
}

const NO_HIT_DETAIL = {
  schema_version: 'd1f-search-record-v1',
  record_id: 'gen_4',
  generation_id: 'gen_4',
  created_at: '2026-11-04T12:00:00+00:00',
  completed_at: '2026-11-04T12:00:04+00:00',
  query: 'nothing found?',
  outcome: 'no_hit',
  outcome_detail: 'source_evidence_empty',
  generation_state: 'completed',
  requested_mode: 'auto',
  resolved_mode: 'hybrid_rag',
  context_level: 'focused',
  hit_count: 0,
  scope: SCOPE,
  source_counts: { total: 3, visible: 3, restricted: 0 },
  sources: [],
  conclusion: { text: null, truncated: false },
  degradations: [],
  degradation_schema_version: 'd1c-degradation-v1',
  failure: null,
  coverage: null,
  record_visibility: 'visible',
  warnings: ['source_unavailable'],
  model: { model_id: 'm-local', provider_id: null },
}

describe('parseSearchRecordListPage', () => {
  it('解析 v1 列表并保留未知 outcome（不崩溃、不丢行）', () => {
    const page = parseSearchRecordListPage({
      schema_version: 'd1f-search-record-list-v1',
      items: [
        {
          schema_version: 'd1f-search-record-v1',
          record_id: 'gen_1',
          generation_id: 'gen_1',
          created_at: '2026-11-04T10:00:00+00:00',
          completed_at: '2026-11-04T10:00:05+00:00',
          query: 'q1',
          outcome: 'no_hit',
          outcome_detail: 'source_evidence_empty',
          generation_state: 'completed',
          requested_mode: 'auto',
          resolved_mode: 'hybrid_rag',
          context_level: 'focused',
          hit_count: 0,
          scope_mode: 'selected',
          source_total: 2,
          failure_code: null,
          degradation_codes: ['insufficient_context'],
        },
        {
          record_id: 'gen_2',
          generation_id: 'gen_2',
          created_at: null,
          query: 'future',
          outcome: 'future_outcome',
          hit_count: 3,
          scope_mode: null,
          source_total: 0,
        },
      ],
      next_cursor: 'cursor_1',
    })
    expect(page.schema_version).toBe('d1f-search-record-list-v1')
    expect(page.next_cursor).toBe('cursor_1')
    expect(page.items).toHaveLength(2)
    expect(page.items[0].outcome).toBe('no_hit')
    expect(page.items[0].degradation_codes).toEqual(['insufficient_context'])
    expect(page.items[1].outcome).toBe('future_outcome')
    expect(page.items[1].scope_mode).toBeNull()
    expect(page.items[1].failure_code).toBeNull()
    expect(page.items[1].degradation_codes).toEqual([])
  })

  it('非对象响应 → 空列表 + next_cursor null（如实降级，不伪造记录）', () => {
    expect(parseSearchRecordListPage(null)).toEqual({
      schema_version: '',
      items: [],
      next_cursor: null,
    })
    expect(parseSearchRecordListPage({ items: 'not-an-array' })).toEqual({
      schema_version: '',
      items: [],
      next_cursor: null,
    })
  })
})

describe('parseSearchRecordDetail', () => {
  it('completed = v2：解析 result_available/hits/citations/model 与精确计数/截断', () => {
    const detail = parseSearchRecordDetail(COMPLETED_DETAIL)
    expect(detail.schema_version).toBe('d1f-search-record-v2')
    expect(detail.outcome).toBe('completed')
    expect(detail.record_visibility).toBe('visible')
    expect(detail.result_available).toBe(true)
    expect(detail.hits).not.toBeNull()
    expect(detail.hits?.total).toBe(2)
    expect(detail.hits?.truncated).toBe(true)
    expect(detail.hits?.items).toHaveLength(2)
    expect(detail.hits?.items[0].snippet).toBe('snippet one')
    expect(detail.hits?.items[1].snippet).toBeNull()
    expect(detail.hits?.items[1].page_idx).toBeNull()
    expect(detail.citations?.total).toBe(1)
    expect(detail.citations?.items[0].claim).toBe('claim one')
    expect(detail.citations?.items[0].citation_id).toBe(7)
    expect(detail.model).toEqual({ model_id: 'm-local', provider_id: 'prov-local' })
    expect(detail.hit_count).toBe(2)
    expect(detail.scope?.mode).toBe('selected')
    expect(detail.scope?.resolved_source_refs).toHaveLength(2)
    expect(detail.sources).toHaveLength(2)
    expect(detail.sources[1].warning).toBe('source_unavailable')
    expect(detail.failure).toBeNull()
    expect(detail.coverage).toEqual({ selected_full: 2, token_estimate: 100 })
    expect(detail.degradations[0].code).toBe('insufficient_context')
  })

  it('no_generation = v1：没有 v2 键 → hits/citations/result_available/model 全为 null', () => {
    const detail = parseSearchRecordDetail(NO_GENERATION_DETAIL)
    expect(detail.schema_version).toBe('d1f-search-record-v1')
    expect(detail.outcome).toBe('no_generation')
    expect(detail.hits).toBeNull()
    expect(detail.citations).toBeNull()
    expect(detail.result_available).toBeNull()
    expect(detail.model).toBeNull()
    expect(hasSearchRecordResultProjection(detail)).toBe(false)
    expect(detail.conclusion.text).toBe('No generation was needed.')
  })

  it('no_hit = v1 + 可选 model（成员 null 如实保留，不伪造提供方）', () => {
    const detail = parseSearchRecordDetail(NO_HIT_DETAIL)
    expect(detail.outcome).toBe('no_hit')
    expect(detail.model).toEqual({ model_id: 'm-local', provider_id: null })
    expect(detail.hits).toBeNull()
    expect(detail.citations).toBeNull()
    expect(detail.result_available).toBeNull()
    expect(hasSearchRecordResultProjection(detail)).toBe(false)
    expect(detail.conclusion.text).toBeNull()
  })

  it('failed：failure 安全字段解析，无 v2、无 model', () => {
    const detail = parseSearchRecordDetail({
      ...NO_GENERATION_DETAIL,
      outcome: 'failed',
      outcome_detail: null,
      failure: { code: 'generation_failed', detail_safe: 'provider returned 500' },
      warnings: ['content_restricted', 'snippet_unavailable', 'future_warning'],
    })
    expect(detail.failure).toEqual({
      code: 'generation_failed',
      detail_safe: 'provider returned 500',
    })
    expect(detail.hits).toBeNull()
    expect(detail.model).toBeNull()
    expect(detail.warnings).toContain('snippet_unavailable')
    expect(detail.warnings).toContain('future_warning')
  })

  it('未知 outcome / 未知 schema_version / 缺失可选键均容错', () => {
    const detail = parseSearchRecordDetail({
      schema_version: 'd1f-search-record-v9',
      record_id: 'gen_9',
      generation_id: 'gen_9',
      query: 'future',
      outcome: 'future_outcome',
      hit_count: 'not-a-number',
      scope: 'malformed',
      source_counts: 'malformed',
      conclusion: 'malformed',
      degradations: 'malformed',
      sources: 'malformed',
      warnings: 'malformed',
      record_visibility: 'future_visibility',
    })
    expect(detail.schema_version).toBe('d1f-search-record-v9')
    expect(detail.outcome).toBe('future_outcome')
    expect(detail.hit_count).toBe(0)
    expect(detail.scope).toBeNull()
    expect(detail.source_counts).toEqual({ total: 0, visible: 0, restricted: 0 })
    expect(detail.conclusion).toEqual({ text: null, truncated: false })
    expect(detail.degradations).toEqual([])
    expect(detail.sources).toEqual([])
    expect(detail.warnings).toEqual([])
    // 未知可见性 → 受限（fail-closed，绝不泄露来源身份）
    expect(detail.record_visibility).toBe('restricted')
    expect(isSearchRecordRestricted(detail)).toBe(true)
  })

  it('restricted：记录投影清空 items，解析保持受限与非伪造', () => {
    const detail = parseSearchRecordDetail({
      ...COMPLETED_DETAIL,
      record_visibility: 'restricted',
      sources: [],
      conclusion: { text: null, truncated: false },
      result_available: false,
      hits: { total: 2, truncated: false, items: [] },
      citations: { total: 1, truncated: false, items: [] },
      warnings: ['content_restricted', 'snippet_unavailable'],
    })
    expect(detail.record_visibility).toBe('restricted')
    expect(detail.sources).toEqual([])
    expect(detail.hits?.items).toEqual([])
    expect(detail.hits?.total).toBe(2)
    expect(detail.citations?.total).toBe(1)
    expect(detail.conclusion.text).toBeNull()
    expect(detail.model).toEqual({ model_id: 'm-local', provider_id: 'prov-local' })
  })

  it('非对象响应 → 抛错（由查询错误态处理，不构造空记录冒充数据）', () => {
    expect(() => parseSearchRecordDetail(null)).toThrow('invalid_search_record_detail')
    expect(() => parseSearchRecordDetail([1, 2])).toThrow('invalid_search_record_detail')
  })
})

describe('能力位与错误分类', () => {
  it('search_history 仅严格 true 为启用（缺失/非法/false → false）', () => {
    expect(readSearchHistoryCapability({ search_history: true })).toBe(true)
    expect(readSearchHistoryCapability({ search_history: false })).toBe(false)
    expect(readSearchHistoryCapability({ search_history: 'true' })).toBe(false)
    expect(readSearchHistoryCapability({ search_history: 1 })).toBe(false)
    expect(readSearchHistoryCapability({})).toBe(false)
    expect(readSearchHistoryCapability(undefined)).toBe(false)
  })

  it('错误分类：403/404/503 not_enabled/503 store/网络未知', () => {
    const httpError = (status: number, code?: string) => ({
      response: { status, data: code ? { detail: { code } } : {} },
    })
    expect(classifySearchRecordError(httpError(403))).toBe('forbidden')
    expect(classifySearchRecordError(httpError(404))).toBe('not_found')
    expect(
      classifySearchRecordError(httpError(503, 'search_record_not_enabled')),
    ).toBe('not_enabled')
    expect(
      classifySearchRecordError(httpError(503, 'search_record_store_unavailable')),
    ).toBe('store_unavailable')
    expect(classifySearchRecordError(httpError(503))).toBe('store_unavailable')
    expect(classifySearchRecordError(new Error('network down'))).toBe('unknown')
    expect(isSearchRecordErrorRetryable('not_enabled')).toBe(false)
    expect(isSearchRecordErrorRetryable('forbidden')).toBe(false)
    expect(isSearchRecordErrorRetryable('store_unavailable')).toBe(true)
    expect(searchRecordErrorCopyKey('not_enabled')).toBe(
      'research.searchHistory.errors.notEnabled',
    )
  })
})

describe('展示映射与三可区分辅助', () => {
  it('outcome / outcome_detail / scope mode 文案 key（未知值有通用兜底）', () => {
    expect(searchRecordOutcomeLabelKey('completed')).toContain('completed')
    expect(searchRecordOutcomeLabelKey('no_hit')).toContain('noHit')
    expect(searchRecordOutcomeLabelKey('no_generation')).toContain('noGeneration')
    expect(searchRecordOutcomeLabelKey('failed')).toContain('failed')
    expect(searchRecordOutcomeLabelKey('future')).toContain('unknown')
    expect(searchRecordOutcomeLabelKey(null)).toContain('unknown')
    expect(searchRecordOutcomeDetailKey('system_route')).toContain('systemRoute')
    expect(searchRecordOutcomeDetailKey('source_evidence_empty')).toContain('sourceEvidenceEmpty')
    expect(searchRecordOutcomeDetailKey('future_detail')).toBeNull()
    expect(searchRecordScopeModeLabelKey('selected')).toContain('selected')
    expect(searchRecordScopeModeLabelKey('future_mode')).toContain('unknown')
  })

  it('命中「已引用」按 (document_version, chunk_id) 复合键比对，不跨版本/不跨文档', () => {
    const citations = parseSearchRecordDetail(COMPLETED_DETAIL).citations?.items ?? []
    expect(isHitCited(
      {
        document_id: 'doc_a',
        document_version: 'v1',
        chunk_id: 'c1',
        page_idx: 0,
        source_id: 'src_1',
        snippet: null,
        warning: null,
      },
      citations,
    )).toBe(true)
    // 同 chunk_id 不同版本身份 → 未引用
    expect(isHitCited(
      {
        document_id: 'doc_a',
        document_version: 'v2',
        chunk_id: 'c1',
        page_idx: 0,
        source_id: 'src_1',
        snippet: null,
        warning: null,
      },
      citations,
    )).toBe(false)
    // 同版本不同 chunk → 未引用
    expect(isHitCited(
      {
        document_id: 'doc_a',
        document_version: 'v1',
        chunk_id: 'c_other',
        page_idx: 0,
        source_id: 'src_1',
        snippet: null,
        warning: null,
      },
      citations,
    )).toBe(false)
  })

  it('三态：citations 截断时未出现在已存窗口的命中 = unknown（不假断言未引用）', () => {
    const citations = parseSearchRecordDetail(COMPLETED_DETAIL).citations?.items ?? []
    const uncitedHit = {
      document_id: 'doc_a',
      document_version: 'v1',
      chunk_id: 'c_other',
      page_idx: 2,
      source_id: 'src_1',
      snippet: null,
      warning: null,
    }
    // 未截断：集合完整 → 可断言未引用
    expect(hitCitationStatus(uncitedHit, citations, false)).toBe('not_cited')
    // 截断：citation 可能落在窗口外 → 不得断言未引用
    expect(hitCitationStatus(uncitedHit, citations, true)).toBe('unknown')
    // 已命中优先于截断：复合键成员 → cited
    const citedHit = {
      document_id: 'doc_a',
      document_version: 'v1',
      chunk_id: 'c1',
      page_idx: 0,
      source_id: 'src_1',
      snippet: null,
      warning: null,
    }
    expect(hitCitationStatus(citedHit, citations, true)).toBe('cited')
  })

  it('page_idx 同值优先：同 version+chunk 多候选页时仍按复合键成员判已引用', () => {
    const duplicatePageCitations = [
      {
        citation_id: 1,
        chunk_id: 'dup',
        document_id: 'doc_x',
        document_version: 'v1',
        page_idx: 0,
        source_id: 'src_x',
        claim: 'p0',
        snippet: null,
        warning: null,
      },
      {
        citation_id: 2,
        chunk_id: 'dup',
        document_id: 'doc_x',
        document_version: 'v1',
        page_idx: 5,
        source_id: 'src_x',
        claim: 'p5',
        snippet: null,
        warning: null,
      },
    ] as const
    // 同页候选存在 → cited（page_idx 同值优先的匹配顺序）
    expect(hitCitationStatus(
      {
        document_id: 'doc_x',
        document_version: 'v1',
        chunk_id: 'dup',
        page_idx: 5,
        source_id: 'src_x',
        snippet: null,
        warning: null,
      },
      duplicatePageCitations,
      false,
    )).toBe('cited')
    // 页不同但复合键成员仍在集合中 → 仍为 cited（不因页不同误判未引用）
    expect(hitCitationStatus(
      {
        document_id: 'doc_x',
        document_version: 'v1',
        chunk_id: 'dup',
        page_idx: 9,
        source_id: 'src_x',
        snippet: null,
        warning: null,
      },
      duplicatePageCitations,
      false,
    )).toBe('cited')
  })
})
