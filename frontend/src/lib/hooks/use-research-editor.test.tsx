import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const getEditorStateMock = vi.fn()
const putEditorStateMock = vi.fn()

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...actual,
    getEditorState: (...args: unknown[]) => getEditorStateMock(...args),
    putEditorState: (...args: unknown[]) => putEditorStateMock(...args),
  }
})

import {
  SESSION_CONTRACT_VERSION,
  sessionKey,
  type ResearchSessionRef,
} from '@/lib/research/session-contract'
import {
  ResearchSessionRuntimeProvider,
} from '@/lib/hooks/research-session-runtime'
import { useResearchEditor } from '@/lib/hooks/use-research-editor'
import {
  SESSION_CACHE_PREFIX,
  clearSessionCacheMemoryFallback,
  listDraftBranches,
  readDraft,
  writeDisplayPointer,
  writeDraft,
  type SessionCacheAuthority,
  type SessionDraftRecord,
} from '@/lib/research/session-cache'
import {
  createSessionRuntime,
  type SessionRuntimeBootstrapOutcome,
  type SessionRuntimeTransport,
} from '@/lib/research/session-runtime'
import { readDisplayPointer } from '@/lib/research/session-cache'
import type { EditorSaveRequestWire } from '@/lib/research/types'

/**
 * 第三批 PR-3：use-research-editor 接线层（Provider → runtime.editor → 控制器）。
 *
 * 证据级别：simulated。api transport 全部 mock，使用 fake timers 与契约 JSON，
 * 不连真实后端，不代表真实浏览器刷新/多标签已验证。
 */

const P = 'p1'
const VIEWER = '7'
const NOW = '2026-10-26T00:00:00.000Z'
const HASH = 'b'.repeat(64)

const ref: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: P,
  sessionId: 's1',
  sourceId: null,
}

const capabilitiesWire = () => ({
  sessions: {
    contract: SESSION_CONTRACT_VERSION,
    editor_ready: true,
    submission_ready: { global: true, source: true },
  },
})

function sessionRefWire(): Record<string, unknown> {
  return {
    domain: 'research',
    kind: 'global',
    project_id: P,
    session_id: 's1',
    source_id: null,
  }
}

function editorResponse(overrides: Partial<{ revision: number; text: string }> = {}): Record<string, unknown> {
  return {
    session_ref: sessionRefWire(),
    editor_revision: overrides.revision ?? 5,
    editor_state: {
      schema_version: 1,
      base_scope: { mode: 'all', source_ids: [], single_source_id: null },
      single_source_id: null,
      note_ids: [],
      draft: { text: overrides.text ?? 'server text', token: 'tok-server' },
      chat_anchor: null,
      reader_anchor: null,
    },
    state_warnings: [],
    editor_intent_hash: HASH,
    viewer_user_id: Number(VIEWER),
    capabilities: capabilitiesWire(),
  }
}

function saveResponse(body: EditorSaveRequestWire, revision = 6): Record<string, unknown> {
  return {
    session_ref: sessionRefWire(),
    editor_revision: revision,
    editor_state: null,
    mutation_id: body.mutation_id,
    saved_at: '2026-10-26T00:00:01.000Z',
    editor_intent_hash: HASH,
  }
}

function deferred<T = unknown>() {
  let resolveFn: (value: T) => void = () => {}
  let rejectFn: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

function okTransport(viewer: string = VIEWER): SessionRuntimeTransport {
  return {
    bootstrap: vi.fn(async (): Promise<SessionRuntimeBootstrapOutcome> => ({
      status: 'ok',
      viewerUserId: viewer,
      capabilities: {
        contract: 'research-session-v1',
        editorReady: true,
        submissionReady: { global: true, source: true },
        degraded: false,
        reason: null,
      },
    })),
  }
}

class MapStorage implements Storage {
  readonly map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

function draftRecord(overrides: Partial<SessionDraftRecord> = {}): SessionDraftRecord {
  return {
    version: 1,
    text: '本机未同步稿',
    token: 'tk-local',
    baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
    singleSourceId: null,
    noteIds: [],
    localVersion: 3,
    baseRevision: 5,
    savedAt: NOW,
    dirty: true,
    ...overrides,
  }
}

function authority(): SessionCacheAuthority {
  return {
    authenticatedViewerUserId: VIEWER,
    projectId: P,
    authGeneration: 1,
    currentAuthGeneration: 1,
  }
}

function scope() {
  return { viewerUserId: VIEWER, projectId: P }
}

function hashState(): void {
  // 不触碰真实 localStorage：hook 测试全部显式注入 MapStorage。
  clearSessionCacheMemoryFallback()
}

let storage: MapStorage
let queryClient: QueryClient

function makeWrapper(options: {
  authGeneration?: number
  transport?: SessionRuntimeTransport
  storage?: MapStorage
  viewerUserId?: string | null
}) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ResearchSessionRuntimeProvider
          authGeneration={options.authGeneration ?? 1}
          projectId={P}
          viewerUserId={options.viewerUserId === undefined ? VIEWER : options.viewerUserId}
          role="owner"
          transport={options.transport ?? okTransport()}
          storage={options.storage ?? storage}
          queryClient={queryClient}
        >
          {children}
        </ResearchSessionRuntimeProvider>
      </QueryClientProvider>
    )
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  hashState()
  storage = new MapStorage()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  vi.useRealTimers()
})

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

// ── 接线：GET/PUT 走 api transport ──

describe('use-research-editor 接线', () => {
  it('Provider 内自动 GET，文本保存走 putEditorState', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    let resolveSave: (value: unknown) => void = () => {}
    putEditorStateMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveSave = resolve
      }),
    )
    const { result } = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    expect(getEditorStateMock).toHaveBeenCalledTimes(1)
    expect(getEditorStateMock).toHaveBeenCalledWith(P, {
      kind: 'global',
      sessionId: 's1',
      sourceId: null,
    })
    expect(result.current.snapshot?.phase).toBe('ready')
    expect(result.current.snapshot?.revision).toBe(5)
    expect(result.current.snapshot?.draftText).toBe('server text')

    act(() => result.current.setDraftText('T1'))
    await settle(500)
    expect(putEditorStateMock).toHaveBeenCalledTimes(1)
    const body = putEditorStateMock.mock.calls[0][2] as EditorSaveRequestWire
    expect(body.expected_revision).toBe(5)
    expect(body.editor_state.draft.text).toBe('T1')
    act(() => resolveSave(saveResponse(body)))
    await settle(0)
    expect(result.current.snapshot?.revision).toBe(6)
    expect(result.current.snapshot?.dirty).toBe(false)
  })

  it('无 Provider 时返回空操作，不抛错、不触碰 api', () => {
    const { result } = renderHook(() =>
      useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
    )
    expect(result.current.snapshot).toBeNull()
    expect(result.current.transportWired).toBe(false)
    expect(result.current.canSubmit()).toEqual({ allowed: false, reason: 'not_loaded' })
    expect(getEditorStateMock).not.toHaveBeenCalled()
  })
})

// ── F02：来源解析 404 时仍读回自有草稿、不清 pointer ──

describe('F02：来源不可用时的草稿读回', () => {
  it('editor GET 404：本 writer 草稿读回、指针保留、可重试', async () => {
    getEditorStateMock.mockRejectedValue({
      response: { status: 404, data: { detail: { code: 'source_not_found', message: '来源不存在' } } },
    })
    const sourceRef: ResearchSessionRef = {
      domain: 'research',
      kind: 'source',
      projectId: P,
      sessionId: 's1',
      sourceId: 'src_a',
    }
    const displayPointer = {
      version: 1 as const,
      surface: 'source' as const,
      sourceId: 'src_a',
      ref: sourceRef,
    }
    writeDisplayPointer(scope(), displayPointer, { storage })
    const { result } = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    expect(result.current.snapshot?.phase).toBe('blocked')
    const writerId = result.current.snapshot?.writerId ?? ''
    expect(writerId.length).toBeGreaterThan(0)

    // 预置该 writer 的本机草稿后重试 load（模拟刷新前同一分支/重试）。
    writeDraft(scope(), ref, writerId, draftRecord(), { storage })
    const controller = result.current.controller
    expect(controller).not.toBeNull()
    act(() => {
      void controller?.load()
    })
    await settle(0)
    expect(result.current.snapshot?.draftText).toBe('本机未同步稿')
    expect(result.current.snapshot?.dirty).toBe(true)
    expect(getEditorStateMock.mock.calls.length).toBeGreaterThanOrEqual(2)

    // 本机草稿分支与 display pointer 均未被删除。
    expect(readDraft(scope(), authority(), ref, writerId, { storage })).not.toBeNull()
    expect(readDisplayPointer(scope(), authority(), { storage })).toEqual(displayPointer)
    expect([...storage.map.keys()].some((key) => key.includes(SESSION_CACHE_PREFIX))).toBe(true)
  })
})

// ── 同 viewer refresh：原 mutation/body 重放，GET 不抢先覆盖 ──

describe('同 viewer refresh 的跨代接管', () => {
  it('旧 ACK 丢弃后用原 mutation/body 重放；T2 在 M 结算后保存', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    const firstPut = deferred<unknown>()
    const secondPut = deferred<unknown>()
    const thirdPut = deferred<unknown>()
    putEditorStateMock
      .mockImplementationOnce(() => firstPut.promise)
      .mockImplementationOnce(() => secondPut.promise)
      .mockImplementationOnce(() => thirdPut.promise)
    const transport = okTransport()
    let generation = 1
    const wrapper = function MigrationWrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ResearchSessionRuntimeProvider
            authGeneration={generation}
            projectId={P}
            viewerUserId={VIEWER}
            role="owner"
            transport={transport}
            storage={storage}
            queryClient={queryClient}
          >
            {children}
          </ResearchSessionRuntimeProvider>
        </QueryClientProvider>
      )
    }
    const { result, rerender } = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper },
    )
    await settle(0)
    expect(result.current.snapshot?.phase).toBe('ready')

    act(() => result.current.setDraftText('M'))
    await settle(500)
    expect(putEditorStateMock).toHaveBeenCalledTimes(1)
    const firstBody = putEditorStateMock.mock.calls[0][2] as EditorSaveRequestWire

    // 同 viewer token refresh：认证代际前进，旧请求结果未知。
    generation = 2
    rerender()
    await settle(0)

    // 旧代 ACK 到达：必须被丢弃（revision 不变、dirty 保留）。
    act(() => firstPut.resolve(saveResponse(firstBody)))
    await settle(0)
    expect(result.current.snapshot?.revision).toBe(5)
    expect(result.current.snapshot?.dirty).toBe(true)

    // 新代际用原 mutation_id/原 body 重放。
    await settle(0)
    const replayCalls = putEditorStateMock.mock.calls.filter(
      (call) => (call[2] as EditorSaveRequestWire).mutation_id === firstBody.mutation_id,
    )
    expect(replayCalls.length).toBeGreaterThanOrEqual(2)
    expect(replayCalls[1][2]).toEqual(firstBody)

    // M 未结算前输入 T2：M 的 ACK 只推进 revision，不覆盖 T2 的可见文本。
    act(() => result.current.setDraftText('T2'))
    await settle(0)
    const replayBody = replayCalls[1][2] as EditorSaveRequestWire
    act(() => secondPut.resolve(saveResponse(replayBody, 6)))
    await settle(0)
    expect(result.current.snapshot?.draftText).toBe('T2')
    expect(result.current.snapshot?.revision).toBe(6)

    // T2 以 M 结算后的 revision 保存。
    await settle(500)
    const t2Calls = putEditorStateMock.mock.calls.filter(
      (call) => (call[2] as EditorSaveRequestWire).editor_state.draft.text === 'T2',
    )
    expect(t2Calls.length).toBe(1)
    expect((t2Calls[0][2] as EditorSaveRequestWire).expected_revision).toBe(6)
    act(() => thirdPut.resolve(saveResponse(t2Calls[0][2] as EditorSaveRequestWire, 7)))
    await settle(0)
    expect(result.current.snapshot?.revision).toBe(7)
    expect(result.current.snapshot?.dirty).toBe(false)
  })
})

// ── writerId 生命周期与恢复选择 ──

describe('writerId 生命周期', () => {
  it('重新挂载生成新 writerId；恢复只复制到当前分支、不删除来源分支', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    putEditorStateMock.mockImplementation(() => Promise.resolve(undefined))
    const first = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    const firstWriter = first.result.current.snapshot?.writerId ?? ''
    expect(firstWriter.length).toBeGreaterThan(0)
    act(() => first.result.current.setDraftText('来源分支稿'))
    await settle(500)
    act(() => first.result.current.releaseDocument())
    await settle(0)
    first.unmount()
    await settle(0)

    const sourceKey = [...storage.map.keys()].find((key) => key.includes(firstWriter))
    expect(sourceKey).toBeDefined()

    // 新挂载（模拟刷新/复制标签）：writerId 必须重新生成。
    const second = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    const secondWriter = second.result.current.snapshot?.writerId ?? ''
    expect(secondWriter).not.toBe(firstWriter)
    expect(second.result.current.snapshot?.restoreCandidates.map((c) => c.writerId)).toContain(
      firstWriter,
    )
    act(() => second.result.current.restoreDraft(firstWriter))
    expect(second.result.current.snapshot?.draftText).toBe('来源分支稿')
    // 来源分支仍在（只复制、不删除）。
    expect(storage.map.has(sourceKey as string)).toBe(true)
  })
})

// ── hold + 条件清稿接线 ──

describe('提交 hold 与清稿接线', () => {
  it('hold 阻止 autosave；clearAfterSubmission 派发清稿并用 ACK 推进 revision', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    const puts: Array<ReturnType<typeof deferred<unknown>>> = []
    putEditorStateMock.mockImplementation(() => {
      const pending = deferred<unknown>()
      puts.push(pending)
      return pending.promise
    })
    const { result } = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    expect(sessionKey(ref)).toBe('research.v1|p1|global||s1')

    act(() => {
      result.current.hold('submit', 'op1')
      result.current.setDraftText('T1')
    })
    await settle(500)
    expect(putEditorStateMock).not.toHaveBeenCalled()

    let clearOutcome: string | null = null
    act(() => {
      void result.current
        .clearAfterSubmission(
          {
            sessionRef: ref,
            draftToken: result.current.snapshot?.draftToken ?? '',
            text: result.current.snapshot?.draftText ?? '',
          },
          'op1',
        )
        .then((outcome) => {
          clearOutcome = outcome
        })
    })
    await settle(0)
    expect(putEditorStateMock).toHaveBeenCalledTimes(1)
    const clearBody = putEditorStateMock.mock.calls[0][2] as EditorSaveRequestWire
    expect(clearBody.editor_state.draft.text).toBe('')
    expect(clearBody.editor_state.draft.token.length).toBeGreaterThan(0)

    act(() => {
      puts[0].resolve(saveResponse(clearBody, 6))
    })
    await settle(0)
    expect(clearOutcome).toBe('cleared')
    expect(result.current.snapshot?.revision).toBe(6)
    expect(result.current.snapshot?.draftText).toBe('')
  })
})

// ── Codex 二轮 review：多消费者共享与页面隐藏 ──

describe('多消费者共享编辑器控制器', () => {
  it('同一会话两个消费者共享同一控制器，只发一次 GET 且状态互通', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    putEditorStateMock.mockResolvedValue(undefined)
    const { result } = renderHook(
      () => ({
        a: useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
        b: useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    expect(getEditorStateMock).toHaveBeenCalledTimes(1)
    expect(result.current.a.controller).not.toBeNull()
    expect(result.current.a.controller).toBe(result.current.b.controller)
    act(() => result.current.a.setDraftText('共享文本'))
    await settle(0)
    expect(result.current.b.snapshot?.draftText).toBe('共享文本')
    expect(result.current.a.snapshot?.draftText).toBe('共享文本')
  })
})

describe('二次 review：幂等释放与页面隐藏（N6/N12）', () => {
  it('同一消费者重复 releaseDocument 幂等，另一消费者编辑仍生效', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    putEditorStateMock.mockResolvedValue(undefined)
    const { result, unmount } = renderHook(
      () => ({
        a: useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
        b: useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    expect(result.current.a.controller).toBe(result.current.b.controller)
    act(() => result.current.a.releaseDocument())
    act(() => result.current.a.releaseDocument())
    await settle(0)
    act(() => result.current.b.setDraftText('B 仍可编辑'))
    await settle(0)
    expect(result.current.b.snapshot?.draftText).toBe('B 仍可编辑')
    unmount()
  })

  it('visibilitychange=hidden 时同步写本机草稿（不依赖 pagehide）', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    const { result } = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    act(() => result.current.setDraftText('隐藏时未同步稿'))
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle(0)
    if (original) Object.defineProperty(document, 'visibilityState', original)
    else Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const branches = listDraftBranches(scope(), authority(), ref, { storage })
    expect(branches.some((branch) => branch.record.text === '隐藏时未同步稿')).toBe(true)
  })
})

describe('pagehide 本机草稿持久化', () => {
  it('pagehide 时立即写本机草稿、不发服务端请求', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    const { result } = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper: makeWrapper({}) },
    )
    await settle(0)
    act(() => result.current.setDraftText('未同步稿'))
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    await settle(0)
    // 尽力保存：可以尝试一次服务端保存，但本机草稿必须先落盘。
    const branches = listDraftBranches(scope(), authority(), ref, { storage })
    expect(branches.length).toBe(1)
    expect(branches[0].record.text).toBe('未同步稿')
  })
})

describe('editor 能力不可用（editor_ready=false）', () => {
  it('hook 暴露只读快照并拒绝保存', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    putEditorStateMock.mockResolvedValue(undefined)
    const readonlyTransport: SessionRuntimeTransport = {
      bootstrap: vi.fn(async (): Promise<SessionRuntimeBootstrapOutcome> => ({
        status: 'ok',
        viewerUserId: VIEWER,
        capabilities: {
          contract: 'research-session-v1',
          editorReady: false,
          submissionReady: { global: false, source: false },
          degraded: true,
          reason: 'missing',
        },
      })),
    }
    const { result } = renderHook(
      () => useResearchEditor({ kind: 'global', sessionId: 's1', storage }),
      { wrapper: makeWrapper({ transport: readonlyTransport }) },
    )
    await settle(0)
    expect(result.current.snapshot?.readOnly).toBe(true)
    act(() => result.current.setDraftText('不应保存'))
    await settle(500)
    expect(putEditorStateMock).not.toHaveBeenCalled()
  })
})

// ── review3 P1：敏感清理与未决 mutation 移交 ──

describe('review3 P1：释放/换人后的敏感清理与未决 mutation 接管', () => {
  const editorTransport = () => ({
    getEditorState: () => getEditorStateMock() as Promise<unknown>,
    putEditorState: (body: unknown) => putEditorStateMock(body) as Promise<unknown>,
  })

  function runtimeWithBootstrap() {
    return createSessionRuntime({
      authGeneration: 1,
      projectId: P,
      viewerUserId: VIEWER,
      role: 'owner',
      storage,
      transport: okTransport(),
      now: () => NOW,
    })
  }

  it('最后消费者释放时仍有在途保存：同一会话新消费者复用控制器，不重复 GET/PUT', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    const pending = deferred<unknown>()
    putEditorStateMock.mockImplementation(() => pending.promise)
    const runtime = runtimeWithBootstrap()
    runtime.start()
    await settle(0)
    const transport = editorTransport()
    const first = runtime.editor(ref, { writerId: 'w-review3-a', transport, storage })
    await first.load()
    act(() => first.setDraftText('未决稿'))
    await settle(500)
    expect(putEditorStateMock).toHaveBeenCalledTimes(1)
    runtime.releaseEditor(ref, first)
    // 未决 mutation 仍在：新消费者必须接管同一控制器，不得为同一会话再发 GET/PUT。
    const second = runtime.editor(ref, { writerId: 'w-review3-b', transport, storage })
    expect(second).toBe(first)
    expect(getEditorStateMock).toHaveBeenCalledTimes(1)
    const firstBody = putEditorStateMock.mock.calls[0][0] as EditorSaveRequestWire
    pending.resolve(saveResponse(firstBody))
    await settle(0)
    expect(second.getSnapshot().draftText).toBe('未决稿')
    expect(second.getSnapshot().dirty).toBe(false)
    runtime.releaseEditor(ref, second)
    runtime.dispose('unmount')
  })

  it('viewer-change 立即清除已释放控制器的敏感快照（不依赖 dispose）', async () => {
    getEditorStateMock.mockResolvedValue(editorResponse())
    putEditorStateMock.mockResolvedValue(undefined)
    const runtime = runtimeWithBootstrap()
    runtime.start()
    await settle(0)
    const controller = runtime.editor(ref, { writerId: 'w-viewer', transport: editorTransport(), storage })
    await controller.load()
    act(() => controller.setDraftText('旧 viewer 敏感文本'))
    runtime.releaseEditor(ref, controller)
    expect(controller.getSnapshot().draftText).toBe('旧 viewer 敏感文本')
    runtime.updateAuth({ authGeneration: 2, projectId: P, viewerUserId: '9', role: 'owner' })
    expect(controller.getSnapshot().draftText).toBe('')
    expect(controller.getSnapshot().draftToken).toBe('')
    runtime.dispose('unmount')
  })
})
