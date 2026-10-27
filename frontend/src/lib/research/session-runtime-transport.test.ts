import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listChatSessions } from '@/lib/research/api'
import {
  SESSION_CONTRACT_VERSION,
  type ResearchSessionCapabilities,
} from '@/lib/research/session-contract'
import { createSessionRuntimeTransport } from './session-runtime-transport'

// PR-8 / 6b：真实 bootstrap transport 的判别映射。
// 证据级别：simulated（mock 传输层；不连真实 Gateway）。真实 7896 UI 验证单独记录。
//
// 冻结 wire：GET /chat/sessions?kind=all&limit=1 + X-Research-Session-Contract
// （由 api.ts `listChatSessions` 负责），响应严格经 `session-contract.parseListResponse`。
vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return { ...actual, listChatSessions: vi.fn() }
})

const listChatSessionsMock = vi.mocked(listChatSessions)

const SCOPE = {
  authGeneration: 3,
  projectId: 'proj_abc',
  viewerUserId: '1',
  role: 'owner',
} as const

const READY_CAPABILITIES = {
  sessions: {
    contract: SESSION_CONTRACT_VERSION,
    editor_ready: true,
    submission_ready: { global: true, source: true },
  },
} as const

function listResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [],
    next_cursor: null,
    viewer_user_id: 1,
    capabilities: READY_CAPABILITIES,
    ...overrides,
  }
}

function httpError(status: number, detail?: unknown): Error {
  const error = new Error(`Request failed with status code ${status}`)
  Object.assign(error, {
    response: {
      status,
      data: detail === undefined ? undefined : { detail },
    },
  })
  return error
}

function networkError(): Error {
  const error = new Error('Network Error')
  Object.assign(error, { code: 'ERR_NETWORK' })
  return error
}

function timeoutError(): Error {
  const error = new Error('timeout of 10000ms exceeded')
  Object.assign(error, { code: 'ECONNABORTED' })
  return error
}

describe('createSessionRuntimeTransport.bootstrap', () => {
  beforeEach(() => {
    listChatSessionsMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('调用真实列表端点（kind=all / limit=1）并返回 viewer 与 capabilities', async () => {
    listChatSessionsMock.mockResolvedValue(listResponse())
    const transport = createSessionRuntimeTransport()

    const outcome = await transport.bootstrap(SCOPE)

    expect(listChatSessionsMock).toHaveBeenCalledTimes(1)
    expect(listChatSessionsMock).toHaveBeenCalledWith('proj_abc', { kind: 'all', limit: 1 })
    expect(outcome).toEqual({
      status: 'ok',
      viewerUserId: 1,
      capabilities: {
        contract: SESSION_CONTRACT_VERSION,
        editorReady: true,
        submissionReady: { global: true, source: true },
        degraded: false,
        reason: null,
      } satisfies ResearchSessionCapabilities,
    })
  })

  it('支持带条目的合法响应（只消费 viewer/capabilities，不读正文）', async () => {
    listChatSessionsMock.mockResolvedValue(
      listResponse({
        items: [
          {
            session_ref: {
              domain: 'research',
              kind: 'global',
              project_id: 'proj_abc',
              session_id: 'sess_1',
              source_id: null,
            },
            title: 'hello',
            created_at: '2026-10-27T10:00:00Z',
            updated_at: '2026-10-27T10:01:00Z',
            record_visibility: 'visible',
            has_draft: false,
          },
        ],
      }),
    )

    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.viewerUserId).toBe(1)
  })

  it('403 chat_owner_required → unauthorized（终态，不重试）', async () => {
    listChatSessionsMock.mockRejectedValue(
      httpError(403, {
        code: 'chat_owner_required',
        message: 'only the project owner may access chat history',
        retryable: false,
        request_id: 'req_1',
      }),
    )

    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toEqual({ status: 'unauthorized', code: 'chat_owner_required' })
  })

  it('其他 403 → unauthorized 且保留 envelope code', async () => {
    listChatSessionsMock.mockRejectedValue(
      httpError(403, { code: 'policy_denied', message: 'denied', retryable: false }),
    )

    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toEqual({ status: 'unauthorized', code: 'policy_denied' })
  })

  it('5xx + session envelope → error retryable true 且保留稳定码', async () => {
    listChatSessionsMock.mockRejectedValue(
      httpError(503, {
        code: 'session_store_unavailable',
        message: 'research chat store is unavailable',
        retryable: true,
        request_id: 'req_2',
      }),
    )

    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toEqual({
      status: 'error',
      code: 'session_store_unavailable',
      retryable: true,
    })
  })

  it('5xx 无 envelope → error retryable true（不伪造稳定码）', async () => {
    listChatSessionsMock.mockRejectedValue(new Error('Bad Gateway'))
    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toMatchObject({ status: 'error', retryable: true })
    if (outcome.status !== 'error') return
    expect(outcome.code).toBe('bootstrap_failed')
  })

  it('网络错误 → error retryable true / network_error', async () => {
    listChatSessionsMock.mockRejectedValue(networkError())
    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toEqual({ status: 'error', code: 'network_error', retryable: true })
  })

  it('超时 → error retryable true / timeout', async () => {
    listChatSessionsMock.mockRejectedValue(timeoutError())
    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toEqual({ status: 'error', code: 'timeout', retryable: true })
  })

  it('401 → error 非重试（交认证层刷新），保留 envelope code', async () => {
    listChatSessionsMock.mockRejectedValue(
      httpError(401, { code: 'token_expired', message: 'expired', retryable: false }),
    )

    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toEqual({ status: 'error', code: 'token_expired', retryable: false })
  })

  it('形状非法 → error invalid_response，不伪造 viewer/capabilities', async () => {
    listChatSessionsMock.mockResolvedValue(listResponse({ viewer_user_id: '1' }))
    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toEqual({ status: 'error', code: 'invalid_response', retryable: false })
    expect(outcome).not.toHaveProperty('viewerUserId')
    expect(outcome).not.toHaveProperty('capabilities')
  })

  it('非对象响应 → error invalid_response', async () => {
    listChatSessionsMock.mockResolvedValue('not-json-object')
    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome).toEqual({ status: 'error', code: 'invalid_response', retryable: false })
  })

  it('capabilities 降级（contract 不匹配）→ ok + 原样 degraded（交 §3.3 门禁）', async () => {
    listChatSessionsMock.mockResolvedValue(
      listResponse({
        capabilities: {
          sessions: {
            contract: 'research-session-v2',
            editor_ready: true,
            submission_ready: { global: true, source: true },
          },
        },
      }),
    )

    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.viewerUserId).toBe(1)
    expect(outcome.capabilities.degraded).toBe(true)
    expect(outcome.capabilities.contract).toBe('research-session-v2')
    expect(outcome.capabilities.editorReady).toBe(false)
  })

  it('capabilities 缺失 → ok + degraded missing（不让整页报错）', async () => {
    // 用删键构造“服务端未下发 capabilities”，不保留未使用的解构变量。
    const withoutCapabilities = listResponse()
    delete withoutCapabilities.capabilities
    listChatSessionsMock.mockResolvedValue(withoutCapabilities)

    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.capabilities.degraded).toBe(true)
    expect(outcome.capabilities.reason).toBe('missing')
  })

  it('不把 claims viewer 当作服务端确认：返回值原样来自响应', async () => {
    listChatSessionsMock.mockResolvedValue(listResponse({ viewer_user_id: 9 }))
    const outcome = await createSessionRuntimeTransport().bootstrap(SCOPE)

    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') return
    expect(outcome.viewerUserId).toBe(9)
  })
})
