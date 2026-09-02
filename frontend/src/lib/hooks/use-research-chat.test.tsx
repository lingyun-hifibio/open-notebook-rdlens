import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResearchChat, MAX_STREAM_ATTEMPTS } from './use-research-chat'
import { newIdempotencyKey, openResearchChatStream } from '@/lib/research/api'
import type { ResearchSseEvent } from '@/lib/research/types'

// UI-03 Red：Chat SSE 流状态机（契约 v0 §9）——乱序/重复事件经由 reducer
// 去重排序、断线自动按 event_id 重连（Last-Event-ID）、终态恰好一次、
// 409 按 code 语义（generation_in_progress 重连 / 其余终态，评审 R-A/R-B）、
// 错误码可重试标记。
// #243 §6.4：modelId 由调用方（confirmed 全局模型快照）required 传入，
// 本 hook 不在执行时读取执行偏好；无模型 fail-closed 不发请求。

vi.mock('@/lib/research/api', () => ({
  newIdempotencyKey: vi.fn(() => 'ik-turn'),
  openResearchChatStream: vi.fn(),
}))

const MODEL = 'm-local'

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

/** send 是同步的（#243 §6.4 后不再有执行前的偏好读取） */
function sendNow(
  result: ReturnType<typeof renderHook<ReturnType<typeof useResearchChat>, { projectId: string }>>['result'],
  query: string,
  modelId: string = MODEL,
  selection?: Parameters<ReturnType<typeof useResearchChat>['send']>[1],
) {
  act(() => {
    result.current.send(query, selection, modelId)
  })
}

describe('useResearchChat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('send 打开流（Bearer + 首轮无 Last-Event-ID），乱序/重复事件正确合并', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '问题', MODEL, { sourceIds: ['src_1'], noteIds: ['note_1'] })

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

  it('#243 §6.4：无 confirmed 模型 → fail-closed，错误 turn 且不打开流', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '问题', '')

    expect(streams).toHaveLength(0)
    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('model_required')
    expect(turn.errorMessage).toMatch(/select a research model/i)
    expect(result.current.isStreaming).toBe(false)
  })

  it('#243 §6.4：modelId 逐次快照——第二轮用新模型，首轮在途 turn 不被改写', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮', 'm-a')
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'A' }))
    })
    sendNow(result, '第二轮', 'm-b')

    expect(streams).toHaveLength(2)
    // 不变量 4：各自保留发送时刻的快照，互不影响
    expect(streams[0].opts.request.model_id).toBe('m-a')
    expect(streams[1].opts.request.model_id).toBe('m-b')
    // 抢占在途 turn 时补终态：已收到的内容保留，但不再停留在 streaming
    const superseded = result.current.turns.find((t) => t.errorCode === 'superseded')
    expect(superseded?.status).toBe('error')
    expect(superseded?.content).toBe('A')
    expect(lastAssistant(result.current.turns).status).toBe('streaming')
  })

  it('done 终态：状态 done、记录 sessionId 供下一轮续接、终态后事件忽略', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, "问题")
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'A' }))
      streams[0].emit(ev(2, 'done', { session_id: 's1', request_id: 'r1', completion_status: 'success' }))
      streams[0].emit(ev(3, 'answer', { delta: '迟到' }))
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('done')
    expect(turn.content).toBe('A')

    sendNow(result, "第二轮")
    expect(streams[1].opts.request.session_id).toBe('s1')
    expect(streams[1].opts.lastEventId).toBe(0)
  })

  it('断线重连：第二次打开携带 Last-Event-ID，重放事件去重不重复追加', async () => {
    const streams = openCapture()
    // 评审 MEDIUM-2：计数器 mock——每轮只应生成一次键（重连复用），
    // 若改成每次尝试重新生成则 n=2、断言失败（非死断言）
    let n = 0
    vi.mocked(newIdempotencyKey).mockImplementation(() => {
      n += 1
      return `ik-${n}`
    })
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, "问题")
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
    expect(n).toBe(1)

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

    sendNow(result, "问题")
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

  it('409 generation_in_progress：同键按退避重试（自愈到 completed-replay）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, "问题")
    act(() => {
      // 评审 R-B：真实 wire 形态——同幂等键重试命中自己仍 running 的
      // gen（首事件前断线防护机制）；detail 为对象且 code 匹配
      streams[0].httpFail(409, {
        detail: { code: 'generation_in_progress', state: 'running' },
      })
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

    sendNow(result, "问题")
    act(() => {
      streams[0].emit(ev(1, 'error', { code: 'project_deleted', message: '项目已删除' }))
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('project_deleted')
    expect(turn.errorMessage).toBe('项目已删除')
    expect(streams).toHaveLength(1)
  })

  it('#243 §6.4：断线重连沿用发送时刻的模型快照（不变量 4）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '问题', 'm-a')
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'A' }))
    })
    act(() => {
      streams[0].fail(new Error('socket reset'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(streams).toHaveLength(2)
    expect(streams[1].opts.request.model_id).toBe('m-a')
  })
})