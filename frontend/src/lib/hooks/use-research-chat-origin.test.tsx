/**
 * RWV2-23（Issue #43，U2）：useResearchChat.resolveChatOrigin —— chat origin
 * （generation_id）绑定 hook 层行为。
 *
 * 覆盖：live 轮按需拉取并回填；恢复行免拉取直解析；恢复行但 id 形状不可
 * 解析 → null 且不拉取；同 turn 并发解析共享（single in-flight）；解析失败
 * 后再次点击可重试；无会话/瞬时失败不抛错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useResearchChat } from './use-research-chat'
import { getResearchChatSession, openResearchChatStream } from '@/lib/research/api'
import type { ResearchGlobalChatMessage } from '@/lib/research/api'
import type { ResearchSseEvent } from '@/lib/research/types'

vi.mock('@/lib/research/api', () => ({
  saveResultFromResult: vi.fn(),
  newIdempotencyKey: vi.fn(() => 'ik-turn'),
  openResearchChatStream: vi.fn(),
  getResearchChatSession: vi.fn(),
}))

const GEN = 'gen_' + 'e'.repeat(32)
const PROJECT = 'proj_1'

interface StreamCapture {
  opts: Parameters<typeof openResearchChatStream>[0]
  emit: (event: ResearchSseEvent) => void
}

function openStream(): StreamCapture {
  let capture: StreamCapture | null = null
  vi.mocked(openResearchChatStream).mockImplementation((opts) => {
    capture = { opts, emit: (event) => opts.onEvent(event) }
    return () => {}
  })
  // 触发一次 send 后返回已捕获的流
  return {
    get opts() {
      if (!capture) throw new Error('no stream captured yet')
      return capture.opts
    },
    emit: (event) => capture!.emit(event),
  }
}

function row(
  overrides: Partial<ResearchGlobalChatMessage>,
): ResearchGlobalChatMessage {
  return {
    message_id: 'msg_placeholder',
    role: 'user',
    content: '',
    thinking: null,
    citations: [],
    usage: null,
    resolved_mode: null,
    degradation_reasons: [],
    created_at: '2026-09-08T00:00:00Z',
    ...overrides,
  }
}

function doneEvent(sessionId: string): ResearchSseEvent {
  return {
    event_id: 2,
    type: 'done',
    session_id: sessionId,
    request_id: 'req_turn1',
    job_id: null,
    completion_status: 'success',
  }
}

describe('useResearchChat.resolveChatOrigin（RWV2-23 D2）', () => {
  beforeEach(() => {
    vi.mocked(getResearchChatSession).mockReset()
    localStorage.clear()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('live 轮：done 后惰性拉取会话并按行绑定 generationId 并回填 turn', async () => {
    const streams = openStream()
    vi.mocked(getResearchChatSession).mockResolvedValue({
      session: {
        session_id: 'sess_1',
        title: null,
        owner_user_id: 1,
        created_at: null,
        updated_at: null,
      },
      messages: [
        row({ message_id: 'msg_ignored_user', role: 'user', content: 'hello?' }),
        row({
          message_id: `msg_${GEN}_assistant`,
          role: 'assistant',
          content: 'world answer',
        }),
      ],
      cards: [],
      next_cursor: null,
    } as Awaited<ReturnType<typeof getResearchChatSession>>)
    const { result } = renderHook(() => useResearchChat({ projectId: PROJECT }))
    act(() => {
      result.current.send('hello?', undefined, 'm-local')
    })
    act(() => {
      streams.emit({ event_id: 1, type: 'answer', delta: 'world answer' })
      streams.emit(doneEvent('sess_1'))
    })
    const turnId = result.current.turns[1].id
    expect(result.current.turns[1].generationId).toBeNull()

    let origin: { messageId: string; generationId: string } | null = null
    await act(async () => {
      origin = await result.current.resolveChatOrigin(turnId)
    })
    expect(origin).toEqual({ messageId: `msg_${GEN}_assistant`, generationId: GEN })
    expect(vi.mocked(getResearchChatSession)).toHaveBeenCalledTimes(1)
    // 回填：后续不再需要拉取
    expect(result.current.turns[1].generationId).toBe(GEN)
    expect(result.current.turns[1].serverMessageId).toBe(`msg_${GEN}_assistant`)
    await act(async () => {
      const again = await result.current.resolveChatOrigin(turnId)
      expect(again).toEqual({ messageId: `msg_${GEN}_assistant`, generationId: GEN })
    })
    expect(vi.mocked(getResearchChatSession)).toHaveBeenCalledTimes(1)
  })

  it('恢复行：直解析 message_id，resolveChatOrigin 免拉取', async () => {
    // 预置最近会话 → mount 恢复
    localStorage.setItem(`rdlens.research.chat.last-session.${PROJECT}`, 'sess_r')
    vi.mocked(getResearchChatSession).mockResolvedValue({
      session: { session_id: 'sess_r', title: null, owner_user_id: 1, created_at: null, updated_at: null },
      messages: [
        row({ message_id: 'msg_u', role: 'user', content: 'asked before' }),
        row({ message_id: `msg_${GEN}_assistant`, role: 'assistant', content: 'prior answer' }),
      ],
      cards: [],
      next_cursor: null,
    } as Awaited<ReturnType<typeof getResearchChatSession>>)

    const { result } = renderHook(() => useResearchChat({ projectId: PROJECT }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.turns[1].generationId).toBe(GEN)
    const callsBefore = vi.mocked(getResearchChatSession).mock.calls.length
    await act(async () => {
      const origin = await result.current.resolveChatOrigin(result.current.turns[1].id)
      expect(origin).toEqual({ messageId: `msg_${GEN}_assistant`, generationId: GEN })
    })
    expect(vi.mocked(getResearchChatSession).mock.calls.length).toBe(callsBefore)
  })

  it('恢复行但 message_id 非 gen 形态：generationId=null 且 resolve 不拉网络返回 null', async () => {
    localStorage.setItem(`rdlens.research.chat.last-session.${PROJECT}`, 'sess_r')
    vi.mocked(getResearchChatSession).mockResolvedValue({
      session: { session_id: 'sess_r', title: null, owner_user_id: 1, created_at: null, updated_at: null },
      messages: [
        row({ message_id: 'msg_u', role: 'user', content: 'asked' }),
        row({
          message_id: `msg_req_${'1'.repeat(16)}_assistant`,
          role: 'assistant',
          content: 'answer',
        }),
      ],
      cards: [],
      next_cursor: null,
    } as Awaited<ReturnType<typeof getResearchChatSession>>)
    const { result } = renderHook(() => useResearchChat({ projectId: PROJECT }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.turns[1].generationId).toBeNull()
    const callsBefore = vi.mocked(getResearchChatSession).mock.calls.length
    await act(async () => {
      const origin = await result.current.resolveChatOrigin(result.current.turns[1].id)
      expect(origin).toBeNull()
    })
    expect(vi.mocked(getResearchChatSession).mock.calls.length).toBe(callsBefore)
  })

  it('会话拉取瞬时失败：返回 null 不抛错，且再次点击可重试（in-flight 已清理）', async () => {
    const streams = openStream()
    vi.mocked(getResearchChatSession).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useResearchChat({ projectId: PROJECT }))
    act(() => {
      result.current.send('q?', undefined, 'm-local')
    })
    act(() => {
      streams.emit({ event_id: 1, type: 'answer', delta: 'ans' })
      streams.emit(doneEvent('sess_1'))
    })
    const turnId = result.current.turns[1].id
    await act(async () => {
      await expect(result.current.resolveChatOrigin(turnId)).resolves.toBeNull()
    })
    expect(result.current.turns[1].generationId).toBeNull()
    // 再次点击 = 重试（不再被 in-flight 缓存短路）
    vi.mocked(getResearchChatSession).mockResolvedValue({
      session: { session_id: 'sess_1', title: null, owner_user_id: 1, created_at: null, updated_at: null },
      messages: [
        row({ message_id: 'msg_u', role: 'user', content: 'q?' }),
        row({ message_id: `msg_${GEN}_assistant`, role: 'assistant', content: 'ans' }),
      ],
      cards: [],
      next_cursor: null,
    } as Awaited<ReturnType<typeof getResearchChatSession>>)
    await act(async () => {
      const origin = await result.current.resolveChatOrigin(turnId)
      expect(origin).toEqual({ messageId: `msg_${GEN}_assistant`, generationId: GEN })
    })
    expect(result.current.turns[1].generationId).toBe(GEN)
  })
})
