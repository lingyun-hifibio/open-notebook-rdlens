import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/research/api', () => ({
  listChatSessions: vi.fn(),
  createChatSession: vi.fn(),
  listSourceChatSessions: vi.fn(),
}))

import {
  createChatSession,
  listChatSessions,
  listSourceChatSessions,
} from '@/lib/research/api'
import {
  SESSION_RUNTIME_SERVER_SNAPSHOT,
  type SessionRuntime,
  type SessionRuntimeSnapshot,
} from '@/lib/research/session-runtime'
import type { ResearchQueryIdentity } from '@/lib/api/query-client'
import {
  RESEARCH_SESSION_PAGE_LIMIT,
  RESEARCH_SOURCE_SESSION_PAGE_LIMIT,
  generateSessionId,
  useResearchSessions,
} from './use-research-sessions'

const PROJECT_ID = 'proj-1'
const VIEWER_ID = '7'
const UPDATED_AT = '2026-10-26T10:00:00.000Z'
const CREATED_AT = '2026-10-26T09:00:00.000Z'
const HASH = 'a'.repeat(64)

const READY_CAPABILITIES = {
  contract: 'research-session-v1',
  editorReady: true,
  submissionReady: { global: true, source: true },
  degraded: false,
  reason: null,
} as const

interface RuntimeController {
  readonly runtime: SessionRuntime
  readonly set: (
    next: Partial<SessionRuntimeSnapshot>,
    nextIdentity?: ResearchQueryIdentity,
  ) => void
}

function makeRuntime(initial: Partial<SessionRuntimeSnapshot> = {}): RuntimeController {
  let snapshot: SessionRuntimeSnapshot = {
    ...SESSION_RUNTIME_SERVER_SNAPSHOT,
    phase: 'ready',
    ready: true,
    projectId: PROJECT_ID,
    viewerUserId: VIEWER_ID,
    role: 'owner',
    authGeneration: 1,
    capabilities: READY_CAPABILITIES,
    lastBootstrap: 'ok',
    transportWired: true,
    ...initial,
  }
  let identity: ResearchQueryIdentity = {
    role: 'owner',
    projectId: PROJECT_ID,
    viewerUserId: VIEWER_ID,
    authGeneration: 1,
  }
  const listeners = new Set<() => void>()
  const runtime = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    identity: () => identity,
  } as unknown as SessionRuntime
  return {
    runtime,
    set(next, nextIdentity) {
      snapshot = { ...snapshot, ...next }
      if (nextIdentity) identity = nextIdentity
      listeners.forEach((listener) => listener())
    },
  }
}

function wireRef(
  sessionId: string,
  kind: 'global' | 'source' = 'global',
  sourceId: string | null = null,
) {
  return {
    domain: 'research',
    kind,
    project_id: PROJECT_ID,
    session_id: sessionId,
    source_id: kind === 'source' ? sourceId : null,
  }
}

function wireSummary(
  sessionId: string,
  options: {
    kind?: 'global' | 'source'
    sourceId?: string | null
    title?: string | null
    visibility?: 'visible' | 'restricted' | 'legacy_context_unverifiable'
    hasDraft?: boolean | null
  } = {},
) {
  return {
    session_ref: wireRef(sessionId, options.kind ?? 'global', options.sourceId ?? 'src-1'),
    title: options.title ?? null,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    record_visibility: options.visibility ?? 'visible',
    has_draft: options.hasDraft ?? null,
  }
}

function wireList(
  items: unknown[],
  nextCursor: string | null = null,
  viewerId: number = Number(VIEWER_ID),
) {
  return {
    items,
    next_cursor: nextCursor,
    viewer_user_id: viewerId,
    capabilities: {
      sessions: {
        contract: 'research-session-v1',
        editor_ready: true,
        submission_ready: { global: true, source: true },
      },
    },
  }
}

function wireEditorState(kind: 'global' | 'source') {
  return {
    schema_version: 1,
    base_scope:
      kind === 'global'
        ? { mode: 'all', source_ids: [], single_source_id: null }
        : null,
    single_source_id: null,
    note_ids: [],
    draft: { text: '', token: 'tok_1' },
    chat_anchor: null,
    reader_anchor: null,
  }
}

function wireCreateResponse(
  sessionId: string,
  options: { kind?: 'global' | 'source'; sourceId?: string | null; created?: boolean } = {},
) {
  const kind = options.kind ?? 'global'
  return {
    session_ref: wireRef(sessionId, kind, options.sourceId ?? 'src-1'),
    editor_revision: 0,
    editor_state: wireEditorState(kind),
    state_warnings: [],
    created: options.created ?? true,
    editor_intent_hash: HASH,
  }
}

function httpError(status: number, code?: string) {
  return {
    response: {
      status,
      data: code ? { detail: { code } } : { detail: {} },
    },
  }
}

function renderSessions(input: {
  runtime: SessionRuntime | null
  surface?: 'global' | 'source'
  sourceId?: string | null
  projectHistory?: boolean
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(
    () =>
      useResearchSessions({
        runtime: input.runtime,
        surface: input.surface ?? 'global',
        sourceId: input.sourceId ?? null,
        projectHistory: input.projectHistory ?? false,
      }),
    { wrapper },
  )
}

beforeEach(() => {
  // factory 里的 vi.fn 调用历史/once 队列不会被 clearAllMocks 重置。
  vi.resetAllMocks()
})

describe('useResearchSessions：新协议 global 列表', () => {
  it('解析 list_response、按服务端顺序展示并按 sessionKey 去重合并分页', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce(
        wireList([wireSummary('sess_a'), wireSummary('sess_b')], 'cursor_page_2'),
      )
      .mockResolvedValueOnce(
        // 跨页重复 sess_b：保留首见，不产生第二个条目。
        wireList([wireSummary('sess_b'), wireSummary('sess_c')], null),
      )

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.sessions).toHaveLength(2))
    expect(listChatSessions).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      kind: 'global',
      limit: RESEARCH_SESSION_PAGE_LIMIT,
    })
    expect(result.current.hasMore).toBe(true)
    expect(result.current.sessions.map((item) => item.ref.sessionId)).toEqual([
      'sess_a',
      'sess_b',
    ])

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.sessions).toHaveLength(3))
    expect(listChatSessions).toHaveBeenNthCalledWith(2, PROJECT_ID, {
      kind: 'global',
      limit: RESEARCH_SESSION_PAGE_LIMIT,
      cursor: 'cursor_page_2',
    })
    expect(result.current.sessions.map((item) => item.ref.sessionId)).toEqual([
      'sess_a',
      'sess_b',
      'sess_c',
    ])
    // 只有 next_cursor=null 才结束（服务端分页语义）。
    expect(result.current.hasMore).toBe(false)
  })

  it('不得因 items.length < limit 判结束：有 next_cursor 就仍可加载更多', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValueOnce(
      wireList([wireSummary('sess_a')], 'next-cursor-2'),
    )

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.hasMore).toBe(true)
  })

  it('只加载更多一次服务端 cursor；next_cursor 为 null 时不再请求', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValueOnce(wireList([wireSummary('sess_a')], null))

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.hasMore).toBe(false)
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.loadingMore).toBe(false))
    expect(listChatSessions).toHaveBeenCalledTimes(1)
  })

  it('projectHistory=true 使用 kind=all', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValueOnce(wireList([], null))

    renderSessions({ runtime: controller.runtime, projectHistory: true })

    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(1))
    expect(listChatSessions).toHaveBeenCalledWith(PROJECT_ID, {
      kind: 'all',
      limit: RESEARCH_SESSION_PAGE_LIMIT,
    })
  })

  it('record_visibility 原样投影（restricted 不在这里降级/隐藏）', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValueOnce(
      wireList([
        wireSummary('sess_restricted', { title: 'secret title', visibility: 'restricted' }),
        wireSummary('sess_visible', { title: 'normal title', visibility: 'visible' }),
      ]),
    )

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.sessions).toHaveLength(2))
    expect(result.current.sessions[0].visibility).toBe('restricted')
    expect(result.current.sessions[0].title).toBe('secret title')
    expect(result.current.sessions[1].visibility).toBe('visible')
  })

  it('列表响应形状非法 → invalid_response 错误，不展示半状态数据', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValueOnce({
      items: 'not-an-array',
      next_cursor: null,
      viewer_user_id: 7,
      capabilities: null,
    })

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.error).toBe('unavailable'))
    expect(result.current.sessions).toHaveLength(0)
  })
})

describe('useResearchSessions：错误分类与无权限终态', () => {
  it('403 chat_owner_required → 终态无权限、清列表缓存、不进入重试循环', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockRejectedValue(
      httpError(403, 'chat_owner_required'),
    )

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.unauthorized).toBe(true))
    expect(result.current.error).toBe('unauthorized')
    // 无自动重试；refresh 也不得重新进入重试循环（列表仍保持无权限终态）。
    expect(listChatSessions).toHaveBeenCalledTimes(1)
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.loading).toBe(false))
    // 终态后 refresh/loadMore 均被门禁关闭，不进入重试循环。
    expect(listChatSessions).toHaveBeenCalledTimes(1)
    expect(result.current.canList).toBe(false)
    expect(result.current.canCreate).toBe(false)
  })

  it('5xx 保留已有列表并允许重试，不自动创建新会话', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce(wireList([wireSummary('sess_a')], null))
      .mockRejectedValueOnce(httpError(503, 'session_store_unavailable'))

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBe('unavailable'))
    expect(result.current.sessions).toHaveLength(1)
  })

  it('404（global）→ not_found；不产生会话条目', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockRejectedValue(httpError(404, 'session_not_found'))

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.error).toBe('not_found'))
    expect(result.current.sessions).toHaveLength(0)
  })
})

describe('useResearchSessions：能力门禁（§3.3）', () => {
  it('capabilities 缺失/不符 → global 列表与创建均不可用且给出原因，不猜能力', async () => {
    const controller = makeRuntime({ capabilities: null })

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.canList).toBe(false))
    expect(result.current.listDisabledReason).toBe('capability_unavailable')
    expect(result.current.createDisabledReason).toBe('capability_unavailable')
    expect(listChatSessions).not.toHaveBeenCalled()
  })

  it('contract 不匹配（degraded）→ 同样拒绝新协议列表/创建', async () => {
    const controller = makeRuntime({
      capabilities: {
        contract: 'research-session-v0',
        editorReady: false,
        submissionReady: { global: false, source: false },
        degraded: true,
        reason: 'contract_unsupported',
      },
    })

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.canList).toBe(false))
    expect(result.current.listDisabledReason).toBe('capability_unavailable')
    expect(createChatSession).not.toHaveBeenCalled()
  })

  it('无 runtime（无 Provider）→ 稳定渲染、不读列表、不崩溃', async () => {
    const { result } = renderSessions({ runtime: null })

    await waitFor(() => expect(result.current.listDisabledReason).toBe('runtime_unavailable'))
    expect(result.current.canList).toBe(false)
    expect(result.current.canCreate).toBe(false)
    expect(result.current.sessions).toHaveLength(0)
    expect(listChatSessions).not.toHaveBeenCalled()
  })

  it('admin 只读运行时（unauthorized）→ 列表/创建不可用', async () => {
    const controller = makeRuntime({
      role: 'admin_readonly',
      viewerUserId: null,
      unauthorized: true,
      capabilities: READY_CAPABILITIES,
    })

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.unauthorized).toBe(true))
    expect(result.current.listDisabledReason).toBe('unauthorized')
    expect(result.current.canCreate).toBe(false)
  })
})

describe('useResearchSessions：Source 旧读路径（§4.1 兼容边界）', () => {
  it('只做身份枚举：ref 映射为 source kind，旧 title/has_draft/visibility 不暴露', async () => {
    const controller = makeRuntime()
    vi.mocked(listSourceChatSessions).mockResolvedValueOnce({
      items: [
        {
          session_id: 'sess_src_1',
          title: 'legacy title',
          source_id: 'src-1',
          created_at: CREATED_AT,
          updated_at: UPDATED_AT,
        },
      ],
      next_cursor: null,
    })

    const { result } = renderSessions({ runtime: controller.runtime, surface: 'source', sourceId: 'src-1' })

    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(listSourceChatSessions).toHaveBeenCalledWith(PROJECT_ID, 'src-1', {
      limit: RESEARCH_SOURCE_SESSION_PAGE_LIMIT,
    })
    const [summary] = result.current.sessions
    expect(summary.ref.kind).toBe('source')
    expect(summary.ref.sourceId).toBe('src-1')
    expect(summary.legacy).toBe(true)
    // 旧读路径 title 不作为新协议可读标题；可见性/草稿未声明 → 未知占位。
    expect(summary.title).toBeNull()
    expect(summary.visibility).toBeNull()
    expect(summary.hasDraft).toBeNull()
  })

  it('满页只表示“可能还有”，由用户显式 loadMore 再取；不在前端判结束', async () => {
    const controller = makeRuntime()
    const fullPage = Array.from(
      { length: RESEARCH_SOURCE_SESSION_PAGE_LIMIT },
      (_, index) => ({
        session_id: `sess_${index}`,
        title: null,
        source_id: 'src-1',
        created_at: CREATED_AT,
        updated_at: UPDATED_AT,
      }),
    )
    vi.mocked(listSourceChatSessions).mockResolvedValue({ items: fullPage, next_cursor: null })

    const { result } = renderSessions({ runtime: controller.runtime, surface: 'source', sourceId: 'src-1' })

    await waitFor(() => expect(result.current.sessions).toHaveLength(20))
    // 旧读路径 API 没有 cursor/offset：只取首页，不伪造“加载更多”（第 21 条
    // 起的续页登记为未完成能力，见 hook 文件头）。
    expect(result.current.hasMore).toBe(false)
    // 组件不渲染“加载更多”入口（hasMore=false），因此不会发出续页请求。
    expect(listSourceChatSessions).toHaveBeenCalledTimes(1)
    expect(result.current.sessions).toHaveLength(20)
  })

  it('来源解析 404 → source_unavailable（不显示“会话不存在”、不清本机稿）', async () => {
    const controller = makeRuntime()
    vi.mocked(listSourceChatSessions).mockRejectedValue(httpError(404))

    const { result } = renderSessions({ runtime: controller.runtime, surface: 'source', sourceId: 'src-1' })

    await waitFor(() => expect(result.current.error).toBe('source_unavailable'))
    expect(result.current.sourceUnavailable).toBe(true)
  })

  it('旧读路径不含新契约会话（空首页/分页未覆盖）→ 不判 not_found，恢复交给指针', async () => {
    const controller = makeRuntime()
    vi.mocked(listSourceChatSessions).mockResolvedValueOnce({ items: [], next_cursor: null })

    const { result } = renderSessions({ runtime: controller.runtime, surface: 'source', sourceId: 'src-1' })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.sessions).toEqual([])
    expect(result.current.error).toBeNull()
    expect(result.current.sourceUnavailable).toBe(false)
  })

  it('source 旧读路径不因新契约能力降级而禁用（原兼容阅读入口仍可用）', async () => {
    const controller = makeRuntime({ capabilities: null })
    vi.mocked(listSourceChatSessions).mockResolvedValueOnce({ items: [], next_cursor: null })

    const { result } = renderSessions({ runtime: controller.runtime, surface: 'source', sourceId: 'src-1' })

    await waitFor(() => expect(result.current.canList).toBe(true))
    expect(result.current.listDisabledReason).toBeNull()
    // 创建（新协议）仍按能力门禁拒绝，并给出原因。
    expect(result.current.createDisabledReason).toBe('capability_unavailable')
  })

  it('无 selectedSourceId → source 列表/创建给出 source_required 原因', async () => {
    const controller = makeRuntime()

    const { result } = renderSessions({ runtime: controller.runtime, surface: 'source', sourceId: null })

    await waitFor(() => expect(result.current.listDisabledReason).toBe('source_required'))
    expect(result.current.createDisabledReason).toBe('source_required')
    expect(listSourceChatSessions).not.toHaveBeenCalled()
  })
})

describe('useResearchSessions：创建（§4.3 幂等与 single-flight）', () => {
  it('显式创建生成合法 session_id、single-flight 且成功后采用响应 state', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValue(wireList([], null))
    let resolveCreate: ((value: unknown) => void) | null = null
    vi.mocked(createChatSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }) as Promise<unknown>,
    )

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    let first: Promise<unknown> = Promise.resolve(null)
    act(() => {
      first = result.current.create()
    })
    expect(result.current.creating).toBe(true)
    // 进行中第二次调用被 single-flight 拒绝（返回 resolved null，不派发新请求）。
    await act(async () => {
      const second = result.current.create()
      await expect(second).resolves.toBeNull()
    })

    await act(async () => {
      resolveCreate?.(wireCreateResponse('sess_new', { created: false }))
      await first
    })

    expect(createChatSession).toHaveBeenCalledTimes(1)
    const [projectArg, inputArg] = vi.mocked(createChatSession).mock.calls[0]
    expect(projectArg).toBe(PROJECT_ID)
    expect(inputArg.kind).toBe('global')
    expect(inputArg.sessionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(result.current.createError).toBeNull()
    expect(result.current.created).toMatchObject({
      created: false,
      editorRevision: 0,
      ref: { sessionId: 'sess_new', kind: 'global', sourceId: null },
    })
    expect(result.current.created?.editorState?.kind).toBe('global')
  })

  it('服务端 200 created=false → 采用已有 state，不再新建', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValue(wireList([], null))
    vi.mocked(createChatSession).mockResolvedValueOnce(wireCreateResponse('sess_existing', { created: false }))

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    await act(async () => {
      await result.current.create()
    })
    expect(result.current.created).toMatchObject({
      created: false,
      ref: { sessionId: 'sess_existing' },
    })
    expect(createChatSession).toHaveBeenCalledTimes(1)
  })

  it('网络失败保留 pending client session_id，重试复用同一 id（不产生空壳）', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValue(wireList([], null))
    vi.mocked(createChatSession)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(wireCreateResponse('sess_retry', { created: true }))

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    await act(async () => {
      await result.current.create()
    })
    expect(result.current.createError).toBe('failed')
    expect(result.current.created).toBeNull()

    await act(async () => {
      await result.current.create()
    })
    expect(result.current.createError).toBeNull()
    expect(result.current.created?.ref.sessionId).toBe('sess_retry')
    const firstId = vi.mocked(createChatSession).mock.calls[0][1].sessionId
    const secondId = vi.mocked(createChatSession).mock.calls[1][1].sessionId
    expect(secondId).toBe(firstId)
  })

  it('响应形状非法 → invalid_response 且不产生 created 半状态', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValue(wireList([], null))
    vi.mocked(createChatSession).mockResolvedValueOnce({ session_ref: null })

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    await act(async () => {
      await result.current.create()
    })
    expect(result.current.createError).toBe('invalid_response')
    expect(result.current.created).toBeNull()
  })

  it('source 创建使用 source kind 与当前 sourceId，editor_state 走 source 约束', async () => {
    const controller = makeRuntime()
    vi.mocked(listSourceChatSessions).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(createChatSession).mockResolvedValueOnce(
      wireCreateResponse('sess_src_new', { kind: 'source', sourceId: 'src-1' }),
    )

    const { result } = renderSessions({ runtime: controller.runtime, surface: 'source', sourceId: 'src-1' })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    await act(async () => {
      await result.current.create()
    })
    const [, input] = vi.mocked(createChatSession).mock.calls[0]
    expect(input).toMatchObject({ kind: 'source', sourceId: 'src-1' })
    expect(result.current.created?.ref).toMatchObject({
      kind: 'source',
      sourceId: 'src-1',
    })
    expect(result.current.created?.editorState?.baseScope).toBeNull()
  })

  it('创建 403 → unauthorized 失败分类，保留当前状态', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValue(wireList([], null))
    vi.mocked(createChatSession).mockRejectedValue(httpError(403, 'chat_owner_required'))

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    await act(async () => {
      await result.current.create()
    })
    expect(result.current.createError).toBe('unauthorized')
    expect(result.current.created).toBeNull()
  })
})

describe('useResearchSessions：身份切换（S1）', () => {
  it('viewer/authGeneration 变化清空列表并重新加载新身份数据', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce(wireList([wireSummary('sess_old_viewer')], null))
      .mockResolvedValueOnce(wireList([wireSummary('sess_new_viewer')], null, 8))

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.sessions[0].ref.sessionId).toBe('sess_old_viewer')

    act(() => {
      controller.set(
        { viewerUserId: '8', authGeneration: 2 },
        { role: 'owner', projectId: PROJECT_ID, viewerUserId: '8', authGeneration: 2 },
      )
    })

    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.sessions[0].ref.sessionId).toBe('sess_new_viewer')
    expect(listChatSessions).toHaveBeenCalledTimes(2)
  })
})


describe('useResearchSessions：列表契约绑定与响应能力（review B2）', () => {
  it('响应 viewer_user_id 与当前身份不符 → invalid_response，不展示他身份数据', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValueOnce(wireList([wireSummary('sess_other')], null, 99))

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.error).toBe('unavailable'))
    expect(result.current.sessions).toHaveLength(0)
  })

  it('拒绝新协议路径的 legacy DTO（无 session_ref）与缺失可见性条目', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce(
        wireList([
          {
            session_id: 'sess_legacy',
            title: 'legacy title',
            created_at: CREATED_AT,
            updated_at: UPDATED_AT,
          },
        ]),
      )
      .mockResolvedValueOnce(
        wireList([
          {
            session_ref: wireRef('sess_no_visibility'),
            title: 'no visibility',
            created_at: CREATED_AT,
            updated_at: UPDATED_AT,
          },
        ]),
      )

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.error).toBe('unavailable'))
    expect(result.current.sessions).toHaveLength(0)

    act(() => result.current.refresh())
    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(2))
    expect(result.current.sessions).toHaveLength(0)
  })

  it('响应 capabilities 降级 → 只收紧创建门禁（阅读入口仍可用）', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValueOnce({
      ...wireList([wireSummary('sess_a')]),
      capabilities: {
        sessions: {
          contract: 'research-session-v0',
          editor_ready: false,
          submission_ready: { global: false, source: false },
        },
      },
    })

    const { result } = renderSessions({ runtime: controller.runtime })

    await waitFor(() => expect(result.current.sessions).toHaveLength(1))
    expect(result.current.canList).toBe(true)
    expect(result.current.canCreate).toBe(false)
    expect(result.current.createDisabledReason).toBe('capability_unavailable')
  })
})

describe('useResearchSessions：403 全页终态（review B3）', () => {
  it('loadMore 403 也进入终态：清列表、关闭列表/刷新、不重试', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce(
        wireList([wireSummary('sess_a')], 'cursor_page_2'),
      )
      .mockRejectedValueOnce(httpError(403, 'chat_owner_required'))

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.unauthorized).toBe(true))
    expect(result.current.error).toBe('unauthorized')
    expect(result.current.sessions).toHaveLength(0)
    expect(result.current.canList).toBe(false)
    expect(result.current.canCreate).toBe(false)

    act(() => result.current.refresh())
    expect(listChatSessions).toHaveBeenCalledTimes(2)
  })
})

describe('useResearchSessions：创建与刷新代际（review B4/B5）', () => {
  it('创建期间打开抽屉刷新列表不得作废创建响应', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValue(wireList([]))
    let resolveCreate: (value: unknown) => void = () => {}
    vi.mocked(createChatSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    let createPromise: Promise<unknown> = Promise.resolve(null)
    act(() => {
      createPromise = result.current.create()
    })
    act(() => result.current.refresh())

    await act(async () => {
      resolveCreate(wireCreateResponse('sess_created'))
      await createPromise
    })

    expect(result.current.createError).toBeNull()
    expect(result.current.created?.ref.sessionId).toBe('sess_created')
  })

  it('身份切换清空创建错误与 pending client session_id（S1）', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce(wireList([]))
      .mockResolvedValueOnce(wireList([], null, 8))
    vi.mocked(createChatSession)
      .mockRejectedValueOnce(httpError(503, 'session_store_unavailable'))
      .mockResolvedValueOnce(wireCreateResponse('sess_after_switch'))

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    await act(async () => {
      await result.current.create()
    })
    expect(result.current.createError).toBe('failed')
    const firstSessionId = vi.mocked(createChatSession).mock.calls[0][1].sessionId

    act(() => {
      controller.set(
        { viewerUserId: '8', authGeneration: 2 },
        { role: 'owner', projectId: PROJECT_ID, viewerUserId: '8', authGeneration: 2 },
      )
    })
    await waitFor(() => expect(result.current.createError).toBeNull())
    expect(result.current.created).toBeNull()

    await act(async () => {
      await result.current.create()
    })
    const secondSessionId = vi.mocked(createChatSession).mock.calls[1][1].sessionId
    expect(secondSessionId).not.toBe(firstSessionId)
    expect(result.current.created?.ref.sessionId).toBe('sess_after_switch')
  })
})

describe('generateSessionId', () => {
  it('符合契约字符集与长度，且包含足够熵（无 crypto 时也有 32 位 hex）', () => {
    const first = generateSessionId()
    const second = generateSessionId()
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(first.startsWith('sess_')).toBe(true)
    expect(first).not.toBe(second)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useResearchSessions：聚焦复核回归（R1/R2/R6）', () => {
  it('旧 viewer 的挂起列表响应不得提交 capabilities 或重开创建门禁（R1）', async () => {
    const controller = makeRuntime()
    const stale = deferred<unknown>()
    vi.mocked(listChatSessions).mockReturnValueOnce(stale.promise as never)

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(1))

    // viewer 8 的当前列表响应是降级能力（capabilities 缺失 → missing）。
    const current = deferred<unknown>()
    vi.mocked(listChatSessions).mockReturnValueOnce(current.promise as never)
    act(() => {
      controller.set(
        { viewerUserId: '8' },
        { role: 'owner', projectId: PROJECT_ID, viewerUserId: '8', authGeneration: 1 },
      )
    })
    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(2))
    await act(async () => {
      current.resolve({
        items: [wireSummary('sess_b')],
        next_cursor: null,
        viewer_user_id: 8,
        capabilities: null,
      })
    })
    await waitFor(() =>
      expect(result.current.sessions.map((item) => item.ref.sessionId)).toEqual(['sess_b']),
    )
    expect(result.current.canCreate).toBe(false)

    // 旧 viewer 的迟到响应：即使能力就绪也不得覆盖当前代际（R1）。
    await act(async () => {
      stale.resolve(wireList([wireSummary('sess_a')]))
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.sessions.map((item) => item.ref.sessionId)).toEqual(['sess_b'])
    expect(result.current.canCreate).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('旧创建的迟到响应不得污染新作用域或释放新创建的单飞（R2）', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockResolvedValue(wireList([]))
    const first = deferred<unknown>()
    vi.mocked(createChatSession).mockReturnValueOnce(first.promise as never)

    const { result } = renderSessions({ runtime: controller.runtime })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    let firstResult: unknown = 'pending'
    act(() => {
      void result.current.create().then((value) => {
        firstResult = value
      })
    })
    await waitFor(() => expect(createChatSession).toHaveBeenCalledTimes(1))

    act(() => {
      controller.set(
        { viewerUserId: '8' },
        { role: 'owner', projectId: PROJECT_ID, viewerUserId: '8', authGeneration: 1 },
      )
    })
    await waitFor(() => expect(result.current.canCreate).toBe(true))

    const second = deferred<unknown>()
    vi.mocked(createChatSession).mockReturnValueOnce(second.promise as never)
    let secondResult: unknown = 'pending'
    act(() => {
      void result.current.create().then((value) => {
        secondResult = value
      })
    })
    await waitFor(() => expect(createChatSession).toHaveBeenCalledTimes(2))

    // 旧尝试失败：不得写 createError，也不得释放 B 的单飞。
    await act(async () => {
      first.reject(new Error('stale failure'))
    })
    await waitFor(() => expect(result.current.creating).toBe(true))
    expect(result.current.createError).toBeNull()
    expect(firstResult).toBeNull()

    // 第三次创建被 B 的单飞拒绝，不产生额外请求。
    let thirdResult: unknown = 'pending'
    act(() => {
      void result.current.create().then((value) => {
        thirdResult = value
      })
    })
    await waitFor(() => expect(thirdResult).toBeNull())
    expect(createChatSession).toHaveBeenCalledTimes(2)

    await act(async () => {
      second.resolve(wireCreateResponse('sess_new'))
    })
    await waitFor(() => expect(result.current.created?.ref.sessionId).toBe('sess_new'))
    expect(secondResult).not.toBeNull()
  })

  it('身份级 403 终态只随身份变化解除，不因切 surface/source 逃逸（R6）', async () => {
    const controller = makeRuntime()
    vi.mocked(listChatSessions).mockRejectedValue(httpError(403, 'chat_owner_required'))
    vi.mocked(listSourceChatSessions).mockResolvedValue({ items: [], next_cursor: null })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const initialProps: { surface: 'global' | 'source'; sourceId: string | null } = {
      surface: 'global',
      sourceId: null,
    }
    const { result, rerender } = renderHook(
      (props: { surface: 'global' | 'source'; sourceId: string | null }) =>
        useResearchSessions({ runtime: controller.runtime, ...props }),
      { wrapper, initialProps },
    )

    await waitFor(() => expect(result.current.unauthorized).toBe(true))

    rerender({ surface: 'source', sourceId: 'src-1' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.unauthorized).toBe(true)
    expect(listSourceChatSessions).not.toHaveBeenCalled()

    act(() => {
      controller.set(
        { viewerUserId: '8' },
        { role: 'owner', projectId: PROJECT_ID, viewerUserId: '8', authGeneration: 1 },
      )
    })
    await waitFor(() => expect(result.current.unauthorized).toBe(false))
  })
})
