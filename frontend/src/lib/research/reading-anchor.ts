/**
 * 阅读锚点纯函数（RDLens #602 第三批 PR-4）。
 *
 * 规范来源：DESIGN §5.7.1（消息锚点）、§5.7.2（来源正文锚点）、§10.3
 * （reading-anchor 纯测试：正/负/零偏移、布局变化、缺失消息、失效）。
 *
 * 本模块只做数值语义，不接触 DOM、React 或网络：
 * - `measureChatAnchor` / `measureReaderAnchor` 根据容器与元素几何计算可持久化锚点；
 * - `restoreScrollTop` 按有符号偏移与目标当前位置反算 scrollTop；
 * - 失效以稳定原因返回，调用方据此展示 `position_unavailable`（§5.7.1/§5.7.2）。
 *
 * 所有几何值均为视口坐标（`getBoundingClientRect().top`），
 * 容器顶沿为 `containerTop`（视口坐标），偏移公式：
 * `offsetPx = targetTop − containerTop`（有符号，可为负，禁止钳成 0）。
 */

import type { WireChatAnchor, WireReaderAnchor } from './session-contract'

/** 有符号像素偏移的协议范围（§5.7.2 / INTERFACE_FREEZE parseInt32）。 */
export const ANCHOR_OFFSET_LIMIT = 2_147_483_647

/** 判定“贴近底部”的默认容差（§5.7.1 follow_tail）。 */
export const DEFAULT_TAIL_THRESHOLD_PX = 4

/** 恢复后允许的亚像素误差。 */
export const DEFAULT_RESTORE_TOLERANCE_PX = 1

/** 滚动容器的可测量几何。 */
export interface ScrollContainerMetrics {
  /** 容器内容区顶沿（视口坐标）。 */
  readonly containerTop: number
  readonly scrollTop: number
  readonly clientHeight: number
  readonly scrollHeight: number
}

/** 消息气泡几何（视口坐标）。 */
export interface MessageGeometry {
  readonly messageId: string
  readonly top: number
  readonly height: number
}

/** 消息锚点测量结果，可直接作为 `chat_anchor` 持久化。 */
export type ChatAnchorMeasurement = WireChatAnchor

/** 锚点恢复失败原因（对应 `position_unavailable`）。 */
export type AnchorRestoreFailure =
  | 'no_container'
  | 'missing_target'
  | 'invalid_offset'
  | 'out_of_range'

export type ScrollRestoreResult =
  | { readonly ok: true; readonly scrollTop: number; readonly clamped: boolean }
  | { readonly ok: false; readonly reason: AnchorRestoreFailure }

/** 来源正文身份（必须来自授权读取，§5.7.2）。 */
export interface ReaderAnchorIdentity {
  readonly sourceId: string
  readonly documentId: string
  readonly documentVersion: string
  /** 授权正文响应中的 `content_hash`；为 `null` 时不得造锚点。 */
  readonly contentHash: string | null
}

/** 来源正文 chunk 几何与定位信息。 */
export interface ReaderChunkGeometry {
  readonly chunkId: string | null
  readonly chunkOrdinal: number
  /** chunk 顶沿（视口坐标）。 */
  readonly top: number
  readonly pageIdx?: number | null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 协议允许的偏移：整数、有限、绝对值不超过 2^31-1。 */
export function isValidAnchorOffsetPx(value: unknown): value is number {
  return (
    isFiniteNumber(value) &&
    Number.isInteger(value) &&
    Math.abs(value) <= ANCHOR_OFFSET_LIMIT
  )
}

function isMeasurableContainer(container: ScrollContainerMetrics): boolean {
  return (
    isFiniteNumber(container.containerTop) &&
    isFiniteNumber(container.scrollTop) &&
    isFiniteNumber(container.clientHeight) &&
    isFiniteNumber(container.scrollHeight) &&
    container.clientHeight > 0 &&
    container.scrollHeight > 0
  )
}

/** 滚动容器当前是否贴近底部（§5.7.1 follow_tail 判定）。 */
export function isNearScrollTail(
  container: ScrollContainerMetrics,
  tailThresholdPx: number = DEFAULT_TAIL_THRESHOLD_PX,
): boolean {
  if (!isMeasurableContainer(container)) return false
  const remaining = container.scrollHeight - container.scrollTop - container.clientHeight
  return remaining <= Math.max(0, tailThresholdPx)
}

/**
 * 测量消息锚点（§5.7.1）。
 *
 * `message_id` 取“视口顶沿所在或最近的上一条消息”：在所有顶沿不低于容器顶沿的
 * 消息中取顶沿最靠下的那条；若没有任何消息在容器顶沿之上，则退化为第一条消息
 * （聊天区顶部留白/首条消息场景）。容器不可度量或没有消息时返回 `null`。
 */
export function measureChatAnchor(input: {
  readonly messages: readonly MessageGeometry[]
  readonly container: ScrollContainerMetrics
  readonly tailThresholdPx?: number
}): ChatAnchorMeasurement | null {
  const { messages, container } = input
  if (!isMeasurableContainer(container) || messages.length === 0) return null

  const ordered = messages
    .filter(
      message =>
        isFiniteNumber(message.top) &&
        isFiniteNumber(message.height) &&
        typeof message.messageId === 'string' &&
        message.messageId.length > 0,
    )
    .slice()
    .sort((a, b) => a.top - b.top)
  if (ordered.length === 0) return null

  const referenceTop = container.containerTop
  let target = ordered[0]
  for (const message of ordered) {
    if (message.top <= referenceTop) {
      target = message
      continue
    }
    break
  }

  const offsetPx = Math.round(target.top - container.containerTop)
  if (!isValidAnchorOffsetPx(offsetPx)) return null

  return {
    messageId: target.messageId,
    offsetPx,
    followTail: isNearScrollTail(container, input.tailThresholdPx),
  }
}

/** 一键会话消息候选：稳定 ID 缺失时只能用于几何，不可持久化（§5.7.1）。 */
export interface ChatAnchorCandidate extends MessageGeometry {
  /** 服务端消息 ID；`null`＝本地临时轮（live 未解析），不得写入 chat_anchor。 */
  readonly stableMessageId: string | null
}

/**
 * 从“含本地临时轮”的完整消息列表测量锚点（§5.7.1）。
 *
 * 真实 live 对话中 user 轮/未解析 assistant 轮没有稳定 `message_id`；此时
 * 向上回退到最近的稳定消息作为锚点目标（负偏移表达“目标在上方”），
 * 避免把临时 turn id 持久化。若视口内及其上方都没有稳定消息 → 返回 null，
 * 调用方保留内存位置。
 */
export function measureChatAnchorCandidates(input: {
  readonly messages: readonly ChatAnchorCandidate[]
  readonly container: ScrollContainerMetrics
  readonly tailThresholdPx?: number
}): WireChatAnchor | null {
  const container = input.container
  if (!isMeasurableContainer(container)) return null
  const ordered = input.messages
    .filter(message =>
      isFiniteNumber(message.top) &&
      isFiniteNumber(message.height) &&
      message.height > 0,
    )
    .slice()
    .sort((a, b) => a.top - b.top)
  if (ordered.length === 0) return null

  let targetIndex = 0
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].top <= container.containerTop) {
      targetIndex = index
    } else {
      break
    }
  }

  let target: ChatAnchorCandidate | null = null
  for (let index = targetIndex; index >= 0; index -= 1) {
    if (ordered[index].stableMessageId !== null) {
      target = ordered[index]
      break
    }
  }
  if (target === null) return null

  const offsetPx = Math.round(target.top - container.containerTop)
  if (!isValidAnchorOffsetPx(offsetPx)) return null

  return {
    messageId: target.stableMessageId ?? '',
    offsetPx,
    followTail: isNearScrollTail(container, input.tailThresholdPx),
  }
}

/**
 * 按有符号偏移恢复 scrollTop（§5.7.1）。
 *
 * `newScrollTop = currentScrollTop + (currentTargetTop − containerTop) − savedOffsetPx`
 *
 * - `followTail=true` 时滚到最新（maxScroll）；
 * - 负偏移原样参与计算，绝不钳成 0（长消息中部）；
 * - 目标缺失 / 容器不可度量 / 偏移非法 / 目标超出一个视口不可达 → 失败，
 *   调用方展示 `position_unavailable`；
 * - 仅在边界处少量裁剪时返回 `clamped: true`（仍属锚点附近恢复）。
 */
export function restoreScrollTop(input: {
  readonly container: ScrollContainerMetrics
  readonly savedOffsetPx: number
  /** 目标元素当前视口顶沿；目标不在已加载消息/正文中时传 `null`。 */
  readonly currentTargetTop: number | null
  readonly followTail?: boolean
  /** 可选：目标元素高度，用于判断越界后目标是否仍可落入视口。 */
  readonly targetHeightPx?: number
  readonly tolerancePx?: number
}): ScrollRestoreResult {
  const { container, savedOffsetPx } = input
  const tolerance = Math.max(0, input.tolerancePx ?? DEFAULT_RESTORE_TOLERANCE_PX)

  if (!isValidAnchorOffsetPx(savedOffsetPx)) {
    return { ok: false, reason: 'invalid_offset' }
  }
  if (!isMeasurableContainer(container) || container.clientHeight <= 0) {
    return { ok: false, reason: 'no_container' }
  }

  const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)

  if (input.followTail === true) {
    return { ok: true, scrollTop: maxScroll, clamped: false }
  }

  if (input.currentTargetTop === null || !isFiniteNumber(input.currentTargetTop)) {
    return { ok: false, reason: 'missing_target' }
  }

  const raw =
    container.scrollTop +
    (input.currentTargetTop - container.containerTop) -
    savedOffsetPx
  if (!Number.isFinite(raw)) {
    return { ok: false, reason: 'invalid_offset' }
  }

  // 目标超出一个视口不可达：即使滚到边界也无法把目标放入视口附近。
  const targetHeight = Math.max(0, input.targetHeightPx ?? 0)
  const viewport = container.clientHeight + targetHeight
  if (raw < -tolerance - viewport || raw > maxScroll + tolerance + viewport) {
    return { ok: false, reason: 'out_of_range' }
  }

  const clampedTop = Math.min(Math.max(raw, 0), maxScroll)
  const drift = Math.abs(clampedTop - raw)
  // 容器滚动范围不足：反算位置不可达（超出 tolerance 的裁剪）→ position_unavailable。
  if (drift > tolerance) {
    return { ok: false, reason: 'out_of_range' }
  }
  return {
    ok: true,
    scrollTop: Math.round(clampedTop),
    clamped: drift > 0,
  }
}

/**
 * 是否应当恢复来源正文锚点（§8.3：Citation 定位优先于旧阅读位置）。
 *
 * - 无已保存锚点 / 服务端已净化（`positionUnavailable`）→ 不恢复；
 * - 同次打开带 Citation 定位请求（`citationFocusRequestId !== undefined`）→
 *   跳过旧锚点，避免覆盖引用目标。
 */
export function shouldRestoreReaderAnchor(input: {
  readonly savedAnchor: WireReaderAnchor | null
  readonly citationFocusRequestId?: number
  readonly positionUnavailable?: boolean
}): boolean {
  if (input.savedAnchor === null) return false
  if (input.positionUnavailable === true) return false
  return input.citationFocusRequestId === undefined
}

/**
 * 测量来源正文锚点（§5.7.2）。
 *
 * `offsetPx = chunkTop − containerTop`，有符号；`content_hash` 为空、chunk 缺失或
 * 容器不可度量时返回 `null`（hash 为 null 时不得造锚点，阅读位置只保留内存）。
 */
export function measureReaderAnchor(input: {
  readonly identity: ReaderAnchorIdentity
  readonly container: ScrollContainerMetrics
  readonly chunk: ReaderChunkGeometry | null
}): WireReaderAnchor | null {
  const { identity, container, chunk } = input
  if (!isMeasurableContainer(container) || chunk === null) return null
  if (identity.contentHash === null || identity.contentHash.length === 0) return null
  if (!isFiniteNumber(chunk.top)) return null
  if (!Number.isInteger(chunk.chunkOrdinal) || chunk.chunkOrdinal < 0) return null

  const offsetPx = Math.round(chunk.top - container.containerTop)
  if (!isValidAnchorOffsetPx(offsetPx)) return null

  return {
    sourceId: identity.sourceId,
    documentId: identity.documentId,
    documentVersion: identity.documentVersion,
    format: 'normalized_markdown',
    chunkId: chunk.chunkId,
    chunkOrdinal: chunk.chunkOrdinal,
    contentHash: identity.contentHash,
    pageIdx: chunk.pageIdx ?? null,
    offsetPx,
  }
}

/**
 * 来源正文锚点是否仍可恢复：source/document/version/content_hash 全部一致，
 * 且当前读取的正文带有可校验 hash（§5.7.2）。
 */
export function readerAnchorMatches(
  identity: ReaderAnchorIdentity,
  saved: WireReaderAnchor | null | undefined,
): saved is WireReaderAnchor {
  if (saved === null || saved === undefined) return false
  if (identity.contentHash === null || identity.contentHash.length === 0) return false
  return (
    saved.sourceId === identity.sourceId &&
    saved.documentId === identity.documentId &&
    saved.documentVersion === identity.documentVersion &&
    saved.contentHash === identity.contentHash
  )
}
