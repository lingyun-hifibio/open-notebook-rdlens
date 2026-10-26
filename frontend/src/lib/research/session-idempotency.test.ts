import { describe, expect, it } from 'vitest'
import {
  SESSION_IDEMPOTENCY_ENCODING,
  SUBMISSION_KEY_DOMAIN,
  SUBMISSION_KEY_PREFIX,
  SubmissionKeyError,
  assertNoUnpairedSurrogates,
  buildSubmissionKey,
  canonicalJson,
  canonicalSubmissionArray,
  ownerDecimal,
  sha256Hex,
  utf8Bytes,
} from './session-idempotency'

/**
 * 第三批 PR-1：提交幂等键（DESIGN §3.2 / 02_INTERFACE_FREEZE §5）。
 *
 * 规范来源：第一批冻结契约 `hash_codec`（revision=6，status=frozen）。
 * 3 个固定向量必须逐条通过；反例必须被拒绝（不得静默改写输入）。
 * 证据级别：simulated（纯函数 + 冻结向量，未接真实服务端）。
 */

const VECTOR_1 = {
  array: ['research-session-v1/submission', 'p1', '42', 'global', null, 'sess_a', 'draft_initial'],
  canonical: '["research-session-v1/submission","p1","42","global",null,"sess_a","draft_initial"]',
  sha256: '4d4d99d252cd262dc2c023c5729ea964d8aaeef60509faf2d57815e976d558cc',
} as const

const VECTOR_2 = {
  array: ['research-session-v1/submission', 'p1', '42', 'source', 'src_a', 'sess_a', 'draft_initial'],
  canonical:
    '["research-session-v1/submission","p1","42","source","src_a","sess_a","draft_initial"]',
  sha256: '1e27a71236788ad42f3ee53a74632566a7d818e83bf25994098b22341dd594d7',
} as const

const VECTOR_3 = {
  array: [
    'research-session-v1/editor',
    ['p1', '42', 'global', null, 'sess_a'],
    '1',
    ['selected', ['src_a', 'src_b'], null],
    null,
    [],
    ['原稿\n é / 😀', 'draft_a'],
  ],
  canonical:
    '["research-session-v1/editor",["p1","42","global",null,"sess_a"],"1",["selected",["src_a","src_b"],null],null,[],["原稿\\n é / 😀","draft_a"]]',
  sha256: '50b8d258a9d3ca422fd6a6c21f53e114da6208108d61bda75f38c13a4692e368',
} as const

describe('session-idempotency: hash_codec 固定向量（冻结契约逐条）', () => {
  it('向量 1：global 会话 source_id=null', () => {
    expect(canonicalJson([...VECTOR_1.array])).toBe(VECTOR_1.canonical)
    expect(sha256Hex(VECTOR_1.canonical)).toBe(VECTOR_1.sha256)
  })

  it('向量 2：source 会话 source_id 非空', () => {
    expect(canonicalJson([...VECTOR_2.array])).toBe(VECTOR_2.canonical)
    expect(sha256Hex(VECTOR_2.canonical)).toBe(VECTOR_2.sha256)
  })

  it('向量 3：嵌套数组 + 换行 + 组合字符 é(U+0065 U+0301) + 表情 + 普通斜杠', () => {
    // 向量文本逐字符核验：原稿 U+000A é(组合) ' / ' 😀（普通 U+002F，非全角）
    expect(canonicalJson([...VECTOR_3.array] as never)).toBe(VECTOR_3.canonical)
    expect(sha256Hex(VECTOR_3.canonical)).toBe(VECTOR_3.sha256)
  })

  it('canonical 输出为紧凑 JSON：无空格、不转义普通 Unicode、无 BOM', () => {
    const canonical = canonicalJson([...VECTOR_1.array])
    expect(canonical).not.toMatch(/ /)
    expect(canonical).not.toMatch(/^\uFEFF/)
    // 普通 Unicode 不转义（\u 序列不出现在 canonical 文本中）
    expect(canonicalJson([...VECTOR_3.array] as never)).not.toMatch(/\\u[0-9a-fA-F]{4}/)
  })

  it('SHA-256 与 Node crypto 交叉校验（仅测试侧使用 Node 实现）', async () => {
    const { createHash } = await import('node:crypto')
    for (const vector of [VECTOR_1, VECTOR_2, VECTOR_3]) {
      expect(sha256Hex(vector.canonical)).toBe(
        createHash('sha256').update(vector.canonical, 'utf8').digest('hex'),
      )
    }
  })
})

describe('session-idempotency: 提交数组与键构造', () => {
  it('canonicalSubmissionArray 段顺序固定：domain, project, owner, kind, source, session, draft', () => {
    expect(
      canonicalSubmissionArray({
        projectId: 'p1',
        ownerUserId: 42,
        kind: 'global',
        sourceId: null,
        sessionId: 'sess_a',
        draftToken: 'draft_initial',
      }),
    ).toEqual(VECTOR_1.array)
  })

  it('buildSubmissionKey 输出 s1_ + 64 位小写十六进制（sha256(lower hex)）', () => {
    const key = buildSubmissionKey({
      projectId: 'p1',
      ownerUserId: 42,
      kind: 'global',
      sourceId: null,
      sessionId: 'sess_a',
      draftToken: 'draft_initial',
    })
    expect(key).toBe(`${SUBMISSION_KEY_PREFIX}${VECTOR_1.sha256}`)
    expect(key).toMatch(/^s1_[a-f0-9]{64}$/)
    expect(SUBMISSION_KEY_PREFIX).toBe('s1_')
    expect(SUBMISSION_KEY_DOMAIN).toBe('research-session-v1/submission')
    expect(SESSION_IDEMPOTENCY_ENCODING).toBe('session-array-utf8-v1')
  })

  it('同一输入稳定；kind/source/session/draft/token 任一变化 → 键变化', () => {
    const base = {
      projectId: 'p1',
      ownerUserId: 42,
      kind: 'global' as const,
      sourceId: null,
      sessionId: 'sess_a',
      draftToken: 'draft_initial',
    }
    const key = buildSubmissionKey(base)
    expect(buildSubmissionKey({ ...base })).toBe(key)
    expect(buildSubmissionKey({ ...base, sessionId: 'sess_b' })).not.toBe(key)
    expect(buildSubmissionKey({ ...base, draftToken: 'draft_other' })).not.toBe(key)
    expect(buildSubmissionKey({ ...base, projectId: 'p2' })).not.toBe(key)
    expect(buildSubmissionKey({ ...base, ownerUserId: 43 })).not.toBe(key)
    expect(
      buildSubmissionKey({ ...base, kind: 'source', sourceId: 'src_a' }),
    ).toBe(`${SUBMISSION_KEY_PREFIX}${VECTOR_2.sha256}`)
  })

  it('global 必须 source_id=null，source 必须非空（否则协议错误）', () => {
    expect(() =>
      buildSubmissionKey({
        projectId: 'p1',
        ownerUserId: 42,
        kind: 'global',
        sourceId: 'src_a',
        sessionId: 'sess_a',
        draftToken: 'draft_initial',
      }),
    ).toThrow(SubmissionKeyError)
    expect(() =>
      buildSubmissionKey({
        projectId: 'p1',
        ownerUserId: 42,
        kind: 'source',
        sourceId: null,
        sessionId: 'sess_a',
        draftToken: 'draft_initial',
      }),
    ).toThrow(SubmissionKeyError)
  })
})

describe('session-idempotency: 反例拒绝（不得静默改写）', () => {
  it('未配对 surrogate 被拒绝（canonical 与 UTF-8 编码均拒绝）', () => {
    expect(() => assertNoUnpairedSurrogates('\uD800')).toThrow(SubmissionKeyError)
    expect(() => assertNoUnpairedSurrogates('ok\uDC00')).toThrow(SubmissionKeyError)
    expect(() => utf8Bytes('\uD800')).toThrow(SubmissionKeyError)
    expect(() => canonicalJson(['x\uD800'] as never)).toThrow(SubmissionKeyError)
    expect(() => buildSubmissionKey({
      projectId: 'p1',
      ownerUserId: 42,
      kind: 'global',
      sourceId: null,
      sessionId: 'sess_\uD800',
      draftToken: 'draft_initial',
    })).toThrow(SubmissionKeyError)
  })

  it('owner 必须是安全正整数（十进制字符串）', () => {
    expect(ownerDecimal(42)).toBe('42')
    expect(ownerDecimal(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER))
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => ownerDecimal(bad)).toThrow(SubmissionKeyError)
    }
  })

  it('空/非法段被拒绝', () => {
    const base = {
      projectId: 'p1',
      ownerUserId: 42,
      kind: 'global' as const,
      sourceId: null,
      sessionId: 'sess_a',
      draftToken: 'draft_initial',
    }
    expect(() => buildSubmissionKey({ ...base, projectId: '' })).toThrow(SubmissionKeyError)
    expect(() => buildSubmissionKey({ ...base, sessionId: '' })).toThrow(SubmissionKeyError)
    expect(() => buildSubmissionKey({ ...base, draftToken: '' })).toThrow(SubmissionKeyError)
    expect(() =>
      buildSubmissionKey({ ...base, kind: 'bogus' as unknown as 'global' }),
    ).toThrow(SubmissionKeyError)
  })
})
