import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/research/api', () => ({
  createExport: vi.fn(),
  createInsight: vi.fn(),
  createNote: vi.fn(),
  createTransformation: vi.fn(),
  deleteNote: vi.fn(),
  getSource: vi.fn(),
  getTransformationResult: vi.fn(),
  listInsights: vi.fn(),
  listNotes: vi.fn(),
  listSources: vi.fn(),
  listTransformations: vi.fn(),
  listTransformationResults: vi.fn(),
  runTransformation: vi.fn(),
  saveResultFromResult: vi.fn(),
  updateNote: vi.fn(),
  listModels: vi.fn(),
  getExecutionPreferences: vi.fn(),
  patchExecutionPreferences: vi.fn(),
  getExternalEgressConsent: vi.fn(),
  acknowledgeExternalEgressConsent: vi.fn(),
}))

import {
  acknowledgeExternalEgressConsent,
  getExecutionPreferences,
  getExternalEgressConsent,
  listModels,
  listNotes,
  listSources,
  patchExecutionPreferences,
} from '@/lib/research/api'
import {
  ResearchWorkspaceProvider,
  useResearchWorkspace,
} from '@/lib/embedded/workspace-context'
import {
  SESSION_RUNTIME_SERVER_SNAPSHOT,
  createMutationRecord,
  createSessionRuntime,
  createTransportAttempt,
  getSessionRuntimeServerSnapshot,
  markTransportAttemptDispatched,
  transportAttemptMatches,
  type SessionRuntimeBootstrapOutcome,
  type SessionRuntimeSnapshot,
  type SessionRuntimeTransport,
} from '@/lib/research/session-runtime'
import {
  ResearchSessionRuntimeProvider,
  useResearchSessionRuntime,
  useSessionSnapshot,
} from '@/lib/hooks/research-session-runtime'
import {
  adminReadonlyResearchIdentity,
  ownerResearchIdentity,
  researchIdentityEquals,
  researchExecutionPreferencesIdentityKey,
  researchSourcesIdentityKey,
  purgeResearchAuthScope,
} from '@/lib/api/query-client'
import {
  SESSION_CACHE_PREFIX,
  clearSessionCacheMemoryFallback,
  readDraft,
  writeDraft,
  type SessionCacheAuthority,
  type SessionCacheStorage,
  type SessionDraftRecord,
} from '@/lib/research/session-cache'
import { useResearchSources } from '@/lib/hooks/use-research'
import {
  ResearchGlobalModelProvider,
  useResearchGlobalModel,
  type GuardedOperationCompletion,
  type UseResearchGlobalModelResult,
} from '@/lib/hooks/use-research-global-model'
import type { ResearchSessionCapabilities, ResearchSessionRef } from '@/lib/research/session-contract'
import type { ResearchModelOption } from '@/lib/research/types'

/**
 * 第三批 PR-1：认证代际 / QueryClient 身份隔离 / 会话运行时骨架。
 *
 * 证据级别：simulated（runtime、transport、hooks 全部 mock；不连真实服务端，
 * 不发送任何真实请求）。
 */

// ── 测试存储（禁止触碰真实 localStorage） ────────────────────────────────────

class MapStorage implements SessionCacheStorage {
  readonly map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

const P = 'proj_1'
const VIEWER = 'user_1'
const NOW = '2026-10-02T00:00:00Z'

const globalRef: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: P,
  sessionId: 'sess_global',
  sourceId: null,
}
const sourceRef: ResearchSessionRef = {
  domain: 'research',
  kind: 'source',
  projectId: P,
  sessionId: 'sess_source',
  sourceId: 'src_a',
}

const CAPABILITIES: ResearchSessionCapabilities = {
  contract: 'research-session-v1',
  editorReady: true,
  submissionReady: { global: true, source: true },
  degraded: false,
  reason: null,
}

function scopeFor(overrides: Partial<{ authGeneration: number; viewerUserId: string | null; role: 'owner' | 'admin_readonly' }> = {}) {
  return {
    authGeneration: 1,
    projectId: P,
    viewerUserId: VIEWER,
    role: 'owner' as const,
    ...overrides,
  }
}

function okTransport(viewerUserId: string | number = VIEWER): SessionRuntimeTransport & { calls: number } {
  const transport = {
    calls: 0,
    bootstrap: vi.fn(async (): Promise<SessionRuntimeBootstrapOutcome> => {
      transport.calls += 1
      return { status: 'ok', viewerUserId, capabilities: CAPABILITIES }
    }),
  }
  return transport as SessionRuntimeTransport & { calls: number }
}

function draftRecord(): SessionDraftRecord {
  return {
    version: 1,
    text: '内存 dirty 稿',
    token: 'draft_1',
    baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
    singleSourceId: null,
    noteIds: [],
    localVersion: 2,
    baseRevision: 3,
    savedAt: NOW,
    dirty: true,
  }
}

/** 写入 viewer 分区草稿（模拟同 viewer refresh 前已有未保存稿）。 */
function seedDraft(storage: SessionCacheStorage, generation = 1): SessionCacheAuthority {
  const authority: SessionCacheAuthority = {
    authenticatedViewerUserId: VIEWER,
    projectId: P,
    authGeneration: generation,
    currentAuthGeneration: generation,
  }
  writeDraft({ viewerUserId: VIEWER, projectId: P }, globalRef, 'writer_a', draftRecord(), { storage })
  return authority
}

function viewerAuthority(generation = 1): SessionCacheAuthority {
  return {
    authenticatedViewerUserId: VIEWER,
    projectId: P,
    authGeneration: generation,
    currentAuthGeneration: generation,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  clearSessionCacheMemoryFallback()
  vi.mocked(listSources).mockResolvedValue({ items: [], next_cursor: null })
  vi.mocked(listNotes).mockResolvedValue({ items: [], next_cursor: null })
})

// ── 运行时：bootstrap 状态机 ────────────────────────────────────────────────

describe('session-runtime：bootstrap 状态机（§3.2 / §3.6）', () => {
  it('无 viewer（Admin 只读）：初始 locked，start 后 ready 且能力降级，不伪装真实接入', () => {
    const storage = new MapStorage()
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      role: 'admin_readonly',
      storage,
      now: () => NOW,
    })
    expect(runtime.getSnapshot().phase).toBe('locked')
    runtime.start()
    const snapshot = runtime.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.ready).toBe(true)
    expect(snapshot.masked).toBe(false)
    expect(snapshot.transportWired).toBe(false)
    expect(snapshot.lastBootstrap).toBe('degraded')
    expect(snapshot.capabilities?.degraded).toBe(true)
    // Admin 身份可用，但不读 owner 本机分区
    expect(runtime.identity()).toEqual({ role: 'admin_readonly', projectId: P, authGeneration: 1 })
    expect(runtime.cacheScope()).toBeNull()
  })

  it('bootstrap ok：viewer 确认、能力就绪、owner 身份带 viewer', async () => {
    const storage = new MapStorage()
    const transport = okTransport('7')
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: '7',
      role: 'owner',
      storage,
      transport,
      now: () => NOW,
    })
    expect(runtime.getSnapshot().phase).toBe('masked')
    runtime.start()
    expect(runtime.getSnapshot().phase).toBe('bootstrapping')
    expect(runtime.getSnapshot().masked).toBe(true)
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe('ready'))
    expect(transport.calls).toBe(1)
    expect(runtime.getSnapshot().capabilities).toEqual(CAPABILITIES)
    expect(runtime.identity()).toEqual(ownerResearchIdentity(P, '7', 1))
    expect(runtime.cacheScope()).toEqual({ viewerUserId: '7', projectId: P })
  })

  it('403 chat_owner_required → unauthorized 终态，不重试', async () => {
    const transport: SessionRuntimeTransport = {
      bootstrap: vi.fn(async () => ({ status: 'unauthorized' as const, code: 'chat_owner_required' })),
    }
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage: new MapStorage(),
      transport,
      now: () => NOW,
    })
    runtime.start()
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe('unauthorized'))
    expect(runtime.getSnapshot().unauthorized).toBe(true)
    expect(runtime.getSnapshot().lastErrorCode).toBe('chat_owner_required')
    runtime.start()
    await Promise.resolve()
    expect(vi.mocked(transport.bootstrap)).toHaveBeenCalledTimes(1)
  })

  it('bootstrap 错误 → error 态并记录可重试错误码', async () => {
    const transport: SessionRuntimeTransport = {
      bootstrap: vi.fn(async () => ({
        status: 'error' as const,
        code: 'session_store_unavailable',
        retryable: true,
      })),
    }
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage: new MapStorage(),
      transport,
      now: () => NOW,
    })
    runtime.start()
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe('error'))
    expect(runtime.getSnapshot().lastErrorCode).toBe('session_store_unavailable')
    expect(runtime.getSnapshot().ready).toBe(false)
  })

  it('服务端 viewer 与 claims 不一致 → viewer_changed：立即遮蔽、清活动会话、清旧 viewer 分区与旧代查询缓存', async () => {
    const storage = new MapStorage()
    seedDraft(storage)
    const client = new QueryClient()
    const oldIdentity = ownerResearchIdentity(P, VIEWER, 1)
    const oldKey = researchSourcesIdentityKey(oldIdentity)
    client.setQueryData(oldKey, { items: ['旧用户数据'], next_cursor: null })

    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage,
      queryClient: client,
      transport: okTransport('999'),
      now: () => NOW,
    })
    runtime.activate('global', globalRef)
    runtime.start()
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe('viewer_changed'))
    const snapshot = runtime.getSnapshot()
    expect(snapshot.masked).toBe(true)
    expect(snapshot.viewerChanged).toBe(true)
    expect(snapshot.active).toEqual({ global: null, source: null })
    // 旧 viewer 本机分区被清除
    expect(readDraft({ viewerUserId: VIEWER, projectId: P }, viewerAuthority(), globalRef, 'writer_a', { storage })).toBeNull()
    await waitFor(() => expect(client.getQueryData(oldKey)).toBeUndefined())
  })

  it('masked 可显式设置（页头提示时遮蔽内容但不卸载 Provider）', () => {
    const storage = new MapStorage()
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage,
      now: () => NOW,
    })
    runtime.start()
    runtime.setMasked(true)
    expect(runtime.getSnapshot().masked).toBe(true)
    expect(runtime.getSnapshot().phase).toBe('masked')
    runtime.setMasked(false)
    expect(runtime.getSnapshot().masked).toBe(false)
  })
})

// ── 运行时：代际更新 / dispose / activate ──────────────────────────────────

describe('session-runtime：代际更新、写入守卫与活动会话（§3.2 / §3.4）', () => {
  it('同 viewer refresh：保留内存 dirty 稿，旧代回调 stale、新代回调 ok', () => {
    const storage = new MapStorage()
    seedDraft(storage)
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage,
      now: () => NOW,
    })
    runtime.start()
    expect(readDraft({ viewerUserId: VIEWER, projectId: P }, runtime.cacheAuthority(), globalRef, 'writer_a', { storage })?.text).toBe('内存 dirty 稿')
    runtime.updateAuth(scopeFor({ authGeneration: 2 }))
    // 同 viewer 新代：dirty 稿仍在（不销毁 editor store/本机分区）
    expect(readDraft({ viewerUserId: VIEWER, projectId: P }, runtime.cacheAuthority(), globalRef, 'writer_a', { storage })?.text).toBe('内存 dirty 稿')
    // 旧代迟到回调被丢弃
    expect(runtime.runIfCurrent(1, () => '旧代结果')).toEqual({ status: 'stale' })
    expect(runtime.runIfCurrent(2, () => '新代结果')).toEqual({ status: 'ok', value: '新代结果' })
    expect(runtime.getSnapshot().authGeneration).toBe(2)
  })

  it('viewer 变化：立即遮蔽、清活动会话、清旧 viewer 分区并清旧代查询缓存', async () => {
    const storage = new MapStorage()
    seedDraft(storage)
    const client = new QueryClient()
    const oldKey = researchSourcesIdentityKey(ownerResearchIdentity(P, VIEWER, 1))
    client.setQueryData(oldKey, { items: ['旧用户数据'] })
    let bootstrapCalls = 0
    const bootstrap = vi.fn(async (): Promise<SessionRuntimeBootstrapOutcome> => {
      bootstrapCalls += 1
      return bootstrapCalls === 1
        ? { status: 'ok', viewerUserId: VIEWER, capabilities: CAPABILITIES }
        : { status: 'ok', viewerUserId: 'user_2', capabilities: CAPABILITIES }
    })
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage,
      queryClient: client,
      transport: { bootstrap },
      now: () => NOW,
    })
    runtime.start()
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe('ready'))
    runtime.activate('global', globalRef)

    runtime.updateAuth(scopeFor({ viewerUserId: 'user_2', authGeneration: 2 }))
    const masked = runtime.getSnapshot()
    expect(masked.masked).toBe(true)
    expect(masked.viewerChanged).toBe(true)
    expect(masked.active).toEqual({ global: null, source: null })
    expect(readDraft({ viewerUserId: VIEWER, projectId: P }, viewerAuthority(), globalRef, 'writer_a', { storage })).toBeNull()
    await waitFor(() => expect(client.getQueryData(oldKey)).toBeUndefined())
    // 新代 bootstrap 以服务端 viewer 为准 → ready，旧内容不复用
    await waitFor(() => expect(runtime.getSnapshot().phase).toBe('ready'))
    expect(runtime.getSnapshot().viewerChanged).toBe(false)
    expect(runtime.cacheScope()).toEqual({ viewerUserId: 'user_2', projectId: P })
  })

  it("dispose('logout') 先失效写入再清理：guard stale、活动清空、本机分区清除", () => {
    const storage = new MapStorage()
    seedDraft(storage)
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage,
      now: () => NOW,
    })
    runtime.start()
    runtime.activate('global', globalRef)
    const guard = runtime.createWriteGuard('editor-flush')
    expect(guard.run(() => 'flush')).toEqual({ status: 'ok', value: 'flush' })
    runtime.dispose('logout')
    expect(runtime.isDisposed()).toBe(true)
    expect(runtime.active('global')).toBeNull()
    expect(guard.run(() => 'cleanup flush 旧稿')).toEqual({ status: 'stale' })
    expect(
      readDraft({ viewerUserId: VIEWER, projectId: P }, viewerAuthority(), globalRef, 'writer_a', { storage }),
    ).toBeNull()
  })

  it("dispose('unmount') 只释放本地资源、不失效写入（可尽力写缓存）", () => {
    const storage = new MapStorage()
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage,
      now: () => NOW,
    })
    runtime.start()
    const guard = runtime.createWriteGuard('cache-on-unmount')
    runtime.dispose('unmount')
    expect(runtime.isDisposed()).toBe(true)
    // 取消挂载不得把写入判 stale：日常卸载允许尽力写本机缓存
    expect(guard.run(() => 'write cache')).toEqual({ status: 'ok', value: 'write cache' })
  })

  it('activate 双 surface 独立：global 与 source 同时存在，display 指针不覆盖 surface 指针', () => {
    const storage = new MapStorage()
    const runtime = createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage,
      now: () => NOW,
    })
    runtime.start()
    expect(runtime.activate('global', globalRef)).toBe(true)
    expect(runtime.activate('source', sourceRef)).toBe(true)
    expect(runtime.active('global')).toEqual(globalRef)
    expect(runtime.active('source')).toEqual(sourceRef)
    const keys = [...storage.map.keys()]
    expect(keys.some((key) => key.startsWith(`${SESSION_CACHE_PREFIX}.global.`))).toBe(true)
    expect(keys.some((key) => key.startsWith(`${SESSION_CACHE_PREFIX}.source.`))).toBe(true)

    runtime.setDisplayPointer({ version: 1, surface: 'source', sourceId: 'src_a', ref: sourceRef })
    expect(runtime.active('global')).toEqual(globalRef)
    expect(runtime.active('source')).toEqual(sourceRef)
    const afterDisplay = [...storage.map.keys()]
    expect(afterDisplay.some((key) => key.startsWith(`${SESSION_CACHE_PREFIX}.display.`))).toBe(true)
    // 清除 source 不影响 global
    expect(runtime.activate('source', null)).toBe(true)
    expect(runtime.active('source')).toBeNull()
    expect(runtime.active('global')).toEqual(globalRef)
    // 错误 kind 的 ref 被拒绝（不写入错误分区）
    expect(runtime.activate('source', globalRef)).toBe(false)
  })

  it('MutationRecord 不可变（深冻结），TransportAttempt 绑定代际/viewer 且可标记派发', () => {
    const record = createMutationRecord({
      mutationId: 'mut_1',
      kind: 'save',
      ref: globalRef,
      requestBody: { draft: { text: '原样请求体', nested: { value: 1 } } },
      baseRevision: 4,
      createdAt: NOW,
    })
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.requestBody)).toBe(true)
    expect(Object.isFrozen((record.requestBody.draft as Record<string, unknown>).nested)).toBe(true)
    expect(record.status).toBe('pending')
    expect(record.baseRevision).toBe(4)

    const attempt = createTransportAttempt({
      attemptId: 'attempt_1',
      mutationId: 'mut_1',
      scope: scopeFor({ authGeneration: 2, viewerUserId: VIEWER }),
      sessionKey: 'research.v1|proj_1|global||sess_global',
      createdAt: NOW,
    })
    expect(attempt.dispatchState).toBe('not-dispatched')
    expect(transportAttemptMatches(attempt, scopeFor({ authGeneration: 2 }))).toBe(true)
    expect(transportAttemptMatches(attempt, scopeFor({ authGeneration: 1 }))).toBe(false)
    expect(transportAttemptMatches(attempt, scopeFor({ authGeneration: 2, viewerUserId: 'user_2' }))).toBe(false)
    expect(markTransportAttemptDispatched(attempt).dispatchState).toBe('dispatched')
  })
})

// ── 运行时 Provider：StrictMode / SSR / 订阅 ────────────────────────────────

function RuntimeConsumer() {
  const runtime = useResearchSessionRuntime()
  const snapshot = useSessionSnapshot()
  return (
    <div>
      <span data-testid="phase">{snapshot.phase}</span>
      <span data-testid="generation">{snapshot.authGeneration}</span>
      <span data-testid="masked">{String(snapshot.masked)}</span>
      <span data-testid="active-global">{runtime.active('global')?.sessionId ?? ''}</span>
    </div>
  )
}

describe('ResearchSessionRuntimeProvider：StrictMode 与 SSR 稳定快照（§3.4 / §10.3）', () => {
  it('StrictMode 双挂载不重复 bootstrap（按代际/项目去重）', async () => {
    const storage = new MapStorage()
    const transport = okTransport(VIEWER)
    render(
      <StrictMode>
        <ResearchSessionRuntimeProvider
          authGeneration={1}
          projectId={P}
          viewerUserId={VIEWER}
          role="owner"
          storage={storage}
          transport={transport}
        >
          <RuntimeConsumer />
        </ResearchSessionRuntimeProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'))
    expect(transport.calls).toBe(1)
    expect(screen.getByTestId('generation').textContent).toBe('1')
    expect(screen.getByTestId('masked').textContent).toBe('false')
  })

  it('provider 随 authGeneration 更新代际；旧代快照不得复用于新代', () => {
    const storage = new MapStorage()
    const { rerender } = render(
      <ResearchSessionRuntimeProvider
        authGeneration={1}
        projectId={P}
        viewerUserId={VIEWER}
        role="owner"
        storage={storage}
      >
        <RuntimeConsumer />
      </ResearchSessionRuntimeProvider>,
    )
    expect(screen.getByTestId('generation').textContent).toBe('1')
    expect(screen.getByTestId('phase').textContent).toBe('ready')
    rerender(
      <ResearchSessionRuntimeProvider
        authGeneration={2}
        projectId={P}
        viewerUserId={VIEWER}
        role="owner"
        storage={storage}
      >
        <RuntimeConsumer />
      </ResearchSessionRuntimeProvider>,
    )
    expect(screen.getByTestId('generation').textContent).toBe('2')
  })

  it('SSR：server snapshot 为模块级冻结常量，无 Provider 时 useSessionSnapshot 稳定返回该常量', () => {
    expect(getSessionRuntimeServerSnapshot()).toBe(SESSION_RUNTIME_SERVER_SNAPSHOT)
    expect(getSessionRuntimeServerSnapshot()).toBe(getSessionRuntimeServerSnapshot())
    expect(Object.isFrozen(SESSION_RUNTIME_SERVER_SNAPSHOT)).toBe(true)
    expect(SESSION_RUNTIME_SERVER_SNAPSHOT.phase).toBe('locked')
    expect(SESSION_RUNTIME_SERVER_SNAPSHOT.projectId).toBe('')

    const snapshots: SessionRuntimeSnapshot[] = []
    function SsrConsumer() {
      const snapshot = useSessionSnapshot()
      snapshots.push(snapshot)
      return <span data-testid="ssr-phase">{snapshot.phase}</span>
    }
    const { rerender } = render(<SsrConsumer />)
    expect(screen.getByTestId('ssr-phase').textContent).toBe('locked')
    const first = snapshots[snapshots.length - 1]
    rerender(<SsrConsumer />)
    expect(snapshots[snapshots.length - 1]).toBe(first)
    expect(first).toBe(SESSION_RUNTIME_SERVER_SNAPSHOT)
  })

  it('useResearchSessionRuntime 无 Provider 时抛错（fail-closed）', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => renderHook(() => useResearchSessionRuntime())).toThrow(/research session runtime/i)
    } finally {
      consoleError.mockRestore()
    }
  })
})

// ── QueryClient 身份隔离与旧代清理 ─────────────────────────────────────────

describe('QueryClient：判别身份键与旧代清理（§3.2 / §3.5）', () => {
  it('owner 键含 viewer 与代际；admin 键不含 viewer；身份相等的语义区分 role/generation/viewer', () => {
    const owner1 = ownerResearchIdentity(P, VIEWER, 1)
    const owner1b = ownerResearchIdentity(P, VIEWER, 1)
    const ownerGen2 = ownerResearchIdentity(P, VIEWER, 2)
    const ownerOther = ownerResearchIdentity(P, 'user_2', 1)
    const admin = adminReadonlyResearchIdentity(P, 1)
    expect(researchIdentityEquals(owner1, owner1b)).toBe(true)
    expect(researchIdentityEquals(owner1, ownerGen2)).toBe(false)
    expect(researchIdentityEquals(owner1, ownerOther)).toBe(false)
    expect(researchIdentityEquals(admin, adminReadonlyResearchIdentity(P, 1))).toBe(true)
    expect(researchIdentityEquals(owner1, admin)).toBe(false)
    // admin 不比较 viewer（本来就没有）
    expect(researchIdentityEquals(admin, { role: 'admin_readonly', projectId: P, authGeneration: 1 })).toBe(true)

    const ownerKey = researchSourcesIdentityKey(owner1)
    const adminKey = researchSourcesIdentityKey(admin)
    expect(JSON.stringify(ownerKey)).toContain(VIEWER)
    expect(JSON.stringify(adminKey)).not.toContain(VIEWER)
    expect(ownerKey).not.toEqual(adminKey)
    expect(researchSourcesIdentityKey(ownerGen2)).not.toEqual(ownerKey)
  })

  it('purgeResearchAuthScope：取消在途旧代查询、移除旧代/无身份段旧键、保留当前身份', async () => {
    const client = new QueryClient()
    const current = ownerResearchIdentity(P, VIEWER, 2)
    const currentKey = researchSourcesIdentityKey(current)
    const staleKey = researchSourcesIdentityKey(ownerResearchIdentity(P, VIEWER, 1))
    const legacyKey = ['research', P, 'sources'] as const
    client.setQueryData(currentKey, { items: ['current'], next_cursor: null })
    client.setQueryData(staleKey, { items: ['stale'], next_cursor: null })
    client.setQueryData(legacyKey, { items: ['legacy'], next_cursor: null })

    const capture: { signal: AbortSignal | null } = { signal: null }
    const inFlightKey = researchSourcesIdentityKey(ownerResearchIdentity(P, VIEWER, 33))
    void client.prefetchQuery({
      queryKey: inFlightKey,
      queryFn: ({ signal }) =>
        new Promise((resolve) => {
          capture.signal = signal
          signal.addEventListener('abort', () => resolve({ items: [], next_cursor: null }))
        }),
      staleTime: Infinity,
    })
    await waitFor(() => expect(capture.signal).not.toBeNull())

    const removed = await purgeResearchAuthScope(client, { projectId: P, current })
    expect(removed).toBeGreaterThanOrEqual(2)
    expect(capture.signal?.aborted).toBe(true)
    expect(client.getQueryData(currentKey)).toEqual({ items: ['current'], next_cursor: null })
    expect(client.getQueryData(staleKey)).toBeUndefined()
    expect(client.getQueryData(legacyKey)).toBeUndefined()
  })
})

// ── Sources/Notes 加载守卫（hooks） ────────────────────────────────────────

function SourcesHarness({ projectId }: { projectId: string }) {
  const query = useResearchSources(projectId)
  return (
    <div>
      <span data-testid="sources-fetch">{query.fetchStatus}</span>
      <span data-testid="sources-count">{query.data?.items.length ?? -1}</span>
    </div>
  )
}

describe('use-research 加载守卫：判别身份键、viewer 未确认 fail-closed、代际切换中止旧代', () => {
  it('owner 身份键含 viewer/代际；Admin 身份键不含 viewer，不读 owner 分区', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const ownerWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <ResearchWorkspaceProvider projectId={P} userId={VIEWER} role="owner" authGeneration={1}>
          {children}
        </ResearchWorkspaceProvider>
      </QueryClientProvider>
    )
    const { unmount } = renderHook(() => useResearchSources(P), { wrapper: ownerWrapper })
    await waitFor(() => expect(vi.mocked(listSources)).toHaveBeenCalledTimes(1))
    expect(client.getQueryData(researchSourcesIdentityKey(ownerResearchIdentity(P, VIEWER, 1)))).toBeDefined()
    unmount()

    const adminClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const adminWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={adminClient}>
        <ResearchWorkspaceProvider projectId={P} role="admin_readonly" authGeneration={1}>
          {children}
        </ResearchWorkspaceProvider>
      </QueryClientProvider>
    )
    renderHook(() => useResearchSources(P), { wrapper: adminWrapper })
    await waitFor(() => expect(vi.mocked(listSources)).toHaveBeenCalledTimes(2))
    expect(adminClient.getQueryData(researchSourcesIdentityKey(adminReadonlyResearchIdentity(P, 1)))).toBeDefined()
  })

  it('owner 无 viewer（未确认）时 enabled=false，不发请求', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <ResearchWorkspaceProvider projectId={P} role="owner" authGeneration={1}>
          {children}
        </ResearchWorkspaceProvider>
      </QueryClientProvider>
    )
    const { result } = renderHook(() => useResearchSources(P), { wrapper })
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(vi.mocked(listSources)).not.toHaveBeenCalled()
  })

  it('authGeneration 变化：中止旧代在途加载且旧代数据不回填', async () => {
    const capture: { signal: AbortSignal | null } = { signal: null }
    vi.mocked(listSources).mockImplementationOnce(
      (_projectId, _params, signal) =>
        new Promise((resolve) => {
          capture.signal = signal ?? null
          signal?.addEventListener('abort', () => resolve({ items: [], next_cursor: null }))
        }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function App({ generation }: { generation: number }) {
      return (
        <QueryClientProvider client={client}>
          <ResearchWorkspaceProvider projectId={P} userId={VIEWER} role="owner" authGeneration={generation}>
            <SourcesHarness projectId={P} />
          </ResearchWorkspaceProvider>
        </QueryClientProvider>
      )
    }
    const { rerender } = render(<App generation={1} />)
    await waitFor(() => expect(capture.signal).not.toBeNull())
    rerender(<App generation={2} />)
    await waitFor(() => expect(capture.signal?.aborted).toBe(true))
    // 旧代键不得写入旧代结果（新代只接受自己发起的请求）
    expect(client.getQueryData(researchSourcesIdentityKey(ownerResearchIdentity(P, VIEWER, 1)))).toBeUndefined()
    await waitFor(() => expect(vi.mocked(listSources)).toHaveBeenCalledTimes(2))
  })
})

// ── runGuarded：未派发 completion（§3.2 / §9.2 / L1120） ──────────────────

const MODELS: ResearchModelOption[] = [
  { model_id: 'm-local', display_name: 'Local M', data_egress: false, interactive_context_levels: ['focused', 'document', 'workspace'] },
  { model_id: 'm-ext', display_name: 'Ext M', data_egress: true, interactive_context_levels: ['focused'] },
]

const PREFS_LOCAL = {
  project_id: P,
  default_context_level: 'focused' as const,
  preferred_model_id: 'm-local',
  updated_by: 1,
  updated_at: '2026-08-28T00:00:00+00:00',
}

const PREFS_EXT = {
  ...PREFS_LOCAL,
  preferred_model_id: 'm-ext',
}

const PREFS_NULL = {
  ...PREFS_LOCAL,
  preferred_model_id: null,
  updated_by: null,
  updated_at: null,
}

const CONSENT_MISSING = {
  consent: null,
  required_scope: {
    policy_version: '1',
    provider_destinations: [{ provider_id: 'ext-1', api_base_url: 'https://ext.example.com/v1' }],
    data_categories: ['focused_context'],
    scope_hash: 'hash',
  },
}

let latestGlobalModel: UseResearchGlobalModelResult | null = null
function GlobalModelConsumer() {
  latestGlobalModel = useResearchGlobalModel()
  return null
}

function GlobalModelApp({
  client,
  authGeneration,
  role = 'owner',
}: {
  client: QueryClient
  authGeneration: number
  role?: 'owner' | 'admin_readonly'
}) {
  return (
    <QueryClientProvider client={client}>
      <ResearchWorkspaceProvider projectId={P} userId={VIEWER} role={role} authGeneration={authGeneration}>
        <ResearchGlobalModelProvider>
          <GlobalModelConsumer />
        </ResearchGlobalModelProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
}

describe('use-research-global-model：Research mutation 不自动重试 + runGuarded 未派发 completion', () => {
  it('PATCH 使用 RESEARCH_MUTATION_OPTIONS(retry:0)：全局默认重试 2 次时仍只派发一次', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: 2 } },
    })
    vi.mocked(listModels).mockResolvedValue({ models: MODELS })
    vi.mocked(getExecutionPreferences).mockResolvedValue(PREFS_LOCAL)
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    vi.mocked(patchExecutionPreferences).mockRejectedValue(new Error('network down'))
    render(<GlobalModelApp client={client} authGeneration={1} />)
    await waitFor(() => expect(latestGlobalModel?.confirmedModelId).toBe('m-local'))
    act(() => latestGlobalModel?.setDraftModelId('m-ext'))
    await act(async () => {
      // 保存失败按既有契约向上抛出（saveModel 设置可见错误后 rethrow）
      await latestGlobalModel?.saveModel().catch(() => undefined)
    })
    expect(vi.mocked(patchExecutionPreferences)).toHaveBeenCalledTimes(1)
  })

  it('不可执行时 onCompletion 收到 blocked，执行体未被调用（hold 在调用方释放）', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.mocked(listModels).mockResolvedValue({ models: MODELS })
    vi.mocked(getExecutionPreferences).mockResolvedValue(PREFS_NULL)
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    render(<GlobalModelApp client={client} authGeneration={1} />)
    await waitFor(() => expect(latestGlobalModel?.canExecute).toBe(false))
    const completions: GuardedOperationCompletion[] = []
    const operation = vi.fn(() => 'ok')
    await act(async () => {
      const result = await latestGlobalModel?.runGuarded(operation, {
        onCompletion: (completion) => completions.push(completion),
      })
      expect(result).toBeUndefined()
    })
    expect(operation).not.toHaveBeenCalled()
    expect(completions).toEqual([{ dispatched: false, reason: 'blocked', modelId: null }])
  })

  it('consent 取消：显式 completion dispatched:false / cancelled，执行体未被调用', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.mocked(listModels).mockResolvedValue({ models: MODELS })
    vi.mocked(getExecutionPreferences).mockResolvedValue(PREFS_EXT)
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    render(<GlobalModelApp client={client} authGeneration={1} />)
    await waitFor(() => expect(latestGlobalModel?.needsConsent).toBe(true))
    const completions: GuardedOperationCompletion[] = []
    const operation = vi.fn(() => 'ok')
    await act(async () => {
      const result = await latestGlobalModel?.runGuarded(operation, {
        onCompletion: (completion) => completions.push(completion),
      })
      expect(result).toBeUndefined()
    })
    expect(latestGlobalModel?.pendingModelId).toBe('m-ext')
    act(() => latestGlobalModel?.cancelConsent())
    expect(operation).not.toHaveBeenCalled()
    expect(completions).toEqual([{ dispatched: false, reason: 'cancelled', modelId: 'm-ext' }])
  })

  it('consent 确认后身份已变化：completion dispatched:false / identity-changed，执行体未被调用', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.mocked(listModels).mockResolvedValue({ models: MODELS })
    vi.mocked(getExecutionPreferences).mockResolvedValue(PREFS_EXT)
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    vi.mocked(acknowledgeExternalEgressConsent).mockResolvedValue({
      consent: {
        project_id: P,
        acknowledged_by: 1,
        acknowledged_at: '2026-08-28T00:00:00+00:00',
        policy_version: '1',
        scope_hash: 'hash',
        revoked_at: null,
        revoked_by: null,
        valid: true,
      },
      required_scope: CONSENT_MISSING.required_scope,
    })
    const { rerender } = render(<GlobalModelApp client={client} authGeneration={1} />)
    await waitFor(() => expect(latestGlobalModel?.needsConsent).toBe(true))
    const completions: GuardedOperationCompletion[] = []
    const operation = vi.fn(() => 'ok')
    await act(async () => {
      await latestGlobalModel?.runGuarded(operation, {
        onCompletion: (completion) => completions.push(completion),
      })
    })
    expect(latestGlobalModel?.pendingModelId).toBe('m-ext')
    // 另一标签页触发 token refresh：认证代际前进 → 登记身份失效
    rerender(<GlobalModelApp client={client} authGeneration={2} />)
    await waitFor(() => expect(completions).toHaveLength(1))
    // 登记已失效：确认流程不得再派发旧意图
    await act(async () => {
      await latestGlobalModel?.confirmConsent()
    })
    expect(operation).not.toHaveBeenCalled()
    expect(completions).toEqual([{ dispatched: false, reason: 'identity-changed', modelId: 'm-ext' }])
  })

  it('consent 确认成功：completion dispatched:true 且执行体只调用一次', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    vi.mocked(listModels).mockResolvedValue({ models: MODELS })
    vi.mocked(getExecutionPreferences).mockResolvedValue(PREFS_EXT)
    vi.mocked(getExternalEgressConsent).mockResolvedValue(CONSENT_MISSING)
    vi.mocked(acknowledgeExternalEgressConsent).mockResolvedValue({
      consent: {
        project_id: P,
        acknowledged_by: 1,
        acknowledged_at: '2026-08-28T00:00:00+00:00',
        policy_version: '1',
        scope_hash: 'hash',
        revoked_at: null,
        revoked_by: null,
        valid: true,
      },
      required_scope: CONSENT_MISSING.required_scope,
    })
    render(<GlobalModelApp client={client} authGeneration={1} />)
    await waitFor(() => expect(latestGlobalModel?.needsConsent).toBe(true))
    const completions: GuardedOperationCompletion[] = []
    const operation = vi.fn(() => 'executed')
    await act(async () => {
      await latestGlobalModel?.runGuarded(operation, {
        onCompletion: (completion) => completions.push(completion),
      })
    })
    await act(async () => {
      await latestGlobalModel?.confirmConsent()
    })
    expect(operation).toHaveBeenCalledTimes(1)
    expect(completions).toEqual([{ dispatched: true, modelId: 'm-ext' }])
  })
})
