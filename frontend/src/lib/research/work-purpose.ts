/**
 * W1 #1106 PR-B：工作目的（purpose）读投影、能力位与展示映射（纯函数）。
 *
 * 契约（RDLens PR-A，commit 16e44fae6；计划 §3/§5/§6/§8）：
 * - 契约值三选一：`document_qa` / `exploration` / `writing`；
 * - 来源四值：`explicit` / `inferred` / `default_legacy` / `not_recorded`
 *   （后端旧行/非法行读回恒为 `null` + `not_recorded`，**不回填、不推断**）；
 * - 「自动判断」= 请求**省略** `work_purpose` 字段（不得发送 null）；
 *   推断只发生在服务端（仅 headed global Chat）；
 * - 能力位 `capabilities.purpose_inference` 为加性键：只在 inference flag on
 *   且 D1-C 契约 on 时出现；**严格 `=== true`** 才视为可用（fail-closed），
 *   缺失/畸形/旧后端 ⇒ 摘要显示「默认（资料问答）」，不显示假控件。
 *
 * 本模块只做纯解析/映射：不读 window、不发请求、不做 i18n（调用方用
 * `workPurposeLabelKey`/`workPurposeSourceLabelKey` 取键）。
 */

import {
  MESSAGE_PROJECTION_KEY_COUNTS,
  type MessageProjectionVersion,
} from './session-contract'
import type { ResearchCapabilities } from './types'

/** 契约目的值（C-01 四值中的三个可写值；`delegated_research` 仍 reserved）。 */
export type ResearchWorkPurpose = 'document_qa' | 'exploration' | 'writing'

/** 持久化来源值（PR-A 新增 `inferred`；`not_recorded` 只用于读投影）。 */
export type ResearchWorkPurposeSource =
  | 'explicit'
  | 'inferred'
  | 'default_legacy'
  | 'not_recorded'

/** composer 三选 + 自动判断控件态（自动判断 = 省略请求字段，非契约值）。 */
export const RESEARCH_WORK_PURPOSES: readonly ResearchWorkPurpose[] = [
  'document_qa',
  'exploration',
  'writing',
]

export const RESEARCH_WORK_PURPOSE_SOURCES: readonly ResearchWorkPurposeSource[] = [
  'explicit',
  'inferred',
  'default_legacy',
  'not_recorded',
]

/** 消息行/SSE 投影的 purpose 两键读取结果。 */
export interface WorkPurposeReadProjection {
  /** null = 无值（`not_recorded`/未记录）；绝不猜测成 document_qa。 */
  readonly workPurpose: ResearchWorkPurpose | null
  /** null = 本端尚无信息（live turn 未收到 usage 前的未知态，不显示）。 */
  readonly workPurposeSource: ResearchWorkPurposeSource | null
}

const NOT_RECORDED: WorkPurposeReadProjection = {
  workPurpose: null,
  workPurposeSource: 'not_recorded',
}

/** 严格目的值解析；null/未知值 → null（fail-closed，不猜测）。 */
export function parseWorkPurpose(value: unknown): ResearchWorkPurpose | null {
  return value === 'document_qa' || value === 'exploration' || value === 'writing'
    ? value
    : null
}

/** 严格来源值解析；null/未知值 → null（fail-closed，不猜测）。 */
export function parseWorkPurposeSource(value: unknown): ResearchWorkPurposeSource | null {
  return value === 'explicit' ||
    value === 'inferred' ||
    value === 'default_legacy' ||
    value === 'not_recorded'
    ? value
    : null
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * `capabilities.purpose_inference`（GET models 顶层 capabilities 加性键）。
 * 仅严格 `=== true` 启用；缺失/非法/旧后端一律 false。
 */
export function readPurposeInferenceCapability(
  capabilities: ResearchCapabilities | null | undefined,
): boolean {
  if (capabilities === null || typeof capabilities !== 'object') return false
  return capabilities.purpose_inference === true
}

/**
 * 目的两键的严格配对解析（消息行与 SSE usage 事件共用）。
 *
 * - 两键必须同时出现且值互相自洽：`work_purpose` 合法 ⇔ source ∈
 *   {explicit, inferred, default_legacy}；`work_purpose === null` ⇔
 *   source === 'not_recorded'；
 * - 任何不自洽/未知值 → null（调用方整组丢弃，不猜、不跨键拼接）。
 */
export function parseWorkPurposePair(payload: Record<string, unknown>): WorkPurposeReadProjection | null {
  if (!hasOwn(payload, 'work_purpose') || !hasOwn(payload, 'work_purpose_source')) {
    return null
  }
  const source = parseWorkPurposeSource(payload.work_purpose_source)
  if (source === null) return null
  const rawPurpose = payload.work_purpose
  if (rawPurpose === null) {
    return source === 'not_recorded' ? NOT_RECORDED : null
  }
  const purpose = parseWorkPurpose(rawPurpose)
  if (purpose === null) return null
  if (source === 'not_recorded') return null
  return { workPurpose: purpose, workPurposeSource: source }
}

/**
 * headed 消息行 → purpose 读投影（历史/重开与首答同一来源，不各自推断）。
 *
 * 复用 `session-contract` 的投影版本/key-count fail-closed 设施：
 * - 版本未知（响应头缺失/旧传输）→ 键出现才严格解析，缺失 = 未记录；
 * - 版本已知（legacy/d1c/d1e）但键数不属于该版本键集 → fail-closed
 *   按未记录（不按旧键集容忍新投影，也不猜键集）；`legacy` 投影不允许
 *   出现 purpose 两键；
 * - 键缺失（15 键旧行/flag off 投影）→ 未记录（不回填 `document_qa`）。
 */
export function readMessageWorkPurpose(
  row: Record<string, unknown>,
  projectionVersion: MessageProjectionVersion | null,
): WorkPurposeReadProjection {
  const hasKeys =
    hasOwn(row, 'work_purpose') && hasOwn(row, 'work_purpose_source')
  if (projectionVersion !== null) {
    const allowed = MESSAGE_PROJECTION_KEY_COUNTS[projectionVersion]
    if (!allowed.includes(Object.keys(row).length)) {
      return NOT_RECORDED
    }
    if (projectionVersion === 'legacy') {
      // legacy = 15 键冻结投影：purpose 两键不应出现，出现即形状不符。
      return NOT_RECORDED
    }
    if (!hasKeys) return NOT_RECORDED
  } else if (!hasKeys) {
    return NOT_RECORDED
  }
  return parseWorkPurposePair(row) ?? NOT_RECORDED
}

/** 目的值 → i18n 键（composer 选项/脚注共用同一组文案）。 */
export function workPurposeLabelKey(purpose: ResearchWorkPurpose): string {
  switch (purpose) {
    case 'document_qa':
      return 'research.target.composer.purpose.documentQa'
    case 'exploration':
      return 'research.target.composer.purpose.exploration'
    case 'writing':
      return 'research.target.composer.purpose.writing'
  }
}

/** 来源值 → i18n 键（explicit=你选择 / inferred=自动判断 / default_legacy=默认 / not_recorded=未记录）。 */
export function workPurposeSourceLabelKey(source: ResearchWorkPurposeSource): string {
  switch (source) {
    case 'explicit':
      return 'research.target.composer.purpose.sourceExplicit'
    case 'inferred':
      return 'research.target.composer.purpose.sourceInferred'
    case 'default_legacy':
      return 'research.target.composer.purpose.sourceDefaultLegacy'
    case 'not_recorded':
      return 'research.target.composer.purpose.sourceNotRecorded'
  }
}
