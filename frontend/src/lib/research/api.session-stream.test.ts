import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openResearchChatStream,
  parseSessionAcceptReceipt,
  type ResearchChatSessionStreamOptions,
} from './api'
import { clearResearchToken, setResearchToken } from '@/lib/embedded/token-store'
import type { ResearchSessionRef } from './session-contract'
import type { ResearchSseEvent } from './types'

/**
 * PR-7 Red（6b 真实接入 P0）：`openResearchChatStream` 的 session 协议是**两步传输**。
 *
 * 隔离 Gateway 7896 实测（RDLens main `3620c9c1`）：
 * 1. `POST .../chat`（session 契约头，无 `Last-Event-ID`）→ **202 application/json**
 *    受理回执（`acceptance_state="accepted"` + `session_ref/generation_id/...`）；
 * 2. 同 body/头 + `Last-Event-ID: 0` 再 POST → **200 text/event-stream**。
 *
 * 旧实现单次 POST 并把 202 判成 `unexpected_content_type:application/json`，
 * 于是真实发送全部失败（PR-5a/PR-6 的 mock 测试未覆盖传输层两次 POST）。
 * 本文件的首个用例在旧实现上必红（fetch 只被调 1 次 + protocol error）。
 *
 * legacy 分支（省略 `protocol`）必须**逐字节不变**：单次 POST，202 仍是协议错误。
 */

const GATEWAY = 'https://gateway.example.com'
const PROJECT = 'proj_1'
const SESSION = 'sess_1'
const DRAFT = 't_ab3f8b607f50923d7090d1231f6b94a7'
const INTENT = 'a'.repeat(64)
/** 客户端 `s1_` 提交键（attach 必须复用同一值）。 */
const KEY = `s1_${'b'.repeat(64)}`

const REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: PROJECT,
  sessionId: SESSION,
  sourceId: null,
}

const SOURCE_REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'source',
  projectId: PROJECT,
  sessionId: 'sess_src_1',
  sourceId: 'src_1',
}

/** 服务端 `submission_response` 10 键 202 受理回执（wire 形状）。 */
function acceptReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_ref: {
      domain: 'research',
      kind: REF.kind,
      project_id: REF.projectId,
      session_id: REF.sessionId,
      source_id: REF.sourceId,
    },
    draft_token: DRAFT,
    idempotency_key: KEY,
    acceptance_state: 'accepted',
    generation_id: 'gen_1',
    generation_state: 'running',
    accepted_editor_revision: 4,
    editor_intent_hash: INTENT,
    submitted_draft_text: 'q',
    context_report: null,
    ...overrides,
  }
}

/** SSE 首事件：`usage` + `accepted` 扩展（服务端 attach(0) 会重放它）。 */
function acceptedFrame(ref: ResearchSessionRef = REF): string {
  return `event: usage\ndata: ${JSON.stringify({
    event_id: 1,
    type: 'usage',
    usage: { input_tokens: 0, output_tokens: 0 },
    accepted: {
      session_ref: {
        domain: 'research',
        kind: ref.kind,
        project_id: ref.projectId,
        session_id: ref.sessionId,
        source_id: ref.sourceId,
      },
      generation_id: 'gen_1',
      request_id: 'req_1',
      editor_revision: 4,
      draft_token: DRAFT,
      editor_intent_hash: INTENT,
    },
  })}\n\n`
}

const DONE_FRAME = 'event: done\ndata: {"event_id": 2, "type": "done", "session_id": "sess_1", "completion_status": "success"}\n\n'

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

/** 200 SSE 响应（可带 `X-Chat-Session-Id` 回显头）。 */
function sseResponse(frames: string[], headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8', ...headers }),
    body: sseBody(frames),
    json: async () => {
      throw new Error('SSE response is not JSON')
    },
  } as unknown as Response
}

/** 202 JSON 受理回执响应。 */
function acceptResponse(body: unknown = acceptReceipt()): Response {
  return {
    ok: true,
    status: 202,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    json: async () => body,
  } as unknown as Response
}

/** 非 2xx 错误响应（体为错误包络）。 */
function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    json: async () => body,
  } as unknown as Response
}

function sessionOptions(
  overrides: Partial<ResearchChatSessionStreamOptions> = {},
): ResearchChatSessionStreamOptions {
  return {
    protocol: 'research-session-v1',
    projectId: PROJECT,
    kind: 'global',
    sessionRef: REF,
    request: { query: 'q', model_id: 'm-test' },
    editorRevision: 4,
    draftToken: DRAFT,
    editorIntentHash: INTENT,
    idempotencyKey: KEY,
    // 测试注入极小退避（生产缺省 300/600/1000ms，共 3 次重试）。
    attachRetryDelaysMs: [5, 5, 5],
    onEvent: () => {},
    ...overrides,
  }
}

interface FetchCall {
  url: string
  init: RequestInit
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index: number): FetchCall {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit]
  return {
    url,
    init,
    headers: (init.headers ?? {}) as Record<string, string>,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  }
}

function installFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const queue = [...responses]
  const fetchMock = vi.fn(() => {
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch called more times than expected')
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(next)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('openResearchChatStream（session 协议：202 受理回执 → Last-Event-ID attach）', () => {
  let events: ResearchSseEvent[]

  beforeEach(() => {
    events = []
    vi.stubEnv('NEXT_PUBLIC_RD_EMBEDDED_MODE', '1')
    vi.stubEnv('NEXT_PUBLIC_RD_GATEWAY_URL', GATEWAY)
    setResearchToken('research.jwt', 9999999999)
  })

  afterEach(() => {
    clearResearchToken()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('首次 202（合法回执）→ attach 带 Last-Event-ID: 0 → 事件恰好消费一次', async () => {
    const fetchMock = installFetch(
      acceptResponse(),
      sseResponse([acceptedFrame(), DONE_FRAME], { 'x-chat-session-id': SESSION }),
    )
    const metas: Headers[] = []
    const protocolErrors: string[] = []
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          onEvent: (event) => {
            events.push(event)
            if (event.type === 'done') resolve()
          },
          onProtocolError: (reason) => protocolErrors.push(reason),
          onResponseMeta: (headers) => metas.push(headers),
        }),
      )
    })

    expect(protocolErrors).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = fetchCall(fetchMock, 0)
    const second = fetchCall(fetchMock, 1)
    // 同一 URL / method / body：两步是同一提交，不是第二次执行。
    expect(first.url).toBe(`${GATEWAY}/v1/research/projects/${PROJECT}/chat`)
    expect(second.url).toBe(first.url)
    expect(first.init.method).toBe('POST')
    expect(second.init.method).toBe('POST')
    expect(second.init.body).toBe(first.init.body)
    // 首步不带 Last-Event-ID；attach 首值恒 0。
    expect(first.headers['Last-Event-ID']).toBeUndefined()
    expect(second.headers['Last-Event-ID']).toBe('0')
    // 除 Last-Event-ID 外头完全相同（含同一 Idempotency-Key / 契约头）。
    const withoutCursor = (headers: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'Last-Event-ID'))
    expect(withoutCursor(second.headers)).toEqual(withoutCursor(first.headers))
    expect(first.headers['Idempotency-Key']).toBe(KEY)
    expect(second.headers['Idempotency-Key']).toBe(KEY)
    expect(first.headers['X-Research-Session-Contract']).toBe('research-session-v1')
    expect(first.headers['X-Research-Contract']).toBe('c05-v1')
    // body 键集 = §6.2 冻结必填（global 无顶层 source_ids）。
    expect(Object.keys(first.body).sort()).toEqual([
      'context_level',
      'draft_token',
      'editor_intent_hash',
      'editor_revision',
      'model_id',
      'query',
      'session_id',
    ])
    expect(first.body.session_id).toBe(SESSION)
    // 事件只消费一次，accepted 由 SSE（usage 扩展）提供。
    expect(events.map((event) => event.type)).toEqual(['usage', 'done'])
    expect(events[0].accepted?.generation_id).toBe('gen_1')
    // 响应头只观察 SSE（attach）响应一次。
    expect(metas).toHaveLength(1)
    expect(metas[0].get('x-chat-session-id')).toBe(SESSION)
  })

  it('attach 首次仍 202（缓冲未就绪）→ 有界退避后 200 SSE', async () => {
    const fetchMock = installFetch(
      acceptResponse(),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
      sseResponse([acceptedFrame(), DONE_FRAME]),
    )
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          onEvent: (event) => {
            events.push(event)
            if (event.type === 'done') resolve()
          },
        }),
      )
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchCall(fetchMock, 0).headers['Last-Event-ID']).toBeUndefined()
    expect(fetchCall(fetchMock, 1).headers['Last-Event-ID']).toBe('0')
    expect(fetchCall(fetchMock, 2).headers['Last-Event-ID']).toBe('0')
    expect(fetchCall(fetchMock, 2).init.body).toBe(fetchCall(fetchMock, 0).init.body)
    expect(events.map((event) => event.type)).toEqual(['usage', 'done'])
  })

  it('attach 持续 202 → 重试上限 3 次后 onIdleTimeout(response) 只结算一次，不发新键/不重复 submit', async () => {
    const fetchMock = installFetch(
      acceptResponse(),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
    )
    const idleTimeouts: Array<'response' | 'idle'> = []
    const protocolErrors: string[] = []
    const httpErrors: number[] = []
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          onEvent: (event) => events.push(event),
          onProtocolError: (reason) => protocolErrors.push(reason),
          onHttpError: (status) => httpErrors.push(status),
          onIdleTimeout: (phase) => {
            idleTimeouts.push(phase)
            resolve()
          },
        }),
      )
    })

    // 1 次首提交 + 4 次 attach（首次 attach + 3 次有界退避重试）= 5 次 POST，
    // 之后停止（不无限重试）。
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(idleTimeouts).toEqual(['response'])
    expect(protocolErrors).toEqual([])
    expect(httpErrors).toEqual([])
    expect(events).toEqual([])
    // 五次 POST 的 body 与 Idempotency-Key 完全相同：不产生新幂等键、不重复 submit。
    const bodies = new Set(Array.from({ length: 5 }, (_, index) => fetchCall(fetchMock, index).init.body))
    const keys = new Set(
      Array.from({ length: 5 }, (_, index) => fetchCall(fetchMock, index).headers['Idempotency-Key']),
    )
    expect(bodies.size).toBe(1)
    expect(keys).toEqual(new Set([KEY]))
    // 重试均为 attach：只允许首步缺 Last-Event-ID。
    expect(fetchCall(fetchMock, 0).headers['Last-Event-ID']).toBeUndefined()
    for (const index of [1, 2, 3, 4]) {
      expect(fetchCall(fetchMock, index).headers['Last-Event-ID']).toBe('0')
    }
  })

  it.each([
    ['acceptance_state', { acceptance_state: 'unknown' }],
    ['session_ref', { session_ref: { ...(acceptReceipt().session_ref as object), session_id: 'sess_other' } }],
    ['session_ref', { session_ref: { ...(acceptReceipt().session_ref as object), project_id: 'proj_other' } }],
    ['draft_token', { draft_token: 't_other' }],
    ['editor_intent_hash', { editor_intent_hash: 'c'.repeat(64) }],
    ['generation_id', { generation_id: '' }],
  ])('回执不匹配（%s）→ 协议错误且不发 attach', async (field, override) => {
    const fetchMock = installFetch(acceptResponse(acceptReceipt(override)))
    const protocolErrors: string[] = []
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          onEvent: (event) => events.push(event),
          onProtocolError: (reason) => {
            protocolErrors.push(reason)
            resolve()
          },
        }),
      )
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(protocolErrors).toHaveLength(1)
    expect(protocolErrors[0]).toMatch(/^invalid_accept_receipt/)
    expect(protocolErrors[0]).toContain(field)
    expect(events).toEqual([])
  })

  it('202 回执体不是 JSON → 协议错误且不发 attach', async () => {
    const fetchMock = installFetch({
      ok: true,
      status: 202,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      json: async () => {
        throw new SyntaxError('bad json')
      },
    } as unknown as Response)
    const protocolErrors: string[] = []
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          onEvent: () => {},
          onProtocolError: (reason) => {
            protocolErrors.push(reason)
            resolve()
          },
        }),
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(protocolErrors).toEqual(['invalid_accept_receipt:body'])
  })

  it('attach 非 2xx（409 session_busy）→ 既有 onHttpError 语义，不重试', async () => {
    const busy = { detail: { code: 'session_busy', message: 'busy', retryable: true } }
    const fetchMock = installFetch(acceptResponse(), errorResponse(409, busy))
    const httpErrors: Array<[number, unknown]> = []
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          onEvent: (event) => events.push(event),
          onHttpError: (status, body) => {
            httpErrors.push([status, body])
            resolve()
          },
        }),
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(httpErrors).toEqual([[409, busy]])
    expect(events).toEqual([])
  })

  it('attach 等待/重试期间 abort：定时器清理、不再发请求、无回调', async () => {
    const fetchMock = installFetch(
      acceptResponse(),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
      acceptResponse(acceptReceipt({ generation_state: 'accepted' })),
    )
    const protocolErrors: string[] = []
    const idleTimeouts: string[] = []
    const abort = openResearchChatStream(
      sessionOptions({
        attachRetryDelaysMs: [200, 200, 200],
        onEvent: (event) => events.push(event),
        onProtocolError: (reason) => protocolErrors.push(reason),
        onIdleTimeout: (phase) => idleTimeouts.push(phase),
      }),
    )
    // 首提交 + 第一次 attach 已完成，正处于第一次退避等待（200ms）中。
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2))
    const callsAtAbort = fetchMock.mock.calls.length
    expect(callsAtAbort).toBeLessThan(5)
    abort('user_cancel')
    await new Promise((resolve) => setTimeout(resolve, 400))

    // abort 之后不再有新的 POST（定时器已清）；也没有任何回调泄漏。
    expect(fetchMock).toHaveBeenCalledTimes(callsAtAbort)
    expect(protocolErrors).toEqual([])
    expect(idleTimeouts).toEqual([])
    expect(events).toEqual([])
  })

  it('重连（options.lastEventId=7）：首步与 attach 都携带同一水位，attach 不退回 0', async () => {
    const fetchMock = installFetch(
      acceptResponse(),
      sseResponse(['event: done\ndata: {"event_id": 8, "type": "done", "completion_status": "success"}\n\n']),
    )
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          lastEventId: 7,
          onEvent: (event) => {
            events.push(event)
            if (event.type === 'done') resolve()
          },
        }),
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchCall(fetchMock, 0).headers['Last-Event-ID']).toBe('7')
    expect(fetchCall(fetchMock, 1).headers['Last-Event-ID']).toBe('7')
  })

  it('向后兼容：服务端首步直出 200 SSE 时仍单次 POST 消费', async () => {
    const fetchMock = installFetch(sseResponse([acceptedFrame(), DONE_FRAME]))
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          onEvent: (event) => {
            events.push(event)
            if (event.type === 'done') resolve()
          },
        }),
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.type)).toEqual(['usage', 'done'])
  })

  it('source session：body 精确键集（路径 source_id 定位，不含 source_ids/note_ids/source_scope）', async () => {
    const fetchMock = installFetch(acceptResponse(acceptReceipt({
      session_ref: {
        domain: 'research',
        kind: 'source',
        project_id: PROJECT,
        session_id: SOURCE_REF.sessionId,
        source_id: SOURCE_REF.sourceId,
      },
    })), sseResponse([acceptedFrame(SOURCE_REF), DONE_FRAME]))
    await new Promise<void>((resolve) => {
      openResearchChatStream(
        sessionOptions({
          kind: 'source',
          sessionRef: SOURCE_REF,
          request: { query: 'q', model_id: 'm-test' },
          onEvent: (event) => {
            events.push(event)
            if (event.type === 'done') resolve()
          },
        }),
      )
    })
    const first = fetchCall(fetchMock, 0)
    expect(first.url).toBe(`${GATEWAY}/v1/research/projects/${PROJECT}/sources/src_1/chat`)
    expect(first.headers['X-Research-Contract']).toBe('v1')
    expect(Object.keys(first.body).sort()).toEqual([
      'context_level',
      'draft_token',
      'editor_intent_hash',
      'editor_revision',
      'model_id',
      'query',
      'session_id',
    ])
    expect(first.body.source_ids).toBeUndefined()
    expect(first.body.note_ids).toBeUndefined()
    expect(first.body.source_scope).toBeUndefined()
  })
})

describe('legacy 分支（零改动）', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_RD_EMBEDDED_MODE', '1')
    vi.stubEnv('NEXT_PUBLIC_RD_GATEWAY_URL', GATEWAY)
    setResearchToken('research.jwt', 9999999999)
  })

  afterEach(() => {
    clearResearchToken()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('legacy 收到 202 JSON 仍按 unexpected_content_type 协议错误（单次 POST）', async () => {
    const fetchMock = installFetch(acceptResponse())
    const protocolErrors: string[] = []
    await new Promise<void>((resolve) => {
      openResearchChatStream({
        projectId: PROJECT,
        request: { query: 'q', source_ids: ['src_1'], model_id: 'm-test' },
        onEvent: () => {},
        onProtocolError: (reason) => {
          protocolErrors.push(reason)
          resolve()
        },
      })
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(protocolErrors).toEqual(['unexpected_content_type:application/json'])
    expect(fetchCall(fetchMock, 0).body).toEqual({
      query: 'q',
      source_ids: ['src_1'],
      model_id: 'm-test',
    })
  })

  it('legacy source 请求体保持原样（source_ids 仍随 body 发送）', async () => {
    const fetchMock = installFetch(sseResponse([DONE_FRAME]))
    await new Promise<void>((resolve) => {
      openResearchChatStream({
        projectId: PROJECT,
        path: '/sources/src_1/chat',
        request: { query: 'q', source_ids: ['src_1'], model_id: 'm-test' },
        onEvent: (event) => {
          if (event.type === 'done') resolve()
        },
      })
    })
    const first = fetchCall(fetchMock, 0)
    expect(first.url).toBe(`${GATEWAY}/v1/research/projects/${PROJECT}/sources/src_1/chat`)
    expect(first.body).toEqual({ query: 'q', source_ids: ['src_1'], model_id: 'm-test' })
    expect(first.headers['X-Research-Session-Contract']).toBeUndefined()
  })
})

describe('parseSessionAcceptReceipt', () => {
  const expected = { sessionRef: REF, draftToken: DRAFT, editorIntentHash: INTENT }

  it('合法 global 回执 → ok，保留 generationId 与 recorded 字段', () => {
    const result = parseSessionAcceptReceipt(acceptReceipt(), expected)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt.generationId).toBe('gen_1')
    expect(result.receipt.idempotencyKey).toBe(KEY)
    expect(result.receipt.sessionRef).toEqual(REF)
  })

  it('合法 source 回执 → ok', () => {
    const result = parseSessionAcceptReceipt(
      acceptReceipt({
        session_ref: {
          domain: 'research',
          kind: 'source',
          project_id: PROJECT,
          session_id: SOURCE_REF.sessionId,
          source_id: SOURCE_REF.sourceId,
        },
      }),
      { sessionRef: SOURCE_REF, draftToken: DRAFT, editorIntentHash: INTENT },
    )
    expect(result.ok).toBe(true)
  })

  it('非对象 / acceptance_state 非 accepted / generation_id 空 → 拒绝并给出字段', () => {
    expect(parseSessionAcceptReceipt(null, expected)).toEqual({
      ok: false,
      reason: 'invalid_accept_receipt:body',
    })
    const hidden = parseSessionAcceptReceipt(acceptReceipt({ acceptance_state: 'not_observed' }), expected)
    expect(hidden.ok).toBe(false)
    if (!hidden.ok) expect(hidden.reason).toBe('invalid_accept_receipt:acceptance_state')
    const noGeneration = parseSessionAcceptReceipt(acceptReceipt({ generation_id: '   ' }), expected)
    expect(noGeneration.ok).toBe(false)
    if (!noGeneration.ok) expect(noGeneration.reason).toBe('invalid_accept_receipt:generation_id')
  })

  it('session_ref 与请求不一致（kind/source_id）→ 拒绝', () => {
    const wrongKind = parseSessionAcceptReceipt(
      acceptReceipt({
        session_ref: {
          domain: 'research',
          kind: 'source',
          project_id: PROJECT,
          session_id: SESSION,
          source_id: 'src_1',
        },
      }),
      expected,
    )
    expect(wrongKind.ok).toBe(false)
    if (!wrongKind.ok) expect(wrongKind.reason).toBe('invalid_accept_receipt:session_ref')
  })
})
