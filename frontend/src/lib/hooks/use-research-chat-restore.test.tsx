import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { StrictMode } from 'react'
import { useResearchChat, type ResearchChatTurn } from './use-research-chat'
import {
  openResearchChatStream,
  getResearchChatSession,
  type ResearchGlobalChatSessionDetail,
} from '@/lib/research/api'

// Issue #302 Red：全局 Research Chat 刷新恢复——turns 纯内存导致 F5 即清空；
// 后端已逐轮持久化（GET /chat/sessions/{session_id} 返回 messages+cards）。
// 本套测试钉死：done/响应头首知 session_id 即写 localStorage（key 含
// project_id）；mount 时若有持久化 id → 分页拉取详情重放为 turns →
// 续接同一会话；在途后台轮经 cards 如实呈现（不显示假进行中）。

vi.mock('@/lib/research/api', () => ({
  newIdempotencyKey: vi.fn(() => 'ik-turn'),
  openResearchChatStream: vi.fn(),
  getResearchChatSession: vi.fn(),
}))

const STORAGE_PREFIX = 'rdlens.research.chat.last-session.'

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`
}

const MODEL = 'm-local'

/** 已持久化的两轮消息（user+assistant ×2，阅读顺序） */
function detailWith(
  messages: ResearchGlobalChatSessionDetail['messages'],
  cards: ResearchGlobalChatSessionDetail['cards'] = [],
  sessionId = 'sess_r1',
): ResearchGlobalChatSessionDetail {
  return {
    session: {
      session_id: sessionId,
      title: null,
      owner_user_id: 7,
      created_at: '2026-09-03T00:00:00Z',
      updated_at: '2026-09-03T00:10:00Z',
    },
    messages,
    cards,
    next_cursor: null,
  }
}

function persistedTurn(
  role: 'user' | 'assistant',
  messageId: string,
  overrides: Partial<ResearchGlobalChatSessionDetail['messages'][number]> = {},
): ResearchGlobalChatSessionDetail['messages'][number] {
  return {
    message_id: messageId,
    role,
    content: '',
    thinking: null,
    citations: [],
    usage: null,
    resolved_mode: null,
    ...overrides,
  }
}

function lastAssistant(turns: ResearchChatTurn[]): ResearchChatTurn {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'assistant') return turns[i]
  }
  throw new Error('no assistant turn')
}

interface StreamCapture {
  opts: Parameters<typeof openResearchChatStream>[0]
  emitHeaders: (headers: Headers) => void
  emit: (event: Parameters<Parameters<typeof openResearchChatStream>[0]['onEvent']>[0]) => void
  httpFail: (status: number, body?: unknown) => void
}

function openCapture(): StreamCapture[] {
  const streams: StreamCapture[] = []
  vi.mocked(openResearchChatStream).mockImplementation((opts) => {
    streams.push({
      opts,
      emitHeaders: (headers) => opts.onResponseMeta?.(headers),
      emit: (event) => opts.onEvent(event),
      httpFail: (status, body) => opts.onHttpError?.(status, body),
    })
    return () => {}
  })
  return streams
}

describe('useResearchChat restore（Issue #302）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    // 必须 reset 而非 restore：工厂 vi.fn 不经 vi.spyOn，restoreAllMocks 不
    // 清其调用历史/once 队列（跨测试累计会污染 toHaveBeenCalledWith 断言）
    vi.resetAllMocks()
    localStorage.clear()
  })

  it('首轮 done 携带 session_id → 写入 localStorage（key 含 project_id）', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    act(() => {
      result.current.send('你好', undefined, MODEL)
    })
    expect(localStorage.getItem(storageKey('proj_1'))).toBeNull()

    act(() => {
      streams[0].emit({ event_id: 1, type: 'done', session_id: 'sess_a', request_id: 'r1' })
    })
    expect(localStorage.getItem(storageKey('proj_1'))).toBe('sess_a')

    // 不同 project 互不覆盖
    expect(localStorage.getItem(storageKey('proj_2'))).toBeNull()
    expect(result.current.turns.length).toBe(2)
  })

  it('流响应头 X-Chat-Session-Id 首知即写 localStorage（刷新窗口早于 done）', () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))

    act(() => {
      result.current.send('问题', undefined, MODEL)
    })
    act(() => {
      streams[0].emitHeaders(new Headers({ 'X-Chat-Session-Id': 'sess_hdr' }))
    })
    expect(localStorage.getItem(storageKey('proj_1'))).toBe('sess_hdr')

    // 后续轮续接该会话
    act(() => {
      result.current.send('第二轮', undefined, MODEL)
    })
    expect(streams[1].opts.request.session_id).toBe('sess_hdr')
  })

  it('有持久化 session：mount 拉取详情并重放为 turns（字段映射），不打开流', async () => {
    const streams = openCapture()
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    vi.mocked(getResearchChatSession).mockResolvedValue(
      detailWith([
        persistedTurn('user', 'msg_g1_user', { content: '你好' }),
        persistedTurn('assistant', 'msg_g1_assistant', {
          content: '你好，我是研究助手',
          thinking: '（无思考）',
          citations: [{ citation_id: 'c1', claim: '陈述', doc_id: 'd1', page_idx: null }],
          usage: { input_tokens: 0, output_tokens: 5 },
          resolved_mode: 'system',
        }),
      ]),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(getResearchChatSession).toHaveBeenCalledWith('proj_1', 'sess_r1', {})
    expect(streams).toHaveLength(0)
    expect(result.current.isStreaming).toBe(false)

    const turns = result.current.turns
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ role: 'user', content: '你好', status: 'done' })
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      content: '你好，我是研究助手',
      thinking: '（无思考）',
      resolvedMode: 'system',
      status: 'done',
      reconnectCount: 0,
      errorCode: null,
    })
    expect(turns[1].usage).toEqual({ input_tokens: 0, output_tokens: 5 })
  })

  it('重放后继续问答续接同一会话（请求体 session_id = 恢复的 id）', async () => {
    const streams = openCapture()
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    vi.mocked(getResearchChatSession).mockResolvedValue(
      detailWith([
        persistedTurn('user', 'msg_g1_user', { content: '你好' }),
        persistedTurn('assistant', 'msg_g1_assistant', { content: '在的' }),
      ]),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      result.current.send('继续', undefined, MODEL)
    })
    expect(streams).toHaveLength(1)
    expect(streams[0].opts.request.session_id).toBe('sess_r1')
    // 恢复的两条 + 新发两条
    expect(result.current.turns).toHaveLength(4)
  })

  it('无持久化 session：mount 不拉详情、保持空态', async () => {
    const streams = openCapture()
    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(getResearchChatSession).not.toHaveBeenCalled()
    expect(result.current.turns).toHaveLength(0)
    expect(streams).toHaveLength(0)
  })

  it('StrictMode 双挂载：首轮 effect 取消后恢复仍执行并生效', async () => {
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    vi.mocked(getResearchChatSession).mockResolvedValue(
      detailWith([
        persistedTurn('user', 'msg_g1_user', { content: '你好' }),
        persistedTurn('assistant', 'msg_g1_assistant', { content: '在的' }),
      ]),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    })
    await act(async () => {
      await Promise.resolve()
    })

    // 首轮被 cleanup 取消、第二轮重新拉取（去重状态允许重跑）
    expect(vi.mocked(getResearchChatSession).mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(result.current.turns).toHaveLength(2)
    expect(result.current.turns[1].content).toBe('在的')
  })

  it('GET 失败（404）：静默回退空态并清除失效的持久化 id，不弹错', async () => {
    localStorage.setItem(storageKey('proj_1'), 'sess_stale')
    vi.mocked(getResearchChatSession).mockRejectedValue(
      Object.assign(new Error('Session not found'), { status: 404 }),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(localStorage.getItem(storageKey('proj_1'))).toBeNull()
    expect(result.current.turns).toHaveLength(0)
    expect(result.current.isStreaming).toBe(false)
  })

  it('分页：next_cursor 非空时继续拉取合并，直至 null', async () => {
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    const page1 = detailWith([
      persistedTurn('user', 'msg_1_user', { content: 'q1' }),
      persistedTurn('assistant', 'msg_1_assistant', { content: 'a1' }),
    ])
    page1.next_cursor = 'cursor-2'
    const page2 = detailWith([
      persistedTurn('user', 'msg_2_user', { content: 'q2' }),
      persistedTurn('assistant', 'msg_2_assistant', { content: 'a2' }),
    ])
    vi.mocked(getResearchChatSession)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getResearchChatSession).toHaveBeenNthCalledWith(1, 'proj_1', 'sess_r1', {})
    expect(getResearchChatSession).toHaveBeenNthCalledWith(2, 'proj_1', 'sess_r1', {
      cursor: 'cursor-2',
    })
    expect(result.current.turns).toHaveLength(4)
    expect(result.current.turns[2].content).toBe('q2')
  })

  it('在途后台轮：cards 仍有 running → backgroundNotice 如实呈现，不显示假进行中', async () => {
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    vi.mocked(getResearchChatSession).mockResolvedValue(
      detailWith(
        [
          persistedTurn('user', 'msg_g1_user', { content: '上一轮问题' }),
          persistedTurn('assistant', 'msg_g1_assistant', { content: 'a1' }),
          persistedTurn('user', 'msg_g2_user', { content: '在途问题' }),
        ],
        [
          {
            generation_id: 'gen_2',
            job_id: null,
            status: 'running',
            failure_code: null,
            created_at: '2026-09-03T00:11:00Z',
          },
        ],
      ),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.turns).toHaveLength(3)
    expect(result.current.isStreaming).toBe(false)
    expect(result.current.backgroundNotice).toEqual({
      kind: 'running',
      count: 1,
      failureCode: null,
    })
  })

  it('cards 为 failed（含 failure_code）→ backgroundNotice kind=failed；全部完成/无 cards → null', async () => {
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    vi.mocked(getResearchChatSession).mockResolvedValue(
      detailWith(
        [
          persistedTurn('user', 'msg_g1_user', { content: 'q' }),
          persistedTurn('assistant', 'msg_g1_assistant', { content: 'a' }),
        ],
        [
          {
            generation_id: 'gen_9',
            job_id: null,
            status: 'failed',
            failure_code: 'delivery_dead_letter',
            created_at: '2026-09-03T00:12:00Z',
          },
        ],
      ),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.backgroundNotice).toEqual({
      kind: 'failed',
      count: 1,
      failureCode: 'delivery_dead_letter',
    })

    // 第二项目：无 cards（全部完成）→ null
    localStorage.setItem(storageKey('proj_2'), 'sess_r2')
    vi.mocked(getResearchChatSession).mockResolvedValue(
      detailWith(
        [
          persistedTurn('user', 'msg_1_user', { content: 'q' }),
          persistedTurn('assistant', 'msg_1_assistant', { content: 'a' }),
        ],
        [],
        'sess_r2',
      ),
    )
    const second = renderHook(() => useResearchChat({ projectId: 'proj_2' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(second.result.current.backgroundNotice).toBeNull()
  })

  it('恢复期间用户抢先发问：恢复结果不覆盖新对话，且新轮续接存储的同一会话', async () => {
    const streams = openCapture()
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    let resolveRestore: (detail: ResearchGlobalChatSessionDetail) => void = () => {}
    vi.mocked(getResearchChatSession).mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve
      }),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })

    // 恢复尚未返回时用户直接发问（sessionIdRef 已同步存储值 → 续接同一会话）
    act(() => {
      result.current.send('新问题', undefined, MODEL)
    })
    expect(streams).toHaveLength(1)
    expect(streams[0].opts.request.session_id).toBe('sess_r1')

    // 恢复此刻才返回：不得把旧历史灌进已开始的对话
    await act(async () => {
      resolveRestore(
        detailWith([
          persistedTurn('user', 'msg_old_user', { content: '旧问题' }),
          persistedTurn('assistant', 'msg_old_assistant', { content: '旧答案' }),
        ]),
      )
      await Promise.resolve()
    })

    expect(result.current.turns).toHaveLength(2)
    expect(result.current.turns[0].content).toBe('新问题')
  })

  it('评审 HIGH-1：running 卡恢复后发问遇首 409 → 终态 error（不按缓冲重连死锁）；旧轮结束后重发成功', async () => {
    const streams = openCapture()
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    vi.mocked(getResearchChatSession).mockResolvedValue(
      detailWith(
        [persistedTurn('user', 'msg_g1_user', { content: '旧问题' })],
        [
          {
            generation_id: 'gen_2',
            job_id: null,
            status: 'running',
            failure_code: null,
            created_at: '2026-09-03T00:11:00Z',
          },
        ],
      ),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.backgroundNotice).toEqual({
      kind: 'running',
      count: 1,
      failureCode: null,
    })

    // 在途轮未结束时用户发问：首请求即 409（会话被占用）
    act(() => {
      result.current.send('继续', undefined, MODEL)
    })
    expect(streams).toHaveLength(1)
    act(() => {
      // 真实 wire 形态（评审 R-B）：全局 /chat begin_turn 占用 409 的
      // detail 是纯字符串（str(exc)），非对象
      streams[0].httpFail(409, {
        detail: "turn already in progress for session 'sess_r1'",
      })
    })

    const busy = streams[0]
    expect(busy).toBeTruthy()
    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('conflict_busy')
    expect(turn.errorMessage).toMatch(/turn already in progress/)

    // 关键：绝不进入退避重连（旧逻辑会命中 failed 行恒 409 死锁）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(streams).toHaveLength(1)
    expect(result.current.isStreaming).toBe(false)

    // 旧轮完成后用户重发（每次 send 新幂等键）→ 续接同一会话成功
    act(() => {
      result.current.send('再问', undefined, MODEL)
    })
    expect(streams).toHaveLength(2)
    expect(streams[1].opts.request.session_id).toBe('sess_r1')
    act(() => {
      streams[1].emit({ event_id: 1, type: 'done', session_id: 'sess_r1' })
    })
    expect(lastAssistant(result.current.turns).status).toBe('done')
  })

  it('评审 MEDIUM-1：分页窗口内 commit 重写 created_at 致同 message_id 跨页重复 → 按 id 去重', async () => {
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    const page1 = detailWith([
      persistedTurn('user', 'msg_g1_user', { content: 'q1' }),
      persistedTurn('assistant', 'msg_g1_assistant', { content: 'a1' }),
    ])
    page1.next_cursor = 'cursor-2'
    // 第 2 页再次返回 msg_g1_user（键集游标在 UPSERT 后重定位）
    const page2 = detailWith([
      persistedTurn('user', 'msg_g1_user', { content: 'q1' }),
      persistedTurn('assistant', 'msg_g2_assistant', { content: 'a2' }),
    ])
    vi.mocked(getResearchChatSession)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.turns).toHaveLength(3)
    const ids = result.current.turns.map((t) => t.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('send 会清掉恢复期遗留的 backgroundNotice（新轮开始后不再提示旧的在途卡）', async () => {
    const streams = openCapture()
    localStorage.setItem(storageKey('proj_1'), 'sess_r1')
    vi.mocked(getResearchChatSession).mockResolvedValue(
      detailWith(
        [persistedTurn('user', 'msg_g1_user', { content: 'q' })],
        [
          {
            generation_id: 'gen_2',
            job_id: null,
            status: 'running',
            failure_code: null,
            created_at: '2026-09-03T00:11:00Z',
          },
        ],
      ),
    )

    const { result } = renderHook(() => useResearchChat({ projectId: 'proj_1' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.backgroundNotice).toEqual({
      kind: 'running',
      count: 1,
      failureCode: null,
    })

    act(() => {
      result.current.send('继续', undefined, MODEL)
    })
    expect(result.current.backgroundNotice).toBeNull()
    expect(streams[0].opts.request.session_id).toBe('sess_r1')
  })
})
