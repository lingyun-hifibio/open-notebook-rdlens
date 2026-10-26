/**
 * 会话提交幂等键（RDLens #602 第三批 PR-1；DESIGN §3.1、02_INTERFACE_FREEZE §5）。
 *
 * 编码规范：`session-array-utf8-v1`
 * - material 是**紧凑 JSON 数组**（无空格、普通 Unicode 不转义、UTF-8 无 BOM）；
 * - 数组顺序固定为
 *   `['research-session-v1/submission', project_id, owner_decimal, kind,
 *     source_id_or_null, session_id, draft_token]`；
 * - 摘要 = SHA-256 的小写十六进制；提交键 = `s1_<64hex>`；
 * - 拒绝未配对 surrogate（`reject_unpaired_surrogates: true`）。
 *
 * 实现约束（PR-1 风险 R3）：
 * - 纯 TypeScript，**不新增依赖**，也不依赖 WebCrypto / TextEncoder 的
 *   环境差异（浏览器、jsdom、Node 行为一致）；
 * - 固定向量来自第一批冻结契约 `hash_codec.vectors`，测试逐条比对
 *   canonical 字符串与 SHA-256，生产代码不得改动算法或键顺序。
 *
 * 本模块是纯函数层：不读存储、不发请求、不持有状态。
 */

/** 幂等键编码名（与第一批冻结契约 `hash_codec.name` 一致）。 */
export const SESSION_IDEMPOTENCY_ENCODING = 'session-array-utf8-v1' as const

/** 幂等键域前缀；同时是数组第 0 段。 */
export const SUBMISSION_KEY_DOMAIN = 'research-session-v1/submission' as const

/** 提交键前缀（wire 正则 `^s1_[a-f0-9]{64}$`）。 */
export const SUBMISSION_KEY_PREFIX = 's1_' as const

export type SubmissionSessionKind = 'global' | 'source'

/**
 * 幂等键输入。`ownerUserId` 必须是正的安全整数：规范要求 owner 以十进制
 * 文本参与哈希，禁止 `Number` 的浮点/指数格式（如 `1e21`）泄漏进 material。
 */
export interface SubmissionKeyInput {
  readonly projectId: string
  readonly ownerUserId: number
  readonly kind: SubmissionSessionKind
  readonly sourceId: string | null
  readonly sessionId: string
  readonly draftToken: string
}

/** 幂等键构造失败原因（调用方按协议错误处理，不得猜测键）。 */
export type SubmissionKeyErrorCode =
  | 'invalid_project_id'
  | 'invalid_owner'
  | 'invalid_kind'
  | 'invalid_source_id'
  | 'invalid_session_id'
  | 'invalid_draft_token'
  | 'unpaired_surrogate'

export class SubmissionKeyError extends Error {
  readonly code: SubmissionKeyErrorCode

  readonly field: string

  constructor(code: SubmissionKeyErrorCode, field: string, message: string) {
    super(message)
    this.name = 'SubmissionKeyError'
    this.code = code
    this.field = field
  }
}

/** wire 允许出现在任何文本段（session/draft/项目/来源）的字符集。 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** 项目/来源 ID 的长度上限（第一批 `session_ref.project_id/source_id`）。 */
const MAX_RESOURCE_ID_LENGTH = 256

const MAX_SAFE_OWNER = 9007199254740991

/**
 * 校验字符串中不含未配对 surrogate（UTF-16 码元级别）。
 *
 * 未配对 surrogate 无法编码为合法 UTF-8；冻结契约要求拒绝而非替换，
 * 否则不同输入可能摘要相同（替换字符 `U+FFFD` 碰撞）。
 */
export function assertNoUnpairedSurrogates(value: string, field = 'value'): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      // 高代理：必须紧跟合法低代理
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new SubmissionKeyError('unpaired_surrogate', field, `${field} contains an unpaired high surrogate`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SubmissionKeyError('unpaired_surrogate', field, `${field} contains an unpaired low surrogate`)
    }
  }
}

function assertTextLength(value: string, field: string): void {
  if (value.length === 0 || value.length > MAX_RESOURCE_ID_LENGTH) {
    throw new SubmissionKeyError(field === 'project_id' ? 'invalid_project_id' : 'invalid_source_id', field, `${field} must be 1..${MAX_RESOURCE_ID_LENGTH} characters`)
  }
}

/**
 * owner 的规范十进制文本。只接受正的安全整数（1..2^53−1），
 * 不接受字符串形式、负数、零、小数、NaN/Infinity。
 */
export function ownerDecimal(ownerUserId: number): string {
  if (
    !Number.isSafeInteger(ownerUserId) ||
    ownerUserId <= 0 ||
    ownerUserId > MAX_SAFE_OWNER
  ) {
    throw new SubmissionKeyError('invalid_owner', 'owner_decimal', 'owner user id must be a positive safe integer')
  }
  return String(ownerUserId)
}

/**
 * 规范化提交数组（幂等键 material 的结构化形式）。
 *
 * 该函数只做校验与规整，不生成 JSON 文本；canonical 文本由
 * {@link canonicalJson} 生成，保证两侧共享同一规则。
 */
export function canonicalSubmissionArray(
  input: SubmissionKeyInput,
): readonly (string | null)[] {
  const { projectId, ownerUserId, kind, sourceId, sessionId, draftToken } = input
  if (typeof projectId !== 'string' || !IDENTIFIER_PATTERN.test(projectId) || projectId.length > MAX_RESOURCE_ID_LENGTH) {
    // 项目 ID 在网关路径中更宽松，但幂等 material 要求可判别的稳定文本；
    // 契约要求 project_id 1..256。
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > MAX_RESOURCE_ID_LENGTH) {
      throw new SubmissionKeyError('invalid_project_id', 'project_id', 'project_id must be 1..256 characters')
    }
  }
  assertNoUnpairedSurrogates(projectId, 'project_id')
  assertTextLength(projectId, 'project_id')
  if (kind !== 'global' && kind !== 'source') {
    throw new SubmissionKeyError('invalid_kind', 'kind', 'kind must be global or source')
  }
  if (kind === 'global') {
    if (sourceId !== null) {
      throw new SubmissionKeyError('invalid_source_id', 'source_id', 'global submissions must use source_id=null')
    }
  }
  if (kind === 'source') {
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new SubmissionKeyError('invalid_source_id', 'source_id', 'source submissions require a non-empty source_id')
    }
    assertTextLength(sourceId, 'source_id')
    assertNoUnpairedSurrogates(sourceId, 'source_id')
  }
  if (typeof sessionId !== 'string' || !IDENTIFIER_PATTERN.test(sessionId)) {
    throw new SubmissionKeyError('invalid_session_id', 'session_id', 'session_id must match ^[A-Za-z0-9_-]{1,128}$')
  }
  if (typeof draftToken !== 'string' || !IDENTIFIER_PATTERN.test(draftToken)) {
    throw new SubmissionKeyError('invalid_draft_token', 'draft_token', 'draft_token must match ^[A-Za-z0-9_-]{1,128}$')
  }
  return [
    SUBMISSION_KEY_DOMAIN,
    projectId,
    ownerDecimal(ownerUserId),
    kind,
    kind === 'source' ? sourceId : null,
    sessionId,
    draftToken,
  ] as const
}

/** {@link canonicalJson} 支持的 JSON 值（拒绝 undefined/NaN/函数等）。 */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

function assertCanonicalValue(value: CanonicalJsonValue, path: string): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SubmissionKeyError('invalid_project_id', path, `${path} must be a finite number`)
    }
    return
  }
  if (typeof value === 'string') {
    assertNoUnpairedSurrogates(value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCanonicalValue(entry, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertNoUnpairedSurrogates(key, `${path}.${key}`)
      assertCanonicalValue(entry, `${path}.${key}`)
    }
    return
  }
  throw new SubmissionKeyError('invalid_project_id', path, `${path} is not canonical-JSON encodable`)
}

/**
 * 生成紧凑规范 JSON（编码名 `session-array-utf8-v1` 的 material 形式）：
 * - 无空格（`JSON.stringify` 默认紧凑输出）；
 * - 普通 Unicode 原样保留（不转义 `é`/emoji）；
 * - 控制字符使用 JSON 转义（如换行 → `\n`），不带 BOM；
 * - 拒绝未配对 surrogate（在 `JSON.stringify` 之前显式校验，避免
 *   ES2019 的 well-formed 转义掩盖非法输入）。
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  assertCanonicalValue(value, 'material')
  const text = JSON.stringify(value)
  // JSON.stringify 对顶层 undefined/函数返回 undefined；此处类型已排除。
  return text
}

/** 手工 UTF-8 编码（不依赖 TextEncoder；未配对 surrogate 直接拒绝）。 */
export function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    let point = value.codePointAt(index)
    if (point === undefined) break
    if (point > 0xffff) {
      // codePointAt 已消费一个代理对，跳过低代理
      index += 1
    }
    // 上面的 codePointAt 对未配对代理返回代理值本身（0xD800..0xDFFF）。
    if (point >= 0xd800 && point <= 0xdfff) {
      throw new SubmissionKeyError('unpaired_surrogate', 'value', 'cannot encode an unpaired surrogate as UTF-8')
    }
    if (point < 0x80) {
      bytes.push(point)
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f))
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f))
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      )
    }
  }
  return Uint8Array.from(bytes)
}

/** SHA-256 轮常量（FIPS 180-4）。 */
const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift))
}

/**
 * 纯 TypeScript SHA-256（输入按 UTF-8 编码），返回 64 位小写十六进制。
 *
 * 只实现单次摘要（无流式 API 需求）；长度按 FIPS 180-4 填充。
 */
export function sha256Hex(input: string | Uint8Array): string {
  const message = typeof input === 'string' ? utf8Bytes(input) : input
  const length = message.length
  const bitLength = length * 8
  // padding：1 bit '1' + 若干 '0' + 64 bit 大端长度，整体补齐 64 字节块
  const paddedLength = Math.ceil((length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(message, 0)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  // 长度按 64 bit 大端写入末尾 8 字节（高位安全整数足够）
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3)
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10)
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, hh] = h
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + s1 + ch + SHA256_K[index] + w[index]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  return Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('')
}

/**
 * 构造提交幂等键：`s1_` + SHA-256(compact JSON array)。
 *
 * 相同 7 段输入永远得到相同键；任何字段非法时抛出
 * {@link SubmissionKeyError}（调用方不得用 "当前编辑状态重建" 兜底）。
 */
export function buildSubmissionKey(input: SubmissionKeyInput): string {
  const material = canonicalJson(canonicalSubmissionArray(input))
  return `${SUBMISSION_KEY_PREFIX}${sha256Hex(material)}`
}
