/**
 * Issue #1016（D1-G 主单）主题概览 fork lib 层测试（计划 §2.2/§2.6/§2.9、
 * §4.2 step 1-2、§5.2 F-01/F-03/F-03b/F-09）。
 *
 * 覆盖（先红后绿）：
 * - `parseTopicOverviewResponse`：ready/restricted 完整投影；未知加性键与未知
 *   warning 容错（不崩溃、不猜测）；缺失核心身份键 → null；`visibility` 非
 *   `ready` 一律按 restricted 处理（fail-closed，正文/引用/来源身份一律丢弃）；
 *   未知 schema_version 不拒绝（wire 加性演进容错）；
 * - `readTopicOverviewCapability`：**仅严格 `=== true`** 视为启用；
 * - `buildTopicOverviewRequest`：含 `focus`、**不含 `query`**、不含顶层
 *   `source_ids`/`mode`/`context_level`；`source_scope` 复用既有
 *   `buildSourceScope` 三形态；`note_ids` 恒 `[]`（Note 一律拒绝）；空
 *   selected fail-closed；
 * - `topicOverviewSourceChanges`：新增/版本变化/已退役计数；
 * - `topicOverviewDiscussionText`：固定引导文本 + focus/首段问题；
 * - `errors.ts` 6 个稳定码 → 冻结 locale key（locale 内容由 fork-ui 添加）。
 */

import { describe, expect, it } from 'vitest'
import {
  RESEARCH_ERROR_USER_COPY,
  RESEARCH_GENERIC_ERROR_KEY,
  userErrorMessageKey,
} from './errors'
import type { C05RequestScope } from './c05-request'
import {
  TOPIC_OVERVIEW_SCHEMA_VERSION,
  buildTopicOverviewRequest,
  parseTopicOverviewResponse,
  readTopicOverviewCapability,
  topicOverviewDiscussionText,
  topicOverviewSourceChanges,
  type TopicOverviewWire,
} from './topic-overview'

/** 完整 ready 响应 envelope（POST 200 与 GET 200 同一形状）。 */
function readyEnvelope(): Record<string, unknown> {
  return {
    schema_version: TOPIC_OVERVIEW_SCHEMA_VERSION,
    request_id: 'req_1',
    overview: {
      overview_id: 'ovw_0123456789abcdef0123456789abcdef',
      generation_id: 'gen_1',
      generated_at: '2026-11-05T10:00:00+00:00',
      generation_created_at: '2026-11-05T09:55:00+00:00',
      focus: '为什么要做 A？',
      visibility: 'ready',
      content_markdown: '# 概览\n正文',
      sections: {
        main_questions: '## 主要问题\n- 问题一？',
        findings: '## 主要发现\n- 发现一',
        disagreements: '## 分歧\n- 分歧一',
        reading_priorities: '## 建议优先细读\n- 资料一',
      },
      citations: [
        {
          citation_id: 1,
          claim: '主张一',
          doc_id: 'doc_a',
          doc_version: 'v1',
          page_idx: 2,
          chunk_id: 'chunk_1',
          source_id: 'src_a',
          warning: null,
        },
        {
          citation_id: 2,
          claim: '主张二',
          doc_id: 'doc_b',
          doc_version: 'v1',
          page_idx: null,
          chunk_id: 'chunk_2',
          source_id: null,
          warning: 'source_unavailable',
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
          { document_id: 'doc_a', document_version: 'v1', source_id: 'src_a' },
          { document_id: 'doc_b', document_version: 'v1', source_id: null },
        ],
        missing_source_ids: [],
        single_source_id: null,
      },
      processing: {
        resolved_mode: 'hybrid_rag',
        evidence_chunk_count: 4,
        citation_count: 2,
        citations_total: 3,
        citations_dropped: 1,
        evidence_modalities: { text: 3, table: 1, figure: 0, mixed: 0 },
        coverage: { discovered: 10, kept: 4, trimmed: 6 },
        included_sources: [
          {
            document_id: 'doc_a',
            document_version: 'v1',
            chunk_count: 3,
            source_id: 'src_a',
          },
        ],
        degradations: [
          { code: 'citations_partial', scope: 'citations', severity: 'info' },
        ],
        degradation_reason: null,
        evidence_degraded: true,
        full_text_read: false,
      },
      model: { model_id: 'm_local', provider_id: 'p_local' },
      purpose: { work_purpose: 'document_qa', work_purpose_source: 'default_legacy' },
      limitations: [
        'full_text_not_read',
        'section_citation_mapping_not_verified',
        'table_evidence_included',
      ],
      warnings: ['citations_degraded'],
    },
  }
}

/** 与 `readyEnvelope()` 一一对应的归一化投影。 */
function readyOverview(): TopicOverviewWire {
  return {
    overview_id: 'ovw_0123456789abcdef0123456789abcdef',
    generation_id: 'gen_1',
    generated_at: '2026-11-05T10:00:00+00:00',
    generation_created_at: '2026-11-05T09:55:00+00:00',
    focus: '为什么要做 A？',
    visibility: 'ready',
    content_markdown: '# 概览\n正文',
    sections: {
      main_questions: '## 主要问题\n- 问题一？',
      findings: '## 主要发现\n- 发现一',
      disagreements: '## 分歧\n- 分歧一',
      reading_priorities: '## 建议优先细读\n- 资料一',
    },
    citations: [
      {
        citation_id: 1,
        claim: '主张一',
        doc_id: 'doc_a',
        doc_version: 'v1',
        page_idx: 2,
        chunk_id: 'chunk_1',
        source_id: 'src_a',
        warning: null,
      },
      {
        citation_id: 2,
        claim: '主张二',
        doc_id: 'doc_b',
        doc_version: 'v1',
        page_idx: null,
        chunk_id: 'chunk_2',
        source_id: null,
        warning: 'source_unavailable',
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
        { document_id: 'doc_a', document_version: 'v1', source_id: 'src_a' },
        { document_id: 'doc_b', document_version: 'v1', source_id: null },
      ],
      missing_source_ids: [],
      single_source_id: null,
    },
    processing: {
      resolved_mode: 'hybrid_rag',
      evidence_chunk_count: 4,
      citation_count: 2,
      citations_total: 3,
      citations_dropped: 1,
      evidence_modalities: { text: 3, table: 1, figure: 0, mixed: 0 },
      coverage: { discovered: 10, kept: 4, trimmed: 6 },
      included_sources: [
        {
          document_id: 'doc_a',
          document_version: 'v1',
          chunk_count: 3,
          source_id: 'src_a',
        },
      ],
      degradations: [
        { code: 'citations_partial', scope: 'citations', severity: 'info' },
      ],
      degradation_reason: null,
      evidence_degraded: true,
      full_text_read: false,
    },
    model: { model_id: 'm_local', provider_id: 'p_local' },
    purpose: { work_purpose: 'document_qa', work_purpose_source: 'default_legacy' },
    limitations: [
      'full_text_not_read',
      'section_citation_mapping_not_verified',
      'table_evidence_included',
    ],
    warnings: ['citations_degraded'],
  }
}

/** 顶层 overview 便于就地变异（不修改共享 fixture）。 */
function overviewOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return envelope.overview as Record<string, unknown>
}

describe('parseTopicOverviewResponse', () => {
  it('完整 ready envelope → 归一化 wire（envelope 包装 + 全键投影）', () => {
    expect(parseTopicOverviewResponse(readyEnvelope())).toEqual(readyOverview())
  })

  it('未知加性键（envelope/overview/scope/processing/citation/sections/model/purpose）忽略且不崩溃', () => {
    const envelope = readyEnvelope()
    const overview = overviewOf(envelope)
    envelope.future_envelope_key = { nested: true }
    overview.future_overview_key = [1, 2, 3]
    ;(overview.sections as Record<string, unknown>).future_section = 'future'
    ;(overview.citations as Record<string, unknown>[])[0].future_citation_key = 'x'
    ;(overview.scope as Record<string, unknown>).future_scope_key = 'x'
    ;(overview.processing as Record<string, unknown>).future_processing_key = 42
    ;(overview.model as Record<string, unknown>).future_model_key = true
    ;(overview.purpose as Record<string, unknown>).future_purpose_key = null

    expect(parseTopicOverviewResponse(envelope)).toEqual(readyOverview())
  })

  it('coverage 是开放聚合投影：未知标量键保留、非标量丢弃（键集合未冻结）', () => {
    const envelope = readyEnvelope()
    ;(overviewOf(envelope).processing as Record<string, unknown>).coverage = {
      discovered: 10,
      future_counter: 3,
      future_flag: true,
      future_null: null,
      nested: { x: 1 },
      list: [1, 2],
    }
    expect(parseTopicOverviewResponse(envelope)?.processing?.coverage).toEqual({
      discovered: 10,
      future_counter: 3,
      future_flag: true,
      future_null: null,
    })
  })

  it('未知 warning / limitation / degradation 值原样保留（不映射、不猜测、不崩溃）', () => {
    const envelope = readyEnvelope()
    const overview = overviewOf(envelope)
    overview.warnings = ['citations_degraded', 'future_warning_code']
    overview.limitations = ['full_text_not_read', 'future_limitation_code']
    ;(overview.citations as Record<string, unknown>[])[0].warning = 'future_citation_warning'
    ;(overview.processing as Record<string, unknown>).degradations = [
      'legacy_string_degradation',
      { code: 'future_degradation', severity: 'info' },
    ]

    const parsed = parseTopicOverviewResponse(envelope)
    expect(parsed?.warnings).toEqual(['citations_degraded', 'future_warning_code'])
    expect(parsed?.limitations).toEqual([
      'full_text_not_read',
      'future_limitation_code',
    ])
    expect(parsed?.citations[0].warning).toBe('future_citation_warning')
    expect(parsed?.processing?.degradations).toEqual([
      { code: 'legacy_string_degradation', scope: null, severity: null },
      { code: 'future_degradation', scope: null, severity: 'info' },
    ])
  })

  it('缺失核心身份键（overview_id / generation_id）→ null', () => {
    const noOverviewId = readyEnvelope()
    delete overviewOf(noOverviewId).overview_id
    expect(parseTopicOverviewResponse(noOverviewId)).toBeNull()

    const emptyOverviewId = readyEnvelope()
    overviewOf(emptyOverviewId).overview_id = ''
    expect(parseTopicOverviewResponse(emptyOverviewId)).toBeNull()

    const noGenerationId = readyEnvelope()
    delete overviewOf(noGenerationId).generation_id
    expect(parseTopicOverviewResponse(noGenerationId)).toBeNull()

    const nonStringGenerationId = readyEnvelope()
    overviewOf(nonStringGenerationId).generation_id = 42
    expect(parseTopicOverviewResponse(nonStringGenerationId)).toBeNull()
  })

  it('畸形 envelope（非对象 / 缺 overview / overview 非对象）→ null', () => {
    expect(parseTopicOverviewResponse(null)).toBeNull()
    expect(parseTopicOverviewResponse(undefined)).toBeNull()
    expect(parseTopicOverviewResponse('oops')).toBeNull()
    expect(parseTopicOverviewResponse([readyEnvelope()])).toBeNull()
    expect(parseTopicOverviewResponse({ schema_version: TOPIC_OVERVIEW_SCHEMA_VERSION })).toBeNull()
    expect(parseTopicOverviewResponse({ overview: 'oops' })).toBeNull()
  })

  it('未知 schema_version 不拒绝（wire 加性演进容错；身份键仍在即解析）', () => {
    const envelope = readyEnvelope()
    envelope.schema_version = 'd1g-topic-overview-v2'
    expect(parseTopicOverviewResponse(envelope)).toEqual(readyOverview())
  })

  it('visibility !== "ready" 一律按 restricted 处理（fail-closed）', () => {
    for (const visibility of [undefined, 'READY', 'restricted', 'partial', 1, null]) {
      const envelope = readyEnvelope()
      if (visibility === undefined) {
        delete overviewOf(envelope).visibility
      } else {
        overviewOf(envelope).visibility = visibility
      }
      const parsed = parseTopicOverviewResponse(envelope)
      expect(parsed?.visibility).toBe('restricted')
      // 即使 host 侧投影异常泄漏正文/引用/来源身份，fork 侧也一律丢弃。
      expect(parsed?.content_markdown).toBeNull()
      expect(parsed?.sections).toBeNull()
      expect(parsed?.citations).toEqual([])
      expect(parsed?.scope?.sources).toEqual([])
      expect(parsed?.scope?.missing_source_ids).toEqual([])
      expect(parsed?.scope?.single_source_id).toBeNull()
      expect(parsed?.processing?.included_sources).toEqual([])
    }
  })

  it('restricted 保留执行元数据与聚合计数（scope.mode/source_count/captured_at、processing 计数、model、purpose、focus）', () => {
    const envelope = readyEnvelope()
    overviewOf(envelope).visibility = 'restricted'
    overviewOf(envelope).content_markdown = null
    overviewOf(envelope).sections = null
    overviewOf(envelope).limitations = ['content_restricted']
    overviewOf(envelope).warnings = ['content_restricted']

    const parsed = parseTopicOverviewResponse(envelope)
    expect(parsed?.visibility).toBe('restricted')
    expect(parsed?.focus).toBe('为什么要做 A？')
    expect(parsed?.generated_at).toBe('2026-11-05T10:00:00+00:00')
    expect(parsed?.scope?.mode).toBe('selected')
    expect(parsed?.scope?.source_count).toBe(2)
    expect(parsed?.scope?.captured_at).toBe('2026-11-05T09:55:00+00:00')
    expect(parsed?.processing?.citation_count).toBe(2)
    expect(parsed?.processing?.citations_total).toBe(3)
    expect(parsed?.model).toEqual({ model_id: 'm_local', provider_id: 'p_local' })
    expect(parsed?.purpose).toEqual({
      work_purpose: 'document_qa',
      work_purpose_source: 'default_legacy',
    })
    expect(parsed?.limitations).toEqual(['content_restricted'])
    expect(parsed?.warnings).toEqual(['content_restricted'])
  })

  it('缺失可选块 → null / 空（不伪造、不崩溃）', () => {
    const envelope = {
      schema_version: TOPIC_OVERVIEW_SCHEMA_VERSION,
      request_id: 'req_min',
      overview: {
        overview_id: 'ovw_min',
        generation_id: 'gen_min',
        // 其余键全部缺失
      },
    }
    const parsed = parseTopicOverviewResponse(envelope)
    expect(parsed).toEqual({
      overview_id: 'ovw_min',
      generation_id: 'gen_min',
      generated_at: null,
      generation_created_at: null,
      focus: null,
      visibility: 'restricted',
      content_markdown: null,
      sections: null,
      citations: [],
      scope: null,
      processing: null,
      model: null,
      purpose: null,
      limitations: [],
      warnings: [],
    })
  })

  it('sections 缺失/非对象/全 null/仅未知键 → null；部分段缺失 → 缺段为 null', () => {
    const cases: unknown[] = [
      undefined,
      null,
      'not-an-object',
      ['x'],
      { future_section: 'x' },
      {
        main_questions: null,
        findings: null,
        disagreements: null,
        reading_priorities: null,
      },
    ]
    for (const sections of cases) {
      const envelope = readyEnvelope()
      overviewOf(envelope).sections = sections
      expect(parseTopicOverviewResponse(envelope)?.sections).toBeNull()
    }

    const partial = readyEnvelope()
    overviewOf(partial).sections = { main_questions: '## 主要问题\n- 问题一？' }
    expect(parseTopicOverviewResponse(partial)?.sections).toEqual({
      main_questions: '## 主要问题\n- 问题一？',
      findings: null,
      disagreements: null,
      reading_priorities: null,
    })
  })

  it('citations/scope.sources/included_sources 逐条容错：畸形项丢弃，编号/页码非数字 → null', () => {
    const envelope = readyEnvelope()
    const overview = overviewOf(envelope)
    overview.citations = [
      null,
      42,
      {},
      { doc_id: '', chunk_id: '', claim: '' },
      { citation_id: 'nope', doc_id: 'doc_c', doc_version: 'v2', chunk_id: 'chunk_9', page_idx: '3' },
    ]
    overview.scope = {
      mode: 'all',
      source_count: 1,
      sources: [null, {}, { document_id: 'doc_c', document_version: 'v2' }],
      missing_source_ids: ['missing_1'],
      refs_truncated: true,
    }
    overview.processing = {
      included_sources: [null, { document_id: 'doc_c' }],
    }

    const parsed = parseTopicOverviewResponse(envelope)
    expect(parsed?.citations).toEqual([
      {
        citation_id: null,
        claim: null,
        doc_id: 'doc_c',
        doc_version: 'v2',
        page_idx: null,
        chunk_id: 'chunk_9',
        source_id: null,
        warning: null,
      },
    ])
    expect(parsed?.scope).toEqual({
      mode: 'all',
      contract_version: null,
      includes_exact_versions: false,
      captured_at: null,
      source_count: 1,
      refs_truncated: true,
      sources: [{ document_id: 'doc_c', document_version: 'v2', source_id: null }],
      missing_source_ids: ['missing_1'],
      single_source_id: null,
    })
    expect(parsed?.processing?.included_sources).toEqual([
      { document_id: 'doc_c', document_version: '', chunk_count: 0, source_id: null },
    ])
    // 缺失的计数按 0、modalities 按 0 归一；full_text_read 缺省 false。
    expect(parsed?.processing?.evidence_chunk_count).toBe(0)
    expect(parsed?.processing?.evidence_modalities).toEqual({
      text: 0,
      table: 0,
      figure: 0,
      mixed: 0,
    })
    expect(parsed?.processing?.full_text_read).toBe(false)
  })

  it('非字符串 focus / 非对象 model·purpose / 非标量 coverage → null', () => {
    const envelope = readyEnvelope()
    const overview = overviewOf(envelope)
    overview.focus = 42
    overview.model = 'local'
    overview.purpose = ['document_qa']
    ;(overview.processing as Record<string, unknown>).coverage = ['not', 'object']

    const parsed = parseTopicOverviewResponse(envelope)
    expect(parsed?.focus).toBeNull()
    expect(parsed?.model).toBeNull()
    expect(parsed?.purpose).toBeNull()
    expect(parsed?.processing?.coverage).toBeNull()
  })
})

describe('readTopicOverviewCapability', () => {
  it('严格 `=== true` 才启用', () => {
    expect(readTopicOverviewCapability({ topic_overview: true })).toBe(true)
  })

  it('false / 缺失 / 非法类型 / 非对象 → false（fail-closed）', () => {
    expect(readTopicOverviewCapability({ topic_overview: false })).toBe(false)
    expect(readTopicOverviewCapability({})).toBe(false)
    expect(readTopicOverviewCapability({ search_history: true })).toBe(false)
    expect(readTopicOverviewCapability({ topic_overview: 'true' })).toBe(false)
    expect(readTopicOverviewCapability({ topic_overview: 1 })).toBe(false)
    expect(readTopicOverviewCapability({ topic_overview: { enabled: true } })).toBe(false)
    expect(readTopicOverviewCapability({ topic_overview: null })).toBe(false)
    expect(readTopicOverviewCapability({ topic_overview: undefined })).toBe(false)
    expect(readTopicOverviewCapability(null)).toBe(false)
    expect(readTopicOverviewCapability(undefined)).toBe(false)
    expect(readTopicOverviewCapability('topic_overview')).toBe(false)
    expect(readTopicOverviewCapability([{ topic_overview: true }])).toBe(false)
  })
})

describe('buildTopicOverviewRequest', () => {
  const selectedScope: C05RequestScope = {
    mode: 'selected',
    sourceIds: ['s1', 's2'],
    noteIds: ['n1'],
  }

  it('selected：含 focus，不含 query；source_scope 复用 buildSourceScope；note_ids 恒 []', () => {
    const body = buildTopicOverviewRequest(selectedScope, {
      focus: '关注 A？',
      modelId: 'm_local',
    })
    expect(body).toEqual({
      focus: '关注 A？',
      model_id: 'm_local',
      source_scope: {
        mode: 'selected',
        source_ids: ['s1', 's2'],
        single_source_id: null,
      },
      // 概览路径 Note 一律拒绝：scope.noteIds 不进入请求体。
      note_ids: [],
    })
    expect(body).not.toHaveProperty('query')
    expect(body).not.toHaveProperty('source_ids')
    expect(body).not.toHaveProperty('mode')
    expect(body).not.toHaveProperty('context_level')
  })

  it('focus 为空串时仍显式携带（服务器空 focus = 固定默认概览指令）', () => {
    const body = buildTopicOverviewRequest(selectedScope, {
      focus: '',
      modelId: 'm_local',
    })
    expect(body.focus).toBe('')
  })

  it('response_language / work_purpose 仅在提供时出现（work_purpose 只接受 document_qa）', () => {
    const base = buildTopicOverviewRequest(selectedScope, {
      focus: 'f',
      modelId: 'm_local',
    })
    expect(base).not.toHaveProperty('response_language')
    expect(base).not.toHaveProperty('work_purpose')

    const full = buildTopicOverviewRequest(selectedScope, {
      focus: 'f',
      modelId: 'm_local',
      responseLanguage: 'en',
      workPurpose: 'document_qa',
    })
    expect(full.response_language).toBe('en')
    expect(full.work_purpose).toBe('document_qa')
  })

  it('all 形态：source_ids 空、single_source_id null', () => {
    const body = buildTopicOverviewRequest(
      { mode: 'all', sourceIds: [], noteIds: [] },
      { focus: '', modelId: 'm_local' },
    )
    expect(body.source_scope).toEqual({
      mode: 'all',
      source_ids: [],
      single_source_id: null,
    })
  })

  it('single 形态：single_source_id 透传、source_ids 空', () => {
    const body = buildTopicOverviewRequest(
      { mode: 'single', sourceIds: [], noteIds: [], singleSourceId: 's_only' },
      { focus: '', modelId: 'm_local' },
    )
    expect(body.source_scope).toEqual({
      mode: 'single',
      source_ids: [],
      single_source_id: 's_only',
    })
  })

  it('空 selected fail-closed（抛 c05_request_empty_selected，不扩大为 all）', () => {
    expect(() => buildTopicOverviewRequest(
      { mode: 'selected', sourceIds: [], noteIds: [] },
      { focus: '', modelId: 'm_local' },
    )).toThrowError('c05_request_empty_selected')

    // Note 不构成资料范围：selected 无来源但带 Note 同样必须拒绝（note_ids 恒空）。
    expect(() => buildTopicOverviewRequest(
      { mode: 'selected', sourceIds: [], noteIds: ['n1'] },
      { focus: '', modelId: 'm_local' },
    )).toThrowError('c05_request_empty_selected')
  })
})

describe('topicOverviewSourceChanges', () => {
  it('新增 / 版本变化 / 已退役计数（按 document_id + document_version 比对）', () => {
    const changes = topicOverviewSourceChanges(
      [
        { document_id: 'doc_a', document_version: 'v1' },
        { document_id: 'doc_b', document_version: 'v1' },
        { document_id: 'doc_retired', document_version: 'v1' },
      ],
      [
        { document_id: 'doc_a', document_version: 'v1' },
        { document_id: 'doc_b', document_version: 'v2' },
        { document_id: 'doc_new', document_version: 'v1' },
      ],
    )
    expect(changes).toEqual({ added: 1, versionChanged: 1, retired: 1 })
  })

  it('空/缺失列表 → 全 0（scope 为 null 时可直接传入）', () => {
    expect(topicOverviewSourceChanges([], [])).toEqual({
      added: 0,
      versionChanged: 0,
      retired: 0,
    })
    expect(topicOverviewSourceChanges(null, undefined)).toEqual({
      added: 0,
      versionChanged: 0,
      retired: 0,
    })
    expect(
      topicOverviewSourceChanges(
        [{ document_id: 'doc_a', document_version: 'v1' }],
        [],
      ),
    ).toEqual({ added: 0, versionChanged: 0, retired: 1 })
    expect(
      topicOverviewSourceChanges(
        [],
        [{ document_id: 'doc_a', document_version: 'v1' }],
      ),
    ).toEqual({ added: 1, versionChanged: 0, retired: 0 })
  })

  it('忽略空 document_id 项；同 document_id 重复项去重（不重复计数）', () => {
    expect(
      topicOverviewSourceChanges(
        [
          { document_id: '', document_version: 'v1' },
          { document_id: 'doc_a', document_version: 'v1' },
          { document_id: 'doc_a', document_version: 'v1' },
        ],
        [
          { document_id: 'doc_a', document_version: 'v1' },
          { document_id: 'doc_a', document_version: 'v1' },
        ],
      ),
    ).toEqual({ added: 0, versionChanged: 0, retired: 0 })
  })
})

describe('topicOverviewDiscussionText', () => {
  const discussionGuide = '基于当前主题概览继续讨论：'

  it('focus 优先：固定引导文本 + focus', () => {
    const overview = readyOverview()
    overview.focus = '为什么要做 A？'
    expect(topicOverviewDiscussionText(overview)).toBe(`${discussionGuide}为什么要做 A？`)
  })

  it('focus 缺失 → 概览首段问题（跳过标题行、剥离列表符号，只取第一条）', () => {
    const overview = readyOverview()
    overview.focus = null
    overview.sections = {
      main_questions: '## 主要问题\n\n- 第一个问题？\n- 第二个问题？',
      findings: null,
      disagreements: null,
      reading_priorities: null,
    }
    expect(topicOverviewDiscussionText(overview)).toBe(`${discussionGuide}第一个问题？`)
  })

  it('focus 为空白 / sections 为 null / restricted → 仅固定引导句（不抛错、不出现 undefined）', () => {
    const overview = readyOverview()
    overview.focus = '   '
    overview.sections = null
    const text = topicOverviewDiscussionText(overview)
    expect(text).toBe(`${discussionGuide.slice(0, -1)}。`)
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('null')
  })

  it('加性 guide：本地化引导句 + target（不再写中文引导句）', () => {
    const overview = readyOverview()
    overview.focus = 'Why A?'
    const localized = 'Continue the discussion based on this topic overview: '
    expect(topicOverviewDiscussionText(overview, localized)).toBe(`${localized}Why A?`)
    expect(topicOverviewDiscussionText(overview, localized)).not.toContain(discussionGuide)
  })

  it('加性 guide 且无可用 target → 仅本地化引导句（去尾空白，无 undefined）', () => {
    const overview = readyOverview()
    overview.focus = '   '
    overview.sections = null
    const text = topicOverviewDiscussionText(overview, 'Continue the discussion: ')
    expect(text).toBe('Continue the discussion:')
    expect(text).not.toContain('undefined')
  })

  it('sections.main_questions 为纯标题 → 无可用问题，回落引导句', () => {
    const overview = readyOverview()
    overview.focus = null
    overview.sections = {
      main_questions: '## 主要问题\n',
      findings: null,
      disagreements: null,
      reading_priorities: null,
    }
    expect(topicOverviewDiscussionText(overview)).toBe(`${discussionGuide.slice(0, -1)}。`)
  })
})

describe('errors.ts：6 个 topic overview 稳定码 → 冻结文案 key（F-09）', () => {
  it('WIRE_CONTRACT §4 冻结映射', () => {
    expect(RESEARCH_ERROR_USER_COPY.topic_overview_not_enabled)
      .toBe('research.topicOverview.errors.notEnabled')
    expect(RESEARCH_ERROR_USER_COPY.topic_overview_not_found)
      .toBe('research.topicOverview.errors.notFound')
    expect(RESEARCH_ERROR_USER_COPY.topic_overview_scope_exceeds_limit)
      .toBe('research.topicOverview.errors.scopeExceedsLimit')
    expect(RESEARCH_ERROR_USER_COPY.topic_overview_insufficient_evidence)
      .toBe('research.topicOverview.errors.insufficientEvidence')
    expect(RESEARCH_ERROR_USER_COPY.topic_overview_store_unavailable)
      .toBe('research.topicOverview.errors.storeUnavailable')
    expect(RESEARCH_ERROR_USER_COPY.topic_overview_output_invalid)
      .toBe('research.topicOverview.errors.outputInvalid')
  })

  it('未知码沿用 generic 兜底（不含新码时行为不变）', () => {
    expect(userErrorMessageKey('topic_overview_not_found'))
      .toBe('research.topicOverview.errors.notFound')
    expect(userErrorMessageKey('future_unknown_code'))
      .toBe(RESEARCH_GENERIC_ERROR_KEY)
    expect(userErrorMessageKey(null)).toBe(RESEARCH_GENERIC_ERROR_KEY)
  })
})
