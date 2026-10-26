/**
 * 阅读锚点纯函数测试（#602 第三批 PR-4，DESIGN §5.7、§10.3）。
 *
 * 覆盖 A1–A4（chat_anchor 测量/恢复/失效/尾部）与 A5–A6（reader_anchor 身份/测量）。
 * 这些是组件层接线之外唯一的数值语义来源，必须覆盖正/负/零偏移、布局变化、
 * 缺目标、非法偏移、容器不足与 follow_tail。
 */

import { describe, expect, it } from 'vitest'

import type { WireChatAnchor, WireReaderAnchor } from './session-contract'
import {
  ANCHOR_OFFSET_LIMIT,
  isValidAnchorOffsetPx,
  measureChatAnchor,
  measureChatAnchorCandidates,
  measureReaderAnchor,
  readerAnchorMatches,
  restoreScrollTop,
  shouldRestoreReaderAnchor,
  type MessageGeometry,
  type ScrollContainerMetrics,
} from './reading-anchor'

const CONTAINER: ScrollContainerMetrics = {
  containerTop: 100,
  scrollTop: 1_000,
  clientHeight: 400,
  scrollHeight: 2_000,
}

function message(messageId: string, top: number, height = 120): MessageGeometry {
  return { messageId, top, height }
}

describe('measureChatAnchor', () => {
  it('A1 选择视口顶沿所在消息并给出有符号偏移', () => {
    const anchor = measureChatAnchor({
      messages: [message('m1', -500), message('m2', 20), message('m3', 200)],
      container: CONTAINER,
    })

    expect(anchor).not.toBeNull()
    expect(anchor?.messageId).toBe('m2')
    // 20 - 100 = -80：消息顶沿在容器顶沿之上 80px，偏移必须保留负号
    expect(anchor?.offsetPx).toBe(-80)
    expect(anchor?.followTail).toBe(false)
  })

  it('A1 无消息跨越顶沿时退化为最近的上一条消息', () => {
    const anchor = measureChatAnchor({
      messages: [message('m1', 40), message('m2', 180), message('m3', 320)],
      container: CONTAINER,
    })

    expect(anchor?.messageId).toBe('m1')
    expect(anchor?.offsetPx).toBe(-60)
  })

  it('A1 全部消息都在顶沿之下时取第一条消息（正偏移）', () => {
    const anchor = measureChatAnchor({
      messages: [message('m1', 140), message('m2', 300)],
      container: CONTAINER,
    })

    expect(anchor?.messageId).toBe('m1')
    expect(anchor?.offsetPx).toBe(40)
  })

  it('A2 长消息中部：负偏移不被钳成 0，可与 scrollTop 往返', () => {
    const longMessageTop = -500
    const anchor = measureChatAnchor({
      messages: [message('long', longMessageTop, 1_200), message('m2', 700)],
      container: CONTAINER,
    })

    expect(anchor).not.toBeNull()
    expect(anchor?.messageId).toBe('long')
    expect(anchor?.offsetPx).toBe(-600)
    expect(anchor?.offsetPx).toBeLessThan(0)

    const restored = restoreScrollTop({
      container: CONTAINER,
      savedOffsetPx: anchor?.offsetPx ?? 0,
      currentTargetTop: longMessageTop,
    })
    expect(restored.ok).toBe(true)
    if (restored.ok) {
      expect(restored.scrollTop).toBe(CONTAINER.scrollTop)
      expect(restored.clamped).toBe(false)
    }
  })

  it('A4 贴近底部时 followTail=true，上滚后为 false', () => {
    const nearBottom = measureChatAnchor({
      messages: [message('m1', 200)],
      container: { ...CONTAINER, scrollTop: 1_597 },
    })
    expect(nearBottom?.followTail).toBe(true)

    const scrolledUp = measureChatAnchor({
      messages: [message('m1', 200)],
      container: { ...CONTAINER, scrollTop: 1_200 },
    })
    expect(scrolledUp?.followTail).toBe(false)
  })

  it('容器不可度量或没有消息时返回 null', () => {
    expect(
      measureChatAnchor({
        messages: [message('m1', 10)],
        container: { ...CONTAINER, clientHeight: 0 },
      }),
    ).toBeNull()
    expect(measureChatAnchor({ messages: [], container: CONTAINER })).toBeNull()
    expect(
      measureChatAnchor({ messages: [message('m1', 40)], container: { ...CONTAINER, scrollTop: 0 } }),
    ).not.toBeNull()
  })
})

describe('restoreScrollTop', () => {
  it('A2 按有符号偏移恢复：布局未变时回原位置', () => {
    const restored = restoreScrollTop({
      container: CONTAINER,
      savedOffsetPx: -600,
      currentTargetTop: -500,
    })

    expect(restored).toEqual({ ok: true, scrollTop: 1_000, clamped: false })
  })

  it('A2 布局变化时按差值修正（消息下移 50px）', () => {
    const restored = restoreScrollTop({
      container: CONTAINER,
      savedOffsetPx: -600,
      currentTargetTop: -450,
    })

    expect(restored.ok).toBe(true)
    if (restored.ok) {
      expect(restored.scrollTop).toBe(1_050)
    }
  })

  it('A2 正偏移恢复', () => {
    const restored = restoreScrollTop({
      container: CONTAINER,
      savedOffsetPx: 40,
      currentTargetTop: 140,
    })

    expect(restored).toEqual({ ok: true, scrollTop: 1_000, clamped: false })
  })

  it('A3 目标消息不存在 → position_unavailable(missing_target)', () => {
    const restored = restoreScrollTop({
      container: CONTAINER,
      savedOffsetPx: 40,
      currentTargetTop: null,
    })

    expect(restored).toEqual({ ok: false, reason: 'missing_target' })
  })

  it('A3 非法偏移（NaN / 超范围）→ invalid_offset，不当作 0', () => {
    const nan = restoreScrollTop({
      container: CONTAINER,
      savedOffsetPx: Number.NaN,
      currentTargetTop: 140,
    })
    expect(nan).toEqual({ ok: false, reason: 'invalid_offset' })

    const tooLarge = restoreScrollTop({
      container: CONTAINER,
      savedOffsetPx: ANCHOR_OFFSET_LIMIT + 1,
      currentTargetTop: 140,
    })
    expect(tooLarge).toEqual({ ok: false, reason: 'invalid_offset' })
  })

  it('A3 容器不可滚动/不可度量 → no_container', () => {
    const restored = restoreScrollTop({
      container: { ...CONTAINER, clientHeight: 0, scrollHeight: 0 },
      savedOffsetPx: 0,
      currentTargetTop: 140,
    })
    expect(restored).toEqual({ ok: false, reason: 'no_container' })
  })

  it('A3 滚动范围不足以到达目标 → out_of_range', () => {
    const restored = restoreScrollTop({
      container: {
        containerTop: 100,
        scrollTop: 0,
        clientHeight: 400,
        scrollHeight: 400,
      },
      savedOffsetPx: 1_000,
      currentTargetTop: 100,
    })
    expect(restored).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('A3 容器滚动范围不足（超出 tolerance 的边界裁剪）→ out_of_range / position_unavailable', () => {
    const restored = restoreScrollTop({
      container: { containerTop: 100, scrollTop: 0, clientHeight: 400, scrollHeight: 900 },
      savedOffsetPx: 10,
      currentTargetTop: -200,
    })
    // raw = 0 + (-300) - 10 = -310 → 上边界只能到 0，偏差 310px 不可达（§5.7.1）
    expect(restored).toEqual({ ok: false, reason: 'out_of_range' })
  })

  it('A3 亚像素边界裁剪在 tolerance 内仍视为恢复成功', () => {
    const nearBoundary = restoreScrollTop({
      container: { containerTop: 100, scrollTop: 0, clientHeight: 400, scrollHeight: 900 },
      savedOffsetPx: 10,
      // raw = 0 + (109.5 − 100) − 10 = −0.5 → 裁剪到 0，偏差 0.5px ≤ 1px tolerance
      currentTargetTop: 109.5,
    })
    expect(nearBoundary).toEqual({ ok: true, scrollTop: 0, clamped: true })
  })

  it('A4 followTail 恢复到底部', () => {
    const restored = restoreScrollTop({
      container: CONTAINER,
      savedOffsetPx: -600,
      currentTargetTop: -500,
      followTail: true,
    })

    expect(restored).toEqual({ ok: true, scrollTop: 1_600, clamped: false })
  })
})

describe('measureReaderAnchor / readerAnchorMatches', () => {
  const baseIdentity = {
    sourceId: 'src-1',
    documentId: 'doc-1',
    documentVersion: 'v3',
    contentHash: 'hash-abc',
  }

  it('A5 以 chunk 顶沿测量有符号偏移并携带身份', () => {
    const anchor = measureReaderAnchor({
      identity: baseIdentity,
      container: { containerTop: 60, scrollTop: 500, clientHeight: 700, scrollHeight: 3_000 },
      chunk: { chunkId: 'chunk-7', chunkOrdinal: 7, top: 260, pageIdx: 3 },
    })

    expect(anchor).not.toBeNull()
    expect(anchor?.sourceId).toBe('src-1')
    expect(anchor?.documentId).toBe('doc-1')
    expect(anchor?.documentVersion).toBe('v3')
    expect(anchor?.contentHash).toBe('hash-abc')
    expect(anchor?.chunkId).toBe('chunk-7')
    expect(anchor?.chunkOrdinal).toBe(7)
    expect(anchor?.pageIdx).toBe(3)
    expect(anchor?.offsetPx).toBe(200)
    expect(anchor?.format).toBe('normalized_markdown')
  })

  it('A5 chunk 顶沿在容器之上时为负偏移', () => {
    const anchor = measureReaderAnchor({
      identity: baseIdentity,
      container: { containerTop: 60, scrollTop: 500, clientHeight: 700, scrollHeight: 3_000 },
      chunk: { chunkId: null, chunkOrdinal: 2, top: -240, pageIdx: null },
    })

    expect(anchor?.offsetPx).toBe(-300)
    expect(anchor?.chunkId).toBeNull()
    expect(anchor?.chunkOrdinal).toBe(2)
  })

  it('A5 content_hash 为空或 chunk 缺失时不得造锚点', () => {
    expect(
      measureReaderAnchor({
        identity: { ...baseIdentity, contentHash: null },
        container: { containerTop: 60, scrollTop: 0, clientHeight: 700, scrollHeight: 3_000 },
        chunk: { chunkId: 'chunk-1', chunkOrdinal: 1, top: 10, pageIdx: null },
      }),
    ).toBeNull()

    expect(
      measureReaderAnchor({
        identity: baseIdentity,
        container: { containerTop: 60, scrollTop: 0, clientHeight: 700, scrollHeight: 3_000 },
        chunk: null,
      }),
    ).toBeNull()
  })

  it('A6 身份匹配要求 source/document/version/hash 全部一致', () => {
    const saved: WireReaderAnchor = {
      sourceId: 'src-1',
      documentId: 'doc-1',
      documentVersion: 'v3',
      format: 'normalized_markdown',
      chunkId: 'chunk-7',
      chunkOrdinal: 7,
      contentHash: 'hash-abc',
      pageIdx: 3,
      offsetPx: 200,
    }

    expect(readerAnchorMatches(baseIdentity, saved)).toBe(true)
    expect(readerAnchorMatches({ ...baseIdentity, documentVersion: 'v4' }, saved)).toBe(false)
    expect(readerAnchorMatches({ ...baseIdentity, contentHash: 'hash-other' }, saved)).toBe(false)
    expect(readerAnchorMatches({ ...baseIdentity, documentId: 'doc-2' }, saved)).toBe(false)
    expect(readerAnchorMatches({ ...baseIdentity, sourceId: 'src-2' }, saved)).toBe(false)
    expect(readerAnchorMatches({ ...baseIdentity, contentHash: null }, saved)).toBe(false)
  })
})

describe('isValidAnchorOffsetPx', () => {
  it('接受整数有符号像素并拒绝越界/非整数', () => {
    expect(isValidAnchorOffsetPx(0)).toBe(true)
    expect(isValidAnchorOffsetPx(-600)).toBe(true)
    expect(isValidAnchorOffsetPx(ANCHOR_OFFSET_LIMIT)).toBe(true)
    expect(isValidAnchorOffsetPx(ANCHOR_OFFSET_LIMIT + 1)).toBe(false)
    expect(isValidAnchorOffsetPx(1.5)).toBe(false)
    expect(isValidAnchorOffsetPx(Number.NaN)).toBe(false)
  })
})

describe('chat_anchor wire 形状', () => {
  it('测量结果可直接作为 WireChatAnchor 使用', () => {
    const anchor = measureChatAnchor({
      messages: [message('m1', 120)],
      container: CONTAINER,
    })
    const wire: WireChatAnchor | null = anchor === null ? null : { ...anchor }
    expect(wire).toEqual({ messageId: 'm1', offsetPx: 20, followTail: false })
  })

  it('D10 Citation 定位优先：同次打开带 focusRequestId 时不恢复旧锚点', () => {
    const readerSaved: WireReaderAnchor = {
      sourceId: 'src-1',
      documentId: 'doc-1',
      documentVersion: 'v3',
      format: 'normalized_markdown' as const,
      chunkId: 'c1',
      chunkOrdinal: 0,
      contentHash: 'h1',
      pageIdx: null,
      offsetPx: 12,
    }
    expect(shouldRestoreReaderAnchor({ savedAnchor: readerSaved })).toBe(true)
    expect(
      shouldRestoreReaderAnchor({ savedAnchor: readerSaved, citationFocusRequestId: 3 }),
    ).toBe(false)
    expect(
      shouldRestoreReaderAnchor({ savedAnchor: readerSaved, positionUnavailable: true }),
    ).toBe(false)
    expect(shouldRestoreReaderAnchor({ savedAnchor: null })).toBe(false)
  })

  it('D11 live 轮无稳定 ID 时回退到最近的稳定消息（负偏移，不持久化临时 ID）', () => {
    const container: ScrollContainerMetrics = {
      containerTop: 100,
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 2000,
    }
    const anchor = measureChatAnchorCandidates({
      container,
      messages: [
        { messageId: 'msg-a', stableMessageId: 'msg-a', top: -50, height: 80 },
        { messageId: '', stableMessageId: null, top: 30, height: 60 },
      ],
    })
    // 视口顶沿落在本地临时 user 轮上 → 锚点回退到其上方稳定消息，offset 为负
    expect(anchor).toEqual({ messageId: 'msg-a', offsetPx: -150, followTail: false })
  })

  it('D12 视口内及上方都没有稳定消息时不写入锚点（保留内存位置）', () => {
    const anchor = measureChatAnchorCandidates({
      container: { containerTop: 100, scrollTop: 0, clientHeight: 400, scrollHeight: 2000 },
      messages: [
        { messageId: '', stableMessageId: null, top: 120, height: 60 },
        { messageId: '', stableMessageId: null, top: 200, height: 60 },
      ],
    })
    expect(anchor).toBeNull()
  })
})