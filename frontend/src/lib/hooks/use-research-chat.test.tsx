import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResearchChat, MAX_STREAM_ATTEMPTS } from './use-research-chat'
import { getExecutionPreferences, openResearchChatStream } from '@/lib/research/api'
import type { ResearchSseEvent } from '@/lib/research/types'

// UI-03 Red：Chat SSE 流状态机（契约 v0 §9）——乱序/重复事件经由 reducer
// 去重排序、断线自动按 event_id 重连（Last-Event-ID）、终态恰好一次、
// 409 resume_after 重试、错误码可重试标记。
// #238：send 前异步读取执行偏好→显式透传 model_id（v1 契约）；无偏好阻止。

vi.mock('@/lib/research/api', () => ({
  getExecutionPreferences: vi.fn(),
  newIdempotencyKey: vi.fn(() => 'ik-turn'),
  openResearchChatStream: vi.fn(),
}))

interface StreamCapture {
  opts: Parameters<typeof openResearchChatStream>[0]
  emit: (event: ResearchSseEvent) => void
  fail: (error: Error) => void
  httpFail: (status: number, body?: unknown) => void
}

function openCapture(): StreamCapture[] {
  const streams: StreamCapture[] = []
  vi.mocked(openResearchChatStream).mockImplementation((opts) => {
    streams.push({
      opts,
      emit: (event) => opts.onEvent(event),
      fail: (error) => opts.onNetworkError?.(error),
      httpFail: (status, body) => opts.onHttpError?.(status, body),
    })
    return () => {}
  })
  return streams
}

function ev(event_id: number, type: ResearchSseEvent['type'], extra: Partial<ResearchSseEvent> = {}): ResearchSseEvent {
  return { event_id, type, ...extra }
}

function lastAssistant(turns: ReturnType<typeof useResearchChat> extends { turns: infer T } ? T : never) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'assistant') return turns[i]
  }
  throw new Error('no assistant turn')
}

/** send + 冲刷偏好读取微任务（#238 后 send 为异步前置） */
async function sendAndFlush(
  result: ReturnType<typeof renderHook<ReturnType<typeof useResearchChat>, { projectId: string }>['result']>,
  query: string,
  selection?: Parameters<ReturnType<typeof useResearchChat>['send']>[1],
) {
  await act(async () => {
    result.current.send(query, selection)
  })
}

describe('useResearchChat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      preferred_model_id: 'm-local',
      default_context_level: 'focused',
    } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('send 打开流（Bearer + 首轮无 Last-Event-ID），乱序/重复事件正确合并', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    await sendAndFlush(result, '问题', { sourceIds: ['src_1'], noteIds: ['note_1'] })

    expect(streams).toHaveLength(1)
    const s = streams[0]
    expect(s.opts.request.query).toBe('问题')
    expect(s.opts.request.source_ids).toEqual(['src_1'])
    expect(s.opts.request.note_ids).toEqual(['note_1'])
    expect(s.opts.request.model_id).toBe('m-local')
    expect(s.opts.lastEventId).toBe(0)

    act(() => {
      s.emit(ev(1, 'thinking', { delta: '思' }))
      s.emit(ev(3, 'answer', { delta: '答' }))
      s.emit(ev(2, 'answer', { delta: '补' })) // 乱序
      s.emit(ev(2, 'answer', { delta: '补' })) // 重复
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.thinking).toBe('思')
    expect(turn.content).toBe('补答')
    expect(turn.status).toBe('streaming')
  })

  it('#238：无已保存偏好 → 错误 turn 且不打开流', async () => {
    const streams = openCapture()
    vi.mocked(getExecutionPreferences).mockResolvedValue({
      preferred_model_id: null,
      default_context_level: 'focused',
    } as never)
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    await sendAndFlush(result, "问题")

    expect(streams).toHaveLength(0)
    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('model_preference_required')
    expect(turn.errorMessage).toMatch(/model preference/i)
  })

  it('#238：偏好读取失败 fail-closed → 不发送', async () => {
    const streams = openCapture()
    vi.mocked(getExecutionPreferences).mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    await sendAndFlush(result, "问题")

    expect(streams).toHaveLength(0)
    expect(lastAssistant(result.current.turns).status).toBe('error')
  })

  it('done 终态：状态 done、记录 sessionId 供下一轮续接、终态后事件忽略', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    await sendAndFlush(result, "问题")
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'A' }))
      streams[0].emit(ev(2, 'done', { session_id: 's1', request_id: 'r1', completion_status: 'success' }))
      streams[0].emit(ev(3, 'answer', { delta: '迟到' }))
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('done')
    expect(turn.content).toBe('A')

    await sendAndFlush(result, "第二轮")
    expect(streams[1].opts.request.session_id).toBe('s1')
    expect(streams[1].opts.lastEventId).toBe(0)
  })

  it('断线重连：第二次打开携带 Last-Event-ID，重放事件去重不重复追加', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    await sendAndFlush(result, "问题")
    act(() => {
      streams[0].emit(ev(1, 'thinking', { delta: 'A' }))
      streams[0].emit(ev(2, 'answer', { delta: 'B' }))
    })
    act(() => {
      streams[0].fail(new Error('socket reset'))
    })
    // 重连状态 + 退避后第二次打开
    expect(lastAssistant(result.current.turns).status).toBe('reconnecting')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(streams).toHaveLength(2)
    expect(streams[1].opts.lastEventId).toBe(2)
    // #238 评审：重连必须复用同一幂等键（新键 = 新 Generation 双扣）
    expect(streams[1].opts.idempotencyKey).toBe(streams[0].opts.idempotencyKey)

    act(() => {
      // 服务端重放 n+1 起（含重复旧事件也不影响）
      streams[1].emit(ev(2, 'answer', { delta: 'B' }))
      streams[1].emit(ev(3, 'answer', { delta: 'C' }))
      streams[1].emit(ev(4, 'done', { session_id: 's1', completion_status: 'success' }))
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('done')
    expect(turn.content).toBe('BC')
    expect(turn.reconnectCount).toBe(1)
  })

  it('超过最大重连次数后标记 error，不再重连', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    await sendAndFlush(result, "问题")
    for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt += 1) {
      act(() => {
        streams[streams.length - 1].fail(new Error('socket reset'))
      })
      if (attempt < MAX_STREAM_ATTEMPTS) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(300 * 2 ** (attempt - 1))
        })
      }
    }

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(streams).toHaveLength(MAX_STREAM_ATTEMPTS)
  })

  it('409 resume_after：按退避重试（次数计入重连预算）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    await sendAndFlush(result, "问题")
    act(() => {
      streams[0].httpFail(409, { detail: 'resume_after' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(streams).toHaveLength(2)
    // 重连流收到首个事件后回到 streaming
    act(() => {
      streams[1].emit(ev(1, 'answer', { delta: '恢复' }))
    })
    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('streaming')
    expect(turn.content).toBe('恢复')
  })

  it('服务端 error 终态：code/message 展示、可重试码标记、不重连', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    await sendAndFlush(result, "问题")
    act(() => {
      streams[0].emit(ev(1, 'error', { code: 'project_deleted', message: '项目已删除' }))
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('project_deleted')
    expect(turn.errorMessage).toBe('项目已删除')
    expect(streams).toHaveLength(1)
  })

  it('#238：偏好读取期间连发 → 旧 turn 整体放弃，最新一轮打开流', async () => {
    const streams = openCapture()
    // 每次调用返回独立的 deferred promise（按调用顺序入队）
    const deferreds: Array<(prefs: unknown) => void> = []
    vi.mocked(getExecutionPreferences).mockImplementation(
      () => new Promise((resolve) => { deferreds.push(resolve) }) as never,
    )
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    act(() => {
      result.current.send('第一问')
    })
    act(() => {
      result.current.send('第二问')
    })
    // 先放行第一轮的偏好读取（seq=1 < latest=2）→ 应被 seq 守卫整体放弃
    await act(async () => {
      deferreds[0]!({ preferred_model_id: 'm-local', default_context_level: 'focused' })
    })
    expect(streams).toHaveLength(0)

    // 放行最新一轮（seq=2）→ 打开流
    await act(async () => {
      deferreds[1]!({ preferred_model_id: 'm-local', default_context_level: 'focused' })
    })
    expect(streams).toHaveLength(1)
    expect(streams[0].opts.request.query).toBe('第二问')
  })
})