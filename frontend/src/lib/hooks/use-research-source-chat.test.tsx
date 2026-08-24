import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  SOURCE_CHAT_MAX_STREAM_ATTEMPTS,
  useResearchSourceChat,
} from './use-research-source-chat'
import {
  getSourceChatSession,
  listSourceChatSessions,
  openResearchChatStream,
} from '@/lib/research/api'

// Issue #182 Red：Source-scoped Chat hook——预生成 session_id、Last-Event-ID
// 断线恢复（首轮任意非终态事件后）、无终态 EOF 重连/终态 EOF 不重连、
// 两类 409 分流（resume_after 重试 vs 活动冲突终态）、Gateway 不可用
// fail-closed、切换 Source 清理、GET detail 冷恢复映射。

vi.mock('@/lib/research/api', () => ({
  openResearchChatStream: vi.fn(),
  listSourceChatSessions: vi.fn(),
  getSourceChatSession: vi.fn(),
}))

interface StreamCapture {
  opts: Parameters<typeof openResearchChatStream>[0]
  emit: (event: Parameters<Parameters<typeof openResearchChatStream>[0]['onEvent']>[0]) => void
  fail: (error: Error) => void
  httpFail: (status: number, body?: unknown) => void
  end: () => void
}

function openCapture(): StreamCapture[] {
  const streams: StreamCapture[] = []
  vi.mocked(openResearchChatStream).mockImplementation((opts) => {
    streams.push({
      opts,
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
    renderHook(() => useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }))
    expect(listSourceChatSessions).toHaveBeenCalledWith('proj_1', 'src_1', { limit: 20 })
    // 不回退原生 /api/source-chat：本 hook 只经参数化 Gateway transport
    expect(vi.mocked(openResearchChatStream)).not.toHaveBeenCalled()
  })

  it('发送首条消息前预生成 sess_<uuid> 并随请求体携带；重连携带同 session + Last-Event-ID', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
    )

    act(() => {
      result.current.send('这篇论文的方法是什么？')
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

  it('usage 事件映射 resolvedMode/degradationReasons/sourceRef 到 turn 层（camelCase）', () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
    )

    act(() => {
      result.current.send('q')
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

  it('X-Chat-Session-Id 回显不一致时 console.warn 并存储回显值（不作其他行为依赖）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
    )

    act(() => {
      result.current.send('q')
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
    act(() => {
      result.current.send('第二轮')
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
    )

    act(() => {
      result.current.send('q')
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
    )

    act(() => {
      result.current.send('q')
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

  it('收到 done/error 后的正常 EOF 不重连', () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
    )

    act(() => {
      result.current.send('q')
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
    )

    act(() => {
      result.current.send('q')
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

  it('409 含 resume_after：按 hint 秒数延迟重试（计入退避预算）', async () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
    )

    act(() => {
      result.current.send('q')
      streams[0].httpFail(409, { detail: 'buffer insufficient', resume_after: 2 })
    })

    // hint=2s 内不得提前重试
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(streams).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1700)
    })
    expect(streams).toHaveLength(2)
    expect(lastAssistant(result.current.turns).status).not.toBe('error')

    // 恢复流完成
    act(() => {
      streams[1].emit(ev(1, 'done', { session_id: 'sess_x', completion_status: 'success' }))
    })
    expect(lastAssistant(result.current.turns).status).toBe('done')
  })

  it('409 无 resume_after（同 Source 同 session 活动 turn 冲突）：直接终态报错，不盲重试', () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
    )

    act(() => {
      result.current.send('q')
      streams[0].httpFail(409, { detail: 'another active turn for this session' })
    })

    const turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('conflict_busy')
    expect(turn.errorMessage).toContain('another active turn')
    expect(streams).toHaveLength(1)
  })

  it('Gateway 不可用（404/503）：fail-closed 终态错误（gateway_unavailable）+ 可重试 query，绝不回退原生端点', () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
    )

    act(() => {
      result.current.send('q')
      streams[0].httpFail(503, { detail: 'gateway unavailable' })
    })

    let turn = lastAssistant(result.current.turns)
    expect(turn.status).toBe('error')
    expect(turn.errorCode).toBe('gateway_unavailable')

    // retry() 重放最近一次失败 query（仍走参数化 Gateway 端点）
    expect(result.current.retryableQuery).toBe('q')
    act(() => {
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
        opts,
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
      { initialProps: { sourceId: 'src_1' } },
    )

    act(() => {
      result.current.send('第一问')
      streams[0].emit(ev(1, 'answer', { delta: '内容' }))
    })

    await act(async () => {
      rerender({ sourceId: 'src_2' })
    })

    expect(aborted).toBe(1)
    expect(result.current.turns).toEqual([])
    expect(result.current.activeSessionId).toBeNull()

    // 新 Source 首条消息生成全新 session_id
    act(() => {
      result.current.send('第二问')
    })
    const newSessionId = (streams[1].opts.request as { session_id?: string }).session_id
    expect(newSessionId).toMatch(/^sess_[0-9a-f-]{36}$/)
  })

  it('新会话按钮语义（selectSession(null)）：清空当前 session 与 turns，下次发送重新预生成', () => {
    const streams = openCapture()
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
    )

    act(() => {
      result.current.send('q')
      streams[0].emit(ev(1, 'done', { session_id: 'sess_x', completion_status: 'success' }))
    })
    expect(result.current.activeSessionId).toBe('sess_x')

    act(() => {
      result.current.selectSession(null)
    })
    expect(result.current.turns).toEqual([])
    expect(result.current.activeSessionId).toBeNull()

    act(() => {
      result.current.send('新会话首条')
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
    )

    await act(async () => {
      result.current.selectSession('sess_old')
    })

    expect(vi.mocked(getSourceChatSession)).toHaveBeenCalledWith('proj_1', 'src_1', 'sess_old')
    expect(result.current.activeSessionId).toBe('sess_old')
    expect(result.current.turns).toHaveLength(2)
    const [userTurn, assistantTurn] = result.current.turns
    expect(userTurn.role).toBe('user')
    expect(userTurn.content).toBe('问题')
    expect(userTurn.status).toBe('done')
    expect(assistantTurn.content).toBe('回答')
    expect(assistantTurn.resolvedMode).toBe('hybrid_rag')
    expect(assistantTurn.degradationReasons).toEqual(['source_over_direct_cap'])
    expect(assistantTurn.sourceRef).toEqual({ sourceId: 'src_1', documentId: 'doc_1', documentVersion: 'v1' })
    expect(assistantTurn.citations[0]).toMatchObject({ claim: '持久化声明', page_idx: 2 })

    // 冷恢复后续接：请求体带恢复的 session_id
    act(() => {
      result.current.send('续问')
    })
    expect((streams[0].opts.request as { session_id?: string }).session_id).toBe('sess_old')
  })

  it('冷恢复加载失败：loadDetailError 置位且不清空已有本地状态之外的行为可重试', async () => {
    vi.mocked(getSourceChatSession).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() =>
      useResearchSourceChat({ projectId: 'proj_1', sourceId: 'src_1' }),
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
    )
    await act(async () => {})
    expect(result.current.sessions).toHaveLength(1)
    expect(result.current.activeSessionId).toBeNull()
    expect(result.current.turns).toEqual([])
  })
})
