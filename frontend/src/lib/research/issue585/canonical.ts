/**
 * Issue #585 D2（B0/PR1）：d2-v1 规范递归编码 `C` 与既有 `H` 的 TypeScript 适配。
 *
 * 权威依据：
 * - 主仓机器契约 `deploy/research/issue585_d2_contract_v1.yaml`；
 * - 主仓 Python 参考实现 `src/rdlens/research/issue585/canonical.py`；
 * - Issue #1045「PR1：契约与黄金向量」。
 *
 * `C` 的编码（跨语言固定，不得按语言习惯改名）：
 * - 对象 → `["object", [[键, C(值)], ...]]`，键按 **UTF-8 字节升序**；
 * - 数组 → `["array", [C(元素), ...]]`，保留顺序；
 * - 字符串 → `["string", 原串]`；整数 → `["int", 整数]`；
 * - 布尔 → `["bool", true|false]`（先于整数判定）；null → `["null", null]`。
 *
 * `H` = `sha256`（小写十六进制）over `[namespace, C(value)]` 的紧凑 JSON 的
 * UTF-8 字节。预像文本复用 `JSON.stringify`：无空格、无 BOM、普通 Unicode
 * 原样保留、控制字符按 JSON 转义、不转义 `U+2028`/`U+2029`；SHA-256 复用本
 * 仓库既有纯 TS 实现（`session-idempotency.sha256Hex`），因此浏览器 / jsdom /
 * Node 的字节结果一致（不依赖 WebCrypto / TextEncoder 的环境差异）。
 *
 * 拒绝面（严格，不静默改写输入）：浮点数与非有限数、JavaScript 安全整数
 * `±(2**53-1)` 范围外的整数、未配对 surrogate（字符串、对象键、命名空间）、
 * 非字符串对象键、schema 外类型（函数、`undefined`、symbol、bigint、
 * `Map`/`Set`/`Date` 等非纯 JSON 对象）。
 *
 * 已知跨语言差异：JavaScript 的 `number` 只有 binary64 一种数值类型，字面量
 * `1.0` 与 `1` 是同一个值，TS 侧无法区分，因此按整数接受；Python 侧 `float`
 * 输入会被拒绝。wire 上写成 `1.0` 的 JSON 由服务端 Python 校验拦截，TS 侧
 * 不存在能表达「浮点 1.0」的输入类别。
 *
 * 本模块是纯函数层：不读存储、不发请求、不注册路由。
 */

import {
  assertNoUnpairedSurrogates,
  sha256Hex,
  utf8Bytes,
} from '../session-idempotency'

/** 编解码器名字（机器契约 `codec.name`；跨语言固定，不得拼入可变配置）。 */
export const D2_CODEC_NAME = 'd2-canonical-v1' as const

/** 摘要算法（机器契约 `codec.hash`）。 */
export const D2_HASH_NAME = 'sha256' as const

/** 预像文本编码（机器契约 `encoding`）。 */
export const D2_ENCODING = 'utf-8' as const

/** JavaScript 安全整数上界 `2**53-1`；`C` 只接受该范围内的整数。 */
export const SAFE_INT_MAX = 9007199254740991

/** JavaScript 安全整数下界 `-(2**53-1)`。 */
export const SAFE_INT_MIN = -9007199254740991

/** 类型标签（机器契约 `codec.tags`；与 Python 侧同名，不得按语言习惯改名）。 */
export const CANONICAL_TAGS = ['object', 'array', 'string', 'int', 'bool', 'null'] as const

/** 编码后的值：`C` 的像（只含数组/字符串/安全整数/布尔/null）。 */
export type CanonicalValue =
  | readonly ['null', null]
  | readonly ['bool', boolean]
  | readonly ['int', number]
  | readonly ['string', string]
  | readonly ['array', readonly CanonicalValue[]]
  | readonly ['object', readonly CanonicalPair[]]

/** 对象编码中的一个键值对（键已按 UTF-8 字节升序排好）。 */
export type CanonicalPair = readonly [string, CanonicalValue]

/** `H` 的预像数组：`[命名空间, C(值)]`。 */
export type CanonicalPreimage = readonly [string, CanonicalValue]

/**
 * `C` 的输入不在契约编码域内（类型、范围或未配对 surrogate）。
 *
 * 调用方按契约映射为 422（`note_request_invalid` 等），不得把异常文本、
 * 正文或来源片段回给客户端。
 */
export class CanonicalEncodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalEncodingError'
  }
}

/**
 * 拒绝未配对 surrogate（UTF-16 码元级别）。
 *
 * 未配对代理无法编码为合法 UTF-8；静默替换成 `U+FFFD` 会让不同输入可能得到
 * 同一摘要（替换字符碰撞），因此必须在序列化之前拒绝。复用既有码元级检查，
 * 但对外只暴露本模块的错误类型。
 */
function assertWellFormedString(value: string, what: string): void {
  try {
    assertNoUnpairedSurrogates(value, what)
  } catch {
    throw new CanonicalEncodingError(`${what} contains an unpaired surrogate code point`)
  }
}

/**
 * 按 UTF-8 字节比较两个字符串（对象键排序规则）。
 *
 * 不能用 JS 默认的 UTF-16 code unit 比较：非 BMP 字符（如 `U+10000`）的代理项
 * 落在 `0xD800` 段，默认排序会把它排到 `U+E000` 之前，而 UTF-8 字节序（= 码点序）
 * 要求相反。调用前键已通过 surrogate 校验，这里是合法 UTF-8。
 */
function compareUtf8Bytes(left: string, right: string): number {
  const leftBytes = utf8Bytes(left)
  const rightBytes = utf8Bytes(right)
  const shared = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < shared; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index]
    }
  }
  return leftBytes.length - rightBytes.length
}

/** 非 JSON 对象（`Map`/`Set`/`Date` 等）的类型名，仅用于错误信息。 */
function objectTypeName(value: object): string {
  const constructor = (value as { constructor?: { name?: string } }).constructor
  return constructor?.name ?? 'object'
}

/**
 * 整数编码。`-0` 与 `0` 在 JSON 中同为 `0`，返回结构里统一为 `0`（避免 `-0`
 * 泄漏给调用方，同时与 Python `int` 的序列化文本一致）。
 */
function encodeNumber(value: number): CanonicalValue {
  if (!Number.isFinite(value)) {
    throw new CanonicalEncodingError('non-finite numbers are not allowed')
  }
  if (!Number.isInteger(value)) {
    throw new CanonicalEncodingError('floating point values are not allowed')
  }
  if (value < SAFE_INT_MIN || value > SAFE_INT_MAX) {
    throw new CanonicalEncodingError('integer outside the JavaScript safe-integer range')
  }
  return ['int', Object.is(value, -0) ? 0 : value] as const
}

/** 数组编码：只接受稠密索引元素（洞或额外属性没有 JSON schema 对应值）。 */
function encodeArray(value: readonly unknown[]): CanonicalValue {
  // 稀疏数组的洞会被 JSON.stringify 静默写成 null，必须在编码前拒绝而不是改写；
  // 额外自有属性会被 JSON.stringify 静默丢弃，同样拒绝。
  if (Object.keys(value).length !== value.length) {
    throw new CanonicalEncodingError(
      'arrays must be dense index elements (no holes or extra properties)',
    )
  }
  return ['array', value.map(encodeCanonical)] as const
}

/** 对象编码：键必须全部是字符串，并按 UTF-8 字节升序重排。 */
function encodeObject(value: object): CanonicalValue {
  if (Array.isArray(value)) {
    return encodeArray(value)
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalEncodingError(
      `unsupported value type for canonical encoding: ${objectTypeName(value)}`,
    )
  }
  // JS 普通对象的 string 键由运行时保证；symbol 键不在契约编码域内，且
  // JSON.stringify 会静默丢弃它，因此显式拒绝。
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalEncodingError('object keys must be strings')
  }
  const pairs: CanonicalPair[] = []
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertWellFormedString(key, 'object key')
    pairs.push([key, encodeCanonical(item)])
  }
  pairs.sort((left, right) => compareUtf8Bytes(left[0], right[0]))
  return ['object', pairs] as const
}

/**
 * 规范递归编码 `C`（见模块 docstring 的类型表）。
 *
 * 输入必须在契约编码域内；任何越界/不支持输入抛
 * {@link CanonicalEncodingError}，不做类型强转或静默降级。
 */
export function encodeCanonical(value: unknown): CanonicalValue {
  if (value === null) {
    return ['null', null] as const
  }
  switch (typeof value) {
    case 'boolean':
      return ['bool', value] as const
    case 'number':
      return encodeNumber(value)
    case 'string':
      assertWellFormedString(value, 'string')
      return ['string', value] as const
    case 'object':
      return encodeObject(value)
    default:
      // function / undefined / symbol / bigint 等不是 JSON schema 值。
      throw new CanonicalEncodingError(
        `unsupported value type for canonical encoding: ${typeof value}`,
      )
  }
}

/**
 * `H` 的预像：`[命名空间, C(值)]`。命名空间必须是非空且合法的 UTF-8 文本。
 */
export function canonicalPreimage(namespace: string, value: unknown): CanonicalPreimage {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new CanonicalEncodingError('hash namespace must be a non-empty string')
  }
  assertWellFormedString(namespace, 'hash namespace')
  return [namespace, encodeCanonical(value)] as const
}

/**
 * 预像的紧凑 JSON 文本（无空格、无 BOM、普通 Unicode 原样、控制字符按 JSON
 * 转义、不转义 `U+2028`/`U+2029`）。预像必须来自 {@link canonicalPreimage}
 * （即已通过 `C` 的拒绝面），本函数不再重复校验内部值。
 */
export function serializePreimage(preimage: CanonicalPreimage): string {
  return JSON.stringify(preimage)
}

/** {@link preimageUtf8Text} 的名字强调返回值是**文本**；UTF-8 字节在哈希时产生。 */
export function preimageUtf8Text(namespace: string, value: unknown): string {
  return serializePreimage(canonicalPreimage(namespace, value))
}

/**
 * `H([命名空间, C(值)])`：预像紧凑 JSON 的 UTF-8 字节的 SHA-256 小写十六进制。
 *
 * 旧 `H`、旧 `note_content_hash` 与 v1/v2 字节都不经过本函数；本函数只服务
 * 新 #585/#1045 契约。
 */
export function hashValue(namespace: string, value: unknown): string {
  return sha256Hex(preimageUtf8Text(namespace, value))
}
