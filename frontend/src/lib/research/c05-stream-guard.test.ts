import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TIMEOUT_MS } from '@/lib/api/client'
import {
  STREAM_IDLE_TIMEOUT_MS,
  createAttemptSettlement,
  isHeartbeatComment,
  isSseContentType,
  isTimeoutRetryEligible,
} from './c05-stream-guard'
import { openResearchChatStream } from './api'
import { clearResearchToken, setResearchToken } from '@/lib/embedded/token-store'

/**
 * PR5（D-24 / handover §5.3）：SSE 传输四条规则的**守卫**。
 *
 * 单列一个文件（而不是并入 stream.test.ts，虽然 stream.test.ts 的注释也强调
 * 与本模块隔离）：本文件覆盖的是 PR5 新增的传输语义，纯函数断言 + 传输层
 * 集成断言各占一半；与既有"帧解析/重连头"用例混在一起会让失败定位变难。
 *
 * 对应规则：
 * 1. `API_TIMEOUT_MS` 正数作用于等待响应与完整 body 读取；`0` 明确禁用超时；
 * 2. 状态 + `Content-Type` 校验**之后**才进入流空闲计时；字节重置空闲；
 *    heartbeat 不是模型进度；
 * 3. abort 原因区分，**仅 timeout** 可进入有界策略；每次尝试只结算一次；
 * 4. `Last-Event-ID`/事件去重/终态一次保持，不新增 SSE 事件类型。
 */

const GATEWAY = 'https://gateway.example.com'
const PROJECT = 'proj_1'

function hangingBody(): ReadableStream<Uint8Array> {
  // 永不 enqueue / 永不 close：模拟代理吞掉流但不断开
  return new ReadableStream<Uint8Array>({ start() { /* 故意挂起 */ } })
}

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame))
      }
      controller.close()
    },
  })
}

function fetchResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: sseBody([]),
    json: async () => ({}),
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_RD_EMBEDDED_MODE', '1')
  vi.stubEnv('NEXT_PUBLIC_RD_GATEWAY_URL', GATEWAY)
  setResearchToken('research.jwt', 9_999_999_999)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearResearchToken()
})

describe('D-24：传输守卫纯函数', () => {
  it('空闲预算复用 API 超时预算（与 use-ask 的既有看门狗同一约定）', () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(API_TIMEOUT_MS)
  })

  it('Content-Type 校验接受参数化与大小写差异，拒绝非 SSE', () => {
    expect(isSseContentType('text/event-stream')).toBe(true)
    expect(isSseContentType('text/event-stream; charset=utf-8')).toBe(true)
    expect(isSseContentType('TEXT/EVENT-STREAM')).toBe(true)
    expect(isSseContentType(' text/event-stream ')).toBe(true)
    expect(isSseContentType('application/json')).toBe(false)
    expect(isSseContentType('text/plain; charset=utf-8')).toBe(false)
    expect(isSseContentType(null)).toBe(false)
    expect(isSseContentType(undefined)).toBe(false)
  })

  it('仅 timeout 可进入有界重试（取消/身份/页面变化一律不重试）', () => {
    expect(isTimeoutRetryEligible('timeout')).toBe(true)
    expect(isTimeoutRetryEligible('user_cancel')).toBe(false)
    expect(isTimeoutRetryEligible('identity')).toBe(false)
    expect(isTimeoutRetryEligible('page_change')).toBe(false)
    expect(isTimeoutRetryEligible('normal_end')).toBe(false)
  })

  it('每次尝试只结算一次（重复终止路径不得二次上报）', () => {
    const { settle } = createAttemptSettlement()
    expect(settle()).toBe(true)
    expect(settle()).toBe(false)
    expect(settle()).toBe(false)
  })

  it('heartbeat 注释帧被识别为传输活跃而非模型进度', () => {
    expect(isHeartbeatComment(': keep-alive')).toBe(true)
    expect(isHeartbeatComment(':ka\n:ka2')).toBe(true)
    expect(isHeartbeatComment(':ka\n')).toBe(true)
    expect(isHeartbeatComment('event: answer\ndata: {"x":1}')).toBe(false)
    expect(isHeartbeatComment('')).toBe(false)
  })
})

describe('D-24：传输层集成（openResearchChatStream）', () => {
  it('非 SSE Content-Type → onProtocolError 且不消费流、不回调事件/EOF', async () => {
    const onEvent = vi.fn()
    const onEnd = vi.fn()
    const onProtocolError = vi.fn()
    const onNetworkError = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse({
      headers: new Headers({ 'content-type': 'application/json' }),
      body: sseBody(['event: answer\ndata: {"type":"answer","content":"leak"}\n\n']),
    })))

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent,
      onEnd,
      onProtocolError,
      onNetworkError,
    })

    await vi.waitFor(() => expect(onProtocolError).toHaveBeenCalledTimes(1))
    expect(onProtocolError.mock.calls[0][0]).toContain('unexpected_content_type')
    // 未视为事件流：不解析、不报 EOF、不当作网络错误（不进入有界重连）
    expect(onEvent).not.toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
    expect(onNetworkError).not.toHaveBeenCalled()
  })

  it('流空闲超时 → onIdleTimeout 恰好一次，且不与 abort 产生的错误重复结算', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse({ body: hangingBody() })))
    const onIdleTimeout = vi.fn()
    const onNetworkError = vi.fn()
    const onEnd = vi.fn()

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent: vi.fn(),
      onEnd,
      onIdleTimeout,
      onNetworkError,
    })

    // 让 fetch.then 先落地（校验 + 武装空闲计时）
    await vi.advanceTimersByTimeAsync(0)
    expect(onIdleTimeout).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
    // 再次推进也不得重复上报
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
    expect(onNetworkError).not.toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('字节（含 heartbeat）会重置空闲计时，不把 heartbeat 当模型进度', async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse({ body })))
    const onIdleTimeout = vi.fn()
    const onEvent = vi.fn()

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent,
      onIdleTimeout,
    })

    await vi.advanceTimersByTimeAsync(0)
    // 每半个预算推一次 heartbeat，累计远超一个预算仍不应超时
    for (let i = 0; i < 4; i += 1) {
      streamController!.enqueue(encoder.encode(': keep-alive\n\n'))
      await vi.advanceTimersByTimeAsync(Math.floor(STREAM_IDLE_TIMEOUT_MS / 2))
    }
    expect(onIdleTimeout).not.toHaveBeenCalled()
    // heartbeat 不产生事件（不是模型进度）
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('调用方中止带原因：不算 EOF、不报网络错误、不进入超时路径', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse({ body: hangingBody() })))
    const onEnd = vi.fn()
    const onNetworkError = vi.fn()
    const onIdleTimeout = vi.fn()

    const dispose = openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent: vi.fn(),
      onEnd,
      onNetworkError,
      onIdleTimeout,
    })

    await vi.advanceTimersByTimeAsync(0)
    dispose('page_change')
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2)

    expect(onEnd).not.toHaveBeenCalled()
    expect(onNetworkError).not.toHaveBeenCalled()
    // 调用方已中止 → 空闲看门狗不得再上报（否则页面切换会被误判为 timeout 重试）
    expect(onIdleTimeout).not.toHaveBeenCalled()
  })

  it('正常读尽只回调一次 onEnd（终态恰好一次）', async () => {
    const onEnd = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse({ body: sseBody([]) })))

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent: vi.fn(),
      onEnd,
    })

    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('Last-Event-ID 重连头语义保持（§5.3 第 4 行）', async () => {
    const fetchMocked = vi.fn().mockResolvedValue(fetchResponse({ body: sseBody([]) }))
    vi.stubGlobal('fetch', fetchMocked)

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      lastEventId: 7,
      onEvent: vi.fn(),
    })

    await vi.waitFor(() => expect(fetchMocked).toHaveBeenCalledTimes(1))
    const init = fetchMocked.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['Last-Event-ID']).toBe('7')
  })
})
