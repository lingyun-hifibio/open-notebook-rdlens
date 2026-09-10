/**
 * Issue #54 S3（FR-03/FR-04）：AI Insight 的风险标记存储与冻结 attempt。
 *
 * 为什么需要 marker：AI Insight 是「可能已外发但结果未知」的操作。若浏览器
 * 在请求途中崩溃/断网，用户再进来时**必须先看到风险提示**，而不是静默重发
 * ——静默重发可能造成第二次付费外发或重复 Insight。
 *
 * 契约（实施计划 S3）：
 * - 每次尝试一个独立 marker：`rdlens.research.ai-insight-risk.v1/{user}/
 *   {project}/{attemptId}`；值只含 `version/markerId/kind/recordedAt`，
 *   绝不保存正文、Scope 或幂等 key（本地存储不是审计面）。
 * - 写入失败 → 调用方不得发送请求（没有 marker = 无法在崩溃后提醒用户）。
 * - 每个请求只清除自己的 marker（多标签页互不误删）。
 * - 同 key 重试只允许 key 单调年龄 <24h（Host 幂等窗口）；到边界后必须按
 *   重复风险重新确认并使用新 key，旧 key 永不再发送。
 *
 * 多标签页同步由 UI 层监听 `storage` 事件后重新 `listAiInsightRiskMarkers`
 * 完成（本模块只做无状态读写，不注册监听器，便于测试与卸载）。
 */

const MARKER_PREFIX = 'rdlens.research.ai-insight-risk.v1'
const MARKER_VERSION = 1

/** Host 幂等窗口：同 key 只在此年龄内可重放。 */
export const AI_INSIGHT_KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type AiInsightRiskKind = 'fresh' | 'recovery'

export interface AiInsightRiskMarker {
  markerId: string
  kind: AiInsightRiskKind
  recordedAt: number
}

export interface AiInsightAttempt<Request = unknown> {
  attemptId: string
  idempotencyKey: string
  request: Request
  /** 单调时刻（performance.now 或注入 now）——用于 key 年龄，不受墙钟漂移影响 */
  startedAt: number
}

interface StorageOptions {
  storage?: Storage | undefined
  now?: () => number
}

function resolveStorage(options: StorageOptions): Storage | null {
  if (options.storage !== undefined) return options.storage ?? null
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * 单调时钟：只用于 key 年龄（`attemptKeyAgeMs`）——同文档内不受墙钟漂移影响。
 */
function resolveNow(options: { now?: () => number }): number {
  if (options.now !== undefined) return options.now()
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * 墙钟：marker 的 `recordedAt` 必须用它。单调时钟每次文档加载从 ~0 重新开始，
 * 持久化后跨页面比较毫无意义，还会让 `listAiInsightRiskMarkers` 的排序错乱
 * （hook 取 `markers[0]` 作为待确认 marker）。
 */
function resolveWallClock(options: { now?: () => number }): number {
  return options.now !== undefined ? options.now() : Date.now()
}

/** marker 的 localStorage 键（user/project/attemptId 全部 URI 编码，防路径碰撞）。 */
export function aiInsightRiskMarkerKey(userId: string, projectId: string, attemptId: string): string {
  return [
    MARKER_PREFIX,
    encodeURIComponent(userId),
    encodeURIComponent(projectId),
    encodeURIComponent(attemptId),
  ].join('/')
}

/** 解析单个 marker 值；畸形/版本不符/缺字段一律 null（忽略，不猜）。 */
export function decodeAiInsightRiskMarker(raw: string | null): AiInsightRiskMarker | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.version !== MARKER_VERSION) return null
  const markerId = record.markerId
  const kind = record.kind
  const recordedAt = record.recordedAt
  if (typeof markerId !== 'string' || markerId.length === 0) return null
  if (kind !== 'fresh' && kind !== 'recovery') return null
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return null
  return { markerId, kind, recordedAt }
}

/**
 * 写入本次尝试的 marker。返回 false = 未写入（storage 不可用/抛错），
 * 调用方必须据此放弃发送请求。
 */
export function markAiInsightAttempt(
  userId: string,
  projectId: string,
  attemptId: string,
  kind: AiInsightRiskKind,
  options: StorageOptions = {},
): boolean {
  const storage = resolveStorage(options)
  if (storage === null) return false
  const value = {
    version: MARKER_VERSION,
    markerId: attemptId,
    kind,
    recordedAt: resolveWallClock(options),
  }
  try {
    storage.setItem(aiInsightRiskMarkerKey(userId, projectId, attemptId), JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** 清除指定 marker（只清自己的）。返回 false = 未清除（storage 抛错）。 */
export function clearAiInsightRiskMarker(
  userId: string,
  projectId: string,
  attemptId: string,
  options: StorageOptions = {},
): boolean {
  const storage = resolveStorage(options)
  if (storage === null) return false
  try {
    storage.removeItem(aiInsightRiskMarkerKey(userId, projectId, attemptId))
    return true
  } catch {
    return false
  }
}

/**
 * 批量清除指定 markerId（只作用于本 user/project 命名空间）。
 * 用途：用户已确认承担重复风险的旧 marker，在本轮新执行写入成功后清除
 * （计划 S3 失败路径「新执行写入自己的 marker 成功后，才清除用户已确认
 * 承担风险的旧 marker」）。返回未能清除的 id 数。
 */
export function clearAcknowledgedRiskMarkers(
  userId: string,
  projectId: string,
  markerIds: readonly string[],
  options: StorageOptions = {},
): number {
  let failed = 0
  for (const id of markerIds) {
    if (!clearAiInsightRiskMarker(userId, projectId, id, options)) failed += 1
  }
  return failed
}

/**
 * 列出当前 user/project 的全部有效 marker（按 recordedAt 升序，同刻按 id）。
 * 严格前缀 + 严格解析：他项目/他用户/其他命名空间的键不会混入。
 */
export function listAiInsightRiskMarkers(
  userId: string,
  projectId: string,
  options: StorageOptions = {},
): AiInsightRiskMarker[] {
  const storage = resolveStorage(options)
  if (storage === null) return []
  const prefix = `${MARKER_PREFIX}/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/`
  const markers: AiInsightRiskMarker[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || !key.startsWith(prefix)) continue
      const marker = decodeAiInsightRiskMarker(storage.getItem(key))
      if (marker !== null) markers.push(marker)
    }
  } catch {
    return markers
  }
  return markers.sort((a, b) =>
    a.recordedAt === b.recordedAt
      ? a.markerId.localeCompare(b.markerId)
      : a.recordedAt - b.recordedAt,
  )
}

/** 冻结一次尝试：request/key/attemptId 与单调起始时刻（同 key 重试复用同一 request）。 */
export function buildAiInsightAttempt<Request>(
  request: Request,
  options: { id: string; key: string; now?: () => number },
): AiInsightAttempt<Request> {
  return {
    attemptId: options.id,
    idempotencyKey: options.key,
    request,
    startedAt: resolveNow({ now: options.now }),
  }
}

/**
 * disposition → marker 生命周期动作（实施计划 S3「合法 200/202 清 marker；
 * terminal 清 marker；retry_same_key/outcome_unknown/protocol_conflict 保留或
 * 升级 marker」）。
 *
 * - `clear`：已知终局（成功 200/202 或确定性失败）→ 清除本次尝试的 marker。
 * - `keep`：结果未知或可同 key 重试 → 保留 marker（崩溃后用户仍能看到风险）。
 * - `escalate`：协议冲突（无法解释的 409/幂等冲突）→ 保留并升级为需要人工
 *   确认的恢复态，禁止自动重发。
 * - `clear_and_refresh_consent`：consent 失效 → 清本次 marker、刷新 consent；
 *   用户重新确认后用**新 key**。
 */
export type AiInsightMarkerAction = 'clear' | 'keep' | 'escalate' | 'clear_and_refresh_consent'

export function markerActionForDisposition(
  disposition: 'outcome_unknown' | 'retry_same_key' | 'terminal' | 'consent_invalid' | 'protocol_conflict',
): AiInsightMarkerAction {
  switch (disposition) {
    case 'terminal':
      return 'clear'
    case 'retry_same_key':
    case 'outcome_unknown':
      return 'keep'
    case 'protocol_conflict':
      return 'escalate'
    case 'consent_invalid':
      return 'clear_and_refresh_consent'
  }
}

/** key 单调年龄（毫秒）；时钟回拨（当前 < 起始）按 0 处理，不产生负值。 */
export function attemptKeyAgeMs(attempt: AiInsightAttempt<unknown>, now: number): number {
  return Math.max(0, now - attempt.startedAt)
}

/** 同 key 是否仍在 Host 幂等窗口内（严格 `<24h`；到边界起禁止）。 */
export function isAiInsightKeyRetryable(attempt: AiInsightAttempt<unknown>, now: number): boolean {
  return attemptKeyAgeMs(attempt, now) < AI_INSIGHT_KEY_MAX_AGE_MS
}
