import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { messageRowToTurn, useResearchChat, deriveScopeSnapshot, MAX_STREAM_ATTEMPTS } from './use-research-chat'
import type { CoverageSubmitAccepted, CoverageSubmitOutcome } from './use-research-chat'
import {
  getChatSubmission,
  getResearchChatSession,
  newIdempotencyKey,
  openResearchChatStream,
} from '@/lib/research/api'
import { buildSubmissionKey } from '@/lib/research/session-idempotency'
import {
  readActiveSubmission,
  readSubmissionMarker,
  writeActiveSubmission,
  writeSubmissionMarker,
  type SessionCacheAuthority,
  type SessionCacheScope,
  type SessionSubmissionMarker,
} from '@/lib/research/session-cache'
import type { ResearchSseEvent } from '@/lib/research/types'
import type { ResearchSessionRef } from '@/lib/research/session-contract'
import type { ConversationController, SessionRuntime } from '@/lib/research/session-runtime'

// UI-03 Red：Chat SSE 流状态机（契约 v0 §9）——乱序/重复事件经由 reducer
// 去重排序、断线自动按 event_id 重连（Last-Event-ID）、终态恰好一次、
// 409 按 code 语义（generation_in_progress 重连 / 其余终态，评审 R-A/R-B）、
// 错误码可重试标记。
// #243 §6.4：modelId 由调用方（confirmed 全局模型快照）required 传入，
// 本 hook 不在执行时读取执行偏好；无模型 fail-closed 不发请求。

// #358：researchApiErrorDetail 保持真实实现（结构化错误解析是本次被测行为），
// 其余 API 面照旧 mock。
vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...actual,
    saveResultFromResult: vi.fn(),
    newIdempotencyKey: vi.fn(() => 'ik-turn'),
    openResearchChatStream: vi.fn(),
    // PR-5b（D2）：详情/查回响应由测试直接驱动 transport。
    getResearchChatSession: vi.fn(),
    getChatSubmission: vi.fn(),
  }
})

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

// PR-5b（D2）：详情请求默认返回空壳；restoreAllMocks 会清掉工厂 mock 的
// 实现，因此每个用例前重新安装默认值（legacy 恢复路径可安全消费）。
beforeEach(() => {
  vi.mocked(getChatSubmission).mockResolvedValue({
    session_ref: {
      domain: 'research',
      kind: 'global',
      project_id: 'proj_1',
      session_id: 'sess_1',
      source_id: null,
    },
    draft_token: 'draft_default',
    idempotency_key: `s1_${'a'.repeat(64)}`,
    acceptance_state: 'not_observed',
    generation_id: null,
    generation_state: null,
    accepted_editor_revision: null,
    editor_intent_hash: null,
    submitted_draft_text: null,
    context_report: null,
  } as never)
  vi.mocked(getResearchChatSession).mockResolvedValue({
    session: null,
    messages: [],
    cards: [],
    next_cursor: null,
  } as never)
})

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

describe('useResearchChat.sendCoverage（COV-09 / DESIGN §9.6）', () => {
  interface CoverageCapture {
    request: { query: string; source_ids: string[]; note_ids: string[]; model_id: string }
    idempotencyKey: string
    resolve: (result: CoverageSubmitAccepted) => void
    reject: (error: Error) => void
  }

  function captureSubmit() {
    const captured: CoverageCapture[] = []
    let resolveLast: ((r: CoverageSubmitAccepted) => void) | null = null
    let rejectLast: ((e: Error) => void) | null = null
    const submit = vi.fn((request: CoverageCapture['request'], idempotencyKey: string) => {
      const capture: CoverageCapture = {
        request,
        idempotencyKey,
        resolve: (result) => resolveLast?.(result),
        reject: (error) => rejectLast?.(error),
      }
      captured.push(capture)
      return new Promise<CoverageSubmitAccepted>((resolve, reject) => {
        resolveLast = resolve
        rejectLast = reject
      })
    })
    return { submit, captured }
  }

  function accepted(overrides: Partial<CoverageSubmitAccepted> = {}): CoverageSubmitAccepted {
    return { job_id: 'job_1', generation_id: 'gen_1', registration: 'registered', ...overrides }
  }

  function startCoverage(
    result: ReturnType<typeof renderHook<ReturnType<typeof useResearchChat>, { projectId: string }>>['result'],
    query: string,
    submit: Parameters<ReturnType<typeof useResearchChat>['sendCoverage']>[3],
    selection?: Parameters<ReturnType<typeof useResearchChat>['send']>[1],
  ): Promise<CoverageSubmitOutcome> {
    return result.current.sendCoverage(query, selection, MODEL, submit)
  }

  it('202 受理：返回 accepted outcome，不写 conversation turns、不共享 Chat isStreaming', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    // 在途 relevant SSE turn：Coverage 派发后必须原样保留（§9.6）
    sendNow(result, '普通问答')
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: '进行中' }))
    })
    expect(result.current.isStreaming).toBe(true)
    const turnsBefore = result.current.turns.length

    const { submit, captured } = captureSubmit()
    const pending = startCoverage(result, '覆盖全部所选来源', submit, {
      sourceIds: ['src-1', 'src-2'],
      noteIds: [],
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].request).toMatchObject({
      query: '覆盖全部所选来源',
      source_ids: ['src-1', 'src-2'],
      note_ids: [],
      model_id: MODEL,
    })
    let outcome: CoverageSubmitOutcome | undefined
    await act(async () => {
      captured[0].resolve(accepted())
      outcome = await pending
    })
    expect(outcome).toMatchObject({ status: 'accepted', jobId: 'job_1' })
    // Chat 在途 turn 未被覆盖/标记 superseded；turns 数量不变
    expect(result.current.turns).toHaveLength(turnsBefore)
    expect(result.current.turns.some((t) => t.status === 'error')).toBe(false)
    expect(result.current.isStreaming).toBe(true)
  })

  it('受理结果原样返回：accepted + job/generation/registration', async () => {
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    const { submit, captured } = captureSubmit()
    const pending = startCoverage(result, '覆盖全部所选来源', submit)
    let outcome: CoverageSubmitOutcome | undefined
    await act(async () => {
      captured[0].resolve(accepted({ job_id: 'job-9', generation_id: 's_123', registration: 'failed' }))
      outcome = await pending
    })
    expect(outcome).toEqual({
      status: 'accepted',
      jobId: 'job-9',
      generationId: 's_123',
      registration: 'failed',
    })
  })

  it('提交失败：返回 failed outcome（code/message），不写 error turn', async () => {
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    const turnsBefore = result.current.turns.length
    const { submit, captured } = captureSubmit()
    const pending = startCoverage(result, '覆盖全部所选来源', submit)
    await act(async () => {
      captured[0].reject(new Error('coverage not enabled'))
    })
    const outcome = await pending
    expect(outcome).toMatchObject({
      status: 'failed',
      errorCode: 'coverage_submit_failed',
    })
    if (outcome.status !== 'failed') throw new Error('expected failed')
    expect(outcome.errorMessage).toContain('coverage not enabled')
    expect(result.current.turns).toHaveLength(turnsBefore)
  })

  it('#358：结构化 detail.code/detail.message 解析——不受通用 Axios 503 干扰', async () => {
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    const { submit, captured } = captureSubmit()
    const pending = startCoverage(result, '覆盖全部所选来源', submit)
    const axiosLikeError = Object.assign(new Error('Request failed with status code 503'), {
      response: {
        status: 503,
        data: {
          detail: {
            code: 'coverage_not_enabled',
            message: 'research coverage is not enabled; relevant synthesis remains available',
          },
        },
      },
    })
    await act(async () => {
      captured[0].reject(axiosLikeError)
    })
    const outcome = await pending
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'coverage_not_enabled' })
    if (outcome.status !== 'failed') throw new Error('expected failed')
    expect(outcome.errorMessage).toBe(
      'research coverage is not enabled; relevant synthesis remains available',
    )
    expect(outcome.errorMessage).not.toContain('Request failed with status code 503')
  })

  it('取消 consent（submit 返回 undefined）→ not_dispatched，零副作用', async () => {
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    const submit = vi.fn(async () => undefined)
    let outcome: CoverageSubmitOutcome | undefined
    await act(async () => {
      outcome = await result.current.sendCoverage('覆盖全部所选来源', undefined, MODEL, submit)
    })
    expect(outcome).toEqual({ status: 'not_dispatched' })
    expect(result.current.turns).toHaveLength(0)
  })

  it('#243 §6.4 扩展：无 confirmed 模型 → failed model_required，不调用 submit', async () => {
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    const { submit } = captureSubmit()
    // 直接以空 model 调一次（面板正常路径不会这样调用）
    const emptyModelOutcome = await result.current.sendCoverage('q', undefined, '', submit)
    expect(submit).not.toHaveBeenCalled()
    expect(emptyModelOutcome).toMatchObject({ status: 'failed', errorCode: 'model_required' })
    expect(result.current.turns).toHaveLength(0)
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

  it('409 generation_in_progress 非终态：ref 保留，send next 仍正确抢占 superseded', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    const firstId = lastAssistant(result.current.turns).id
    act(() => {
      // 评审 R-B：真实 wire 形态（同键重试命中自己 running 的 gen）
      streams[0].httpFail(409, {
        detail: { code: 'generation_in_progress', state: 'running' },
      })
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

  it('done 后 send next：终态释放传输一次，且不再对已终态 turn 重复释放', () => {
    const streams = openCapture()
    const abortReasons: Array<string | undefined> = []
    vi.mocked(openResearchChatStream).mockImplementation((opts) => {
      streams.push({
        opts,
        emit: (event) => opts.onEvent(event),
        fail: (error) => opts.onNetworkError?.(error),
        httpFail: (status, body) => opts.onHttpError?.(status, body),
      })
      return (reason?: string) => {
        abortReasons.push(reason)
      }
    })
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    sendNow(result, '第一轮')
    act(() => {
      streams[0].emit(ev(1, 'done', { session_id: 's1', completion_status: 'success' }))
    })
    // PR5（D-24，评审 MEDIUM-6）：终态（done）**必须**释放传输——此前只把
    // abort 置 null，看门狗与 reader 会一直挂到页面卸载且再也释放不掉。
    expect(abortReasons).toEqual(['terminal_reached'])
    sendNow(result, '第二轮')
    // activeRef 已释放：第二轮 send 不会**再次**释放第一轮（计数仍为 1）
    expect(abortReasons).toEqual(['terminal_reached'])
    expect(streams).toHaveLength(2)
  })
})

describe('D-22（审查轮 2 B1）：冻结请求的会话身份过期则丢弃', () => {
  it('冻结体带过期 session_id（当前会话已失效）→ 不原样发送，按当前身份重建', () => {
    // 前置：本地无持久会话 → 当前会话身份为 null（与冻结体的 sess_stale 不同）
    localStorage.clear()
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    act(() => {
      // 冻结体声称属于 sess_stale，但当前没有会话身份（无存储会话 → null）
      result.current.send(
        'q-stale-session',
        undefined,
        MODEL,
        'key-1',
        'v1',
        {
          query: 'q-stale-session',
          source_ids: [],
          note_ids: [],
          session_id: 'sess_stale',
          model_id: MODEL,
        },
      )
    })

    expect(streams).toHaveLength(1)
    const request = streams[0].opts.request as unknown as Record<string, unknown>
    // 不得把已失效的会话身份发出去（否则同轮首次尝试与重连身份不一致）
    expect(request.session_id).not.toBe('sess_stale')
    expect(request.session_id).toBeUndefined()
    expect(request.query).toBe('q-stale-session')
  })

  it('冻结体与会话身份一致时**原样**发送（用可区分的字段钉住"逐字派发"）', () => {
    // 存储形态是**纯字符串**（lastSessionStorageKey = prefix + projectId）
    localStorage.setItem('rdlens.research.chat.last-session.proj_1', 'sess_same')
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    act(() => {
      result.current.send(
        'q-same-session',
        undefined,
        MODEL,
        'key-2',
        'v1',
        {
          query: 'q-same-session',
          // 审查轮 3 L2：用**只有冻结体才有**的取值做判别——否则"重建"也会
          // 产出同样的 session_id，用例无法区分"原样派发"与"丢弃后重建"。
          source_ids: ['frozen_only'],
          note_ids: [],
          session_id: 'sess_same',
          model_id: 'm-frozen',
        },
      )
    })

    expect(streams).toHaveLength(1)
    const request = streams[0].opts.request as unknown as Record<string, unknown>
    expect(request.session_id).toBe('sess_same')
    // 冻结体被**逐字**派发（不是重建出来的等价体）
    expect(request.source_ids).toEqual(['frozen_only'])
    expect(request.model_id).toBe('m-frozen')
  })
})

describe('deriveScopeSnapshot（RWV2-11 K8）', () => {
  it('显式 mode 优先；数组复制不共享引用', () => {
    const sourceIds = ['src_1', 'src_2']
    const snapshot = deriveScopeSnapshot({
      mode: 'selected',
      sourceIds,
      noteIds: ['n1'],
    })
    expect(snapshot).toEqual({ mode: 'selected', sourceIds: ['src_1', 'src_2'], noteIds: ['n1'], singleSourceId: null })
    expect(snapshot.sourceIds).not.toBe(sourceIds)
  })

  it('mode 缺省按 ID 推导：非空 = selected，空 = all（C-05 语义）', () => {
    expect(deriveScopeSnapshot({ sourceIds: ['s1'], noteIds: [] })).toEqual({
      mode: 'selected',
      sourceIds: ['s1'],
      noteIds: [],
      singleSourceId: null,
    })
    expect(deriveScopeSnapshot(undefined)).toEqual({
      mode: 'all',
      sourceIds: [],
      noteIds: [],
      singleSourceId: null,
    })
    expect(deriveScopeSnapshot({ sourceIds: [], noteIds: [] })).toEqual({
      mode: 'all',
      sourceIds: [],
      noteIds: [],
      singleSourceId: null,
    })
  })
})

describe('PR-5a（D2）：显式 session 接线', () => {
  it('经 runtime 创建对话控制器；卸载 detach + releaseConversation（引用计数归 runtime）', () => {
    const controller = {
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(async () => ({ status: 'blocked' as const })),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    } as unknown as ConversationController
    const conversation = vi.fn((..._args: unknown[]) => controller)
    const releaseConversation = vi.fn()
    const runtime = {
      conversation,
      releaseConversation,
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const ref: ResearchSessionRef = {
      domain: 'research',
      kind: 'global',
      projectId: 'proj_1',
      sessionId: 'sess_1',
      sourceId: null,
    }

    const { result, unmount } = renderHook(() =>
      useResearchChat({ projectId: 'proj_1', session: { runtime, ref } }),
    )

    expect(conversation).toHaveBeenCalledTimes(1)
    expect(conversation.mock.calls[0]?.[0]).toEqual(ref)
    expect(result.current.conversation).toBe(controller)

    unmount()
    expect(controller.detach).toHaveBeenCalled()
    expect(releaseConversation).toHaveBeenCalledWith(ref, controller)
  })

  it('详情迟到：切换到另一会话后旧详情不得写回 turns（review-4 #2）', async () => {
    let resolveA: (value: unknown) => void = () => {}
    const makeController = (load: () => Promise<unknown>) => ({
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(load),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    }) as unknown as ConversationController
    const controllerA = makeController(() => new Promise<unknown>((resolve) => { resolveA = resolve }))
    const controllerB = makeController(async () => ({ status: 'ok' as const, value: { messages: [] } }))
    const conversation = vi.fn((target: ResearchSessionRef) =>
      target.sessionId === 'sess_a' ? controllerA : controllerB)
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const refA: ResearchSessionRef = {
      domain: 'research', kind: 'global', projectId: 'proj_1', sessionId: 'sess_a', sourceId: null,
    }
    const refB: ResearchSessionRef = { ...refA, sessionId: 'sess_b' }
    const { result, rerender } = renderHook(
      ({ ref }: { ref: ResearchSessionRef }) => useResearchChat({ projectId: 'proj_1', session: { runtime, ref } }),
      { initialProps: { ref: refA } },
    )
    rerender({ ref: refB })
    await act(async () => {
      resolveA({
        status: 'ok',
        value: {
          messages: [{
            message_id: 'msg_a',
            role: 'assistant',
            content: 'A answer',
            created_at: '2026-01-01T00:00:00Z',
          }],
          next_cursor: null,
        },
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    // 旧会话 A 的迟到详情不得覆盖当前会话 B 的 turns。
    expect(result.current.turns).toEqual([])
  })

  it('切换到空会话：上一会话已回填消息不得残留（review-5 B3）', async () => {
    const msgA = {
      message_id: 'msg_a',
      role: 'assistant',
      content: 'A answer',
      created_at: '2026-01-01T00:00:00Z',
    }
    const makeController = (messages: unknown[]) => ({
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(async () => ({ status: 'ok' as const, value: { messages, next_cursor: null } })),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    }) as unknown as ConversationController
    const controllerA = makeController([msgA])
    const controllerB = makeController([])
    const conversation = vi.fn((target: ResearchSessionRef) =>
      target.sessionId === 'sess_a' ? controllerA : controllerB)
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const refA: ResearchSessionRef = {
      domain: 'research', kind: 'global', projectId: 'proj_1', sessionId: 'sess_a', sourceId: null,
    }
    const refB: ResearchSessionRef = { ...refA, sessionId: 'sess_b' }
    const { result, rerender } = renderHook(
      ({ ref }: { ref: ResearchSessionRef }) => useResearchChat({ projectId: 'proj_1', session: { runtime, ref } }),
      { initialProps: { ref: refA } },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(1)
    rerender({ ref: refB })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // B 会话成功返回空详情：必须清空 A 已回填的消息。
    expect(result.current.turns).toEqual([])
  })

  it('切换到加载中的会话：旧会话消息必须立即清空（review-5 B3）', async () => {
    const msgA = {
      message_id: 'msg_a2',
      role: 'assistant',
      content: 'A answer 2',
      created_at: '2026-01-01T00:00:00Z',
    }
    const makeController = (load: () => Promise<unknown>) => ({
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(load),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    }) as unknown as ConversationController
    const controllerA = makeController(async () => ({
      status: 'ok' as const, value: { messages: [msgA], next_cursor: null },
    }))
    const controllerB = makeController(() => new Promise<unknown>(() => {}))
    const conversation = vi.fn((target: ResearchSessionRef) =>
      target.sessionId === 'sess_a' ? controllerA : controllerB)
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const refA: ResearchSessionRef = {
      domain: 'research', kind: 'global', projectId: 'proj_1', sessionId: 'sess_a', sourceId: null,
    }
    const refB: ResearchSessionRef = { ...refA, sessionId: 'sess_b' }
    const { result, rerender } = renderHook(
      ({ ref }: { ref: ResearchSessionRef }) => useResearchChat({ projectId: 'proj_1', session: { runtime, ref } }),
      { initialProps: { ref: refA } },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(1)
    rerender({ ref: refB })
    await act(async () => {
      await Promise.resolve()
    })
    // B 的详情仍在加载，也必须先清空 A 的消息，不能继续显示上一会话。
    expect(result.current.turns).toEqual([])
  })

  it('认证代次切换后重新 acquire controller（review-2 B1）', () => {
    const makeController = () => ({
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(async () => ({ status: 'blocked' as const })),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    }) as unknown as ConversationController
    const controllers = [makeController(), makeController()]
    let generation = 1
    let listener: (() => void) | null = null
    const conversation = vi.fn((..._args: unknown[]) => controllers[conversation.mock.calls.length - 1])
    const releaseConversation = vi.fn()
    const runtime = {
      conversation,
      releaseConversation,
      getSnapshot: () => ({ authGeneration: generation }),
      subscribe: (next: () => void) => {
        listener = next
        return () => { listener = null }
      },
    } as unknown as SessionRuntime
    const ref: ResearchSessionRef = {
      domain: 'research', kind: 'global', projectId: 'proj_1', sessionId: 'sess_1', sourceId: null,
    }
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1', session: { runtime, ref } }))
    expect(conversation).toHaveBeenCalledTimes(1)

    act(() => {
      generation = 2
      listener?.()
    })

    expect(conversation).toHaveBeenCalledTimes(2)
    expect(releaseConversation).toHaveBeenCalledWith(ref, controllers[0])
    expect(result.current.conversation).toBe(controllers[1])
  })

  it('global 新协议请求：携带 source_scope 且不发送顶层 source_ids（review-1 P1-#2）', () => {
    const captures = openCapture()
    const controller = {
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(async () => ({ status: 'blocked' as const })),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    } as unknown as ConversationController
    let capturedOptions: { transport: { openStream: (input: Record<string, unknown>) => { abort: (reason?: string) => void } } } | null = null
    const conversation = vi.fn((...args: unknown[]) => {
      capturedOptions = args[1] as typeof capturedOptions
      return controller
    })
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const ref: ResearchSessionRef = {
      domain: 'research',
      kind: 'global',
      projectId: 'proj_1',
      sessionId: 'sess_1',
      sourceId: null,
    }

    renderHook(() => useResearchChat({ projectId: 'proj_1', session: { runtime, ref } }))
    expect(capturedOptions).not.toBeNull()
    act(() => {
      capturedOptions?.transport.openStream({
        sessionRef: ref,
        editorRevision: 4,
        draftToken: 'draft_1',
        editorIntentHash: 'a'.repeat(64),
        idempotencyKey: `s1_${'b'.repeat(64)}`,
        lastEventId: 0,
        query: 'q1',
        modelId: MODEL,
        sourceIds: ['src_1', 'src_2'],
        noteIds: ['note_1'],
        scope: { mode: 'selected', sourceIds: ['src_1', 'src_2'], singleSourceId: null },
      })
    })
    expect(captures).toHaveLength(1)
    expect(captures[0].opts.protocol).toBe('research-session-v1')
    const request = captures[0].opts.request as unknown as Record<string, unknown>
    expect(request.source_ids).toBeUndefined()
    expect(request.note_ids).toEqual(['note_1'])
    expect(request.source_scope).toEqual({
      mode: 'selected',
      source_ids: ['src_1', 'src_2'],
      single_source_id: null,
    })
  })

  // PR-7 P0-2（6b 真实接入）：服务端 `SourceSessionSubmission` 是
  // `extra="forbid"`——source session 请求体带顶层 `source_ids` 会 422
  // `extra_forbidden`。source 以路径 source_id 定位，wire 只写 query/model_id。
  it('source 新协议请求：只含 query/model_id，不发送 source_ids/note_ids/source_scope（PR-7 P0-2）', () => {
    const captures = openCapture()
    const controller = {
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(async () => ({ status: 'blocked' as const })),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    } as unknown as ConversationController
    let capturedOptions: { transport: { openStream: (input: Record<string, unknown>) => { abort: (reason?: string) => void } } } | null = null
    const conversation = vi.fn((...args: unknown[]) => {
      capturedOptions = args[1] as typeof capturedOptions
      return controller
    })
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const ref: ResearchSessionRef = {
      domain: 'research',
      kind: 'source',
      projectId: 'proj_1',
      sessionId: 'sess_src_1',
      sourceId: 'src_1',
    }

    renderHook(() => useResearchChat({ projectId: 'proj_1', session: { runtime, ref } }))
    expect(capturedOptions).not.toBeNull()
    act(() => {
      capturedOptions?.transport.openStream({
        sessionRef: ref,
        editorRevision: 0,
        draftToken: 'draft_src_1',
        editorIntentHash: 'a'.repeat(64),
        idempotencyKey: `s1_${'b'.repeat(64)}`,
        lastEventId: 0,
        query: 'q-src',
        modelId: MODEL,
        sourceIds: ['src_1'],
        noteIds: [],
        scope: null,
      })
    })
    expect(captures).toHaveLength(1)
    const request = captures[0].opts.request as unknown as Record<string, unknown>
    expect(Object.keys(request).sort()).toEqual(['model_id', 'query'])
    expect(request.source_ids).toBeUndefined()
    expect(request.note_ids).toBeUndefined()
    expect(request.source_scope).toBeUndefined()
  })
})

describe('PR-5a F13：持久化恢复路径保留扩展字段', () => {
  const baseRow = {
    message_id: 'msg_gen_abc123',
    role: 'assistant' as const,
    content: '答案正文',
    thinking: '思考',
    citations: [{ citation_id: 'c1', source_id: 's1', source_title: 't', locator: null, snippet: null }],
  }

  it('context_report / context_coverage / record_visibility 随恢复轮保留；未知 report 保持 null', () => {
    const turn = messageRowToTurn({
      ...baseRow,
      context_report: {
        version: 1,
        status: 'trimmed',
        history: { available_turns: 5, included_turns: 2, omitted_turns: 3 },
        evidence: { included_chunks: 4, omitted_chunks: 1 },
        input_budget: 8000,
        serialized_input_tokens: 6400,
        estimator_version: 'v1',
        reason_codes: ['history_omitted'],
        required_context_missing: false,
        measurement_scope: 'final_reasoning_call',
      },
      context_coverage: { selected_full: 3, relevant_extra: 1, trimmed: 0, missing: 2, token_estimate: 123, input_budget: 8000 },
      record_visibility: 'legacy_context_unverifiable',
    })
    expect(turn?.contextReport?.status).toBe('trimmed')
    expect(turn?.contextReport?.history.omittedTurns).toBe(3)
    expect(turn?.contextCoverage?.missing).toBe(2)
    expect(turn?.recordVisibility).toBe('legacy_context_unverifiable')
    expect(turn?.content).toBe('答案正文')

    const unknown = messageRowToTurn({ ...baseRow, context_report: null })
    expect(unknown?.contextReport).toBeUndefined()
    expect(unknown?.contextReport).not.toEqual(expect.objectContaining({ status: 'complete' }))
  })

  it('user 行保留持久 message_id（面板 data-message-id 与身份去重依赖）', () => {
    const user = messageRowToTurn({ message_id: 'msg_u1', role: 'user', content: '问题' } as never)
    expect(user?.serverMessageId).toBe('msg_u1')
    const assistant = messageRowToTurn(baseRow)
    expect(assistant?.serverMessageId).toBe('msg_gen_abc123')
  })

  it('受限消息强制安全投影：正文/思考/引用不渲染', () => {
    const turn = messageRowToTurn({
      ...baseRow,
      record_visibility: 'restricted',
      context_report: {
        version: 1,
        status: 'unknown',
        history: { available_turns: null, included_turns: null, omitted_turns: null },
        evidence: { included_chunks: null, omitted_chunks: null },
        input_budget: null,
        serialized_input_tokens: null,
        estimator_version: null,
        reason_codes: [],
        required_context_missing: false,
        measurement_scope: 'unknown',
      },
    })
    expect(turn?.content).toBe('')
    expect(turn?.thinking).toBe('')
    expect(turn?.citations).toEqual([])
    expect(turn?.recordVisibility).toBe('restricted')
  })
})

// ── PR-5b（D2/D3）：详情元数据同响应捕获、marker 开流前写入与未结算查回 ──

describe('PR-5b（D2/D3）：会话元数据、submission marker 与未结算查回', () => {
  beforeEach(() => {
    // 工厂 vi.fn 不受 restoreAllMocks 影响：显式清空调用历史与 localStorage
    // 标记，避免跨用例污染（调用次数断言/残留 marker）。
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  const scope: SessionCacheScope = { viewerUserId: '1', projectId: 'proj_1' }
  const authority: SessionCacheAuthority = {
    authenticatedViewerUserId: '1',
    projectId: 'proj_1',
    authGeneration: 1,
    currentAuthGeneration: 1,
  }
  const ref: ResearchSessionRef = {
    domain: 'research',
    kind: 'global',
    projectId: 'proj_1',
    sessionId: 'sess_1',
    sourceId: null,
  }

  function submissionKeyFor(draftToken: string): string {
    return buildSubmissionKey({
      projectId: 'proj_1',
      ownerUserId: 1,
      kind: 'global',
      sourceId: null,
      sessionId: 'sess_1',
      draftToken,
    })
  }

  function markerFor(draftToken: string, acceptanceState: 'not_observed' | 'accepted' | 'terminal' = 'not_observed'): SessionSubmissionMarker {
    const now = '2026-10-27T00:00:00.000Z'
    return {
      version: 1,
      draftToken,
      idempotencyKey: submissionKeyFor(draftToken),
      acceptanceState,
      request: null,
      exactRequestAvailable: false,
      generationId: null,
      observedRevision: null,
      createdAt: now,
      updatedAt: now,
      terminalAt: acceptanceState === 'terminal' ? now : null,
    }
  }

  interface Harness {
    runtime: SessionRuntime
    controller: ConversationController
    transport: {
      openStream: (input: Record<string, unknown>) => { abort: (reason?: string) => void }
      loadDetail: (input: { cursor: string | null }) => Promise<unknown>
      getSubmission: (input: { token: string }) => Promise<unknown>
    }
    lookups: string[]
    maxInFlight: { value: number }
    setCache: (cache: { scope: SessionCacheScope | null; authority: SessionCacheAuthority | null }) => void
  }

  function harness(options: {
    load?: () => Promise<unknown>
    lookup?: 'ok' | 'blocked'
  } = {}): Harness {
    let transport: Harness['transport'] | null = null
    let currentTurn: Record<string, unknown> | null = null
    let cache: { scope: SessionCacheScope | null; authority: SessionCacheAuthority | null } = {
      scope,
      authority,
    }
    let inFlight = 0
    const lookups: string[] = []
    const maxInFlight = { value: 0 }
    const listenerRef: { current: (() => void) | null } = { current: null }
    const controller = {
      detach: vi.fn(),
      reattach: vi.fn(async () => ({ status: 'ok' as const })),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(options.load ?? (async () => ({ status: 'ok' as const, value: { messages: [], next_cursor: null } }))),
      loadMore: vi.fn(async () => ({ status: 'ok' as const, value: { messages: [], next_cursor: null } })),
      send: vi.fn(async () => ({ status: 'ok' as const })),
      retryTerminal: vi.fn(),
      refreshStatus: vi.fn(),
      lookupSubmission: vi.fn(async (token: string) => {
        lookups.push(token)
        inFlight += 1
        maxInFlight.value = Math.max(maxInFlight.value, inFlight)
        try {
          if (options.lookup === 'blocked') return { status: 'blocked' as const, reason: 'historical_token_not_supported' }
          await transport?.getSubmission({ token })
          currentTurn = {
            external: true,
            state: 'terminal',
            identity: { draftToken: token },
          }
          listenerRef.current?.()
          return { status: 'ok' as const }
        } finally {
          inFlight -= 1
        }
      }),
      subscribe: vi.fn((listener: () => void) => {
        listenerRef.current = listener
        listener()
        return () => {
          listenerRef.current = null
        }
      }),
      getSnapshot: vi.fn(() => ({
        version: 1,
        sessionKey: 'sk',
        authGeneration: 1,
        turn: currentTurn,
        history: [],
        detailMessages: [],
        detailCursor: null,
      })),
    } as unknown as ConversationController
    const conversation = vi.fn((_target: ResearchSessionRef, opts: { transport: Harness['transport'] }) => {
      transport = opts.transport
      return controller
    })
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
      cacheScope: () => cache.scope,
      cacheAuthority: () => cache.authority,
    } as unknown as SessionRuntime
    return {
      runtime,
      controller,
      get transport() {
        if (transport === null) throw new Error('transport not installed')
        return transport
      },
      lookups,
      maxInFlight,
      setCache: (next) => {
        cache = next
      },
    }
  }

  function flush(): Promise<void> {
    return act(async () => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    })
  }

  const streamInput = {
    sessionRef: ref,
    editorRevision: 1,
    draftToken: 'draft_1',
    editorIntentHash: 'a'.repeat(64),
    idempotencyKey: submissionKeyFor('draft_1'),
    lastEventId: 0,
    query: 'q1',
    modelId: 'm-1',
    sourceIds: [],
    noteIds: [],
    scope: { mode: 'selected', sourceIds: [], singleSourceId: null },
    onEvent: () => {},
    onEnd: () => {},
    onHttpError: () => {},
    onNetworkError: () => {},
    onProtocolError: () => {},
  }

  it('D2：同一份 loadDetail 响应被捕获为 header 元数据 + Generation cards，不额外发详情请求', async () => {
    vi.mocked(getResearchChatSession).mockResolvedValue({
      session: {
        session_id: 'sess_1',
        title: 'Real title',
        record_visibility: 'restricted',
      },
      messages: [],
      cards: [
        {
          generation_id: 'gen_1',
          job_id: 'job_1',
          status: 'failed',
          failure_code: 'context_limit_exceeded',
          created_at: '2026-10-27T00:00:00Z',
        },
      ],
      next_cursor: null,
    } as unknown as Awaited<ReturnType<typeof getResearchChatSession>>)
    const h = harness()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1', session: { runtime: h.runtime, ref } }))
    await flush()
    await act(async () => {
      await h.transport.loadDetail({ cursor: null })
    })
    expect(vi.mocked(getResearchChatSession)).toHaveBeenCalledTimes(1)
    expect(result.current.sessionMeta).toEqual({ title: 'Real title', recordVisibility: 'restricted' })
    expect(result.current.sessionCards).toHaveLength(1)
    expect(result.current.sessionCards?.[0]).toMatchObject({ generation_id: 'gen_1', status: 'failed' })
  })

  it('D3：marker 在 openStream 之前落盘（顺序断言）', () => {
    const h = harness()
    let activeAtOpen: string | null = 'missing'
    vi.mocked(openResearchChatStream).mockImplementation(() => {
      activeAtOpen = readActiveSubmission(scope, authority, ref)
      return () => {}
    })
    renderHook(() => useResearchChat({ projectId: 'proj_1', session: { runtime: h.runtime, ref } }))
    act(() => {
      h.transport.openStream(streamInput)
    })
    expect(activeAtOpen).toBe('draft_1')
    expect(readSubmissionMarker(scope, authority, ref, 'draft_1')).not.toBeNull()
    expect(vi.mocked(openResearchChatStream)).toHaveBeenCalledTimes(1)
  })

  it('D3：marker 写入失败不阻断发送，但如实标记 markerWriteFailed', () => {
    const h = harness()
    h.setCache({ scope: null, authority: null })
    vi.mocked(openResearchChatStream).mockImplementation(() => () => {})
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1', session: { runtime: h.runtime, ref } }))
    act(() => {
      h.transport.openStream(streamInput)
    })
    expect(vi.mocked(openResearchChatStream)).toHaveBeenCalledTimes(1)
    expect(result.current.markerWriteFailed).toBe(true)
  })

  it('D3：冷启动查回顺序 active→其余 marker，逐条串行（并发 ≤ 1）', async () => {
    writeSubmissionMarker(scope, ref, markerFor('t_a'))
    writeSubmissionMarker(scope, ref, markerFor('t_b'))
    writeSubmissionMarker(scope, ref, markerFor('t_c'))
    writeActiveSubmission(scope, ref, 't_active')
    vi.mocked(getChatSubmission).mockResolvedValue({
      session_ref: { domain: 'research', kind: 'global', project_id: 'proj_1', session_id: 'sess_1', source_id: null },
      draft_token: 't_active',
      idempotency_key: `s1_${'b'.repeat(64)}`,
      acceptance_state: 'not_observed',
      generation_id: null,
      generation_state: null,
      accepted_editor_revision: null,
      editor_intent_hash: null,
      submitted_draft_text: null,
      context_report: null,
    } as unknown as Awaited<ReturnType<typeof getChatSubmission>>)
    const h = harness()
    renderHook(() => useResearchChat({ projectId: 'proj_1', session: { runtime: h.runtime, ref } }))
    await flush()
    expect(h.lookups[0]).toBe('t_active')
    expect(new Set(h.lookups)).toEqual(new Set(['t_active', 't_a', 't_b', 't_c']))
    expect(h.maxInFlight.value).toBe(1)
  })

  it('D3/F10：冷启动 marker + 非空 durable detail + terminal 查回 → 保留已提交稿与恢复消息，不重发', async () => {
    writeSubmissionMarker(scope, ref, markerFor('t_old', 'terminal'))
    writeActiveSubmission(scope, ref, 't_old')
    vi.mocked(getChatSubmission).mockResolvedValue({
      session_ref: { domain: 'research', kind: 'global', project_id: 'proj_1', session_id: 'sess_1', source_id: null },
      draft_token: 't_old',
      idempotency_key: `s1_${'b'.repeat(64)}`,
      acceptance_state: 'terminal',
      generation_id: 'gen_old',
      generation_state: 'completed',
      accepted_editor_revision: 1,
      editor_intent_hash: 'a'.repeat(64),
      submitted_draft_text: '上一份已提交草稿',
      context_report: {
        version: 1,
        status: 'trimmed',
        history: { available_turns: 3, included_turns: 2, omitted_turns: 1 },
        evidence: { included_chunks: 2, omitted_chunks: 1 },
        input_budget: 1000,
        serialized_input_tokens: 800,
        estimator_version: 'v1',
        reason_codes: ['history_omitted'],
        required_context_missing: false,
        measurement_scope: 'final_reasoning_call',
      },
    } as unknown as Awaited<ReturnType<typeof getChatSubmission>>)
    const h = harness({
      load: async () => ({
        status: 'ok' as const,
        value: {
          messages: [{
            message_id: 'msg_1',
            role: 'assistant',
            content: '历史答案',
            created_at: '2026-10-26T00:00:00Z',
          }],
          next_cursor: null,
        },
      }),
    })
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1', session: { runtime: h.runtime, ref } }))
    await flush()
    expect(h.lookups).toContain('t_old')
    expect(result.current.turns).toHaveLength(1)
    expect(result.current.turns[0]?.content).toBe('历史答案')
    expect(result.current.submissionLookup).toMatchObject({
      token: 't_old',
      acceptance: 'terminal',
      generationState: 'completed',
      submittedDraftText: '上一份已提交草稿',
    })
    // 不自动重发（新执行必须显式确认）
    expect(vi.mocked(openResearchChatStream)).not.toHaveBeenCalled()
    // 不清稿：marker 仍保留，供面板“查看/复制/恢复已提交稿”
    expect(readSubmissionMarker(scope, authority, ref, 't_old')).not.toBeNull()
  })
})
