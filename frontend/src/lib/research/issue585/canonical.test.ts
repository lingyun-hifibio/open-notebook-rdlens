/**
 * Issue #1045 PR1（主仓 #585 D2）：fork 侧 TypeScript 共享黄金向量验证。
 *
 * 权威锚点（与主仓**同一份**字节）：
 * - `golden_vectors.json` 是主仓 `src/rdlens/research/issue585/golden_vectors.json`
 *   的**逐字节复制**，本文件不重排、不重新生成；
 * - bundle 字节 SHA-256 固定在 {@link GOLDEN_VECTORS_SHA256}：主仓或 fork 任何
 *   一侧漂移都会在这里变红（跨仓库同步锚）；
 * - 编码/摘要语义见 `./canonical.ts` 与主仓机器契约
 *   `deploy/research/issue585_d2_contract_v1.yaml`。
 *
 * 验证分工（不重复实现服务端逻辑）：
 * - `codec`：用 `C`/`H` **重算** value → encoded / preimage_utf8 / sha256；
 * - `note_snapshot` / `mutation_request` / `export_request`：服务端 normalize
 *   不在 TS 侧重写；直接以 bundle 冻结的 `normalized_value` 验证 `C`/`H`，
 *   并断言 `encoded` + `preimage_utf8` 的重新序列化逐字节一致；
 * - `export_id` / `file_content_hash`：`nex_` 派生与文件内容摘要；
 * - `document_context` / `history_turns` / `writing_intent` /
 *   `writing_envelope`：sidecar、意图与信封摘要，信封按
 *   `{payload, document_context, history_turns}`（payload 不含自引用摘要）重算。
 *
 * 证据级别：simulated（纯函数 + 冻结向量；无产品接线、无网络、无存储）。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../session-idempotency'
import {
  CANONICAL_TAGS,
  CanonicalEncodingError,
  D2_CODEC_NAME,
  D2_ENCODING,
  D2_HASH_NAME,
  SAFE_INT_MAX,
  SAFE_INT_MIN,
  canonicalPreimage,
  encodeCanonical,
  hashValue,
  preimageUtf8Text,
  serializePreimage,
  type CanonicalPair,
  type CanonicalPreimage,
  type CanonicalValue,
} from './canonical'

/**
 * 冻结的 bundle **字节** SHA-256（跨仓库同步锚）。
 *
 * 主仓 `src/rdlens/research/issue585/golden_vectors.json` 与本 fork 副本必须
 * 逐字节一致；bundle 更新时先同步文件，再更新本常量与 `README.md`。
 */
const GOLDEN_VECTORS_SHA256 = '884050b3020e4853f8ee63dbe39e15fac56177fb2f5c69f09fd8eb714e5db358'

const GOLDEN_VECTORS_BYTES = readFileSync(join(__dirname, 'golden_vectors.json'))

interface VectorBase {
  readonly id: string
  readonly kind: string
  readonly description: string
}

interface CodecVector extends VectorBase {
  readonly kind: 'codec'
  readonly namespace: string
  readonly value: unknown
  readonly encoded: CanonicalValue
  readonly preimage_utf8: string
  readonly sha256: string
}

/** `note_snapshot` / `mutation_request` / `export_request`：服务端 normalize 后冻结。 */
interface NormalizedVector extends VectorBase {
  readonly kind: 'note_snapshot' | 'mutation_request' | 'export_request'
  readonly namespace: string
  readonly value: unknown
  readonly normalized_value: unknown
  readonly encoded: CanonicalValue
  readonly preimage_utf8: string
  readonly sha256: string
}

interface ExportIdVector extends VectorBase {
  readonly kind: 'export_id'
  readonly namespace: string
  readonly value: {
    readonly project_id: string
    readonly actor_user_id: number
    readonly idempotency_key: string
  }
  readonly export_id: string
}

interface FileContentVector extends VectorBase {
  readonly kind: 'file_content_hash'
  readonly value: { readonly file_text: string }
  readonly content_hash: string
}

interface SidecarVector extends VectorBase {
  readonly kind: 'document_context' | 'history_turns'
  readonly namespace: string
  readonly normalized_value: unknown
  readonly sha256: string
}

interface WritingIntentVector extends VectorBase {
  readonly kind: 'writing_intent'
  readonly namespace: string
  readonly value: unknown
  readonly sha256: string
}

interface WritingEnvelopeVector extends VectorBase {
  readonly kind: 'writing_envelope'
  readonly namespace: string
  readonly value: {
    readonly payload_without_envelope_hash: Record<string, unknown>
    readonly document_context: unknown
    readonly history_turns: unknown
  }
  readonly normalized_value: { readonly payload: { readonly envelope_hash: string } }
  readonly payload_envelope_hash: string
  readonly envelope_hash: string
  readonly preimage_utf8: string
}

interface GoldenVectorBundle {
  readonly bundle_version: number
  readonly contract: string
  readonly codec: { readonly name: string; readonly hash: string }
  readonly encoding: string
  readonly vectors: readonly VectorBase[]
}

const bundle = JSON.parse(GOLDEN_VECTORS_BYTES.toString('utf8')) as unknown as GoldenVectorBundle

function vectorsOfKind<T extends VectorBase>(kind: string): T[] {
  return bundle.vectors.filter((vector) => vector.kind === kind) as unknown as T[]
}

const codecVectors = vectorsOfKind<CodecVector>('codec')
const normalizedVectors = [
  ...vectorsOfKind<NormalizedVector>('note_snapshot'),
  ...vectorsOfKind<NormalizedVector>('mutation_request'),
  ...vectorsOfKind<NormalizedVector>('export_request'),
]
const exportIdVectors = vectorsOfKind<ExportIdVector>('export_id')
const fileContentVectors = vectorsOfKind<FileContentVector>('file_content_hash')
const sidecarVectors = [
  ...vectorsOfKind<SidecarVector>('document_context'),
  ...vectorsOfKind<SidecarVector>('history_turns'),
]
const intentVectors = vectorsOfKind<WritingIntentVector>('writing_intent')
const envelopeVectors = vectorsOfKind<WritingEnvelopeVector>('writing_envelope')

/** 本测试显式验证过的 kind；bundle 出现新 kind 必须在此补验证。 */
const COVERED_KINDS = new Set([
  'codec',
  'note_snapshot',
  'mutation_request',
  'export_request',
  'export_id',
  'file_content_hash',
  'document_context',
  'history_turns',
  'writing_intent',
  'writing_envelope',
])

/** 独立实现交叉校验：Node `crypto` 不经过本仓库纯 TS SHA-256。 */
function nodeSha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 用 bundle 的 `namespace` + `encoded` 重建预像（不重跑 `C`）。 */
function preimageOf(namespace: string, encoded: CanonicalValue): CanonicalPreimage {
  return [namespace, encoded]
}

function isCanonicalArray(
  encoded: CanonicalValue,
): encoded is readonly ['array', readonly CanonicalValue[]] {
  return encoded[0] === 'array'
}

function isCanonicalObject(
  encoded: CanonicalValue,
): encoded is readonly ['object', readonly CanonicalPair[]] {
  return encoded[0] === 'object'
}

function collectTags(encoded: CanonicalValue, tags: Set<string>): Set<string> {
  tags.add(encoded[0])
  if (isCanonicalArray(encoded)) {
    for (const item of encoded[1]) collectTags(item, tags)
  } else if (isCanonicalObject(encoded)) {
    for (const pair of encoded[1]) collectTags(pair[1], tags)
  }
  return tags
}

describe('bundle 同步锚与冻结元数据', () => {
  it('golden_vectors.json 字节 SHA-256 == 冻结常量（主仓 / fork 逐字节一致）', () => {
    expect(GOLDEN_VECTORS_BYTES.length).toBeGreaterThan(0)
    expect(nodeSha256Hex(GOLDEN_VECTORS_BYTES)).toBe(GOLDEN_VECTORS_SHA256)
  })

  it('bundle 元数据与机器契约一致', () => {
    expect(bundle.bundle_version).toBe(1)
    expect(bundle.contract).toBe('issue585_d2_contract_v1')
    expect(bundle.codec).toEqual({ name: D2_CODEC_NAME, hash: D2_HASH_NAME })
    expect(bundle.encoding).toBe(D2_ENCODING)
  })

  it('29 条向量、10 种 kind 的覆盖与 id 唯一性', () => {
    const counts = bundle.vectors.reduce<Record<string, number>>((accumulator, vector) => {
      accumulator[vector.kind] = (accumulator[vector.kind] ?? 0) + 1
      return accumulator
    }, {})
    expect(counts).toEqual({
      codec: 8,
      document_context: 1,
      export_id: 1,
      export_request: 1,
      file_content_hash: 1,
      history_turns: 1,
      mutation_request: 7,
      note_snapshot: 6,
      writing_envelope: 2,
      writing_intent: 1,
    })
    expect(bundle.vectors).toHaveLength(29)
    expect(new Set(bundle.vectors.map((vector) => vector.id)).size).toBe(29)
  })

  it('不存在未覆盖的 kind（新 kind 必须显式补验证）', () => {
    const unknownKinds = [...new Set(bundle.vectors.map((vector) => vector.kind))].filter(
      (kind) => !COVERED_KINDS.has(kind),
    )
    expect(unknownKinds).toEqual([])
  })
})

describe(`codec 向量：C / preimage / H 逐条重算（${codecVectors.length} 条）`, () => {
  for (const vector of codecVectors) {
    it(`${vector.id}：${vector.description}`, () => {
      expect(encodeCanonical(vector.value)).toEqual(vector.encoded)
      expect(preimageUtf8Text(vector.namespace, vector.value)).toBe(vector.preimage_utf8)
      expect(hashValue(vector.namespace, vector.value)).toBe(vector.sha256)
      // preimage_utf8 == [namespace, encoded] 的紧凑 JSON，且摘要为 UTF-8 字节的 SHA-256
      const preimage = preimageOf(vector.namespace, vector.encoded)
      expect(serializePreimage(preimage)).toBe(vector.preimage_utf8)
      expect(JSON.parse(vector.preimage_utf8)).toEqual([vector.namespace, vector.encoded])
      expect(nodeSha256Hex(vector.preimage_utf8)).toBe(vector.sha256)
    })
  }

  it('C 的像只使用冻结的 6 个类型标签（object/array/string/int/bool/null）', () => {
    const tags = new Set<string>()
    for (const vector of codecVectors) collectTags(vector.encoded, tags)
    expect([...tags].sort()).toEqual([...CANONICAL_TAGS].sort())
  })
})

describe(`normalize 后冻结的向量：note_snapshot / mutation_request / export_request（${normalizedVectors.length} 条）`, () => {
  for (const vector of normalizedVectors) {
    it(`${vector.kind}:${vector.id}`, () => {
      // 服务端 metadata normalize 不在 TS 侧重实现：直接使用 bundle 的 normalized_value。
      expect(encodeCanonical(vector.normalized_value)).toEqual(vector.encoded)
      expect(hashValue(vector.namespace, vector.normalized_value)).toBe(vector.sha256)
      // encoded + preimage_utf8 的重新序列化必须逐字节一致（共享序列化契约）。
      const preimage = preimageOf(vector.namespace, vector.encoded)
      expect(serializePreimage(preimage)).toBe(vector.preimage_utf8)
      expect(JSON.parse(vector.preimage_utf8)).toEqual([vector.namespace, vector.encoded])
      expect(nodeSha256Hex(vector.preimage_utf8)).toBe(vector.sha256)
    })
  }
})

describe(`export_id 向量：nex_ + 预像摘要前 32 hex（${exportIdVectors.length} 条）`, () => {
  for (const vector of exportIdVectors) {
    it(vector.id, () => {
      const preimageText = serializePreimage(canonicalPreimage(vector.namespace, vector.value))
      const derived = `nex_${sha256Hex(preimageText).slice(0, 32)}`
      expect(derived).toBe(vector.export_id)
      expect(vector.export_id).toMatch(/^nex_[0-9a-f]{32}$/)
      // 幂等键只由 project / actor / 原始幂等键派生，不依赖正文
      expect(nodeSha256Hex(preimageText).slice(0, 32)).toBe(vector.export_id.slice(4))
    })
  }
})

describe(`file_content_hash 向量：UTF-8 文件字节 SHA-256（${fileContentVectors.length} 条）`, () => {
  for (const vector of fileContentVectors) {
    it(vector.id, () => {
      expect(sha256Hex(vector.value.file_text)).toBe(vector.content_hash)
      expect(nodeSha256Hex(vector.value.file_text)).toBe(vector.content_hash)
      expect(vector.content_hash).toMatch(/^[0-9a-f]{64}$/)
    })
  }
})

describe(`document_context / history_turns 向量：sidecar 摘要（${sidecarVectors.length} 条）`, () => {
  for (const vector of sidecarVectors) {
    it(`${vector.kind}:${vector.id}`, () => {
      const preimageText = preimageUtf8Text(vector.namespace, vector.normalized_value)
      expect(sha256Hex(preimageText)).toBe(vector.sha256)
      expect(nodeSha256Hex(preimageText)).toBe(vector.sha256)
      expect(JSON.parse(preimageText)).toEqual([
        vector.namespace,
        encodeCanonical(vector.normalized_value),
      ])
      // 紧凑 JSON：无 BOM、无多余空白/转义（重排后逐字节一致）
      expect(preimageText.charCodeAt(0)).not.toBe(0xfeff)
      expect(JSON.stringify(JSON.parse(preimageText))).toBe(preimageText)
    })
  }
})

describe(`writing_intent 向量：意图摘要（${intentVectors.length} 条）`, () => {
  for (const vector of intentVectors) {
    it(vector.id, () => {
      const preimageText = preimageUtf8Text(vector.namespace, vector.value)
      expect(hashValue(vector.namespace, vector.value)).toBe(vector.sha256)
      expect(nodeSha256Hex(preimageText)).toBe(vector.sha256)
      expect(JSON.parse(preimageText)).toEqual([
        vector.namespace,
        encodeCanonical(vector.value),
      ])
    })
  }
})

describe(`writing_envelope 向量：信封摘要（${envelopeVectors.length} 条）`, () => {
  for (const vector of envelopeVectors) {
    it(vector.id, () => {
      const envelope = {
        payload: vector.value.payload_without_envelope_hash,
        document_context: vector.value.document_context,
        history_turns: vector.value.history_turns,
      }
      const preimageText = preimageUtf8Text(vector.namespace, envelope)
      expect(preimageText).toBe(vector.preimage_utf8)
      expect(hashValue(vector.namespace, envelope)).toBe(vector.envelope_hash)
      expect(nodeSha256Hex(preimageText)).toBe(vector.envelope_hash)
      expect(JSON.parse(preimageText)).toEqual([
        vector.namespace,
        encodeCanonical(envelope),
      ])
      // payload 不含自引用信封摘要；payload 内的摘要与 envelope_hash 同源相等。
      expect(
        Object.prototype.hasOwnProperty.call(
          vector.value.payload_without_envelope_hash,
          'envelope_hash',
        ),
      ).toBe(false)
      expect(vector.normalized_value.payload.envelope_hash).toBe(vector.payload_envelope_hash)
      expect(vector.payload_envelope_hash).toBe(vector.envelope_hash)
    })
  }
})

describe('C / H 的编码域性质', () => {
  it('同语义嵌套对象换插入序得到同一编码与同一摘要', () => {
    const first = { z: 1, a: { y: 2, b: 3 } }
    const second = { a: { b: 3, y: 2 }, z: 1 }
    expect(encodeCanonical(first)).toEqual(encodeCanonical(second))
    expect(hashValue('d2-canonical-vector/v1', first)).toBe(
      hashValue('d2-canonical-vector/v1', second),
    )
  })

  it('对象键按 UTF-8 字节序，而不是 JS 默认的 UTF-16 code unit 序', () => {
    // U+E000（UTF-8 EE 80 80）< U+10000（UTF-8 F0 90 80 80）；JS 默认排序会把
    // U+10000 的代理项 0xD800 排在 0xE000 之前，必须显式按 UTF-8 字节比较。
    const encoded = encodeCanonical({ '\u{10000}': 1, '\uE000': 2 })
    expect(encoded).toEqual(['object', [['\uE000', ['int', 2]], ['\u{10000}', ['int', 1]]]])
    expect(['\uE000', '\u{10000}'].sort()).toEqual(['\u{10000}', '\uE000'])
  })

  it('接受 null 原型对象（纯字典），键仍按 UTF-8 字节升序', () => {
    const dictionary = Object.create(null) as Record<string, unknown>
    dictionary.b = 2
    dictionary.a = 1
    expect(encodeCanonical(dictionary)).toEqual([
      'object',
      [['a', ['int', 1]], ['b', ['int', 2]]],
    ])
  })

  it('预像序列化规则与 Python json.dumps(ensure_ascii=False, separators=(",", ":")) 对齐', () => {
    const preimageText = preimageUtf8Text('d2-canonical-vector/v1', {
      backslash: '\\',
      control: '\b\t\n\f\r\u0001\u001f',
      lineSeparator: '\u2028\u2029',
      quote: '"',
      slash: '/',
      unicode: '原稿é😀',
    })
    // 紧凑 JSON：重排后逐字节一致（无多余空白、无可省略转义）
    expect(JSON.stringify(JSON.parse(preimageText))).toBe(preimageText)
    // 无 BOM
    expect(preimageText.charCodeAt(0)).not.toBe(0xfeff)
    // 普通 Unicode 原样保留；U+2028/U+2029 不转义（JSON.stringify 与 Python 一致）
    expect(preimageText).toContain('原稿é😀')
    expect(preimageText).toContain('\u2028\u2029')
    expect(preimageText).not.toContain('\\u2028')
    // 引号/反斜杠/控制字符使用标准 JSON 转义（\b \t \n \f \r + \u00xx）
    expect(preimageText).toContain('\\"')
    expect(preimageText).toContain('\\\\')
    expect(preimageText).toContain('\\b\\t\\n\\f\\r\\u0001\\u001f')
    // 普通斜杠不转义
    expect(preimageText).toContain('/')
  })

  it('H 输出 64 位小写十六进制', () => {
    expect(hashValue('d2-canonical-vector/v1', 'x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('C 的拒绝面（严格，不静默改写输入）', () => {
  it('拒绝浮点数（1.5）并抛出 CanonicalEncodingError', () => {
    expect(() => encodeCanonical(1.5)).toThrow(CanonicalEncodingError)
    expect(() => encodeCanonical(1.5)).toThrow(/floating point/)
    expect(() => encodeCanonical(-0.5)).toThrow(/floating point/)
  })

  it('1.0 在 JavaScript 中与整数 1 不可区分：按 int 接受（Python float 判定的边界）', () => {
    // JS 的 number 只有 binary64：字面量 1.0 与 1 是同一个值，TS 侧不存在
    // 「浮点 1.0」这一输入类别；wire 上写成 1.0 的 JSON 由服务端 Python 校验拦截。
    expect(1.0).toBe(1)
    expect(Number.isInteger(1.0)).toBe(true)
    expect(encodeCanonical(1.0)).toEqual(['int', 1])
  })

  it('拒绝非有限数 NaN / Infinity / -Infinity', () => {
    expect(() => encodeCanonical(Number.NaN)).toThrow(/non-finite/)
    expect(() => encodeCanonical(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
    expect(() => encodeCanonical(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/)
  })

  it('拒绝安全整数范围外的整数 ±(2^53)', () => {
    expect(SAFE_INT_MAX).toBe(2 ** 53 - 1)
    expect(() => encodeCanonical(9007199254740992)).toThrow(/safe-integer/)
    expect(() => encodeCanonical(-9007199254740992)).toThrow(/safe-integer/)
    expect(() => encodeCanonical(SAFE_INT_MAX + 1)).toThrow(/safe-integer/)
    expect(() => encodeCanonical(SAFE_INT_MIN - 1)).toThrow(/safe-integer/)
  })

  it('接受安全整数端点 ±(2^53−1)', () => {
    expect(encodeCanonical(SAFE_INT_MAX)).toEqual(['int', 9007199254740991])
    expect(encodeCanonical(SAFE_INT_MIN)).toEqual(['int', -9007199254740991])
  })

  it('拒绝未配对 high / low surrogate（字符串与对象键）', () => {
    expect(() => encodeCanonical('\uD800')).toThrow(/unpaired surrogate/)
    expect(() => encodeCanonical('a\uD800b')).toThrow(/unpaired surrogate/)
    expect(() => encodeCanonical('\uDC00')).toThrow(/unpaired surrogate/)
    expect(() => encodeCanonical({ '\uD800': 1 })).toThrow(/object key.*unpaired surrogate/)
    expect(() => encodeCanonical({ ok: 1, bad: { '\uDC00': 2 } })).toThrow(
      /object key.*unpaired surrogate/,
    )
  })

  it('接受合法代理对（emoji / 非 BMP 字符）', () => {
    expect(encodeCanonical('😀')).toEqual(['string', '😀'])
    expect(encodeCanonical('\u{10000}')).toEqual(['string', '\u{10000}'])
  })

  it('拒绝带非字符串键的对象（symbol 键会被 JSON.stringify 静默丢弃）', () => {
    const withSymbolKey = { ok: 1, [Symbol('bad')]: 2 }
    expect(() => encodeCanonical(withSymbolKey)).toThrow(/keys must be strings/)
  })

  it('拒绝 schema 外类型：函数 / undefined / symbol / bigint', () => {
    expect(() => encodeCanonical(() => 1)).toThrow(/unsupported value type/)
    expect(() => encodeCanonical(undefined)).toThrow(/unsupported value type/)
    expect(() => encodeCanonical(Symbol('x'))).toThrow(/unsupported value type/)
    expect(() => encodeCanonical(BigInt(10))).toThrow(/unsupported value type/)
  })

  it('拒绝 Map / Set / Date / Uint8Array 等非纯 JSON 对象', () => {
    expect(() => encodeCanonical(new Map([['a', 1]]))).toThrow(/unsupported value type for canonical encoding: Map/)
    expect(() => encodeCanonical(new Set([1]))).toThrow(/unsupported value type for canonical encoding: Set/)
    expect(() => encodeCanonical(new Date(0))).toThrow(/unsupported value type for canonical encoding: Date/)
    expect(() => encodeCanonical(new Uint8Array([1, 2]))).toThrow(
      /unsupported value type for canonical encoding: Uint8Array/,
    )
  })

  it('拒绝稀疏数组（洞会被 JSON.stringify 静默写成 null）', () => {
    const sparse: unknown[] = new Array(3)
    sparse[0] = 1
    sparse[2] = 3
    expect(() => encodeCanonical(sparse)).toThrow(/dense/)
    // 对照：密集数组与 JSON.stringify 的 null 填充不同，C 必须拒绝而不是改写。
    expect(JSON.stringify(sparse)).toBe('[1,null,3]')
  })

  it('拒绝空或非法命名的 namespace（H 需要非空合法 UTF-8 命名空间）', () => {
    expect(() => canonicalPreimage('', 'x')).toThrow(/non-empty/)
    expect(() => hashValue('', 'x')).toThrow(/non-empty/)
    expect(() => preimageUtf8Text('bad\uD800', 'x')).toThrow(/namespace.*unpaired surrogate/)
  })
})
