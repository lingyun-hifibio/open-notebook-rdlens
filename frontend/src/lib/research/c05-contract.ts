/**
 * Issue #601 PR5：C-05 范围契约的**前端消费层**（契约解析、能力门禁、请求头）。
 *
 * 权威接口：`fixtures/issue615_c05/schemas.json`（v8 计划 §2.1）；
 * 消费纪律：#615 交接文档 §3.3——整条声明形状不符一律按**不可用**处理，
 * 不做字段级降级；`scope_modes` 非空 ≠ 可执行；只映射服务端
 * `unavailable_reason`（不建前端 fallback 表）；`preview` 不属于
 * `entries`（用顶层 `preview_supported` 单独表达，D-07）。
 *
 * 本 PR5 内 `ai_insight` 即使服务端声明 execution_ready 也**不启用** C-05
 * （本地原因码 `c05_entry_pending_pr4`，D-09——该入口的空范围守卫/响应头
 * 断言/attempt 机制需要成套改造，属 PR4 交付项）。
 */

import contractSchemas from './fixtures/issue615_c05/schemas.json'
import contractSamples from './fixtures/issue615_c05/samples.json'

/** C-05 范围模式（服务端 `SCOPE_MODES` 顺序一致） */
export type C05ScopeMode = 'all' | 'selected' | 'single'

/** C-05 生成入口（服务端 `C05_ENTRIES` 同序；PR5 不接 `ai_insight`） */
export type C05Entry =
  | 'search' | 'chat' | 'coverage' | 'compare' | 'ai_insight' | 'transformation'

/** C-05 逐入口能力声明（`c05_entry_capability` schema） */
export interface C05EntryCapability {
  scope_modes: C05ScopeMode[]
  execution_modes: string[]
  context_levels: string[]
  preview_supported: boolean
  execution_ready: boolean
  unavailable_reason: string | null
}

/** C-05 能力块（`c05_capabilities` schema） */
export interface C05Capabilities {
  contract: 'c05-v1'
  enabled: boolean
  preview_supported: boolean
  entries: Record<C05Entry, C05EntryCapability>
}

/** PR5 本地原因码：入口尚未由本 PR 启用（不冒充服务端码，D-09） */
export const C05_ENTRY_PENDING_PR4 = 'c05_entry_pending_pr4'

/** 服务端声明过、但 PR5 不接的入口 */
export const PR5_DISABLED_ENTRIES: ReadonlySet<C05Entry> = new Set(['ai_insight'])

export const C05_CONTRACT_HEADER = 'X-Research-Contract'
export const C05_CONTRACT_VALUE = 'c05-v1'
export const C05_ENTRY_ORDER: readonly C05Entry[] = [
  'search', 'chat', 'coverage', 'compare', 'ai_insight', 'transformation',
]

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function unavailableEntry(reason: string): C05EntryCapability {
  return {
    scope_modes: [],
    execution_modes: [],
    context_levels: [],
    preview_supported: false,
    execution_ready: false,
    unavailable_reason: reason,
  }
}

/**
 * 解析**单个**入口声明。整条形状不符 → `c05_entry_not_declared`（镜像主仓
 * `readEntryCapability`：只检查 `execution_ready` 会让畸形声明被当成就绪）。
 */
function readEntryCapability(candidate: unknown): C05EntryCapability {
  if (typeof candidate !== 'object' || candidate === null) {
    return unavailableEntry('c05_entry_not_declared')
  }
  const cap = candidate as Record<string, unknown>
  const wellFormed =
    typeof cap.execution_ready === 'boolean'
    && typeof cap.preview_supported === 'boolean'
    && isStringArray(cap.scope_modes)
    && isStringArray(cap.execution_modes)
    && isStringArray(cap.context_levels)
    && (cap.unavailable_reason === null || typeof cap.unavailable_reason === 'string')
  if (!wellFormed) return unavailableEntry('c05_entry_not_declared')
  // 纪律：未接线的入口不得宣称 execution_modes/context_levels（主仓 builder
  // 保证；这里防御性归一，防畸形声明流入 UI 门禁）
  const executionReady = cap.execution_ready === true
  return {
    scope_modes: cap.scope_modes as C05ScopeMode[],
    execution_modes: executionReady ? (cap.execution_modes as string[]) : [],
    context_levels: executionReady ? (cap.context_levels as string[]) : [],
    preview_supported: cap.preview_supported === true,
    execution_ready: executionReady,
    unavailable_reason: cap.unavailable_reason as string | null,
  }
}

/**
 * 解析 `/models`（或 bootstrap）响应中的加性 `capabilities.c05`。
 * 缺失/畸形 → `null`（调用方按不可用处理，不得据此降级旧契约）。
 */
export function readC05Capabilities(candidate: unknown): C05Capabilities | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const cap = candidate as Record<string, unknown>
  if (cap.contract !== C05_CONTRACT_VALUE) return null
  if (typeof cap.enabled !== 'boolean' || typeof cap.preview_supported !== 'boolean') {
    return null
  }
  if (typeof cap.entries !== 'object' || cap.entries === null) return null
  const rawEntries = cap.entries as Record<string, unknown>
  const entries = {} as Record<C05Entry, C05EntryCapability>
  for (const entry of C05_ENTRY_ORDER) {
    entries[entry] = readEntryCapability(rawEntries[entry])
  }
  return {
    contract: 'c05-v1',
    enabled: cap.enabled,
    preview_supported: cap.preview_supported === true,
    entries,
  }
}

/** 该入口的 C-05 请求是否可由本 PR 发出（能力就绪 + 未被 PR5 主动禁用） */
export function entryDispatchReady(
  caps: C05Capabilities | null,
  entry: C05Entry,
): boolean {
  if (!caps || !caps.enabled) return false
  const decl = caps.entries[entry]
  if (!decl || !decl.execution_ready) return false
  return !PR5_DISABLED_ENTRIES.has(entry)
}

/** 入口不可用的稳定原因码（服务端码直传；本地禁用用本地码） */
export function entryUnavailableReason(
  caps: C05Capabilities | null,
  entry: C05Entry,
): string {
  if (!caps || !caps.enabled) return 'c05_contract_disabled'
  const decl = caps.entries[entry]
  if (!decl) return 'c05_entry_not_declared'
  if (decl.execution_ready && PR5_DISABLED_ENTRIES.has(entry)) {
    return C05_ENTRY_PENDING_PR4
  }
  if (!decl.execution_ready) return decl.unavailable_reason ?? 'c05_entry_not_wired'
  return ''
}

/** 该入口在该模式下是否被契约支持（`scope_modes` 非空 ≠ 可执行，但模式仍需被声明） */
export function entrySupportsMode(
  caps: C05Capabilities | null,
  entry: C05Entry,
  mode: C05ScopeMode,
): boolean {
  if (!caps || !caps.enabled) return false
  const decl = caps.entries[entry]
  if (!decl) return false
  return decl.scope_modes.includes(mode)
}

/** C-05 请求头的判定（与响应头无关——响应头恒 `v1`，见 v8 §2.1） */
export function c05RequestHeaders(): Record<string, string> {
  return { [C05_CONTRACT_HEADER]: C05_CONTRACT_VALUE }
}

/** fixtures 直接导出，供测试与消费方共享同一份契约数据 */
export const C05_CONTRACT_SCHEMAS = contractSchemas
export const C05_CONTRACT_SAMPLES = contractSamples
