/**
 * Issue #1048 PR7：写作意图编码/请求构造测试。
 *
 * 覆盖：黄金向量（与 Python 侧同一 bundle）、意图独立性（Note revision vs
 * composer 身份）、选区/文档上下文校验、请求 11 键闭合、容量与选区文本。
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  buildWritingSubmissionRequest,
  measureWritingCapacity,
  normalizeWritingDocumentContext,
  normalizeWritingIntentFields,
  normalizeWritingSelection,
  selectedWritingText,
  writingIntentHash,
  writingUtf8Bytes,
} from './writing-intent'
import { WRITING_INTENT_NAMESPACE, type WritingIntentFields } from './writing-types'

const BUNDLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'golden_vectors.json'), 'utf8'),
) as {
  vectors: Array<{
    kind: string
    id: string
    namespace: string
    value: unknown
    sha256: string
  }>
}

const DOC_CONTEXT = {
  note_id: 'note_abc123',
  revision: 7,
  snapshot_hash: 'd'.repeat(64),
  selection: { kind: 'range', start_utf16: 0, end_utf16: 7 },
} as const

function intentFields(overrides: Partial<WritingIntentFields> = {}): WritingIntentFields {
  return {
    schema_version: 1,
    project_id: 'p_demo',
    owner_user_id: 42,
    session_kind: 'global',
    source_id: null,
    session_id: 'sess_a',
    editor_revision: 5,
    editor_intent_hash: 'a'.repeat(64),
    draft_token: 'draft_a',
    query: '请把这段改写为更精炼的表述',
    model_id: 'm1',
    response_language: 'zh-CN',
    work_purpose: 'writing',
    document_context: DOC_CONTEXT,
    history_mode: 'current',
    ...overrides,
  }
}

describe('writing_intent 黄金向量（与 Python 同一 bundle）', () => {
  const vectors = BUNDLE.vectors.filter((vector) => vector.kind === 'writing_intent')
  it('bundle 至少有一条向量且命名空间一致', () => {
    expect(vectors.length).toBeGreaterThan(0)
    expect(vectors[0].namespace).toBe(WRITING_INTENT_NAMESPACE)
  })
  for (const vector of vectors) {
    it(vector.id, () => {
      const normalized = normalizeWritingIntentFields(vector.value)
      expect(normalized.ok).toBe(true)
      if (!normalized.ok) return
      const hashed = writingIntentHash(normalized.value)
      expect(hashed.ok).toBe(true)
      if (!hashed.ok) return
      expect(hashed.value).toBe(vector.sha256)
    })
  }
})

describe('意图对象与 Note revision / composer 身份分离', () => {
  it('只有 document_context 的 Note revision 不同 → 意图不同（Note revision 只在 document_context 中）', () => {
    const first = writingIntentHash(intentFields())
    const second = writingIntentHash(
      intentFields({
        document_context: { ...DOC_CONTEXT, revision: 8 },
      }),
    )
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value).not.toBe(second.value)
  })

  it('composer 身份（editor_revision/intent/draft_token）变化 → 意图变化', () => {
    const base = writingIntentHash(intentFields())
    for (const override of [
      { editor_revision: 6 },
      { editor_intent_hash: 'b'.repeat(64) },
      { draft_token: 'draft_b' },
    ] as const) {
      const next = writingIntentHash(intentFields(override))
      expect(next.ok).toBe(true)
      if (!base.ok || !next.ok) continue
      expect(next.value).not.toBe(base.value)
    }
  })

  it('history_mode / selection / model / language 变化 → 意图变化', () => {
    const base = writingIntentHash(intentFields())
    const variants = [
      intentFields({ history_mode: 'none' }),
      intentFields({ document_context: { ...DOC_CONTEXT, selection: { kind: 'full' } } }),
      intentFields({ model_id: 'm2' }),
      intentFields({ response_language: 'en' }),
    ]
    for (const variant of variants) {
      const next = writingIntentHash(variant)
      expect(next.ok).toBe(true)
      if (!base.ok || !next.ok) continue
      expect(next.value).not.toBe(base.value)
    }
  })

  it('同语义嵌套键顺序不同 → 同一摘要', () => {
    const reordered = {
      ...intentFields(),
      document_context: {
        selection: { end_utf16: 7, start_utf16: 0, kind: 'range' },
        snapshot_hash: 'd'.repeat(64),
        revision: 7,
        note_id: 'note_abc123',
      },
    } as unknown as WritingIntentFields
    const first = writingIntentHash(intentFields())
    const second = writingIntentHash(reordered)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value).toBe(second.value)
  })

  it('闭合 15 键：多/少键均拒绝', () => {
    const extra = { ...intentFields(), extra: true } as unknown as WritingIntentFields
    expect(normalizeWritingIntentFields(extra).ok).toBe(false)
    const { history_mode: _omitted, ...missing } = intentFields()
    expect(normalizeWritingIntentFields(missing).ok).toBe(false)
    void _omitted
  })

  it('source 会话必须带 source_id；global 会话不得带', () => {
    expect(normalizeWritingIntentFields(intentFields({ session_kind: 'source' })).ok).toBe(false)
    expect(
      normalizeWritingIntentFields(
        intentFields({ session_kind: 'source', source_id: 'src_1' }),
      ).ok,
    ).toBe(true)
    expect(normalizeWritingIntentFields(intentFields({ source_id: 'src_1' })).ok).toBe(false)
  })

  it('work_purpose 非 writing 拒绝', () => {
    const fields = { ...intentFields(), work_purpose: 'document_qa' } as unknown as WritingIntentFields
    expect(normalizeWritingIntentFields(fields).ok).toBe(false)
  })
})

describe('document_context / selection 校验', () => {
  it('range 必须 start < end 且非负安全整数', () => {
    expect(normalizeWritingSelection({ kind: 'range', start_utf16: 3, end_utf16: 3 }).ok).toBe(false)
    expect(normalizeWritingSelection({ kind: 'range', start_utf16: 4, end_utf16: 3 }).ok).toBe(false)
    expect(normalizeWritingSelection({ kind: 'range', start_utf16: -1, end_utf16: 3 }).ok).toBe(false)
    expect(normalizeWritingSelection({ kind: 'range', start_utf16: 0, end_utf16: 3 }).ok).toBe(true)
    expect(normalizeWritingSelection({ kind: 'full', extra: 1 }).ok).toBe(false)
  })

  it('revision 必须 >= 1、snapshot_hash 必须 hex64', () => {
    expect(normalizeWritingDocumentContext({ ...DOC_CONTEXT, revision: 0 }).ok).toBe(false)
    expect(normalizeWritingDocumentContext({ ...DOC_CONTEXT, snapshot_hash: 'xyz' }).ok).toBe(false)
    expect(normalizeWritingDocumentContext({ ...DOC_CONTEXT, revision: 1 }).ok).toBe(true)
  })
})

describe('buildWritingSubmissionRequest：闭合 11 键与独立意图', () => {
  const built = buildWritingSubmissionRequest({
    projectId: 'p_demo',
    ownerUserId: 42,
    sessionKind: 'global',
    sourceId: null,
    sessionId: 'sess_a',
    editorRevision: 5,
    editorIntentHash: 'a'.repeat(64),
    draftToken: 'draft_a',
    query: '请把这段改写为更精炼的表述',
    modelId: 'm1',
    responseLanguage: 'zh-CN',
    documentContext: DOC_CONTEXT,
    historyMode: 'none',
  })

  it('成功构造且键集为冻结 11 键', () => {
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(Object.keys(built.value.request).sort()).toEqual(
      [
        'editor_intent_hash',
        'document_context',
        'draft_token',
        'editor_revision',
        'history_mode',
        'model',
        'query',
        'response_language',
        'schema_version',
        'work_purpose',
        'writing_intent_hash',
      ].sort(),
    )
    expect(built.value.request.schema_version).toBe(1)
    expect(built.value.request.work_purpose).toBe('writing')
    expect(built.value.request.history_mode).toBe('none')
    expect(built.value.request.document_context).toEqual(DOC_CONTEXT)
  })

  it('writing_intent_hash 与 composer 身份/文档选择同源（独立重算一致）', () => {
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const recomputed = writingIntentHash(
      intentFields({
        history_mode: 'none',
        document_context: DOC_CONTEXT,
        editor_revision: 5,
        editor_intent_hash: 'a'.repeat(64),
        draft_token: 'draft_a',
      }),
    )
    expect(recomputed.ok).toBe(true)
    if (!recomputed.ok) return
    expect(built.value.request.writing_intent_hash).toBe(recomputed.value)
  })

  it('composer 身份缺失/畸形 → 拒绝（不回退 Note revision 或旧 schema1 哈希）', () => {
    for (const bad of [
      { editorIntentHash: 'not-hex' },
      { draftToken: '' },
      { editorRevision: -1 },
    ]) {
      const rejected = buildWritingSubmissionRequest({
        projectId: 'p_demo',
        ownerUserId: 42,
        sessionKind: 'global',
        sourceId: null,
        sessionId: 'sess_a',
        editorRevision: 5,
        editorIntentHash: 'a'.repeat(64),
        draftToken: 'draft_a',
        query: 'q',
        modelId: 'm1',
        responseLanguage: 'en',
        documentContext: DOC_CONTEXT,
        historyMode: 'none',
        ...bad,
      })
      expect(rejected.ok).toBe(false)
    }
  })

  it('query 超 128 KiB → query_too_large（不截断）', () => {
    const rejected = buildWritingSubmissionRequest({
      projectId: 'p_demo',
      ownerUserId: 42,
      sessionKind: 'global',
      sourceId: null,
      sessionId: 'sess_a',
      editorRevision: 0,
      editorIntentHash: 'a'.repeat(64),
      draftToken: 'draft_a',
      query: 'x'.repeat(128 * 1024 + 1),
      modelId: 'm1',
      responseLanguage: 'en',
      documentContext: DOC_CONTEXT,
      historyMode: 'none',
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.code).toBe('query_too_large')
  })
})

describe('容量与选区文本', () => {
  it('UTF-8 字节按实际编码（emoji 4 字节）', () => {
    expect(writingUtf8Bytes('ab')).toBe(2)
    expect(writingUtf8Bytes('中')).toBe(3)
    expect(writingUtf8Bytes('😀')).toBe(4)
  })

  it('容量摘要与超限部件', () => {
    const many = 'x'.repeat(128 * 1024 + 1)
    const summary = measureWritingCapacity({ selectedText: 'abc', query: many })
    expect(summary.overLimit).toBe(true)
    expect(summary.overLimitParts).toEqual(['query'])
    expect(summary.queryBytes).toBe(many.length)
    const bigText = 'x'.repeat(1024 * 1024 + 1)
    const summary2 = measureWritingCapacity({ selectedText: bigText, query: 'q' })
    expect(summary2.overLimitParts).toEqual(['document_context'])
  })

  it('全文/选区取文本（UTF-16 区间，不做 trim）', () => {
    expect(selectedWritingText(' 正文 ', { kind: 'full' })).toBe(' 正文 ')
    expect(
      selectedWritingText('abcd😀ef', { kind: 'range', start_utf16: 1, end_utf16: 4 }),
    ).toBe('bcd')
  })
})
