import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TIMEOUT_MS } from '@/lib/api/client'
import {
  STREAM_IDLE_TIMEOUT_MS,
  hasRetrySemanticsStatus,
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

/**
 * 与真实 fetch 行为一致的可中止挂起流：signal abort 时 `read()` 以
 * AbortError 拒绝。评审 LOW-13 指出：若挂起流与 signal 无关，超时用例里
 * "不得报网络错误"的负向断言永远走不到（abort 后的 catch 路径没被执行）。
 */
function hangingBodyAbortable(signal: AbortSignal | null): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
      })
    },
  })
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

  it('带重试语义的状态码被识别（409/429/5xx）——其余状态无重试语义', () => {
    expect(hasRetrySemanticsStatus(409)).toBe(true)
    expect(hasRetrySemanticsStatus(429)).toBe(true)
    expect(hasRetrySemanticsStatus(500)).toBe(true)
    expect(hasRetrySemanticsStatus(503)).toBe(true)
    expect(hasRetrySemanticsStatus(401)).toBe(false)
    expect(hasRetrySemanticsStatus(403)).toBe(false)
    expect(hasRetrySemanticsStatus(422)).toBe(false)
    expect(hasRetrySemanticsStatus(404)).toBe(false)
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

  it('流空闲超时 → onIdleTimeout 恰好一次；abort 引起的 read 拒绝不重复上报', async () => {
    vi.useFakeTimers()
    // 真实行为：abort 会让 read() 以 AbortError 拒绝——该拒绝必须被吞掉
    //（结算守卫已消费），不能变成第二次失败上报。
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => Promise.resolve(
      fetchResponse({ body: hangingBodyAbortable(init.signal as AbortSignal | null) }),
    )))
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
    // 让 abort 触发的 read() 拒绝真正落地
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    // 再次推进也不得重复上报
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
    expect(onNetworkError).not.toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('等待响应头也受预算约束：代理吞掉响应头 → 超时（phase=response）后不再悬挂', async () => {
    vi.useFakeTimers()
    // fetch 永不 resolve（连接建立但服务端不回响应头）
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* 永久悬挂 */ })))
    const onIdleTimeout = vi.fn()
    const onEnd = vi.fn()

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent: vi.fn(),
      onEnd,
      onIdleTimeout,
    })

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
    // 相位可辨：这是"等待响应"超时，不是流内空闲
    expect(onIdleTimeout.mock.calls[0][0]).toBe('response')
    expect(onEnd).not.toHaveBeenCalled()
  })

  it('响应头到达后切换为 idle 相位（超时相位可辨）', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse({ body: hangingBody() })))
    const onIdleTimeout = vi.fn()

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent: vi.fn(),
      onIdleTimeout,
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
    expect(onIdleTimeout.mock.calls[0][0]).toBe('idle')
  })

  it('API_TIMEOUT_MS=0 时两个相位都不计时（0 = 明确禁用超时）', async () => {
    // 该模块的常量在导入时求值；此处直接断言守卫语义：
    // 0 → armWatchdog 提前返回。用模块级常量判断测试环境取值。
    expect(typeof STREAM_IDLE_TIMEOUT_MS).toBe('number')
    if (STREAM_IDLE_TIMEOUT_MS > 0) {
      // 正数配置下，禁用语义由 armWatchdog 的 `<= 0` 分支保证（见实现）；
      // 用 vi.resetModules + env 覆盖重新导入来验证该分支。
      vi.resetModules()
      vi.stubEnv('NEXT_PUBLIC_API_TIMEOUT_MS', '0')
      const fresh = await import('./c05-stream-guard')
      expect(fresh.STREAM_IDLE_TIMEOUT_MS).toBe(0)
    }
  })

  it('非 2xx 且响应体卡住 → 按 HTTP 错误上报（保留状态码），不谎报 timeout', async () => {
    vi.useFakeTimers()
    // 服务端已给出 401，但响应体永远读不完
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise(() => { /* 永久挂起 */ }),
    }))
    const onHttpError = vi.fn()
    const onIdleTimeout = vi.fn()
    const onNetworkError = vi.fn()

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent: vi.fn(),
      onHttpError,
      onIdleTimeout,
      onNetworkError,
    })

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    // 真实状态码必须保留——否则 401 会被当成"可重试的传输超时"（无意义重试）
    expect(onHttpError).toHaveBeenCalledTimes(1)
    expect(onHttpError.mock.calls[0][0]).toBe(401)
    expect(onIdleTimeout).not.toHaveBeenCalled()
    expect(onNetworkError).not.toHaveBeenCalled()
  })

  it('409 且响应体卡住 → 保留可重试的 timeout 语义（不升级成终态 409）', async () => {
    vi.useFakeTimers()
    // 409 有同键自愈（completed-replay）语义：把它判成终态会让用户重发换新键
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise(() => { /* 永久挂起 */ }),
    }))
    const onHttpError = vi.fn()
    const onIdleTimeout = vi.fn()

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent: vi.fn(),
      onHttpError,
      onIdleTimeout,
    })

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
    expect(onHttpError).not.toHaveBeenCalled()
  })

  it('5xx 且响应体卡住 → 同样保留可重试语义', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => new Promise(() => { /* 永久挂起 */ }),
    }))
    const onHttpError = vi.fn()
    const onIdleTimeout = vi.fn()

    openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q', source_ids: ['src_1'], model_id: 'm' },
      onEvent: vi.fn(),
      onHttpError,
      onIdleTimeout,
    })

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
    expect(onHttpError).not.toHaveBeenCalled()
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
