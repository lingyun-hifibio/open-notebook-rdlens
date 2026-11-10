/**
 * Issue #1047 PR5（D2-B3）：摘入片段 / 引用 marker / UTF-16 选区纯逻辑单测。
 *
 * 覆盖 A–D 中可脱离 DOM/网络验证的部分：四类来源描述与版本规则、快照
 * summary、marker 解析/编号/预览装饰、代理对边界、raw Markdown 定位、
 * 编辑器选区 → 片段目标、插入区间（光标恢复）、locator 解析的 fail-safe。
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildCitationNumbering,
  citationContentHashMatches,
  joinSourceSnapshotText,
  resolveSourceCitationReading,
  splitTextForHighlight,
  buildFragmentSource,
  buildFragmentTarget,
  computeInsertedRange,
  CITE_MARKER_PATTERN_SOURCE,
  decorateCitationMarkersForPreview,
  excerptContentHash,
  excerptUtf8Bytes,
  EXCERPT_MAX_UTF8_BYTES,
  isSourceVersionValid,
  isStableId,
  parseCitationAnchorHref,
  parseNoteSourceVersion,
  readChatMessageCitationLocator,
  readLegacyInsightCitationLocator,
  readNoteCitationLocator,
  readSourceCitationLocator,
  resolveExcerptSelection,
  splitsSurrogatePair,
  splitCitationMarkers,
} from './excerpt'
import type { NoteCitationBinding, NoteFragmentSourceDescriptor } from './types'

const HASH = 'a'.repeat(64)

function binding(overrides: Partial<NoteCitationBinding> = {}): NoteCitationBinding {
  return {
    binding_id: 'cb_1',
    source_kind: 'source',
    source_id: 'src_1',
    source_version: 'docv_2026_11_01',
    locator: null,
    unresolved: false,
    ...overrides,
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('citation markers', () => {
  it('splits text and markers without dropping characters', () => {
    const content = '前[[cite:cb_a]]中[[cite:cb_b]]后'
    expect(splitCitationMarkers(content)).toEqual([
      { kind: 'text', text: '前' },
      { kind: 'citation', bindingId: 'cb_a', raw: '[[cite:cb_a]]' },
      { kind: 'text', text: '中' },
      { kind: 'citation', bindingId: 'cb_b', raw: '[[cite:cb_b]]' },
      { kind: 'text', text: '后' },
    ])
  })

  it('keeps malformed/unknown-shape markers as plain text (fail-safe)', () => {
    const content = 'a[[cite:bad id]]b[[cite:]]c[[cite:ok_1]'
    const segments = splitCitationMarkers(content)
    expect(segments).toEqual([{ kind: 'text', text: content }])
  })

  it('marker regex only accepts stable ids', () => {
    expect(new RegExp(`^${CITE_MARKER_PATTERN_SOURCE}$`).test('[[cite:cb_-A]]')).toBe(true)
    expect(new RegExp(`^${CITE_MARKER_PATTERN_SOURCE}$`).test(`[[cite:${'x'.repeat(129)}]]`)).toBe(
      false,
    )
  })

  it('numbers bindings by first appearance and appends unreferenced bindings', () => {
    const content = 'x[[cite:cb_b]]y[[cite:cb_a]]z[[cite:cb_b]]'
    const numbering = buildCitationNumbering(content, [
      binding({ binding_id: 'cb_a' }),
      binding({ binding_id: 'cb_b' }),
      binding({ binding_id: 'cb_c' }),
    ])
    expect(numbering.numbers.get('cb_b')).toBe(1)
    expect(numbering.numbers.get('cb_a')).toBe(2)
    expect(numbering.numbers.get('cb_c')).toBe(3)
    expect(numbering.bindings.map((item) => item.binding_id)).toEqual(['cb_b', 'cb_a', 'cb_c'])
    expect(numbering.unknownBindingIds).toEqual([])
  })

  it('reports unknown marker ids and never fabricates bindings', () => {
    const numbering = buildCitationNumbering('x[[cite:cb_unknown]]', [binding()])
    expect(numbering.unknownBindingIds).toEqual(['cb_unknown'])
    expect(numbering.numbers.has('cb_unknown')).toBe(false)
    expect(numbering.numbers.get('cb_1')).toBe(1)
    expect(numbering.bindings.map((item) => item.binding_id)).toEqual(['cb_1'])
  })

  it('decorates known markers as preview anchors and leaves unknown markers literal', () => {
    const numbering = buildCitationNumbering('a[[cite:cb_a]]b[[cite:cb_unknown]]', [
      binding({ binding_id: 'cb_a' }),
    ])
    expect(decorateCitationMarkersForPreview('a[[cite:cb_a]]b[[cite:cb_unknown]]', numbering)).toBe(
      'a[1](#cite-cb_a)b[[cite:cb_unknown]]',
    )
  })

  it('parses only valid citation anchors', () => {
    expect(parseCitationAnchorHref('#cite-cb_1')).toBe('cb_1')
    expect(parseCitationAnchorHref('#cite-')).toBeNull()
    expect(parseCitationAnchorHref('#cite-bad id')).toBeNull()
    expect(parseCitationAnchorHref(null)).toBeNull()
  })

  it('handles duplicate markers for the same binding (single number)', () => {
    const numbering = buildCitationNumbering('[[cite:cb_a]][[cite:cb_a]]', [
      binding({ binding_id: 'cb_a' }),
    ])
    expect(numbering.numbers.get('cb_a')).toBe(1)
    expect(numbering.bindings).toHaveLength(1)
  })
})

describe('excerpt hashing / UTF-16 selection', () => {
  it('hash is UTF-8 sha256 and matches Node crypto', () => {
    expect(excerptContentHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(excerptContentHash('emoji 😀 中文')).toBe(sha256('emoji 😀 中文'))
  })

  it('returns the full text for full selection', () => {
    expect(resolveExcerptSelection('正文', { kind: 'full' })).toEqual({
      ok: true,
      excerpt: '正文',
      start: 0,
      end: 2,
    })
  })

  it('rejects empty full selection and empty ranges', () => {
    expect(resolveExcerptSelection('', { kind: 'full' })).toEqual({
      ok: false,
      reason: 'empty_selection',
    })
    expect(resolveExcerptSelection('abc', { kind: 'range', start_utf16: 1, end_utf16: 1 })).toEqual({
      ok: false,
      reason: 'empty_selection',
    })
  })

  it('accepts a range that contains a full surrogate pair and rejects splitting it', () => {
    const text = 'a😀b' // a(0) high(1) low(2) b(3)
    expect(resolveExcerptSelection(text, { kind: 'range', start_utf16: 1, end_utf16: 3 })).toEqual({
      ok: true,
      excerpt: '😀',
      start: 1,
      end: 3,
    })
    expect(
      resolveExcerptSelection(text, { kind: 'range', start_utf16: 1, end_utf16: 2 }),
    ).toEqual({ ok: false, reason: 'surrogate_split' })
    expect(
      resolveExcerptSelection(text, { kind: 'range', start_utf16: 2, end_utf16: 3 }),
    ).toEqual({ ok: false, reason: 'surrogate_split' })
  })

  it('rejects out-of-bounds offsets (UTF-16 units, not code points)', () => {
    expect(resolveExcerptSelection('abc', { kind: 'range', start_utf16: 0, end_utf16: 4 })).toEqual({
      ok: false,
      reason: 'out_of_bounds',
    })
    expect(resolveExcerptSelection('😀', { kind: 'range', start_utf16: 0, end_utf16: 2 })).toEqual({
      ok: true,
      excerpt: '😀',
      start: 0,
      end: 2,
    })
  })

  it('rejects excerpts over the 1 MiB safety limit', () => {
    const text = 'x'.repeat(EXCERPT_MAX_UTF8_BYTES + 1)
    expect(resolveExcerptSelection(text, { kind: 'full' })).toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(excerptUtf8Bytes('中')).toBe(3)
  })

  it('detects surrogate split boundaries', () => {
    const text = '😀'
    expect(splitsSurrogatePair(text, 1)).toBe(true)
    expect(splitsSurrogatePair(text, 0)).toBe(false)
    expect(splitsSurrogatePair(text, 2)).toBe(false)
  })

  it('note source version follows <revision>:<snapshot_hash>', () => {
    expect(isSourceVersionValid('note', `3:${HASH}`)).toBe(true)
    expect(isSourceVersionValid('note', HASH)).toBe(false)
    expect(isSourceVersionValid('note', null)).toBe(false)
    expect(isSourceVersionValid('source', 'docv_1')).toBe(true)
    expect(isSourceVersionValid('source', null)).toBe(false)
    expect(isSourceVersionValid('chat_message', null)).toBe(true)
    expect(isSourceVersionValid('chat_message', 'v1')).toBe(false)
    expect(isSourceVersionValid('legacy_insight', null)).toBe(true)
  })
})

describe('fragment source descriptor', () => {
  const text = '第一段\n\n第二段 😀'

  function source(overrides: Partial<{
    sourceKind: NoteFragmentSourceDescriptor['source_kind']
    sourceId: string
    sourceVersion: string | null
    selection: NoteFragmentSourceDescriptor['selection']
  }> = {}) {
    return buildFragmentSource({
      sourceKind: 'source',
      sourceId: 'src_orR_01',
      sourceVersion: 'docv_2026_11_01',
      text,
      selection: { kind: 'full' },
      ...overrides,
    })
  }

  it('builds the frozen wire shape without sending trusted full text', () => {
    const result = source()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toEqual({
      source_kind: 'source',
      source_id: 'src_orR_01',
      source_version: 'docv_2026_11_01',
      expected_content_hash: sha256(text),
      selection: { kind: 'full' },
    })
    expect(JSON.stringify(result.source)).not.toContain('第二段')
  })

  it('supports range selection over the snapshot text', () => {
    const result = source({ selection: { kind: 'range', start_utf16: 0, end_utf16: 3 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toBe('第一段')
    expect(result.source.selection).toEqual({ kind: 'range', start_utf16: 0, end_utf16: 3 })
  })

  it('rejects invalid source versions and ids before any request', () => {
    expect(source({ sourceVersion: null }).ok).toBe(false)
    expect(source({ sourceKind: 'note', sourceVersion: null }).ok).toBe(false)
    expect(source({ sourceKind: 'note', sourceVersion: `3:${HASH}` }).ok).toBe(true)
    expect(source({ sourceKind: 'chat_message', sourceVersion: 'v1' }).ok).toBe(false)
    expect(source({ sourceId: 'bad id!' }).ok).toBe(false)
  })

  it('fails the same way for a surrogate-splitting range', () => {
    // 文本：第一段(3) + \n\n(2) + 第二段(3) + 空格(1) + 😀(2)
    const result = source({ selection: { kind: 'range', start_utf16: 9, end_utf16: 10 } })
    expect(result).toEqual({ ok: false, reason: 'surrogate_split' })
  })
})

describe('editor selection → fragment target', () => {
  const content = '开头😀结尾'

  it('maps a collapsed cursor to a cursor target', () => {
    expect(buildFragmentTarget(content, { start: 2, end: 2 })).toEqual({
      kind: 'cursor',
      position_utf16: 2,
    })
  })

  it('maps a non-collapsed selection to a range target in ascending order', () => {
    expect(buildFragmentTarget(content, { start: 6, end: 2 })).toEqual({
      kind: 'range',
      start_utf16: 2,
      end_utf16: 6,
    })
  })

  it('defaults to append/start when the editor has no selection', () => {
    expect(buildFragmentTarget(content, null)).toEqual({
      kind: 'cursor',
      position_utf16: content.length,
    })
    expect(buildFragmentTarget(content, null, 'start')).toEqual({
      kind: 'cursor',
      position_utf16: 0,
    })
  })

  it('refuses boundaries that split a surrogate pair', () => {
    expect(buildFragmentTarget(content, { start: 3, end: 3 })).toBeNull()
  })
})

describe('inserted range (cursor restore after server read-back)', () => {
  it('computes the inserted region for cursor insertions', () => {
    // `[[cite:cb_1]]` = 13 UTF-16 units；片段 = 2
    expect(computeInsertedRange('ab', 'ab片段[[cite:cb_1]]')).toEqual({ start: 2, end: 17 })
    expect(computeInsertedRange('ab', 'a片段[[cite:cb_1]]b')).toEqual({ start: 1, end: 16 })
  })

  it('computes the replaced region for range replacement', () => {
    expect(computeInsertedRange('前旧文本后', '前替换后')).toEqual({ start: 1, end: 3 })
  })

  it('returns null when nothing changed', () => {
    expect(computeInsertedRange('same', 'same')).toBeNull()
  })

  it('never splits an emoji at the computed boundaries', () => {
    const before = 'a😀b'
    const after = 'a😀新b'
    const range = computeInsertedRange(before, after)
    expect(range).not.toBeNull()
    if (range === null) return
    expect(after.slice(range.start, range.end)).toBe('新')
  })
})

describe('binding locator readers (fail-safe)', () => {
  it('reads the source locator with UTF-16 offsets', () => {
    expect(
      readSourceCitationLocator({
        locator: {
          document_version: 'docv_1',
          chunk_id: 'chunk_1',
          chunk_ordinal: 0,
          page_idx: 2,
          start_utf16: 4,
          end_utf16: 9,
        },
      }),
    ).toEqual({
      document_version: 'docv_1',
      content_hash: null,
      chunk_id: 'chunk_1',
      chunk_ordinal: 0,
      page_idx: 2,
      start_utf16: 4,
      end_utf16: 9,
    })
  })

  it('treats malformed/invalid offsets as missing instead of throwing', () => {
    expect(readSourceCitationLocator({ locator: null })).toBeNull()
    expect(readSourceCitationLocator({ locator: {} })).toBeNull()
    expect(
      readSourceCitationLocator({ locator: { start_utf16: '4', end_utf16: 2 } }),
    ).toEqual({
      document_version: null,
      content_hash: null,
      chunk_id: null,
      chunk_ordinal: null,
      page_idx: null,
      start_utf16: null,
      end_utf16: null,
    })
  })

  it('reads chat message locator surface/session/message', () => {
    expect(
      readChatMessageCitationLocator({
        locator: {
          surface: 'source',
          source_id: 'src_1',
          session_id: 'sess_1',
          message_id: 'msg_1',
        },
      }),
    ).toEqual({
      surface: 'source',
      source_id: 'src_1',
      session_id: 'sess_1',
      message_id: 'msg_1',
      start_utf16: null,
      end_utf16: null,
      content_hash: null,
    })
    expect(readChatMessageCitationLocator({ locator: { surface: 'bogus' } })).toBeNull()
  })

  it('reads chat message offsets/hash and legacy-insight locators', () => {
    expect(
      readChatMessageCitationLocator({
        locator: {
          surface: 'global',
          session_id: 'sess_1',
          message_id: 'msg_1',
          start_utf16: 2,
          end_utf16: 6,
          content_hash: 'd'.repeat(64),
        },
      }),
    ).toMatchObject({ start_utf16: 2, end_utf16: 6, content_hash: 'd'.repeat(64) })
    expect(
      readLegacyInsightCitationLocator({
        locator: {
          insight_id: 'ins_1',
          start_utf16: 0,
          end_utf16: 4,
          content_hash: 'e'.repeat(64),
        },
      }),
    ).toEqual({
      insight_id: 'ins_1',
      start_utf16: 0,
      end_utf16: 4,
      content_hash: 'e'.repeat(64),
    })
  })

  it('reads note locator offsets only for valid half-open ranges', () => {
    expect(readNoteCitationLocator({ locator: { start_utf16: 1, end_utf16: 4 } })).toEqual({
      start_utf16: 1,
      end_utf16: 4,
      content_hash: null,
    })
    expect(readNoteCitationLocator({ locator: { start_utf16: 4, end_utf16: 1 } })).toEqual({
      start_utf16: null,
      end_utf16: null,
      content_hash: null,
    })
    expect(
      readNoteCitationLocator({ locator: { content_hash: 'c'.repeat(64) } }),
    ).toEqual({ start_utf16: null, end_utf16: null, content_hash: 'c'.repeat(64) })
  })

  it('parses <revision>:<snapshot_hash> only in the frozen shape', () => {
    expect(parseNoteSourceVersion(`3:${HASH}`)).toEqual({ revision: 3, snapshotHash: HASH })
    expect(parseNoteSourceVersion(`0:${HASH}`)).toBeNull()
    expect(parseNoteSourceVersion(HASH)).toBeNull()
    expect(parseNoteSourceVersion(null)).toBeNull()
  })

  it('stable id guard matches the host contract', () => {
    expect(isStableId('cb_ABC-123')).toBe(true)
    expect(isStableId('')).toBe(false)
    expect(isStableId('has space')).toBe(false)
    expect(isStableId('x'.repeat(129))).toBe(false)
  })
})


describe('source snapshot join / citation reading (host B3 locator)', () => {
  const chunks = [
    { chunk_id: 'c2', chunk_ordinal: 1, page_idx: 1, markdown: '第二段', content_hash: 'b'.repeat(64) },
    { chunk_id: 'c1', chunk_ordinal: 0, page_idx: 0, markdown: '第一段', content_hash: 'a'.repeat(64) },
  ]

  it('joins chunks by ordinal with a blank line (host contract)', () => {
    expect(joinSourceSnapshotText(chunks)).toBe('第一段\n\n第二段')
    expect(excerptContentHash(joinSourceSnapshotText(chunks))).toBe(sha256('第一段\n\n第二段'))
  })

  it('maps a joined-text range back to chunk ids and pages', () => {
    const reading = resolveSourceCitationReading(chunks, {
      document_version: 'docv_1',
      content_hash: sha256('第一段\n\n第二段'),
      start_utf16: 0,
      end_utf16: 8,
    }, 'docv_1')
    expect(reading).toMatchObject({ state: 'ok', chunkIds: ['c1', 'c2'] })
    expect(reading.pageIdxs).toEqual([0, 1])
  })

  it('reports old_version when the source has advanced', () => {
    const reading = resolveSourceCitationReading(chunks, {
      document_version: 'docv_old',
      content_hash: sha256('第一段\n\n第二段'),
      start_utf16: 0,
      end_utf16: 3,
    }, 'docv_new')
    expect(reading.state).toBe('old_version')
  })

  it('reports content_mismatch when the snapshot hash differs', () => {
    const reading = resolveSourceCitationReading(chunks, {
      document_version: 'docv_1',
      content_hash: 'c'.repeat(64),
      start_utf16: 0,
      end_utf16: 3,
    }, 'docv_1')
    expect(reading.state).toBe('content_mismatch')
  })

  it('reports position_unavailable for out-of-bounds / surrogate-splitting offsets', () => {
    const hash = sha256('a😀b')
    expect(
      resolveSourceCitationReading(
        [{ chunk_id: 'c1', chunk_ordinal: 0, page_idx: 0, markdown: 'a😀b' }],
        { document_version: 'v1', content_hash: hash, start_utf16: 0, end_utf16: 99 },
        'v1',
      ).state,
    ).toBe('position_unavailable')
    expect(
      resolveSourceCitationReading(
        [{ chunk_id: 'c1', chunk_ordinal: 0, page_idx: 0, markdown: 'a😀b' }],
        { document_version: 'v1', content_hash: hash, start_utf16: 1, end_utf16: 2 },
        'v1',
      ).state,
    ).toBe('position_unavailable')
  })

  it('splits text for highlight only at safe boundaries', () => {
    expect(splitTextForHighlight('abcdef', 1, 3)).toEqual({
      before: 'a',
      quote: 'bc',
      after: 'def',
    })
    expect(splitTextForHighlight('a😀b', 1, 2)).toBeNull()
    expect(splitTextForHighlight('abc', 2, 2)).toBeNull()
  })

  it('verifies citation content hashes (null = not checked)', () => {
    expect(citationContentHashMatches('abc', null)).toBe(true)
    expect(citationContentHashMatches('abc', sha256('abc'))).toBe(true)
    expect(citationContentHashMatches('abc', sha256('abcd'))).toBe(false)
    expect(citationContentHashMatches('abc', 'not-a-hash')).toBe(false)
  })
})
