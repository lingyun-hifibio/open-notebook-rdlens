import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  SOURCE_CHAT_MAX_STREAM_ATTEMPTS,
  useResearchSourceChat,
} from './use-research-source-chat'
import {
  getSourceChatSession,
  listSourceChatSessions,
  openResearchChatStream,
} from '@/lib/research/api'
import type { ResearchSessionRef } from '@/lib/research/session-contract'
import type { ConversationController, SessionRuntime } from '@/lib/research/session-runtime'

/** #243 §6.4：调用方传入的 confirmed 全局模型快照 */
const MODEL = 'm-local'

// Issue #182 Red：Source-scoped Chat hook——预生成 session_id、Last-Event-ID
// 断线恢复（首轮任意非终态事件后）、无终态 EOF 重连/终态 EOF 不重连、
// 两类 409 分流（resume_after 重试 vs 活动冲突终态）、Gateway 不可用
// fail-closed、切换 Source 清理、GET detail 冷恢复映射。
// #243 §6.4：modelId 由调用方 required 传入（confirmed 全局模型快照）；
// 无模型 fail-closed 不发请求，重放沿用同一快照。

vi.mock('@/lib/research/api', () => ({
  saveResultFromResult: vi.fn(),
  openResearchChatStream: vi.fn(),
  listSourceChatSessions: vi.fn(),
  getSourceChatSession: vi.fn(),
  newIdempotencyKey: vi.fn(() => 'ik-src'),
}))

type LegacyStreamOptions = Extract<
  Parameters<typeof openResearchChatStream>[0],
  { protocol?: 'legacy' }
>

interface StreamCapture {
  opts: LegacyStreamOptions
  emit: (event: Parameters<Parameters<typeof openResearchChatStream>[0]['onEvent']>[0]) => void
  fail: (error: Error) => void
  httpFail: (status: number, body?: unknown) => void
  end: () => void
}

function openCapture(): StreamCapture[] {
  const streams: StreamCapture[] = []
  vi.mocked(openResearchChatStream).mockImplementation((opts) => {
    streams.push({
      opts: opts as LegacyStreamOptions,
      emit: (event) => opts.onEvent(event),
      fail: (error) => opts.onNetworkError?.(error),
      httpFail: (status, body) => opts.onHttpError?.(status, body),
      end: () => opts.onEnd?.(),
    })
    return () => {}
  })
  return streams
}

function ev(event_id: number, type: 'thinking' | 'answer' | 'citation' | 'usage' | 'done' | 'error', extra: Record<string, unknown> = {}) {
  return { event_id, type, ...extra } as Parameters<Parameters<typeof openResearchChatStream>[0]['onEvent']>[0]
}

function lastAssistant(turns: ReturnType<typeof useResearchSourceChat>['turns']) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'assistant') return turns[i]
  }
  throw new Error('no assistant turn')
}

function mockSessionsList(items: Array<Record<string, unknown>> = []): void {
  vi.mocked(listSourceChatSessions).mockResolvedValue({
    items: items as never,
    next_cursor: null,
  })
}

function makeHookWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function SourceChatHookWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

describe('useResearchSourceChat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSessionsList()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sessions 列表按 research-source-chat query key 只取首页（limit 20）', () => {
    renderHook(() => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }), {
      wrapper: makeHookWrapper(),
    })
    expect(listSourceChatSessions).toHaveBeenCalledWith('proj_1', 'src_1', { limit: 20 })
    // 不回退原生 /api/source-chat：本 hook 只经参数化 Gateway transport
    expect(vi.mocked(openResearchChatStream)).not.toHaveBeenCalled()
  })

  it('发送首条消息前预生成 sess_<uuid> 并随请求体携带；重连携带同 session + Last-Event-ID', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('这篇论文的方法是什么？', MODEL)
    })

    expect(streams).toHaveLength(1)
    const first = streams[0]
    expect(first.opts.path).toBe('/sources/src_1/chat')
    const sessionId = (first.opts.request as { session_id?: string }).session_id ?? ''
    expect(sessionId).toMatch(/^sess_[0-9a-f-]{36}$/)

    act(() => {
      first.emit(ev(1, 'answer', { delta: 'A' }))
    })
    act(() => {
      first.fail(new Error('socket reset'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(streams).toHaveLength(2)
    expect(streams[1].opts.lastEventId).toBe(1)
    expect((streams[1].opts.request as { session_id?: string }).session_id).toBe(sessionId)
  })

  it('usage 事件映射 resolvedMode/degradationReasons/sourceRef 到 turn 层（camelCase）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].emit(ev(1, 'citation', {
        citations: [{
          citation_id: 1,
          claim: '声明',
          doc_id: 'doc_1',
          doc_version: 'v2',
          chunk_id: 'chunk_1',
          page_idx: 3,
          original_text: '原文',
          citation_type: 'passage',
          confidence: 'high',
        }],
      }))
      streams[0].emit(ev(2, 'usage', {
        usage: { input_tokens: 100, output_tokens: 20 },
        resolved_mode: 'hybrid_rag',
        degradation_reasons: ['source_over_direct_cap'],
        source_ref: { source_id: 'src_1', document_id: 'doc_1', document_version: 'v2' },
      }))
      streams[0].emit(ev(3, 'done', { session_id: 'sess_x', completion_status: 'success' }))
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('done')
    expect(turn.resolvedMode).toBe('hybrid_rag')
    expect(turn.degradationReasons).toEqual(['source_over_direct_cap'])
    expect(turn.sourceRef).toEqual({
      sourceId: 'src_1',
      documentId: 'doc_1',
      documentVersion: 'v2',
    })
    expect(turn.citations).toEqual([expect.objectContaining({ claim: '声明', page_idx: 3 })])
  })

  it('X-Chat-Session-Id 回显不一致时 console.warn 并存储回显值（不作其他行为依赖）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    const sentSessionId = (streams[0].opts.request as { session_id?: string }).session_id

    act(() => {
      streams[0].opts.onResponseMeta?.(
        new Headers({ 'X-Chat-Session-Id': 'sess_server_generated' }) as unknown as Headers,
      )
      streams[0].emit(ev(1, 'done', { completion_status: 'success' }))
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain(sentSessionId)
    expect(warnSpy.mock.calls[0][0]).toContain('sess_server_generated')

    // 存储回显值：下一轮续接使用服务端回显的 session_id
    await act(async () => {
      result.current.send('第二轮', MODEL)
    })
    expect((streams[1].opts.request as { session_id?: string }).session_id).toBe('sess_server_generated')

    // 一致回显不告警
    warnSpy.mockClear()
    act(() => {
      streams[1].opts.onResponseMeta?.(
        new Headers({ 'X-Chat-Session-Id': 'sess_server_generated' }) as unknown as Headers,
      )
      streams[1].emit(ev(1, 'done', { completion_status: 'success' }))
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('首轮任意非终态事件后断线恢复：重放不重复追加且终态恰好一次', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].emit(ev(1, 'thinking', { delta: '思' }))
    })
    act(() => {
      streams[0].fail(new Error('socket reset'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    act(() => {
      streams[1].emit(ev(1, 'thinking', { delta: '思' })) // 服务端从 n+1 起重放含旧事件
      streams[1].emit(ev(2, 'answer', { delta: '答' }))
      streams[1].emit(ev(3, 'done', { session_id: 'sess_x', completion_status: 'success' }))
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.thinking).toBe('思')
    expect(turn.content).toBe('答')
    expect(turn.status).toBe('done')
  })

  it('未收到终态的正常 EOF 触发有限指数退避重连', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: '部分' }))
      streams[0].end()
    })
    expect(lastAssistant(result.current.turns).status).toBe('reconnecting')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(streams).toHaveLength(2)
    expect(streams[1].opts.lastEventId).toBe(1)
    expect(lastAssistant(result.current.turns).reconnectCount).toBe(1)
  })

  it('收到 done/error 后的正常 EOF 不重连', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].emit(ev(1, 'done', { session_id: 'sess_x', completion_status: 'success' }))
      streams[0].end()
    })

    expect(lastAssistant(result.current.turns).status).toBe('done')
    expect(streams).toHaveLength(1)
  })

  it(`EOF/断线超过 ${SOURCE_CHAT_MAX_STREAM_ATTEMPTS} 次后终态报错不再重连`, async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    for (let attempt = 1; attempt <= SOURCE_CHAT_MAX_STREAM_ATTEMPTS; attempt += 1) {
      act(() => {
        streams[streams.length - 1].end()
      })
      if (attempt < SOURCE_CHAT_MAX_STREAM_ATTEMPTS) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(300 * 2 ** (attempt - 1))
        })
      }
    }

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('stream_lost')
    expect(streams).toHaveLength(SOURCE_CHAT_MAX_STREAM_ATTEMPTS)
  })

  it('409 缓冲缺口：resume_after 为事件游标，Last-Event-ID=resume_after-1 接受缺口续放（有限退避）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'A' }))
      streams[0].httpFail(409, {
        detail: { message: 'event buffer gap: missing 2-4 (resume_after=5)', resume_after: 5 },
      })
    })
    expect(lastAssistant(result.current.turns).status).toBe('reconnecting')

    // 退避窗口内不提前重连
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(streams).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(streams).toHaveLength(2)
    // 关键：Last-Event-ID 跳到 resume_after-1（本地只收到 1，缺口 2-4 被接受）
    expect(streams[1].opts.lastEventId).toBe(4)

    // 服务端从缓冲最早可用事件续放：缺口后的事件必须被应用而非卡在乱序缓冲
    act(() => {
      streams[1].emit(ev(5, 'answer', { delta: 'B' }))
      streams[1].emit(ev(6, 'done', { session_id: 'sess_x', completion_status: 'success' }))
    })
    const turn = lastAssistant(result.current.turns)
    expect(turn.content).toBe('AB')
    expect(turn.status).toBe('done')
  })

  it('409 resume_after 不大于本地进度时不回退水位（沿用本地 lastEventId）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: 'a' }))
      streams[0].emit(ev(2, 'answer', { delta: 'b' }))
      streams[0].emit(ev(3, 'answer', { delta: 'c' }))
      streams[0].httpFail(409, {
        detail: { message: 'event buffer gap', resume_after: 2 },
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(streams).toHaveLength(2)
    expect(streams[1].opts.lastEventId).toBe(3)
  })

  it('409 无 resume_after/null（同 Source 同 session 活动 turn 冲突）：直接终态报错，不盲重试', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].httpFail(409, {
        detail: { message: 'another active turn for this session', resume_after: null },
      })
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('conflict_busy')
    expect(turn.errorMessage).toContain('another active turn')
    expect(streams).toHaveLength(1)
  })

  it('Gateway 不可用（404/503）：fail-closed 终态错误（gateway_unavailable）+ 可重试 query，绝不回退原生端点', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].httpFail(503, { detail: 'gateway unavailable' })
    })

    let turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('gateway_unavailable')

    // retry() 重放最近一次失败 query（仍走参数化 Gateway 端点）
    expect(result.current.retryableQuery).toBe('q')
    // #238：retry 同样走异步偏好前置 → 需冲刷
    await act(async () => {
      result.current.retry()
    })
    expect(streams).toHaveLength(2)
    expect(streams[1].opts.path).toBe('/sources/src_1/chat')
    expect(result.current.retryableQuery).toBeNull()

    act(() => {
      streams[1].emit(ev(1, 'done', { session_id: 'sess_x', completion_status: 'success' }))
    })
    turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('done')
  })

  it('切换 Source：中止旧流并清空 turns/session/sessions 引用', async () => {
    const streams = openCapture()
    let aborted = 0
    vi.mocked(openResearchChatStream).mockImplementation((opts) => {
      streams.push({
        opts: opts as LegacyStreamOptions,
        emit: (event) => opts.onEvent(event),
        fail: (error) => opts.onNetworkError?.(error),
        httpFail: (status, body) => opts.onHttpError?.(status, body),
        end: () => opts.onEnd?.(),
      })
      return () => {
        aborted += 1
      }
    })

    const { result, rerender } = renderHook(
      ({ sourceId }: { sourceId: string }) =>
        useResearchSourceChat({ projectId: 'proj_1', sourceId }),
      {
        initialProps: { sourceId: 'src_1' },
        wrapper: makeHookWrapper(),
      },
    )

    await act(async () => {
      result.current.send('第一问', MODEL)
    })
    act(() => {
      streams[0].emit(ev(1, 'answer', { delta: '内容' }))
    })

    await act(async () => {
      rerender({ sourceId: 'src_2' })
    })

    expect(aborted).toBe(1)
    expect(result.current.turns).toEqual([])
    expect(result.current.activeSessionId).toBeNull()

    // 新 Source 首条消息生成全新 session_id
    await act(async () => {
      result.current.send('第二问', MODEL)
    })
    const newSessionId = (streams[1].opts.request as { session_id?: string }).session_id
    expect(newSessionId).toMatch(/^sess_[0-9a-f-]{36}$/)
  })

  it('切换 Source 不 cancel：只中止本地读取，不发送服务端 cancel/abort 请求', async () => {
    // 工厂 vi.fn 的调用历史不会被 restoreAllMocks 重置（跨用例污染），显式清零。
    vi.mocked(openResearchChatStream).mockClear()
    vi.mocked(getSourceChatSession).mockClear()
    const streams = openCapture()
    let aborted = 0
    vi.mocked(openResearchChatStream).mockImplementation((opts) => {
      streams.push({
        opts: opts as LegacyStreamOptions,
        emit: (event) => opts.onEvent(event),
        fail: (error) => opts.onNetworkError?.(error),
        httpFail: (status, body) => opts.onHttpError?.(status, body),
        end: () => opts.onEnd?.(),
      })
      return () => {
        aborted += 1
      }
    })

    const { result, rerender } = renderHook(
      ({ sourceId }: { sourceId: string }) =>
        useResearchSourceChat({ projectId: 'proj_1', sourceId }),
      {
        initialProps: { sourceId: 'src_1' },
        wrapper: makeHookWrapper(),
      },
    )
    await act(async () => {
      result.current.send('问题', MODEL)
    })

    await act(async () => {
      rerender({ sourceId: 'src_2' })
    })

    // 本地读取中止 1 次（浏览器断开 ≠ 服务端取消）；不得再发任何取消/追加请求。
    expect(aborted).toBe(1)
    expect(openResearchChatStream).toHaveBeenCalledTimes(1)
    expect(getSourceChatSession).not.toHaveBeenCalled()
    expect(result.current.activeSessionId).toBeNull()
  })

  it('新会话按钮语义（selectSession(null)）：清空当前 session 与 turns，下次发送重新预生成', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })
    act(() => {
      streams[0].emit(ev(1, 'done', { session_id: 'sess_x', completion_status: 'success' }))
    })
    expect(result.current.activeSessionId).toBe('sess_x')

    act(() => {
      result.current.selectSession(null)
    })
    expect(result.current.turns).toEqual([])
    expect(result.current.activeSessionId).toBeNull()

    await act(async () => {
      result.current.send('新会话首条', MODEL)
    })
    const freshSessionId = (streams[1].opts.request as { session_id?: string }).session_id
    expect(freshSessionId).not.toBe('sess_x')
    expect(result.current.activeSessionId).toBe(freshSessionId)
  })

  it('选择历史会话冷恢复：GET detail 映射为 turns（17 字段 Citation/降级原因/source_ref）', async () => {
    vi.mocked(getSourceChatSession).mockResolvedValue({
      session: {
        session_id: 'sess_old',
        title: '历史会话',
        source_id: 'src_1',
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-02T00:00:00Z',
      },
      messages: [
        { message_id: 'm1', role: 'user', content: '问题', created_at: '2026-08-01T00:00:01Z' },
        {
          message_id: 'm2',
          role: 'assistant',
          content: '回答',
          thinking: '持久化的思考过程',
          created_at: '2026-08-01T00:00:02Z',
          resolved_mode: 'hybrid_rag',
          degradation_reasons: ['source_over_direct_cap'],
          source_ref: { source_id: 'src_1', document_id: 'doc_1', document_version: 'v1' },
          usage: { input_tokens: 10, output_tokens: 5 },
          citations: [{
            citation_id: 'c_1',
            claim: '持久化声明',
            chunk_id: 'chunk_9',
            doc_id: 'doc_1',
            doc_version: 'v1',
            page_idx: 2,
            section: null,
            original_text: '原文快照',
            citation_type: null,
            confidence: null,
            doc_display_name: null,
            short_name: null,
            doc_type: null,
            project_id: null,
            vlm_bboxes: null,
            minio_uri: null,
            source_path: null,
          }],
        },
      ],
      next_cursor: null,
    })

    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.selectSession('sess_old')
    })

    // RDLens #892 审查 F1：冷恢复读**尾部窗口**（order=desc + limit=50），
    // 不再读「第一页」（asc）。
    expect(vi.mocked(getSourceChatSession)).toHaveBeenCalledWith('proj_1', 'src_1', 'sess_old', {
      order: 'desc',
      limit: 50,
    })
    expect(result.current.activeSessionId).toBe('sess_old')
    expect(result.current.turns).toHaveLength(2)
    const [userTurn, assistantTurn] = result.current.turns
    expect(userTurn.role).toBe('user')
    expect(userTurn.content).toBe('问题')
    expect(userTurn.status).toBe('done')
    expect(assistantTurn.content).toBe('回答')
    expect(assistantTurn.thinking).toBe('持久化的思考过程')
    expect(assistantTurn.resolvedMode).toBe('hybrid_rag')
    expect(assistantTurn.degradationReasons).toEqual(['source_over_direct_cap'])
    expect(assistantTurn.sourceRef).toEqual({ sourceId: 'src_1', documentId: 'doc_1', documentVersion: 'v1' })
    expect(assistantTurn.citations[0]).toMatchObject({ claim: '持久化声明', page_idx: 2 })

    // 冷恢复后续接：请求体带恢复的 session_id
    await act(async () => {
      result.current.send('续问', MODEL)
    })
    expect((streams[0].opts.request as { session_id?: string }).session_id).toBe('sess_old')
  })

  it('冷恢复加载失败：loadDetailError 置位且不清空已有本地状态之外的行为可重试', async () => {
    vi.mocked(getSourceChatSession).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.selectSession('sess_bad')
    })
    expect(result.current.loadDetailError).toBeTruthy()
  })

  it('默认新会话：不自动选择最近历史会话', async () => {
    mockSessionsList([
      {
        session_id: 'sess_recent',
        title: '最近',
        source_id: 'src_1',
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-02T00:00:00Z',
      },
    ])
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )
    // 刷新 query observer 订阅与 promise microtask（fake timers 下两轮推进）
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.sessions).toHaveLength(1)
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.turns).toEqual([])
  })

  it('#243 §6.4：请求体显式携带调用方传入的模型快照（model_id）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', MODEL)
    })

    expect(streams[0].opts.request).toMatchObject({ model_id: 'm-local' })
    expect(streams[0].opts.idempotencyKey).toBe('ik-src')
  })

  it('#243 §6.4：无 confirmed 模型 → 错误 turn 且不打开流', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', '')
    })

    expect(streams).toHaveLength(0)
    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('model_required')
    expect(turn.errorMessage).toMatch(/select a research model/i)
  })

  it('#243 §6.4：retry 重放沿用失败时的模型快照（不变量 4）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )

    await act(async () => {
      result.current.send('q', 'm-a')
    })
    act(() => {
      streams[0].emit(ev(1, 'error', { code: 'gateway_unavailable', message: 'down' }))
    })
    expect(result.current.retryableQuery).toBe('q')

    await act(async () => {
      result.current.retry()
    })

    expect(streams).toHaveLength(2)
    expect(streams[1].opts.request).toMatchObject({ model_id: 'm-a' })
  })
})

describe('PR-5a（D2）：显式 session 接线（source）', () => {
  it('经 runtime 创建对话控制器；卸载 detach + releaseConversation', () => {
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
      kind: 'source',
      projectId: 'proj_1',
      sessionId: 'sess_src_1',
      sourceId: 'src_1',
    }

    const { result, unmount } = renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )

    expect(conversation).toHaveBeenCalledTimes(1)
    expect(conversation.mock.calls[0]?.[0]).toEqual(ref)
    expect(result.current.conversation).toBe(controller)

    unmount()
    expect(controller.detach).toHaveBeenCalled()
    expect(releaseConversation).toHaveBeenCalledWith(ref, controller)
  })

  it('详情迟到：切换到另一 source 会话后旧详情不得写回 turns（review-4 #2）', async () => {
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
      target.sessionId === 'sess_src_a' ? controllerA : controllerB)
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const refA: ResearchSessionRef = {
      domain: 'research', kind: 'source', projectId: 'proj_1', sessionId: 'sess_src_a', sourceId: 'src_1',
    }
    const refB: ResearchSessionRef = { ...refA, sessionId: 'sess_src_b' }
    const { result, rerender } = renderHook(
      ({ ref }: { ref: ResearchSessionRef }) =>
        useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime, ref } }),
      { initialProps: { ref: refA }, wrapper: makeHookWrapper() },
    )
    rerender({ ref: refB })
    await act(async () => {
      resolveA({
        status: 'ok',
        value: {
          messages: [{ message_id: 'msg_src_a', role: 'assistant', content: 'A answer', created_at: '2026-01-01T00:00:00Z' }],
          next_cursor: null,
        },
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toEqual([])
  })

  it('切换到空 source 会话：上一会话已回填消息不得残留（review-5 B3）', async () => {
    const msgA = {
      message_id: 'msg_src_a',
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
      target.sessionId === 'sess_src_a' ? controllerA : controllerB)
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const refA: ResearchSessionRef = {
      domain: 'research', kind: 'source', projectId: 'proj_1', sessionId: 'sess_src_a', sourceId: 'src_1',
    }
    const refB: ResearchSessionRef = { ...refA, sessionId: 'sess_src_b' }
    const { result, rerender } = renderHook(
      ({ ref }: { ref: ResearchSessionRef }) =>
        useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime, ref } }),
      { initialProps: { ref: refA }, wrapper: makeHookWrapper() },
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
    expect(result.current.turns).toEqual([])
  })

  it('切换到加载中的 source 会话：旧会话消息必须立即清空（review-5 B3）', async () => {
    const msgA = {
      message_id: 'msg_src_a2',
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
      target.sessionId === 'sess_src_a' ? controllerA : controllerB)
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    const refA: ResearchSessionRef = {
      domain: 'research', kind: 'source', projectId: 'proj_1', sessionId: 'sess_src_a', sourceId: 'src_1',
    }
    const refB: ResearchSessionRef = { ...refA, sessionId: 'sess_src_b' }
    const { result, rerender } = renderHook(
      ({ ref }: { ref: ResearchSessionRef }) =>
        useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime, ref } }),
      { initialProps: { ref: refA }, wrapper: makeHookWrapper() },
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
    expect(result.current.turns).toEqual([])
  })

  // PR-7 P0-2（6b 真实接入）：服务端 `SourceSessionSubmission` 是
  // `extra="forbid"`，session 协议 source 请求体只允许
  // `session_id/editor_revision/draft_token/editor_intent_hash/query/model_id/
  // context_level`——顶层 `source_ids` 会 422 `extra_forbidden`。source 以路径
  // source_id 定位，wire 只写 query/model_id（身份字段由 api.ts 追加）。
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

    renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )
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
        modelId: 'm-a',
        sourceIds: [],
        noteIds: [],
        scope: null,
      })
    })
    expect(captures).toHaveLength(1)
    expect(captures[0].opts.protocol).toBe('research-session-v1')
    const request = captures[0].opts.request as unknown as Record<string, unknown>
    expect(Object.keys(request).sort()).toEqual(['model_id', 'query'])
    expect(request.source_ids).toBeUndefined()
    expect(request.source_scope).toBeUndefined()
    expect(request.note_ids).toBeUndefined()
  })
})

// RDLens #892：源会话 detail 与全局同构——尾部窗口（order=desc）+「更早一页」。
// 此前 source 会话 detail 显式拒绝游标（source_detail_pagination_unsupported），
// 其前提（源详情接口没有 cursor 参数）已不成立。
describe('RDLens #892：源会话尾部窗口（desc）', () => {
  it('detail 不再拒绝游标：按 order=desc/limit=50 取尾部窗口，「更早一页」透传后向游标', async () => {
    const controller = {
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(async () => ({ status: 'ok' as const, value: { messages: [], next_cursor: null } })),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    } as unknown as ConversationController
    let capturedOptions: {
      transport: { loadDetail: (input: Record<string, unknown>) => Promise<unknown> }
    } | null = null
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
    vi.mocked(getSourceChatSession).mockResolvedValue({
      session: { session_id: 'sess_src_1', title: null },
      messages: [],
      next_cursor: null,
    } as never)

    renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )
    expect(capturedOptions).not.toBeNull()

    // 首读（恢复）= 尾部窗口。
    await act(async () => {
      await capturedOptions?.transport.loadDetail({ cursor: null, order: 'desc', limit: 50 })
    })
    expect(getSourceChatSession).toHaveBeenLastCalledWith('proj_1', 'src_1', 'sess_src_1', {
      order: 'desc',
      limit: 50,
    })

    // 「更早一页」：此前抛 source_detail_pagination_unsupported → 现在必须透传游标。
    await act(async () => {
      await capturedOptions?.transport.loadDetail({ cursor: 'c1', order: 'desc', limit: 50 })
    })
    expect(getSourceChatSession).toHaveBeenLastCalledWith('proj_1', 'src_1', 'sess_src_1', {
      cursor: 'c1',
      order: 'desc',
      limit: 50,
    })
  })
})

/**
 * RDLens #892 独立审查 F1/F6：
 * - F1：`selectSession` 走「读第一页 + 整表替换」活路径 → 与 controller 的
 *   desc 尾部读并发覆盖，最终显示哪一页取决于响应先后（非确定）。
 * - F6：source hook 完全没有详情序号守卫 → 迟到响应可乱序合并/替换。
 */
interface SourceTransportStub {
  loadDetail: (input: Record<string, unknown>) => Promise<unknown>
}

describe('RDLens #892 审查修复：source 会话详情读取', () => {
  interface SourceHarness {
    runtime: SessionRuntime
    controller: ConversationController
    transport: { loadDetail: (input: Record<string, unknown>) => Promise<unknown> }
  }

  function sourceHarness(options: {
    load?: () => Promise<unknown>
  } = {}): SourceHarness {
    const controller = {
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(options.load ?? (async () => ({
        status: 'ok' as const,
        value: { messages: [], next_cursor: null },
      }))),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    } as unknown as ConversationController
    let captured: { transport: SourceHarness['transport'] } | null = null
    const conversation = vi.fn((...args: unknown[]) => {
      captured = args[1] as typeof captured
      return controller
    })
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    return {
      runtime,
      controller,
      get transport() {
        if (captured === null) throw new Error('transport not captured')
        return captured.transport
      },
    }
  }

  const ref: ResearchSessionRef = {
    domain: 'research', kind: 'source', projectId: 'proj_1', sessionId: 'sess_src_1', sourceId: 'src_1',
  }

  const tailMessage = {
    message_id: 'msg_tail',
    role: 'assistant' as const,
    content: '最新答案',
    created_at: '2026-10-30T00:00:00Z',
  }
  const olderMessage = {
    message_id: 'msg_older',
    role: 'assistant' as const,
    content: '更早答案',
    created_at: '2026-10-29T00:00:00Z',
  }

  it('F1：selectSession 读尾部窗口（只发 order=desc + limit=50）', async () => {
    const h = sourceHarness()
    vi.mocked(getSourceChatSession).mockResolvedValue({
      session: { session_id: 'sess_src_other', title: null },
      messages: [tailMessage],
      next_cursor: null,
    } as never)
    const { result } = renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime: h.runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )
    // 判别力：只看**本次动作新增**的调用（该文件的 mock 调用历史跨用例累计），
    // 且该 sessionId 与 controller 的不同 → 只能由 selectSession 的调用满足。
    const before = vi.mocked(getSourceChatSession).mock.calls.length
    await act(async () => {
      // 独立 sessionId（与 controller 的 ref.sessionId 不同）。
      result.current.selectSession('sess_src_other')
      await Promise.resolve()
      await Promise.resolve()
    })
    const calls = vi.mocked(getSourceChatSession).mock.calls.slice(before)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['proj_1', 'src_1', 'sess_src_other', {
      order: 'desc',
      limit: 50,
    }])
  })

  it('F1：selectSession 读到的尾部窗口不得抹掉已加载的更早行', async () => {
    // controller 路径先回填「更早的一行 + 最新一行」。
    const h = sourceHarness({
      load: async () => ({
        status: 'ok' as const,
        value: { messages: [olderMessage, tailMessage], next_cursor: null },
      }),
    })
    vi.mocked(getSourceChatSession).mockResolvedValue({
      session: { session_id: 'sess_src_1', title: null },
      messages: [tailMessage],
      next_cursor: null,
    } as never)
    const { result } = renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime: h.runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(2)

    // selectSession 再读一次尾部窗口 → 合并而非整表替换（更早行不得消失）。
    const before = vi.mocked(getSourceChatSession).mock.calls.length
    await act(async () => {
      result.current.selectSession('sess_src_1')
      await Promise.resolve()
      await Promise.resolve()
    })
    // 判别力：只看本次动作新增的调用（mock 调用历史跨用例累计）。
    const calls = vi.mocked(getSourceChatSession).mock.calls.slice(before)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['proj_1', 'src_1', 'sess_src_1', {
      order: 'desc',
      limit: 50,
    }])
    expect(result.current.turns).toHaveLength(2)
    expect(result.current.turns.map((turn) => turn.content)).toEqual(['更早答案', '最新答案'])
  })

  it('M-1：切到空会话 → 上一会话的 durable 行必须清空（空窗口也整表替换）', async () => {
    const h = sourceHarness({
      load: async () => ({
        status: 'ok' as const,
        value: { messages: [olderMessage, tailMessage], next_cursor: null },
      }),
    })
    // 目标会话是空的（窗口 0 行）。
    vi.mocked(getSourceChatSession).mockResolvedValue({
      session: { session_id: 'sess_src_b', title: null },
      messages: [],
      next_cursor: null,
    } as never)
    const { result } = renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime: h.runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(2)

    await act(async () => {
      result.current.selectSession('sess_src_b')
      await Promise.resolve()
      await Promise.resolve()
    })
    // 空会话也必须整表替换：上一会话的行不得残留。
    expect(result.current.turns).toEqual([])
  })

  it('M-1：切到有内容的会话 → 不残留上一会话的 durable 行', async () => {
    const h = sourceHarness({
      load: async () => ({
        status: 'ok' as const,
        value: { messages: [olderMessage, tailMessage], next_cursor: null },
      }),
    })
    const nextMessage = {
      message_id: 'msg_next_session',
      role: 'assistant' as const,
      content: '新会话的答案',
      created_at: '2026-10-30T01:00:00Z',
    }
    vi.mocked(getSourceChatSession).mockResolvedValue({
      session: { session_id: 'sess_src_b', title: null },
      messages: [nextMessage],
      next_cursor: null,
    } as never)
    const { result } = renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime: h.runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(2)

    await act(async () => {
      result.current.selectSession('sess_src_b')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(1)
    expect(result.current.turns[0]?.content).toBe('新会话的答案')
  })

  it('口径：同会话合并**保留 live 轮**；跨会话整表替换（旧 live 轮也丢弃）', async () => {
    vi.mocked(getSourceChatSession).mockResolvedValue({
      session: { session_id: 'sess_live', title: null },
      messages: [tailMessage],
      next_cursor: null,
    } as never)
    // legacy 模式（不接 session runtime）：hook 自己的 send 会把 live 轮写进 turns。
    const { result } = renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
      { wrapper: makeHookWrapper() },
    )
    await act(async () => {
      result.current.selectSession('sess_live')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(1)

    // 发一条消息 → live 轮（user + assistant）进入 turns。
    await act(async () => {
      result.current.send('新问题', MODEL)
      await Promise.resolve()
    })
    const liveTurns = result.current.turns.filter((turn) => turn.id.startsWith('turn_'))
    expect(liveTurns.length).toBeGreaterThan(0)
    const beforeLive = result.current.turns.length

    // 同一会话再读一次 durable → **合并**：live 轮必须保留。
    await act(async () => {
      result.current.selectSession('sess_live')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(beforeLive)
    expect(result.current.turns.filter((turn) => turn.id.startsWith('turn_')).length)
      .toBe(liveTurns.length)

    // 跨会话 → **整表替换**：旧会话的 live 轮也必须丢弃。
    await act(async () => {
      result.current.selectSession('sess_other')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns).toHaveLength(1)
    expect(result.current.turns[0]?.content).toBe('最新答案')
  })

  it('R1：分页读不得触发跨会话整表替换（切会话后点「加载更早」不得替换当前会话内容）', async () => {
    const controllerRow = {
      message_id: 'msg_controller_session',
      role: 'assistant' as const,
      content: 'controller 会话的答案',
      created_at: '2026-10-30T00:00:00Z',
    }
    const controllerOlderRow = {
      message_id: 'msg_controller_older',
      role: 'assistant' as const,
      content: 'controller 会话的更早答案',
      created_at: '2026-10-29T00:00:00Z',
    }
    const displayedRow = {
      message_id: 'msg_displayed_session',
      role: 'assistant' as const,
      content: '当前会话的答案',
      created_at: '2026-10-30T02:00:00Z',
    }
    let capturedTransport: SourceTransportStub | null = null
    const controller = {
      detach: vi.fn(),
      hasActiveTurn: vi.fn(() => false),
      load: vi.fn(async () => ({
        status: 'ok' as const,
        value: { messages: [controllerRow], next_cursor: null },
      })),
      loadMore: vi.fn(async () => {
        // controller 的「更早一页」：属于 controller 会话，不是当前展示会话。
        await capturedTransport?.loadDetail({ cursor: 'back-1', order: 'desc', limit: 50 })
        return { status: 'ok' as const, value: { messages: [controllerOlderRow] } }
      }),
      getSnapshot: vi.fn(() => ({ turn: null, authGeneration: 1 })),
    } as unknown as ConversationController
    const conversation = vi.fn((...args: unknown[]) => {
      capturedTransport = (args[1] as { transport: SourceTransportStub })?.transport ?? null
      return controller
    })
    const runtime = {
      conversation,
      releaseConversation: vi.fn(),
      getSnapshot: () => ({ authGeneration: 1 }),
      subscribe: () => () => {},
    } as unknown as SessionRuntime
    vi.mocked(getSourceChatSession).mockImplementation((_p, _s, _source, options) => {
      const opts = options as { cursor?: string } | undefined
      // 带游标 = controller 会话的「更早一页」；不带游标 = 当前展示会话的尾部窗口。
      const payload = opts?.cursor === undefined
        ? {
          session: { session_id: 'sess_displayed', title: null },
          messages: [displayedRow],
          next_cursor: null,
        }
        : {
          session: { session_id: 'sess_src_1', title: null },
          messages: [controllerOlderRow],
          next_cursor: null,
        }
      return Promise.resolve(payload as never)
    })

    const { result } = renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // 切到「当前展示会话」：其尾部窗口成为当前内容。
    await act(async () => {
      result.current.selectSession('sess_displayed')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.turns.map((turn) => turn.content)).toEqual(['当前会话的答案'])

    // 点「加载更早」→ controller（仍绑在它自己的会话上）取回更早一页：
    // 当前会话的内容不得被 controller 会话的行整表替换。
    await act(async () => {
      await controller.loadMore()
      await Promise.resolve()
    })
    expect(result.current.turns.map((turn) => turn.content)).toEqual(['当前会话的答案'])
  })

  it('F6：迟到的旧详情响应整体丢弃（不得乱序并入 turns）', async () => {
    const h = sourceHarness()
    const responses: Array<(value: unknown) => void> = []
    vi.mocked(getSourceChatSession).mockImplementation((() => new Promise((resolve) => {
      responses.push(resolve as (value: unknown) => void)
    })) as never)
    const { result } = renderHook(
      () => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1', session: { runtime: h.runtime, ref } }),
      { wrapper: makeHookWrapper() },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    let older: Promise<unknown> = Promise.resolve()
    let newer: Promise<unknown> = Promise.resolve()
    await act(async () => {
      older = h.transport.loadDetail({ cursor: null, order: 'desc', limit: 50 })
      newer = h.transport.loadDetail({ cursor: null, order: 'desc', limit: 50 })
    })
    // 更新的一读先返回。
    await act(async () => {
      responses[1]?.({
        session: { session_id: 'sess_src_1', title: null },
        messages: [tailMessage],
        next_cursor: null,
      })
      await newer
    })
    expect(result.current.turns).toHaveLength(1)
    expect(result.current.turns[0]?.content).toBe('最新答案')

    // 迟到的旧响应：整体丢弃，不得并入（否则会出现乱序/重复行）。
    await act(async () => {
      responses[0]?.({
        session: { session_id: 'sess_src_1', title: null },
        messages: [olderMessage],
        next_cursor: null,
      })
      await older
    })
    expect(result.current.turns).toHaveLength(1)
    expect(result.current.turns[0]?.content).toBe('最新答案')
  })
})
