/**
 * Issue #1048 PR7：写作变体的**真实两步传输**测试（#1048 fork §9 白名单内）。
 *
 * 与既有 `api.session-stream.test.ts`（#602 会话变体）互补：本文件不 mock
 * `openResearchWritingStream`，用真实 `fetch` stub 断言写作 wire——
 * 1. 首步 POST 无 `Last-Event-ID`，带会话契约头 / 契约头 / 幂等键，body 为
 *    冻结 11 键（无 `source_scope`）→ 202 十键回执；
 * 2. 同 body/头 + `Last-Event-ID: 0` attach → SSE（accepted → answer → done）；
 * 3. 回执身份不符或键集漂移不 attach；HTTP 422 保留状态码/稳定码；
 * 4. EOF 无终态通过 `onEnd` 交回调用方结算（不永久 streaming）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openResearchWritingStream,
  WRITING_ACCEPT_RECEIPT_KEYS,
  type ResearchWritingStreamOptions,
} from '../api'
import { clearResearchToken, setResearchToken } from '@/lib/embedded/token-store'
import type { ResearchSessionRef } from '../session-contract'
import type { ResearchSseEvent } from '../types'

const GATEWAY = 'https://gateway.example.com'
const PROJECT = 'proj_1'
const SESSION = 'sess_1'
const DRAFT = 't_ab3f8b607f50923d7090d1231f6b94a7'
const INTENT = 'a'.repeat(64)
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

/** host 写作 202 受理回执（闭合 10 键；`writing_submission.WRITING_RECEIPT_KEYS`）。 */
function writingAcceptReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** SSE 首事件：`usage` + `accepted` 扩展。 */
function acceptedFrame(ref: ResearchSessionRef = REF, generationId = 'gen_1'): string {
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
      generation_id: generationId,
      request_id: 'req_1',
      editor_revision: 4,
      draft_token: DRAFT,
      editor_intent_hash: INTENT,
    },
  })}\n\n`
}

const DONE_FRAME =
  'event: done\ndata: {"event_id": 2, "type": "done", "session_id": "sess_1", "completion_status": "success"}\n\n'

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

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

function acceptResponse(body: unknown = writingAcceptReceipt()): Response {
  return {
    ok: true,
    status: 202,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    json: async () => body,
  } as unknown as Response
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    json: async () => body,
  } as unknown as Response
}

/** 冻结的写作请求体（11 键；传输层只校验形状/原样复用）。 */
function writingRequest(): Record<string, unknown> {
  return {
    schema_version: 1,
    editor_revision: 4,
    draft_token: DRAFT,
    editor_intent_hash: INTENT,
    writing_intent_hash: 'c'.repeat(64),
    query: 'q',
    model: 'm-test',
    response_language: 'en',
    work_purpose: 'writing',
    document_context: {
      note_id: 'note_1',
      revision: 2,
      snapshot_hash: 'd'.repeat(64),
      selection: { kind: 'full' },
    },
    history_mode: 'none',
  }
}

function writingOptions(
  overrides: Partial<ResearchWritingStreamOptions> = {},
): ResearchWritingStreamOptions {
  return {
    protocol: 'research-writing-v1',
    projectId: PROJECT,
    sessionRef: REF,
    request: writingRequest() as unknown as ResearchWritingStreamOptions['request'],
    idempotencyKey: KEY,
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

describe('openResearchWritingStream（#1048 PR7：写作变体真实两步传输）', () => {
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

  it('首步 202 → attach 带 Last-Event-ID: 0；POST 带会话契约头且 body 为 11 键', async () => {
    const fetchMock = installFetch(
      acceptResponse(writingAcceptReceipt()),
      sseResponse([acceptedFrame(), DONE_FRAME], { 'x-chat-session-id': SESSION }),
    )
    const receipts: string[] = []
    const protocolErrors: string[] = []
    const ends: number[] = []
    await new Promise<void>((resolve) => {
      openResearchWritingStream(
        writingOptions({
          onEvent: (event) => {
            events.push(event)
            if (event.type === 'done') resolve()
          },
          onAcceptReceipt: (receipt) => receipts.push(receipt.generationId),
          onProtocolError: (reason) => protocolErrors.push(reason),
          onEnd: () => ends.push(1),
        }),
      )
    })

    expect(protocolErrors).toEqual([])
    expect(events.map((event) => event.type)).toEqual(['usage', 'done'])
    expect(receipts).toEqual(['gen_1'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = fetchCall(fetchMock, 0)
    const second = fetchCall(fetchMock, 1)
    // 写作路径：会话身份只在路径中，body 不携带 session_id/source_scope。
    expect(first.url).toBe(
      `${GATEWAY}/v1/research/projects/${PROJECT}/chat/sessions/${SESSION}/writing`,
    )
    expect(second.url).toBe(first.url)
    expect(second.init.body).toBe(first.init.body)
    // BLOCKING-1（round-1）：首步/attach 都必须带会话契约头。
    expect(first.headers['X-Research-Session-Contract']).toBe('research-session-v1')
    expect(second.headers['X-Research-Session-Contract']).toBe('research-session-v1')
    expect(first.headers['X-Research-Contract']).toBe('c05-v1')
    expect(second.headers['X-Research-Contract']).toBe('c05-v1')
    expect(first.headers['Idempotency-Key']).toBe(KEY)
    expect(second.headers['Idempotency-Key']).toBe(KEY)
    // 首步不带 Last-Event-ID；attach 首值恒 0。
    expect(first.headers['Last-Event-ID']).toBeUndefined()
    expect(second.headers['Last-Event-ID']).toBe('0')
    const withoutCursor = (headers: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'Last-Event-ID'))
    expect(withoutCursor(second.headers)).toEqual(withoutCursor(first.headers))
    // body 恰为 11 键，且不含 source_scope（host 出现即 422）。
    expect(Object.keys(first.body).sort()).toEqual([
      'document_context',
      'draft_token',
      'editor_intent_hash',
      'editor_revision',
      'history_mode',
      'model',
      'query',
      'response_language',
      'schema_version',
      'work_purpose',
      'writing_intent_hash',
    ])
    expect(first.body.source_scope).toBeUndefined()
    expect(ends).toHaveLength(0)
  })

  it('source 变体：/sources/{id}/chat/sessions/{id}/writing 且 X-Research-Contract 为 v1', async () => {
    const sourceReceipt = writingAcceptReceipt({
      session_ref: {
        domain: 'research',
        kind: 'source',
        project_id: PROJECT,
        session_id: SOURCE_REF.sessionId,
        source_id: SOURCE_REF.sourceId,
      },
    })
    const fetchMock = installFetch(
      acceptResponse(sourceReceipt),
      sseResponse([
        acceptedFrame(SOURCE_REF),
        'event: done\ndata: {"event_id": 2, "type": "done", "session_id": "sess_src_1", "completion_status": "success"}\n\n',
      ]),
    )
    await new Promise<void>((resolve) => {
      openResearchWritingStream(
        writingOptions({
          sessionRef: SOURCE_REF,
          onEvent: (event) => {
            events.push(event)
            if (event.type === 'done') resolve()
          },
        }),
      )
    })
    expect(fetchCall(fetchMock, 0).url).toBe(
      `${GATEWAY}/v1/research/projects/${PROJECT}/sources/src_1/chat/sessions/sess_src_1/writing`,
    )
    expect(fetchCall(fetchMock, 0).headers['X-Research-Contract']).toBe('v1')
    expect(fetchCall(fetchMock, 0).headers['X-Research-Session-Contract']).toBe(
      'research-session-v1',
    )
  })

  it('回执身份不符（draft_token）→ 不 attach、只一次 POST、protocol error', async () => {
    const fetchMock = installFetch(
      acceptResponse(writingAcceptReceipt({ draft_token: 't_other' })),
    )
    const protocolErrors: string[] = []
    const receipts: string[] = []
    await new Promise<void>((resolve) => {
      openResearchWritingStream(
        writingOptions({
          onEvent: () => resolve(),
          onAcceptReceipt: (receipt) => receipts.push(receipt.generationId),
          onProtocolError: (reason) => {
            protocolErrors.push(reason)
            resolve()
          },
        }),
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(receipts).toEqual([])
    expect(protocolErrors).toEqual(['invalid_accept_receipt:draft_token'])
  })

  it('写作回执必须闭合 10 键：缺 context_report → 拒绝 attach（不猜测）', async () => {
    const nineKeys = writingAcceptReceipt()
    delete nineKeys.context_report
    const fetchMock = installFetch(acceptResponse(nineKeys))
    const protocolErrors: string[] = []
    await new Promise<void>((resolve) => {
      openResearchWritingStream(
        writingOptions({
          onEvent: () => resolve(),
          onProtocolError: (reason) => {
            protocolErrors.push(reason)
            resolve()
          },
        }),
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(protocolErrors).toEqual(['invalid_accept_receipt:body_keys'])
    // 与 host 常量同源（键集漂移会在此测试暴露）。
    expect(WRITING_ACCEPT_RECEIPT_KEYS).toHaveLength(10)
  })

  it('422 session_contract_unsupported → onHttpError 保留状态码/稳定码，不 attach', async () => {
    const envelope = {
      detail: {
        code: 'session_contract_unsupported',
        message: 'X-Research-Session-Contract is required',
        retryable: false,
      },
    }
    const fetchMock = installFetch(errorResponse(422, envelope))
    const httpErrors: Array<[number, unknown]> = []
    await new Promise<void>((resolve) => {
      openResearchWritingStream(
        writingOptions({
          onEvent: () => resolve(),
          onHttpError: (status, body) => {
            httpErrors.push([status, body])
            resolve()
          },
        }),
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(httpErrors).toHaveLength(1)
    expect(httpErrors[0][0]).toBe(422)
    expect(
      (httpErrors[0][1] as { detail?: { code?: string } }).detail?.code,
    ).toBe('session_contract_unsupported')
  })

  it('EOF 无终态 → onEnd 恰好一次（调用方据此结算，不永久 streaming）', async () => {
    const fetchMock = installFetch(sseResponse([acceptedFrame()]))
    const ends: number[] = []
    await new Promise<void>((resolve) => {
      openResearchWritingStream(
        writingOptions({
          onEvent: (event) => events.push(event),
          onEnd: () => {
            ends.push(1)
            resolve()
          },
        }),
      )
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.type)).toEqual(['usage'])
    expect(ends).toEqual([1])
  })
})
