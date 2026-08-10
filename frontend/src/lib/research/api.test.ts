import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildResearchUrl,
  openResearchChatStream,
  requireResearchGateway,
  ResearchStreamHttpError,
} from './api'
import { clearResearchToken, setResearchToken } from '@/lib/embedded/token-store'
import type { ResearchSseEvent } from './types'

// UI-03 Red：Gateway 流式客户端（契约 v0 §9.5）——Last-Event-ID 重连头、
// 帧解析、409 resume_after 分类、网络错误分类、fail-closed 未配置。

const GATEWAY = 'https://gateway.example.com'
const PROJECT = 'proj_1'

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

function fetchMock(ok: boolean, status: number, body?: ReadableStream<Uint8Array>) {
  const response = {
    ok,
    status,
    body: body ?? null,
    json: async () => ({ detail: 'resume_after' }),
  }
  return vi.fn().mockResolvedValue(response)
}

describe('requireResearchGateway / buildResearchUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('嵌入式模式且配置 Gateway 时返回基址（去尾斜杠）', () => {
    vi.stubEnv('NEXT_PUBLIC_RD_EMBEDDED_MODE', '1')
    vi.stubEnv('NEXT_PUBLIC_RD_GATEWAY_URL', 'https://gw.example.com/')
    expect(requireResearchGateway()).toBe('https://gw.example.com')
  })

  it('未配置 Gateway fail-closed 抛错', () => {
    vi.stubEnv('NEXT_PUBLIC_RD_EMBEDDED_MODE', '1')
    vi.stubEnv('NEXT_PUBLIC_RD_GATEWAY_URL', '')
    expect(() => requireResearchGateway()).toThrow(/not configured/i)
  })

  it('非嵌入式模式抛错（Research 仅 Embedded 存在）', () => {
    vi.stubEnv('NEXT_PUBLIC_RD_EMBEDDED_MODE', '')
    expect(() => requireResearchGateway()).toThrow(/embedded/i)
  })

  it('buildResearchUrl 拼接项目路径并编码项目 id', () => {
    expect(buildResearchUrl('p/1', '/chat')).toBe('/v1/research/projects/p%2F1/chat')
  })
})

describe('openResearchChatStream', () => {
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

  it('POST /chat 携带 Authorization 与 Accept，解析帧并回调事件', async () => {
    const fetchMocked = fetchMock(true, 200, sseBody([
      'event: thinking\ndata: {"event_id": 1, "type": "thinking", "delta": "t"}\n\n',
      'event: answer\ndata: {"event_id": 2, "type": "answer", "delta": "a"}\n\n',
      'event: done\ndata: {"event_id": 3, "type": "done", "session_id": "s1", "completion_status": "success"}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMocked)

    await new Promise<void>((resolve) => {
      openResearchChatStream({
        projectId: PROJECT,
        request: { query: 'q', source_ids: ['src_1'] },
        onEvent: (event) => {
          events.push(event)
          if (event.type === 'done') resolve()
        },
      })
    })

    const [url, init] = fetchMocked.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${GATEWAY}/v1/research/projects/${PROJECT}/chat`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer research.jwt')
    expect(headers.Accept).toBe('text/event-stream')
    expect(headers['Last-Event-ID']).toBeUndefined()
    expect(JSON.parse(String(init.body))).toEqual({ query: 'q', source_ids: ['src_1'] })
    expect(events).toHaveLength(3)
    expect(events[2].type).toBe('done')
  })

  it('重连时携带 Last-Event-ID 头（从 n+1 恢复，契约 §9.5）', async () => {
    const fetchMocked = fetchMock(true, 200, sseBody([
      'event: answer\ndata: {"event_id": 3, "type": "answer", "delta": "c"}\n\n',
      'event: done\ndata: {"event_id": 4, "type": "done", "completion_status": "success"}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMocked)

    await new Promise<void>((resolve) => {
      openResearchChatStream({
        projectId: PROJECT,
        request: { query: 'q' },
        lastEventId: 2,
        onEvent: (event) => {
          if (event.type === 'done') resolve()
        },
      })
    })

    const headers = fetchMocked.mock.calls[0][1].headers as Record<string, string>
    expect(headers['Last-Event-ID']).toBe('2')
  })

  it('409（缓冲不足且任务进行中）分类为 ResearchStreamHttpError', async () => {
    const fetchMocked = fetchMock(false, 409)
    vi.stubGlobal('fetch', fetchMocked)

    await new Promise<void>((resolve) => {
      openResearchChatStream({
        projectId: PROJECT,
        request: { query: 'q' },
        onHttpError: (status) => {
          expect(status).toBe(409)
          resolve()
        },
      })
    })
    expect(fetchMocked).toHaveBeenCalledTimes(1)
  })

  it('网络错误（fetch reject）分类为网络回调', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    await new Promise<void>((resolve) => {
      openResearchChatStream({
        projectId: PROJECT,
        request: { query: 'q' },
        onNetworkError: (error) => {
          expect(error.message).toBe('Failed to fetch')
          resolve()
        },
      })
    })
  })

  it('流中途断开（reader 抛错）分类为网络回调且不回调事件', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: answer\ndata: {"event_id": 1, "type": "answer", "delta": "x"}\n\n'))
        controller.error(new Error('socket reset'))
      },
    })
    vi.stubGlobal('fetch', fetchMock(true, 200, body))

    await new Promise<void>((resolve) => {
      openResearchChatStream({
        projectId: PROJECT,
        request: { query: 'q' },
        onEvent: () => {
          throw new Error('事件不应在断开后被回调')
        },
        onNetworkError: (error) => {
          expect(error.message).toBe('socket reset')
          resolve()
        },
      })
    })
  })

  it('abort 返回函数中止请求且不触发网络错误回调', async () => {
    const fetchMocked = vi.fn().mockImplementation(
      () => new Promise((_, reject) => {
        const controller = new AbortController()
        controller.abort()
        reject(new DOMException('aborted', 'AbortError'))
      }),
    )
    vi.stubGlobal('fetch', fetchMocked)
    const onNetworkError = vi.fn()

    const abort = openResearchChatStream({
      projectId: PROJECT,
      request: { query: 'q' },
      onNetworkError,
    })
    abort()

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onNetworkError).not.toHaveBeenCalled()
  })

  it('非 409 的 HTTP 错误同样分类（状态码透传）', async () => {
    const fetchMocked = fetchMock(false, 422)
    vi.stubGlobal('fetch', fetchMocked)
    const errors: number[] = []
    await new Promise<void>((resolve) => {
      openResearchChatStream({
        projectId: PROJECT,
        request: { query: 'q' },
        onHttpError: (status) => {
          errors.push(status)
          resolve()
        },
      })
    })
    expect(errors).toEqual([422])
  })
})

describe('ResearchStreamHttpError', () => {
  it('携带 status 与 body', () => {
    const err = new ResearchStreamHttpError(409, { detail: 'resume_after' })
    expect(err.status).toBe(409)
    expect(err.message).toMatch(/409/)
  })
})
