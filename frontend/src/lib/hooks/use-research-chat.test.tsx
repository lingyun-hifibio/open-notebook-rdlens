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
// ── COV-09：all_selected 覆盖提交（202 持久 Job，不走 SSE；§12.1） ──

describe('useResearchChat.sendCoverage（COV-09）', () => {
  beforeEach(() => {
    // 既有 afterEach restoreAllMocks 会清掉模块级实现，这里重新钉住
    vi.mocked(newIdempotencyKey).mockImplementation(() => 'ik-turn')
  })

  interface CoverageCapture {
    request: { query: string; source_ids: string[]; note_ids: string[]; model_id: string }
    idempotencyKey: string
    submit: (request: CoverageCapture['request'], idempotencyKey: string) => Promise<{ job_id: string }>
    resolve: (result: { job_id: string }) => void
    reject: (error: Error) => void
  }

  function captureSubmit() {
    const captured: CoverageCapture[] = []
    let resolveLast: ((r: { job_id: string }) => void) | null = null
    let rejectLast: ((e: Error) => void) | null = null
    const submit = vi.fn((request: CoverageCapture['request'], idempotencyKey: string) => {
      const capture: CoverageCapture = {
        request,
        idempotencyKey,
        submit,
        resolve: (result: { job_id: string }) => resolveLast?.(result),
        reject: (error: Error) => rejectLast?.(error),
      }
      captured.push(capture)
      return new Promise<{ job_id: string }>((resolve, reject) => {
        resolveLast = resolve
        rejectLast = reject
      })
    })
    return { submit, captured }
  }

  function sendCoverageNow(
    result: ReturnType<typeof renderHook<ReturnType<typeof useResearchChat>, { projectId: string }>>['result'],
    query: string,
    submit: CoverageCapture['submit'],
    selection?: Parameters<ReturnType<typeof useResearchChat>['send']>[1],
  ) {
    act(() => {
      result.current.sendCoverage(query, selection, MODEL, submit)
    })
  }

  it('202 成功：user + assistant 双 turn，coverageJobId 绑定、done 终态', async () => {
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    const { submit, captured } = captureSubmit()
    sendCoverageNow(result, '覆盖全部所选来源', submit, { sourceIds: ['src-1', 'src-2'], noteIds: [] })
    expect(captured).toHaveLength(1)
    expect(captured[0].request).toEqual({
      query: '覆盖全部所选来源',
      source_ids: ['src-1', 'src-2'],
      note_ids: [],
      model_id: MODEL,
    })
    expect(captured[0].idempotencyKey).toBe('ik-turn')

    await act(async () => {
      captured[0].resolve({ job_id: 'job_1' })
    })
    const assistant = lastAssistant(result.current.turns)
    expect(assistant.coverageJobId).toBe('job_1')
    expect(assistant.status).toBe('done')
    expect(result.current.turns[0]).toMatchObject({ role: 'user', content: '覆盖全部所选来源' })
  })

  it('提交失败：error turn（code/message），coverageJobId 保持 null', async () => {
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    const { submit, captured } = captureSubmit()
    sendCoverageNow(result, '覆盖全部所选来源', submit)
    await act(async () => {
      captured[0].reject(new Error('coverage not enabled'))
    })
    const assistant = lastAssistant(result.current.turns)
    expect(assistant.status).toBe('error')
    expect(assistant.errorCode).toBe('coverage_submit_failed')
    expect(assistant.errorMessage).toContain('coverage not enabled')
    expect(assistant.coverageJobId).toBeNull()
  })

  it('#243 §6.4 扩展：无 confirmed 模型 → fail-closed error turn，不调用 submit', () => {
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    const { submit } = captureSubmit()
    // 只走无模型路径：不建 user turn 之外的状态，submit 绝不调用
    act(() => {
      result.current.sendCoverage('q', undefined, '', submit)
    })
    expect(submit).not.toHaveBeenCalled()
    const last = result.current.turns[result.current.turns.length - 1]
    expect(last).toMatchObject({ role: 'assistant', status: 'error', errorCode: 'model_required' })
  })

  it('抢占有在途 relevant SSE turn（补终态不悬挂）', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    sendNow(result, '普通问答')
    expect(streams).toHaveLength(1)
    const { submit } = captureSubmit()
    sendCoverageNow(result, '覆盖全部所选来源', submit)
    const superseded = result.current.turns.find((t) => t.status === 'error')
    expect(superseded).toMatchObject({ errorCode: 'superseded' })
    // 覆盖率 turn 在最后
    expect(result.current.turns[result.current.turns.length - 1].content).toBe('')
  })
})

// ── #292 P0：终态后 activeRef 生命周期 ──
// 已终态（done/error/HTTP 终态/重连耗尽）的 turn 不得被下一次 send()
// 改写为 superseded；只有真正在途的 turn 才被抢占；旧流迟到事件既不能
// 覆盖也不能清理新 turn 的 activeRef（turnId guard）。

describe('useResearchChat #292 P0 终态生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.mocked(newIdempotencyKey).mockImplementation(() => 'ik-turn')
  })

  function assistantById(
    result: ReturnType<typeof renderHook<ReturnType<typeof useResearchChat>, { projectId: string }>>['result'],
    id: string,
  ): ReturnType<typeof lastAssistant> {
    const turn = result.current.turns.find((t) => t.id === id)
    if (!turn) throw new Error(`turn ${id} not found`)
    return turn
  }

  it('done → send next：上一轮保持 done，errorCode/errorMessage 不被改写', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    const firstId = lastAssistant(result.current.turns).id
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'A' }))
      streams[0].emit(ev(2, 'done', { session_id: 's1', completion_status: 'success' }))
    })

    sendNow(result, '第二轮')
    const first = assistantById(result, firstId)
    expect(first.status).toBe('done')
    expect(first.errorCode).toBeNull()
    expect(first.errorMessage).toBeNull()
    expect(first.content).toBe('A')
    // 新一轮不受影响，正常在途
    expect(lastAssistant(result.current.turns).status).toBe('streaming')
  })

  it('SSE error → send next：上一轮保留原错误码（daily_limit_exceeded 不被改写）', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    const firstId = lastAssistant(result.current.turns).id
    act(() => {
      streams[0].emit(ev(1, 'error', { code: 'daily_limit_exceeded', message: 'external generation failed' }))
    })

    sendNow(result, '第二轮')
    const first = assistantById(result, firstId)
    expect(first.status).toBe('error')
    expect(first.errorCode).toBe('daily_limit_exceeded')
    expect(first.errorMessage).toBe('external generation failed')
  })

  it('非 409 HTTP 终态 → send next：上一轮保留 http_error，不被 superseded 覆盖', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    const firstId = lastAssistant(result.current.turns).id
    act(() => {
      streams[0].httpFail(500, { detail: 'boom' })
    })

    sendNow(result, '第二轮')
    const first = assistantById(result, firstId)
    expect(first.status).toBe('error')
    expect(first.errorCode).toBe('http_error')
    expect(first.errorMessage).toBe('boom')
  })

  it('网络重连耗尽终态 → send next：上一轮保留 stream_lost', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    const firstId = lastAssistant(result.current.turns).id
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
    expect(assistantById(result, firstId).errorCode).toBe('stream_lost')

    sendNow(result, '第二轮')
    const first = assistantById(result, firstId)
    expect(first.status).toBe('error')
    expect(first.errorCode).toBe('stream_lost')
    expect(first.errorMessage).toContain('Connection lost')
    expect(streams).toHaveLength(MAX_STREAM_ATTEMPTS + 1)
  })

  it('409 resume_after 非终态：ref 保留，send next 仍正确抢占 superseded', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    const firstId = lastAssistant(result.current.turns).id
    act(() => {
      streams[0].httpFail(409, { detail: 'resume_after' })
    })
    expect(assistantById(result, firstId).status).toBe('reconnecting')

    sendNow(result, '第二轮')
    // 409 重连中的 turn 仍属「真正在途」，抢占语义保留
    expect(assistantById(result, firstId).errorCode).toBe('superseded')
  })

  it('streaming → send next：在途 turn 正确标记 superseded（ref 不变量修复后仍成立）', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    const firstId = lastAssistant(result.current.turns).id
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'A' }))
    })

    sendNow(result, '第二轮')
    const first = assistantById(result, firstId)
    expect(first.status).toBe('error')
    expect(first.errorCode).toBe('superseded')
    expect(first.errorMessage).toBe('Superseded by a newer request')
    // 新 turn 已在途
    expect(streams).toHaveLength(2)
    expect(lastAssistant(result.current.turns).status).toBe('streaming')
  })

  it('旧流迟到事件：既不覆盖新 turn，也不清理新 turn 的 activeRef', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    const firstId = lastAssistant(result.current.turns).id
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'A' }))
    })
    sendNow(result, '第二轮')
    const secondId = lastAssistant(result.current.turns).id

    // 第一轮被抢占后，其旧流迟到 done：不能改写 turn1，也不能清理
    // 指向 turn2 的 activeRef（turnId guard）
    act(() => {
      streams[0].emit(ev(2, 'done', { session_id: 'stale', completion_status: 'success' }))
    })
    expect(assistantById(result, firstId).errorCode).toBe('superseded')
    expect(assistantById(result, firstId).content).toBe('A')

    // activeRef 仍属于第二轮：正常事件继续生效
    act(() => {
      streams[1].emit(ev(1, 'answer', { delta: 'B' }))
    })
    expect(assistantById(result, secondId).content).toBe('B')
    expect(assistantById(result, secondId).status).toBe('streaming')

    // 旧流继续迟到的 answer 不再写入已终态/被抢占的 turn1
    act(() => {
      streams[0].emit(ev(3, 'answer', { delta: '迟到' }))
    })
    expect(assistantById(result, firstId).content).toBe('A')
    expect(assistantById(result, secondId).content).toBe('B')
  })

  it('done 后 send next：不再 abort 已终态 turn（activeRef 已释放，stopActive 空转）', () => {
    const streams = openCapture()
    let aborted = 0
    vi.mocked(openResearchChatStream).mockImplementation((opts) => {
      streams.push({
        opts,
        emit: (event) => opts.onEvent(event),
        fail: (error) => opts.onNetworkError?.(error),
        httpFail: (status, body) => opts.onHttpError?.(status, body),
      })
      return () => {
        aborted += 1
      }
    })
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    act(() => {
      streams[0].emit(ev(1, 'done', { session_id: 's1', completion_status: 'success' }))
    })
    sendNow(result, '第二轮')
    // done 已清理 ref：第二轮 send 不应对第一轮流调用 abort（服务端已完成）
    expect(aborted).toBe(0)
    expect(streams).toHaveLength(2)
  })
})
