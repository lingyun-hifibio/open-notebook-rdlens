import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  EDITOR_POSITION_IDLE_MS,
  EDITOR_TEXT_DEBOUNCE_MS,
  EDITOR_TEXT_MAX_BYTES,
  buildSaveRequestWire,
  classifySaveFailure,
  createDraftToken,
  createEditorController,
  createEditorState,
  editorStateToWire,
  isMutationIdShaped,
  type EditorController,
  type EditorDeps,
  type EditorRuntimeView,
} from './editor-machine'
import {
  SESSION_CONTRACT_VERSION,
  sessionKey,
  type ResearchSessionRef,
} from './session-contract'
import {
  createMutationRecord,
  createTransportAttempt,
  markTransportAttemptDispatched,
  transportAttemptMatches,
  type SessionWriteGuard,
} from './session-runtime'
import { readDraft, writeDraft } from './session-cache'
import type {
  SessionCacheAuthority,
  SessionCacheScope,
  SessionCacheStorage,
} from './session-cache'
import type { EditorSaveRequestWire } from './types'

// ── 测试夹具 ──

const REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: 'p1',
  sessionId: 's1',
  sourceId: null,
}
const HASH = 'a'.repeat(64)

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T = unknown>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {}
  let rejectFn: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

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

function capabilitiesWire() {
  return {
    sessions: {
      contract: SESSION_CONTRACT_VERSION,
      editor_ready: true,
      submission_ready: { global: true, source: true },
    },
  }
}

function editorResponse(options: {
  revision?: number
  state?: unknown
  hash?: string | null
  warnings?: readonly string[]
} = {}): Record<string, unknown> {
  const state = options.state === undefined ? editorStateWire() : options.state
  const hash = options.hash !== undefined ? options.hash : state === null ? null : HASH
  return {
    session_ref: {
      domain: 'research',
      kind: 'global',
      project_id: 'p1',
      session_id: 's1',
      source_id: null,
    },
    editor_revision: options.revision ?? 5,
    editor_state: state,
    state_warnings: options.warnings ?? [],
    editor_intent_hash: hash,
    viewer_user_id: 1,
    capabilities: capabilitiesWire(),
  }
}

function editorStateWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    base_scope: { mode: 'all', source_ids: [], single_source_id: null },
    single_source_id: null,
    note_ids: [],
    draft: { text: 'hello', token: 'tok-server' },
    chat_anchor: null,
    reader_anchor: null,
    ...overrides,
  }
}

function saveResponse(
  mutationId: string,
  options: { revision?: number; hash?: string } = {},
): Record<string, unknown> {
  return {
    session_ref: {
      domain: 'research',
      kind: 'global',
      project_id: 'p1',
      session_id: 's1',
      source_id: null,
    },
    editor_revision: options.revision ?? 6,
    editor_state: null,
    mutation_id: mutationId,
    saved_at: '2026-10-26T00:00:01.000Z',
    editor_intent_hash: options.hash ?? HASH,
  }
}

function httpError(status: number, code?: string): unknown {
  return {
    response: {
      status,
      data: code === undefined ? { detail: { message: 'boom' } } : { detail: { code, message: 'boom' } },
    },
  }
}

interface PutCall {
  readonly body: EditorSaveRequestWire
  readonly response: Deferred<unknown>
}

interface Harness {
  readonly controller: EditorController
  readonly puts: PutCall[]
  readonly gets: Deferred<unknown>[]
  /** 每次 createMutationRecord 的 kind（verifier 观察：清稿必须记为 clear）。 */
  readonly mutationKinds: string[]
  readonly storage: MapStorage
  readonly scope: SessionCacheScope
  readonly authority: SessionCacheAuthority
  setRuntime(patch: Partial<EditorRuntimeView>): void
  runtime(): EditorRuntimeView
}

interface HarnessOptions {
  writerId?: string
  storage?: MapStorage
  runtime?: Partial<EditorRuntimeView>
  invalidateGuards?: boolean
}

let mutationSeq = 0
let tokenSeq = 0
let attemptSeq = 0

function createHarness(options: HarnessOptions = {}): Harness {
  mutationSeq = 0
  tokenSeq = 0
  attemptSeq = 0
  const storage = options.storage ?? new MapStorage()
  let runtimeView: EditorRuntimeView = {
    authGeneration: 7,
    projectId: 'p1',
    viewerUserId: '1',
    phase: 'ready',
    ready: true,
    disposed: false,
    viewerChanged: false,
    ...options.runtime,
  }
  const runtimeListeners = new Set<() => void>()
  const puts: PutCall[] = []
  const gets: Deferred<unknown>[] = []
  const mutationKinds: string[] = []
  const scope: SessionCacheScope = { viewerUserId: '1', projectId: 'p1' }
  const authority: SessionCacheAuthority = {
    authenticatedViewerUserId: '1',
    projectId: 'p1',
    authGeneration: 7,
    currentAuthGeneration: 7,
  }
  const guardFlags = { invalidated: options.invalidateGuards ?? false }

  const deps: EditorDeps = {
    ref: REF,
    writerId: options.writerId ?? 'w-test',
    transport: {
      getEditorState: () => {
        const pending = deferred<unknown>()
        gets.push(pending)
        return pending.promise
      },
      putEditorState: (body) => {
        const pending = deferred<unknown>()
        puts.push({ body, response: pending })
        return pending.promise
      },
    },
    getRuntimeView: () => runtimeView,
    subscribeRuntime: (listener) => {
      runtimeListeners.add(listener)
      return () => {
        runtimeListeners.delete(listener)
      }
    },
    createWriteGuard: (label): SessionWriteGuard => ({
      label,
      isInvalidated: () => guardFlags.invalidated,
      invalidate: () => {
        guardFlags.invalidated = true
      },
      run: <T>(operation: () => T) =>
        guardFlags.invalidated
          ? ({ status: 'stale' } as const)
          : ({ status: 'ok', value: operation() } as const),
    }),
    mutations: {
      createMutationRecord: (input) => {
        mutationKinds.push(input.kind)
        return createMutationRecord(input)
      },
      createTransportAttempt: (input) => {
        attemptSeq += 1
        return createTransportAttempt({
          ...input,
          attemptId: `a${attemptSeq}`,
          scope: { ...input.scope, role: 'owner' },
        })
      },
      markTransportAttemptDispatched,
      transportAttemptMatches,
    },
    getCacheScope: () => scope,
    getCacheAuthority: () =>
      runtimeView.ready
        ? {
            ...authority,
            authGeneration: runtimeView.authGeneration,
            currentAuthGeneration: runtimeView.authGeneration,
          }
        : null,
    storage,
    now: () => '2026-10-26T00:00:00.000Z',
    nextMutationId: () => {
      mutationSeq += 1
      return `m${mutationSeq}`
    },
    nextDraftToken: () => {
      tokenSeq += 1
      return `tk${tokenSeq}`
    },
  }
  const controller = createEditorController(deps)
  return {
    controller,
    puts,
    gets,
    mutationKinds,
    storage,
    scope,
    authority,
    setRuntime: (patch) => {
      runtimeView = { ...runtimeView, ...patch }
      for (const listener of [...runtimeListeners]) listener()
    },
    runtime: () => runtimeView,
  }
}

async function flushMicrotasks(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve()
  }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushMicrotasks()
}

async function loadHarness(
  harness: Harness,
  response: Record<string, unknown> = editorResponse(),
): Promise<void> {
  expect(harness.gets.length).toBeGreaterThanOrEqual(1)
  harness.gets[harness.gets.length - 1].resolve(response)
  await flushMicrotasks()
}

function lastPut(harness: Harness): PutCall {
  const call = harness.puts[harness.puts.length - 1]
  expect(call).toBeDefined()
  return call
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── 状态构造/纯函数 ──

describe('editor state machine primitives', () => {
  it('createEditorState 使用 wire 的 camelCase 形状并生成 token', () => {
    const token = createDraftToken()
    const state = createEditorState({ ref: REF, writerId: 'w1', transportAvailable: true })
    expect(state.phase).toBe('idle')
    expect(state.revision).toBe(0)
    expect(state.draftToken).toMatch(/^t[A-Za-z0-9]+$/)
    expect(isMutationIdShaped(token)).toBe(true)
    expect(editorStateToWire(state)).toMatchObject({
      schema_version: 1,
      base_scope: { mode: 'all', source_ids: [], single_source_id: null },
      draft: { text: '', token: state.draftToken },
    })
  })

  it('buildSaveRequestWire 不接受外部 revision 猜测，expected_revision 只取快照', () => {
    const state = createEditorState({ ref: REF, writerId: 'w1', transportAvailable: true })
    const body = buildSaveRequestWire(state, 'm42')
    expect(body.expected_revision).toBe(state.revision)
    expect(body.mutation_id).toBe('m42')
    expect(sessionKey(REF)).toBe('research.v1|p1|global||s1')
  })

  it('classifySaveFailure 覆盖 409/413/422/5xx/网络错误分类', () => {
    expect(classifySaveFailure(httpError(409, 'editor_revision_conflict'))).toMatchObject({
      code: 'editor_revision_conflict',
      handling: 'conflict',
      retryable: false,
    })
    expect(classifySaveFailure(httpError(409, 'editor_mutation_conflict'))).toMatchObject({
      code: 'editor_mutation_conflict',
      handling: 'conflict',
    })
    expect(classifySaveFailure(httpError(413))).toMatchObject({
      code: 'editor_state_too_large',
      handling: 'blocked',
    })
    expect(classifySaveFailure(httpError(422, 'editor_state_invalid'))).toMatchObject({
      code: 'editor_state_invalid',
      handling: 'blocked',
    })
    expect(classifySaveFailure(httpError(503))).toMatchObject({ retryable: true, handling: 'retry' })
    expect(classifySaveFailure(new Error('network down'))).toMatchObject({ handling: 'retry' })
    expect(classifySaveFailure(httpError(403))).toMatchObject({ handling: 'error' })
  })
})

// ── 初始加载（F02/F17 基线） ──

describe('editor initial load', () => {
  it('构造后自动 GET 并采用服务端 revision/intent_hash', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.revision).toBe(5)
    expect(snapshot.intentHash).toBe(HASH)
    expect(snapshot.draftText).toBe('hello')
    expect(snapshot.dirty).toBe(false)
    expect(snapshot.transportAvailable).toBe(true)
  })

  it('editor_state=null + editor_state_unreadable 时只读且不写默认范围（F17）', async () => {
    const harness = createHarness()
    await loadHarness(
      harness,
      editorResponse({ state: null, hash: null, warnings: ['editor_state_unreadable'] }),
    )
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.phase).toBe('readonly')
    expect(snapshot.readOnly).toBe(true)
    expect(snapshot.unreadable).toBe(true)
    expect(snapshot.revision).toBe(5)
    harness.controller.setDraftText('should not apply')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(0)
    expect(harness.controller.getSnapshot().draftText).toBe('')
  })

  it('load 5xx 只进入可重试 error，不覆盖本机稿', async () => {
    const harness = createHarness()
    harness.gets[0].reject(httpError(503))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().phase).toBe('error')
    expect(harness.controller.getSnapshot().saveFailure?.retryable).toBe(true)
  })
})

// ── 文本保存 / ACK ──

describe('editor text save', () => {
  it('文本变化 500ms 后单飞 PUT，ACK 推进 revision 并清 dirty', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    expect(harness.controller.getSnapshot().saving).toBe(false)
    await advance(EDITOR_TEXT_DEBOUNCE_MS - 1)
    expect(harness.puts.length).toBe(0)
    await advance(1)
    expect(harness.puts.length).toBe(1)
    const call = lastPut(harness)
    expect(call.body.expected_revision).toBe(5)
    expect(call.body.editor_state.draft.text).toBe('T1')
    expect(harness.controller.getSnapshot().saving).toBe(true)
    call.response.resolve(saveResponse(call.body.mutation_id))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.revision).toBe(6)
    expect(snapshot.dirty).toBe(false)
    expect(snapshot.saving).toBe(false)
    expect(snapshot.lastSavedAt).toBe('2026-10-26T00:00:01.000Z')
    // ACK 后 clean：本 writer 草稿分支被条件删除。
    expect([...harness.storage.map.keys()].some((key) => key.includes('.draft.'))).toBe(false)
  })

  it('位置变化 1000ms 后保存且不生成新 draft token', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    const beforeToken = harness.controller.getSnapshot().draftToken
    harness.controller.setChatAnchor({ messageId: 'msg1', offsetPx: 12, followTail: false })
    await advance(EDITOR_POSITION_IDLE_MS)
    expect(harness.puts.length).toBe(1)
    const call = lastPut(harness)
    expect(call.body.editor_state.draft.token).toBe(beforeToken)
    expect(call.body.editor_state.chat_anchor).toMatchObject({ message_id: 'msg1', offset_px: 12 })
    call.response.resolve(saveResponse(call.body.mutation_id, { revision: 5 }))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().revision).toBe(5)
    expect(harness.controller.getSnapshot().intentHash).toBe(HASH)
  })

  it('ACK 丢失后自动重试用同一 mutation_id 与同一请求体重放', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const first = lastPut(harness)
    first.response.reject(new Error('connection reset'))
    await flushMicrotasks()
    await advance(1000)
    expect(harness.puts.length).toBe(2)
    const second = lastPut(harness)
    expect(second.body.mutation_id).toBe(first.body.mutation_id)
    expect(second.body).toEqual(first.body)
    second.response.resolve(saveResponse(second.body.mutation_id))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().revision).toBe(6)
    expect(harness.controller.getSnapshot().dirty).toBe(false)
  })

  it('ACK 缺 mutation_id 回声按协议错误处理并保留 dirty', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const call = lastPut(harness)
    call.response.resolve(saveResponse('m-other'))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.dirty).toBe(true)
    expect(snapshot.saveFailure?.code).toBe('invalid_response')
    expect(snapshot.revision).toBe(5)
  })

  it('ACK 返回 session_ref 不匹配时同样拒绝', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const call = lastPut(harness)
    // 篡改 session_ref 的 session_id，ACK 必须被拒绝。
    call.response.resolve({
      ...saveResponse(call.body.mutation_id),
      session_ref: {
        domain: 'research',
        kind: 'global',
        project_id: 'p1',
        session_id: 's2',
        source_id: null,
      },
    })
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().dirty).toBe(true)
    expect(harness.controller.getSnapshot().saveFailure?.code).toBe('invalid_response')
  })

  it('409 revision_conflict 保留 dirty 并给出 conflict（不自动覆盖）', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const call = lastPut(harness)
    call.response.reject(httpError(409, 'editor_revision_conflict'))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.phase).toBe('conflict')
    expect(snapshot.conflict).toEqual({ kind: 'revision' })
    expect(snapshot.dirty).toBe(true)
    expect(snapshot.draftText).toBe('T1')
  })

  it('409 mutation_conflict 记录 mutation 冲突类型', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    lastPut(harness).response.reject(httpError(409, 'editor_mutation_conflict'))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().conflict).toEqual({ kind: 'mutation' })
    expect(harness.controller.getSnapshot().dirty).toBe(true)
  })

  it('413/422 进入 blocked 且保留本机稿；503 重试耗尽标记 unsynced', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    lastPut(harness).response.reject(httpError(413))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().blocked).toBe(true)
    expect(harness.controller.getSnapshot().draftText).toBe('T1')

    const harness2 = createHarness()
    await loadHarness(harness2)
    harness2.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      lastPut(harness2).response.reject(httpError(503))
      await flushMicrotasks()
      await advance(2000)
    }
    expect(harness2.controller.getSnapshot().unsynced).toBe(true)
    expect(harness2.controller.getSnapshot().dirty).toBe(true)
  })

  it('文本超过 256KiB 时保留全文但阻断保存（不截断、不派发）', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    const oversized = 'a'.repeat(EDITOR_TEXT_MAX_BYTES + 1)
    harness.controller.setDraftText(oversized)
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(0)
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.draftText).toBe(oversized)
    expect(snapshot.oversize).toBe(true)
    expect(await harness.controller.flush('submit')).toBe('blocked')
    expect(harness.puts.length).toBe(0)
  })

  it('含未配对 UTF-16 代理项的文本原样保留并允许保存（不改写）', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    const surrogateText = 'x\uD800y'
    harness.controller.setDraftText(surrogateText)
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.controller.getSnapshot().draftText).toBe(surrogateText)
    expect(harness.puts.length).toBe(1)
    expect(lastPut(harness).body.editor_state.draft.text).toBe(surrogateText)
  })
})

// ── 跨认证代际接管（F03/F04） ──

describe('editor cross-generation takeover', () => {
  it('旧代 ACK 丢弃，下一代用原 mutation/原 body 重放成功且不误报 conflict', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const first = lastPut(harness)
    // 同 viewer token refresh：旧代 ACK 到达之前代际已前进。
    const proxy = harness
    harness.setRuntime({ authGeneration: 8 })
    await flushMicrotasks()
    first.response.resolve(saveResponse(first.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().revision).toBe(5)
    expect(harness.controller.getSnapshot().dirty).toBe(true)
    // ready 事件触发重放：同一 mutation_id 与同一 body，换新 attempt。
    harness.setRuntime({})
    await flushMicrotasks()
    expect(proxy.puts.length).toBe(2)
    const replay = lastPut(harness)
    expect(replay.body).toEqual(first.body)
    replay.response.resolve(saveResponse(replay.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.revision).toBe(6)
    expect(snapshot.conflict).toBeNull()
    expect(snapshot.dirty).toBe(false)
  })

  it('保存未结算前 GET 不得覆盖 shadow（dirty 竞态：同 revision 保留本机）', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('local')
    harness.setRuntime({ authGeneration: 8 })
    await flushMicrotasks()
    expect(harness.gets.length).toBe(2)
    harness.gets[1].resolve(editorResponse({ revision: 5 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.draftText).toBe('local')
    expect(snapshot.dirty).toBe(true)
    expect(snapshot.conflict).toBeNull()
  })

  it('GET 返回不同 revision 且本机 dirty 时不自动覆盖，进入 revision 冲突', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('local')
    harness.setRuntime({ authGeneration: 8 })
    await flushMicrotasks()
    harness.gets[1].resolve(editorResponse({ revision: 9 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.conflict).toEqual({ kind: 'revision' })
    expect(snapshot.draftText).toBe('local')
  })

  it('viewer 变化使控制器失效，停止一切写入', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    harness.setRuntime({ viewerChanged: true, phase: 'viewer_changed', ready: false })
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.invalidated).toBe(true)
    harness.controller.setDraftText('T2')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(0)
    expect(harness.controller.canSubmit()).toEqual({ allowed: false, reason: 'invalidated' })
  })
})

// ── hold / 单飞闸门 ──

describe('editor hold and single-flight gate', () => {
  it('T1 保存期间输入 T2 且 hold 时 T2 不抢跑，ACK+release 后才续跑', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    harness.controller.hold('submit', 'op1')
    harness.controller.setDraftText('T2')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    lastPut(harness).response.resolve(saveResponse(harness.puts[0].body.mutation_id))
    await flushMicrotasks()
    expect(harness.puts.length).toBe(1)
    harness.controller.release('op1')
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    expect(lastPut(harness).body.editor_state.draft.text).toBe('T2')
  })

  it('清稿已派发但 ACK 未知时 T2 不能取消 mutation；ACK 只推进 revision，T2 用新 revision 保存', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.hold('submit', 'op1')
    const clearPromise = harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: 'tok-server', text: 'hello' },
      'op1',
    )
    expect(harness.puts.length).toBe(1)
    const clearCall = lastPut(harness)
    expect(clearCall.body.editor_state.draft.text).toBe('')
    const clearToken = clearCall.body.editor_state.draft.token
    harness.controller.setDraftText('T2')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    clearCall.response.resolve(saveResponse(clearCall.body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    expect(await clearPromise).toBe('superseded')
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.draftText).toBe('T2')
    expect(snapshot.revision).toBe(7)
    expect(snapshot.draftToken).not.toBe(clearToken)
    expect(harness.puts.length).toBe(2)
    const next = lastPut(harness)
    expect(next.body.expected_revision).toBe(7)
    expect(next.body.editor_state.draft.text).toBe('T2')
  })

  it('清稿在排队未派发时被新输入取消（未发任何请求）', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const saveCall = lastPut(harness)
    harness.controller.hold('submit', 'op1')
    const beforeClear = harness.controller.getSnapshot()
    const clearPromise = harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: beforeClear.draftToken, text: beforeClear.draftText },
      'op1',
    )
    harness.controller.setDraftText('T2')
    saveCall.response.resolve(saveResponse(saveCall.body.mutation_id))
    await flushMicrotasks()
    expect(await clearPromise).toBe('cancelled')
    expect(harness.puts.length).toBe(1)
    expect(harness.puts.some((call) => call.body.editor_state.draft.text === '')).toBe(false)
    expect(harness.controller.getSnapshot().draftText).toBe('T2')
  })

  it('清稿 ACK 丢失后重试复用首次生成的 token 与请求体', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.hold('submit', 'op1')
    void harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: 'tok-server', text: 'hello' },
      'op1',
    )
    const first = lastPut(harness)
    first.response.reject(new Error('connection reset'))
    await flushMicrotasks()
    await advance(1000)
    expect(harness.puts.length).toBe(2)
    const replay = lastPut(harness)
    expect(replay.body).toEqual(first.body)
    expect(replay.body.editor_state.draft.token).toBe(first.body.editor_state.draft.token)
  })

  it('flush 在非 dirty 状态返回 skipped；hold 期间显式 flush 仍可派发', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    expect(await harness.controller.flush('switch')).toBe('skipped')
    harness.controller.setDraftText('T1')
    harness.controller.hold('submit', 'op1')
    const flushPromise = harness.controller.flush('submit')
    expect(harness.puts.length).toBe(1)
    const call = lastPut(harness)
    call.response.resolve(saveResponse(call.body.mutation_id))
    expect(await flushPromise).toBe('saved')
  })
})

// ── 提交闸门与 token 消费 ──

describe('editor submission readiness', () => {
  it('canSubmit 覆盖 dirty/saving/consumed 闸门', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    expect(harness.controller.canSubmit()).toEqual({ allowed: true, reason: null })
    harness.controller.setDraftText('T1')
    expect(harness.controller.canSubmit()).toEqual({ allowed: false, reason: 'dirty' })
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.controller.canSubmit()).toEqual({ allowed: false, reason: 'saving' })
    lastPut(harness).response.resolve(saveResponse(harness.puts[0].body.mutation_id))
    await flushMicrotasks()
    expect(harness.controller.canSubmit()).toEqual({ allowed: true, reason: null })
    harness.controller.markTokenConsumed(harness.controller.getSnapshot().draftToken)
    expect(harness.controller.canSubmit()).toEqual({ allowed: false, reason: 'consumed' })
  })

  it('已消费 token 再次用于清稿仍可 markTokenConsumed 幂等', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    const token = harness.controller.getSnapshot().draftToken
    harness.controller.markTokenConsumed(token)
    harness.controller.markTokenConsumed(token)
    expect(harness.controller.getSnapshot().consumedToken).toBe(token)
  })
})

// ── 本机草稿与 writer 分支 ──

describe('editor local draft branches', () => {
  it('releaseDocument 写本机草稿、不发服务端请求', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('local-draft')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const before = harness.puts.length
    harness.controller.releaseDocument()
    expect(harness.puts.length).toBe(before)
    const draftKeys = [...harness.storage.map.keys()].filter((key) => key.includes('.draft.'))
    expect(draftKeys.length).toBe(1)
    const raw = harness.storage.map.get(draftKeys[0]) ?? ''
    expect(raw).toContain('local-draft')
  })

  it('restoreDraft 只复制到当前分支，不删除来源 writer 分支', async () => {
    const storage = new MapStorage()
    const harness = createHarness({ storage, writerId: 'w-current' })
    await loadHarness(harness)
    harness.controller.setDraftText('other-branch-text')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    // 用另一 writer 读取同会话草稿（模拟来源分支）。
    const other = createHarness({ storage, writerId: 'w-other' })
    await loadHarness(other, editorResponse())
    other.controller.setDraftText('source-branch-text')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const keysBefore = new Set(storage.map.keys())
    const sourceKeys = [...keysBefore].filter((key) => key.includes('.draft.') && key.includes('w-other'))
    expect(sourceKeys.length).toBe(1)

    harness.controller.refreshDraftCandidates()
    const candidates = harness.controller.getSnapshot().restoreCandidates
    expect(candidates.some((candidate) => candidate.writerId === 'w-other')).toBe(true)
    harness.controller.restoreDraft('w-other')
    expect(harness.controller.getSnapshot().draftText).toBe('source-branch-text')
    // 来源分支仍在（不删除、不迁移）。
    expect(storage.map.has(sourceKeys[0])).toBe(true)
  })
})

// ── 范围与位置语义 ──

describe('editor scope edits', () => {
  it('scope 变化生成新 token 并保存 wire 范围', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    const beforeToken = harness.controller.getSnapshot().draftToken
    harness.controller.setScope({ mode: 'selected', sourceIds: ['src1'], noteIds: ['n1'] })
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    const call = lastPut(harness)
    expect(call.body.editor_state.base_scope).toEqual({
      mode: 'selected',
      source_ids: ['src1'],
      single_source_id: null,
    })
    expect(call.body.editor_state.note_ids).toEqual(['n1'])
    // DESIGN §5.4：本地 token 只在文本变化时换新；范围改变影响的是提交意图。
    expect(call.body.editor_state.draft.token).toBe(beforeToken)
  })

  it('service 端 position_unavailable 后关闭位置保存', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ warnings: ['position_unavailable'] }))
    expect(harness.controller.getSnapshot().positionUnavailable).toBe(true)
    harness.controller.setChatAnchor({ messageId: 'msg1', offsetPx: 3, followTail: true })
    await advance(EDITOR_POSITION_IDLE_MS)
    expect(harness.puts.length).toBe(0)
  })
})


// ── Codex 二轮 review 阻塞项回归（PR-3 round 2） ──

function draftRecord(overrides: Record<string, unknown> = {}): Parameters<typeof writeDraft>[3] {
  return {
    version: 1,
    text: '本机未同步稿',
    token: 'tk-local',
    baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
    singleSourceId: null,
    noteIds: [],
    localVersion: 3,
    baseRevision: 5,
    savedAt: '2026-10-26T00:00:00.000Z',
    dirty: true,
    ...overrides,
  }
}

describe('editor review 回归：ACK 身份与不可变重放', () => {
  it('ACK revision 低于本地快照时按协议错误处理，不推进 revision、保留 dirty', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const call = lastPut(harness)
    call.response.resolve(saveResponse(call.body.mutation_id, { revision: 4 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.revision).toBe(5)
    expect(snapshot.draftText).toBe('T1')
    expect(snapshot.dirty).toBe(true)
    expect(snapshot.saveFailure?.code).toBe('invalid_response')
  })

  it('保存在途时 retrySave 不并发第二个 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    expect(await harness.controller.retrySave()).toBe('queued')
    expect(harness.puts.length).toBe(1)
    const call = lastPut(harness)
    call.response.resolve(saveResponse(call.body.mutation_id))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().revision).toBe(6)
  })

  it('派发后调用方修改 sourceIds 不影响重放请求体（不可变 MVCC）', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    const sourceIds = ['s1']
    harness.controller.setScope({ mode: 'selected', sourceIds })
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    sourceIds.push('s2')
    const first = harness.puts[0]
    first.response.reject(httpError(503))
    await flushMicrotasks()
    await advance(2000)
    expect(harness.puts.length).toBe(2)
    const replay = harness.puts[1]
    expect(replay.body.mutation_id).toBe(first.body.mutation_id)
    expect(replay.body.editor_state.base_scope!.source_ids).toEqual(['s1'])
  })

  it('同 viewer refresh：未确认保存立即重放同一 mutation，旧 ACK 迟到不推进 revision', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const first = lastPut(harness)
    harness.setRuntime({ authGeneration: 8 })
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    const replay = lastPut(harness)
    expect(replay.body.mutation_id).toBe(first.body.mutation_id)
    first.response.resolve(saveResponse(first.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().revision).toBe(5)
    replay.response.resolve(saveResponse(replay.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.revision).toBe(6)
    expect(snapshot.draftText).toBe('T1')
    expect(snapshot.dirty).toBe(false)
  })

  it('旧代 GET 晚到后自动续跑、不永久卡 loading', async () => {
    const harness = createHarness()
    expect(harness.gets.length).toBe(1)
    harness.setRuntime({ authGeneration: 8 })
    await flushMicrotasks()
    harness.gets[0].resolve(editorResponse())
    await flushMicrotasks()
    expect(harness.gets.length).toBe(2)
    harness.gets[1].resolve(editorResponse({ revision: 5 }))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().phase).toBe('ready')
    expect(harness.controller.getSnapshot().revision).toBe(5)
  })
})

describe('editor review 回归：清稿/只读/失效', () => {
  it('过期 receipt（token/text 与当前快照不符）返回 invalid 且不占用提交 hold', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T2')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const outcome = await harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: 'tok-server', text: 'hello' },
      'op1',
    )
    expect(outcome).toBe('invalid')
    expect(harness.controller.getSnapshot().holds).toEqual([])
    expect(harness.puts.some((call) => call.body.editor_state.draft.text === '')).toBe(false)
  })

  it('普通 flush 不得穿透 submit hold，释放后自动续跑', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.hold('submit', 'op1')
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(0)
    expect(await harness.controller.flush('switch')).toBe('blocked')
    expect(await harness.controller.flush('position')).toBe('blocked')
    harness.controller.release('op1')
    await flushMicrotasks()
    expect(harness.puts.length).toBe(1)
  })

  it('显式 submit 排队冻结派发时快照，ACK 后按冻结文本重发', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const first = lastPut(harness)
    const submitPromise = harness.controller.flush('submit')
    harness.controller.setDraftText('T1+T2')
    first.response.resolve(saveResponse(first.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    const second = harness.puts[1]
    expect(second.body.expected_revision).toBe(6)
    expect(second.body.editor_state.draft.text).toBe('T1')
    expect(harness.controller.getSnapshot().draftText).toBe('T1+T2')
    expect(harness.controller.getSnapshot().dirty).toBe(true)
    second.response.resolve(saveResponse(second.body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    expect(await submitPromise).toBe('saved')
  })

  it('editorReady=false 时只读：仍读回编辑器快照但禁止编辑与保存', async () => {
    const harness = createHarness({ runtime: { editorReady: false } })
    expect(harness.gets.length).toBe(0)
    void harness.controller.load()
    await flushMicrotasks()
    expect(harness.gets.length).toBe(1)
    harness.gets[0].resolve(editorResponse())
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('hello')
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(0)
    expect(harness.controller.getSnapshot().readOnly).toBe(true)
    expect(await harness.controller.flush('submit')).toBe('readonly')
  })

  it('logout 失效后清空敏感快照与草稿', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    harness.controller.invalidate('logout')
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.invalidated).toBe(true)
    expect(snapshot.draftText).toBe('')
    expect(snapshot.draftToken).toBe('')
    expect(snapshot.baseScope).toBeNull()
    expect(snapshot.holds).toEqual([])
  })
})

describe('editor review 回归：GET 与本地 dirty 竞态', () => {
  function storageWithDirtyDraft(baseRevision = 5): MapStorage {
    const storage = new MapStorage()
    writeDraft(
      { viewerUserId: '1', projectId: 'p1' },
      REF,
      'w-test',
      draftRecord({ baseRevision }),
      { storage },
    )
    return storage
  }

  it('加载时本机 dirty 且 revision 相同：保留本机文本并自动补发', async () => {
    const storage = storageWithDirtyDraft(5)
    const harness = createHarness({ storage })
    await loadHarness(harness, editorResponse({ revision: 5 }))
    expect(harness.controller.getSnapshot().draftText).toBe('本机未同步稿')
    expect(harness.controller.getSnapshot().dirty).toBe(true)
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(lastPut(harness).body.editor_state.draft.text).toBe('本机未同步稿')
  })

  it('加载时本机 dirty 但服务端 revision 已前进：进入冲突不自动覆盖', async () => {
    const storage = storageWithDirtyDraft(5)
    const harness = createHarness({ storage })
    await loadHarness(harness, editorResponse({ revision: 6 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.draftText).toBe('本机未同步稿')
    expect(snapshot.conflict).toEqual({ kind: 'revision' })
    expect(snapshot.saveFailure?.code).toBe('editor_revision_conflict')
    expect(harness.puts.length).toBe(0)
  })
})

describe('editor 二次 review 回归（P1/N1–N4、N7–N11）', () => {
  it('N1 排队 submit 用入队时本地版本结算：ACK 不得把可见 T2 标为 clean', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const first = lastPut(harness)
    harness.controller.hold('submit', 'op1')
    const queued = harness.controller.flush('submit')
    harness.controller.setDraftText('T2')
    first.response.resolve(saveResponse(first.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    const second = lastPut(harness)
    expect(second.body.editor_state.draft.text).toBe('T1')
    second.response.resolve(saveResponse(second.body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    expect(await queued).toBe('saved')
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.draftText).toBe('T2')
    expect(snapshot.dirty).toBe(true)
    expect(snapshot.confirmedLocalVersion).toBeLessThan(snapshot.localVersion)
  })

  it('N2 手动 retry 取消退避定时器：不得产生第三个并发 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    lastPut(harness).response.reject(httpError(503))
    await flushMicrotasks()
    expect(harness.puts.length).toBe(1)
    await harness.controller.retrySave()
    expect(harness.puts.length).toBe(2)
    await advance(2000)
    expect(harness.puts.length).toBe(2)
  })

  it('N3 重放未结束时再次换代：旧尝试结算后继续接管，不丢失 mutation', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const original = lastPut(harness)
    harness.setRuntime({ authGeneration: 8 })
    await flushMicrotasks()
    const replay8 = lastPut(harness)
    expect(harness.puts.length).toBe(2)
    harness.setRuntime({ authGeneration: 9 })
    await flushMicrotasks()
    replay8.response.resolve(saveResponse(replay8.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    expect(harness.puts.length).toBe(3)
    const replay9 = lastPut(harness)
    expect(replay9.body).toEqual(original.body)
    replay9.response.resolve(saveResponse(replay9.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.revision).toBe(6)
    expect(snapshot.dirty).toBe(false)
  })

  it('N4 本机 dirty 且 GET 同 revision：loading 收敛，保存成功后可以提交', async () => {
    const storage = new MapStorage()
    const scope: SessionCacheScope = { viewerUserId: '1', projectId: 'p1' }
    writeDraft(scope, REF, 'w-test', draftRecord({ baseRevision: 5 }), { storage })
    const harness = createHarness({ storage })
    await loadHarness(harness, editorResponse({ revision: 5 }))
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const call = lastPut(harness)
    call.response.resolve(saveResponse(call.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.loading).toBe(false)
    expect(snapshot.dirty).toBe(false)
    expect(harness.controller.canSubmit()).toEqual({ allowed: true, reason: null })
  })

  it('N7 已排队普通 flush 不得穿透 conflict hold，释放后续跑', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const first = lastPut(harness)
    void harness.controller.flush('text')
    harness.controller.hold('conflict', 'c1')
    first.response.resolve(saveResponse(first.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    expect(harness.puts.length).toBe(1)
    harness.controller.setDraftText('T2')
    harness.controller.release('c1')
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    expect(lastPut(harness).body.editor_state.draft.text).toBe('T2')
  })

  it('N8 服务端 unreadable 时本机 dirty 不覆盖：只读且不发 PUT', async () => {
    const storage = new MapStorage()
    const scope: SessionCacheScope = { viewerUserId: '1', projectId: 'p1' }
    writeDraft(scope, REF, 'w-test', draftRecord({ baseRevision: 5 }), { storage })
    const harness = createHarness({ storage })
    await loadHarness(
      harness,
      editorResponse({ revision: 5, state: null, warnings: ['editor_state_unreadable'] }),
    )
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.phase).toBe('readonly')
    expect(snapshot.readOnly).toBe(true)
    expect(harness.puts.length).toBe(0)
  })

  it('N9 认证未就绪时 canSubmit 返回 not_ready，masked 后不提交', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.setRuntime({ ready: false, phase: 'masked' })
    await flushMicrotasks()
    expect(harness.controller.canSubmit()).toEqual({ allowed: false, reason: 'not_ready' })
  })

  it('N10 本机读回超限文本重算 oversize，停止自动保存', async () => {
    const storage = new MapStorage()
    const scope: SessionCacheScope = { viewerUserId: '1', projectId: 'p1' }
    const huge = 'x'.repeat(EDITOR_TEXT_MAX_BYTES + 1)
    writeDraft(
      scope,
      REF,
      'w-test',
      draftRecord({ text: huge, localVersion: 3, baseRevision: 5 }),
      { storage },
    )
    const harness = createHarness({ storage })
    await loadHarness(harness, editorResponse({ revision: 5 }))
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.draftText).toBe(huge)
    expect(snapshot.oversize).toBe(true)
    expect(harness.puts.length).toBe(0)
  })

  it('N11 清稿 ACK 按派发前旧 token 删除本 writer 分支', async () => {
    const storage = new MapStorage()
    const scope: SessionCacheScope = { viewerUserId: '1', projectId: 'p1' }
    const authority: SessionCacheAuthority = {
      authenticatedViewerUserId: '1',
      projectId: 'p1',
      authGeneration: 7,
      currentAuthGeneration: 7,
    }
    writeDraft(
      scope,
      REF,
      'w-test',
      draftRecord({ text: 'hello', token: 'tok-server', dirty: false, localVersion: 0, baseRevision: 5 }),
      { storage },
    )
    const harness = createHarness({ storage })
    await loadHarness(harness)
    harness.controller.hold('submit', 'op1')
    const promise = harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: 'tok-server', text: 'hello' },
      'op1',
    )
    expect(harness.puts.length).toBe(1)
    const call = lastPut(harness)
    call.response.resolve(saveResponse(call.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    expect(await promise).toBe('cleared')
    expect(readDraft(scope, authority, REF, 'w-test', { storage })).toBeNull()
  })
})

// ── review3 P1：手动 retry 并发闸门与排队 flush 结算版本 ──

describe('editor review3 回归：并发闸门与结算版本', () => {
  it('N2b 退避 attempt 在途时手动 retry 不得并发第三个 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('A')
    await advance(500)
    expect(harness.puts.length).toBe(1)
    harness.puts[0].response.reject(httpError(503, 'editor_store_unavailable'))
    await advance(0)
    // 1s 退避后发出第二个 attempt，并保持在途。
    await advance(1000)
    expect(harness.puts.length).toBe(2)
    const outcome = await harness.controller.retrySave()
    expect(outcome).toBe('queued')
    // 关键：在途 attempt 未结算前绝不允许第三个并发 PUT。
    expect(harness.puts.length).toBe(2)
    harness.puts[1].response.resolve(saveResponse(harness.puts[1].body.mutation_id, { revision: 6 }))
    await advance(0)
    expect(harness.puts.length).toBe(2)
    expect(harness.controller.getSnapshot().dirty).toBe(false)
  })

  it('N1b 排队普通 flush 按派发时最新 localVersion 结算，T2 不残留 dirty', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('T1')
    await advance(500)
    expect(harness.puts.length).toBe(1)
    harness.controller.setDraftText('T2')
    const flushed = harness.controller.flush('text')
    await advance(0)
    expect(harness.puts.length).toBe(1)
    harness.puts[0].response.resolve(saveResponse(harness.puts[0].body.mutation_id, { revision: 6 }))
    await advance(0)
    // eslint-disable-next-line no-console
    expect(harness.puts.length).toBe(2)
    expect(lastPut(harness).body.editor_state.draft.text).toBe('T2')
    harness.puts[1].response.resolve(saveResponse(harness.puts[1].body.mutation_id, { revision: 7 }))
    await advance(0)
    expect(await flushed).toBe('saved')
    expect(harness.controller.getSnapshot().dirty).toBe(false)
  })
})

// ── review3 P1：跨代接管不依赖旧 promise / masked 恢复 / 清稿尺寸 ──

describe('editor review3 回归：跨代桥与清稿边界', () => {
  it('R2 旧 replay promise 永不 settle 时新代仍立即派发原 mutation/body，旧 attempt 被丢弃', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('A')
    await advance(500)
    expect(harness.puts.length).toBe(1)
    const firstMutation = harness.puts[0].body.mutation_id
    const firstBody = JSON.stringify(harness.puts[0].body)
    // 同 viewer refresh：代际 7→8，旧 PUT promise 保持 pending 永不 settle。
    harness.setRuntime({ authGeneration: 8 })
    await advance(0)
    expect(harness.puts.length).toBe(2)
    expect(harness.puts[1].body.mutation_id).toBe(firstMutation)
    expect(JSON.stringify(harness.puts[1].body)).toBe(firstBody)
    // 旧 replay（gen8 的 PUT2）也未 settle 时再换 gen9：新代码必须立刻再派发 PUT3，
    // 不能因为 replaying 仍在途而只排队等待（R2 核心：不等旧 promise）。
    harness.setRuntime({ authGeneration: 9 })
    await advance(0)
    expect(harness.puts.length).toBe(3)
    expect(harness.puts[2].body.mutation_id).toBe(firstMutation)
    expect(JSON.stringify(harness.puts[2].body)).toBe(firstBody)
    // 旧两代迟到 ACK：全部丢弃，不推进 revision。
    harness.puts[0].response.resolve(saveResponse(firstMutation, { revision: 6 }))
    harness.puts[1].response.resolve(saveResponse(firstMutation, { revision: 6 }))
    await advance(0)
    expect(harness.controller.getSnapshot().revision).toBe(5)
    // 当前代 ACK 正常结算。
    harness.puts[2].response.resolve(saveResponse(firstMutation, { revision: 6 }))
    await advance(0)
    expect(harness.controller.getSnapshot().revision).toBe(6)
    expect(harness.controller.getSnapshot().dirty).toBe(false)
  })

  it('R6 masked 解除后同代续跑被暂停的退避重试，且不重复/不并发', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('A')
    await advance(500)
    expect(harness.puts.length).toBe(1)
    harness.puts[0].response.reject(httpError(503, 'editor_store_unavailable'))
    await advance(0)
    // 退避期间被 masked：timer 空转返回，不再发 PUT。
    harness.setRuntime({ ready: false, phase: 'masked' })
    await advance(1000)
    expect(harness.puts.length).toBe(1)
    // 遮蔽解除（同代）：恢复一次重试，不并发第二个。
    harness.setRuntime({ ready: true, phase: 'ready' })
    await advance(0)
    expect(harness.puts.length).toBe(2)
    harness.puts[1].response.resolve(
      saveResponse(harness.puts[1].body.mutation_id, { revision: 6 }),
    )
    await advance(0)
    expect(harness.controller.getSnapshot().dirty).toBe(false)
    expect(harness.puts.length).toBe(2)
  })

  it('R7 清稿 512KiB 上限按实际清稿请求体判定，不因旧快照含全文而误判 blocked', async () => {
    const pad = (prefix: string, index: number): string =>
      `${prefix}${String(index).padStart(4, '0')}`.padEnd(256, prefix === 'n' ? 'n' : 's')
    const harness = createHarness()
    await loadHarness(
      harness,
      editorResponse({
        revision: 5,
        state: editorStateWire({
          base_scope: {
            mode: 'selected',
            source_ids: Array.from({ length: 1000 }, (_, index) => pad('s', index)),
            single_source_id: null,
          },
          note_ids: Array.from({ length: 1000 }, (_, index) => pad('n', index)),
          draft: { text: 'x'.repeat(250 * 1024), token: 'tok-server' },
        }),
      }),
    )
    const snapshot = harness.controller.getSnapshot()
    // 旧检查把 250KiB 全文算进 body 会 >512KiB；实际清稿 body 已将 text 清空，必须允许派发。
    const pending = harness.controller.clearAfterSubmission(
      { sessionRef: snapshot.ref, draftToken: snapshot.draftToken, text: snapshot.draftText },
      'op-clear-boundary',
    )
    await advance(0)
    expect(harness.puts.length).toBe(1)
    expect(harness.puts[0].body.editor_state.draft.text).toBe('')
    harness.puts[0].response.resolve(
      saveResponse(harness.puts[0].body.mutation_id, { revision: 6 }),
    )
    expect(await pending).toBe('cleared')
  })
})

// ── review4 P2：暂停重试状态与队列替换 hold 释放 ──

describe('editor review4 回归：重试暂停与队列替换', () => {
  it('F1 自动重试耗尽进入 unsynced 后，无关 runtime 通知不得重启 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('A')
    await advance(500)
    expect(harness.puts.length).toBe(1)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const call = lastPut(harness)
      call.response.reject(httpError(503, 'editor_store_unavailable'))
      await advance(5000)
    }
    expect(harness.puts.length).toBe(4)
    expect(harness.controller.getSnapshot().unsynced).toBe(true)
    // 仅 runtime 通知（如 activate/pointer 变化）不得绕过重试上限再发 PUT。
    harness.setRuntime({ phase: 'ready', ready: true })
    harness.setRuntime({ phase: 'ready', ready: true })
    await advance(0)
    expect(harness.puts.length).toBe(4)
  })

  it('F2 排队清稿被 submit flush 替换时按 cancelled 结算并释放自身 hold，不阻塞后续保存', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('T1')
    await advance(500)
    expect(harness.puts.length).toBe(1)
    const snapshot = harness.controller.getSnapshot()
    const clearPromise = harness.controller.clearAfterSubmission(
      { sessionRef: snapshot.ref, draftToken: snapshot.draftToken, text: snapshot.draftText },
      'op-replaced',
    )
    await advance(0)
    expect(harness.controller.getSnapshot().holds.some((hold) => hold.operationId === 'op-replaced')).toBe(true)
    harness.controller.setDraftText('T2')
    // 保存请求替换排队清稿：清稿取消、其 hold 必须释放，且 T2 必须能继续保存。
    const savePromise = harness.controller.flush('submit')
    expect(await clearPromise).toBe('cancelled')
    expect(harness.controller.getSnapshot().holds).toEqual([])
    harness.puts[0].response.resolve(saveResponse(harness.puts[0].body.mutation_id, { revision: 6 }))
    await advance(0)
    expect(harness.puts.length).toBe(2)
    expect(lastPut(harness).body.editor_state.draft.text).toBe('T2')
    harness.puts[1].response.resolve(saveResponse(harness.puts[1].body.mutation_id, { revision: 7 }))
    expect(await savePromise).toBe('saved')
    await advance(0)
    expect(harness.controller.getSnapshot().dirty).toBe(false)
    expect(harness.controller.getSnapshot().holds).toEqual([])
  })
})

describe('editor review5 回归：恢复一次后不再重启重试', () => {
  it('F1b 暂停最后一次重试后恢复，耗尽进入 unsynced 时无关通知不得重启 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('A')
    await advance(500)
    expect(harness.puts.length).toBe(1)
    lastPut(harness).response.reject(httpError(503, 'editor_store_unavailable'))
    await advance(1000) // 重试 1 → PUT2
    expect(harness.puts.length).toBe(2)
    lastPut(harness).response.reject(httpError(503, 'editor_store_unavailable'))
    await advance(3000) // 重试 2 → PUT3
    expect(harness.puts.length).toBe(3)
    lastPut(harness).response.reject(httpError(503, 'editor_store_unavailable'))
    await advance(0) // 处理失败、安排最后一次重试（预算内 retries=3）
    harness.setRuntime({ phase: 'masked', ready: false })
    await advance(6000) // 最后一次重试到点但 masked → 暂停（不再派发）
    expect(harness.puts.length).toBe(3)
    harness.setRuntime({ phase: 'ready', ready: true }) // 恢复一次 → PUT4
    await advance(0)
    expect(harness.puts.length).toBe(4)
    lastPut(harness).response.reject(httpError(503, 'editor_store_unavailable'))
    await advance(0) // 预算耗尽 → unsynced，active 仍保留未确认
    expect(harness.controller.getSnapshot().unsynced).toBe(true)
    harness.setRuntime({ phase: 'ready', ready: true })
    harness.setRuntime({ phase: 'ready', ready: true })
    await advance(0)
    expect(harness.puts.length).toBe(4)
  })

  it('F1c 暂停恢复的一次 PUT 收到非法 ACK（invalid_response）后，无关通知不得重启 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('A')
    await advance(500)
    expect(harness.puts.length).toBe(1)
    lastPut(harness).response.reject(httpError(503, 'editor_store_unavailable'))
    await advance(0) // 处理失败、安排退避（ready）
    harness.setRuntime({ phase: 'masked', ready: false })
    await advance(3000) // 到点但 masked → 暂停
    expect(harness.puts.length).toBe(1)
    harness.setRuntime({ phase: 'ready', ready: true }) // 恢复一次 → PUT2
    await advance(0)
    expect(harness.puts.length).toBe(2)
    const illegal = { ...saveResponse(lastPut(harness).body.mutation_id, { revision: 6 }) }
    delete (illegal as Record<string, unknown>).mutation_id // 缺 mutation_id 回声
    lastPut(harness).response.resolve(illegal)
    await advance(0)
    expect(harness.controller.getSnapshot().saveFailure?.code).toBe('invalid_response')
    harness.setRuntime({ phase: 'ready', ready: true })
    await advance(0)
    expect(harness.puts.length).toBe(2)
  })

})


// ── verifier 阻塞项回归（Lead 核对 #74 comment 6421813634） ──

describe('verifier regression: clear settlement decoupled from position', () => {
  it('清稿在途仅锚点变化 → 仍 cleared，且不把旧稿写回', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.hold('submit', 'op1')
    const clearPromise = harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: 'tok-server', text: 'hello' },
      'op1',
    )
    expect(harness.mutationKinds).toEqual(['clear'])
    const clearCall = lastPut(harness)
    harness.controller.setChatAnchor({ messageId: 'm2', offsetPx: 24, followTail: true })
    await advance(EDITOR_POSITION_IDLE_MS) // 清稿在途：位置意图只暂存，不得改变清稿结算
    clearCall.response.resolve(saveResponse(clearCall.body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    expect(await clearPromise).toBe('cleared')
    expect(harness.controller.getSnapshot().draftText).toBe('')
    expect(
      harness.puts.filter((call) => call.body.editor_state.draft.text === 'hello'),
    ).toHaveLength(0)
  })

  it('清稿 + 排队位置保存：清稿 ACK 后无旧稿回写，T2 用新 revision 保存', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.hold('submit', 'op1')
    const clearPromise = harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: 'tok-server', text: 'hello' },
      'op1',
    )
    const clearCall = lastPut(harness)
    harness.controller.setChatAnchor({ messageId: 'm2', offsetPx: 10, followTail: false })
    await advance(EDITOR_POSITION_IDLE_MS)
    clearCall.response.resolve(saveResponse(clearCall.body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    expect(await clearPromise).toBe('cleared')
    // 清稿后允许派发仅锚点保存，但其文本必须是已清空的空稿（不得回写 hello）。
    expect(
      harness.puts.filter((call) => call.body.editor_state.draft.text === 'hello'),
    ).toHaveLength(0)
    const positionPut = lastPut(harness)
    expect(positionPut.body.editor_state.draft.text).toBe('')
    positionPut.response.resolve(saveResponse(positionPut.body.mutation_id, { revision: 8 }))
    await flushMicrotasks()
    harness.controller.setDraftText('T2')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const t2 = lastPut(harness)
    expect(t2.body.editor_state.draft.text).toBe('T2')
    expect(t2.body.expected_revision).toBe(8)
  })
})

describe('verifier regression: masked same-generation ACK', () => {
  it('masked 期间同代 ACK 正常到达 → unmask 后 settled，无重复 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    harness.setRuntime({ phase: 'masked', ready: false })
    lastPut(harness).response.resolve(saveResponse(harness.puts[0].body.mutation_id))
    await flushMicrotasks()
    harness.setRuntime({ phase: 'ready', ready: true })
    await flushMicrotasks()
    expect(harness.puts.length).toBe(1)
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.saving).toBe(false)
    expect(snapshot.draftText).toBe('T1')
  })

  it('masked 期间 debounce 到点后 unmask 续跑自动保存，新文本不滞留 dirty', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const first = lastPut(harness)
    harness.setRuntime({ phase: 'masked', ready: false })
    first.response.resolve(saveResponse(first.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    harness.controller.setDraftText('T2')
    await advance(EDITOR_TEXT_DEBOUNCE_MS) // masked 期间到点：只记 pending，不发 PUT
    expect(harness.puts.length).toBe(1)
    harness.setRuntime({ phase: 'ready', ready: true })
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    const t2 = lastPut(harness)
    expect(t2.body.editor_state.draft.text).toBe('T2')
    expect(t2.body.expected_revision).toBe(6)
  })

  it('masked 期间 ACK 丢失 → unmask 后用原 mutation/body 重放一次', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const first = lastPut(harness)
    const firstBody = first.body
    harness.setRuntime({ phase: 'masked', ready: false })
    first.response.reject(new Error('lost ack'))
    await flushMicrotasks()
    await advance(1000) // 退避到点但 masked → 暂停，不发 PUT
    expect(harness.puts.length).toBe(1)
    harness.setRuntime({ phase: 'ready', ready: true })
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    expect(lastPut(harness).body).toEqual(firstBody)
  })
})

describe('verifier regression: GET failure recovery / dirty conflict', () => {
  it('GET 在途已有新输入：失败恢复不得用磁盘旧稿覆盖新文本', async () => {
    const storage = new MapStorage()
    writeDraft(
      { viewerUserId: '1', projectId: 'p1' },
      REF,
      'w-test',
      {
        version: 1,
        text: 'OLD-draft',
        token: 'tok-old',
        baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
        singleSourceId: null,
        noteIds: [],
        localVersion: 0,
        baseRevision: 5,
        savedAt: '2026-10-26T00:00:00.000Z',
        dirty: true,
      },
      { storage },
    )
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    expect(harness.gets.length).toBe(1)
    harness.controller.setDraftText('NEW-text')
    harness.gets[0].reject(new Error('network down'))
    await loadPromise
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('NEW-text')
    expect(harness.controller.getSnapshot().draftText).not.toBe('OLD-draft')
  })

  it('GET 成功但响应非法：加载期间的新输入不被磁盘旧稿覆盖', async () => {
    const storage = new MapStorage()
    writeDraft(
      { viewerUserId: '1', projectId: 'p1' },
      REF,
      'w-test',
      {
        version: 1,
        text: 'OLD-draft',
        token: 'tok-old',
        baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
        singleSourceId: null,
        noteIds: [],
        localVersion: 0,
        baseRevision: 5,
        savedAt: '2026-10-26T00:00:00.000Z',
        dirty: true,
      },
      { storage },
    )
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    expect(harness.gets.length).toBe(1)
    harness.controller.setDraftText('NEW-text')
    harness.gets[0].resolve({ nonsense: true })
    await loadPromise
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('NEW-text')
    expect(harness.controller.getSnapshot().draftText).not.toBe('OLD-draft')
  })

  it('GET 成功但 editor_state_unreadable：加载期间的新输入不被磁盘旧稿覆盖', async () => {
    const storage = new MapStorage()
    writeDraft(
      { viewerUserId: '1', projectId: 'p1' },
      REF,
      'w-test',
      {
        version: 1,
        text: 'OLD-draft',
        token: 'tok-old',
        baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
        singleSourceId: null,
        noteIds: [],
        localVersion: 0,
        baseRevision: 5,
        savedAt: '2026-10-26T00:00:00.000Z',
        dirty: true,
      },
      { storage },
    )
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    expect(harness.gets.length).toBe(1)
    harness.controller.setDraftText('NEW-text')
    harness.gets[0].resolve(editorResponse({ state: null, hash: null, warnings: ['editor_state_unreadable'] }))
    await loadPromise
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('NEW-text')
    expect(harness.controller.getSnapshot().draftText).not.toBe('OLD-draft')
  })

  it('dirty GET 冲突后 loading 收敛，canSubmit 返回 conflict', async () => {
    const harness = createHarness()
    await loadHarness(harness, editorResponse({ revision: 5 }))
    harness.controller.setDraftText('LOCAL-dirty')
    harness.setRuntime({ authGeneration: 8 }) // 代际变化触发重新 GET
    await flushMicrotasks()
    expect(harness.gets.length).toBeGreaterThanOrEqual(2)
    harness.gets[harness.gets.length - 1].resolve(editorResponse({ revision: 9 }))
    await flushMicrotasks()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.conflict).not.toBeNull()
    expect(snapshot.loading).toBe(false)
    expect(harness.controller.canSubmit()).toEqual({ allowed: false, reason: 'conflict' })
  })
})

describe('verifier evidence gap: dispatchAutoIfPossible single-flight guard', () => {
  it('auto 单飞行守卫：unsynced 未决 mutation 上 debounce 不得自动并发第二个 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('A')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    // 初始 PUT + 3 次自动重试全部 503 → 重试耗尽，保留 active（unsynced），saving=false。
    for (let i = 0; i < 3; i += 1) {
      lastPut(harness).response.reject(httpError(503, 'editor_store_unavailable'))
      await advance(5000)
      expect(harness.puts.length).toBe(i + 2)
    }
    lastPut(harness).response.reject(httpError(503, 'editor_store_unavailable'))
    await advance(0)
    expect(harness.controller.getSnapshot().unsynced).toBe(true)
    const before = harness.puts.length
    harness.controller.setDraftText('B')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    // 未决 mutation 未结算前，debounce 触发的自动保存必须被单飞行守卫挡下（不并发 PUT）。
    expect(harness.puts.length).toBe(before)
  })

  it('在途保存未确认时新文本 debounce 不得再派发第二个 PUT（守卫承重）', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    expect(harness.puts.length).toBe(1)
    lastPut(harness).response.reject(new Error('connection reset'))
    await flushMicrotasks() // unconfirmed + 退避，saving=false 但 active 仍在
    harness.controller.setDraftText('T2')
    await advance(EDITOR_TEXT_DEBOUNCE_MS) // 自动保存意图触发：active 守卫必须拦截
    expect(harness.puts.length).toBe(1)
    await advance(1000) // 退避到点：用原 mutation/body 重放一次
    expect(harness.puts.length).toBe(2)
    expect(lastPut(harness).body).toEqual(harness.puts[0].body)
  })
})

describe('verifier observations: clear invalid ACK, 512KiB 口径', () => {
  it('清稿非法 ACK 保留 active/hold，retrySave 原样重放并最终 cleared', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.hold('submit', 'op1')
    const clearPromise = harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: 'tok-server', text: 'hello' },
      'op1',
    )
    const first = lastPut(harness)
    first.response.resolve({ ...saveResponse(first.body.mutation_id), mutation_id: 'other-id' })
    await flushMicrotasks()
    expect(await clearPromise).toBe('invalid')
    expect(harness.controller.hasPendingWork()).toBe(true)
    expect(harness.controller.getSnapshot().holds).toHaveLength(1)
    expect(await harness.controller.retrySave()).toBe('queued')
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    expect(lastPut(harness).body).toEqual(first.body)
    lastPut(harness).response.resolve(saveResponse(first.body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('')
    expect(harness.controller.getSnapshot().holds).toHaveLength(0)
  })

  it('文本未超 256KiB 但 JSON 转义后超 512KiB → flush blocked 且不发 PUT', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    const text = '"'.repeat(EDITOR_TEXT_MAX_BYTES) // 256KiB 字节：未超 draft.text 上限
    harness.controller.setDraftText(text)
    expect(harness.controller.getSnapshot().oversize).toBe(false)
    const outcome = await harness.controller.flush('text')
    expect(outcome).toBe('blocked')
    expect(harness.controller.getSnapshot().saveFailure?.code).toBe('editor_state_too_large')
    expect(harness.puts.length).toBe(0)
  })
})

describe('verifier 第二轮回归：GET 恢复基线只认文本内容', () => {
  function seedPrivateDraft(storage: MapStorage): void {
    writeDraft(
      { viewerUserId: '1', projectId: 'p1' },
      REF,
      'w-test',
      draftRecord({ text: 'PRIVATE-UNSAVED', token: 'tk-local', localVersion: 3 }),
      { storage },
    )
  }

  it('仅锚点变化 + GET 网络失败：未同步稿保留在 UI 与 storage，不被空写清空', async () => {
    const storage = new MapStorage()
    seedPrivateDraft(storage)
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    expect(harness.gets.length).toBe(1)
    // 仅滚动/锚点变化：localVersion 会 +1，但文本基线未变。
    harness.controller.setChatAnchor({ messageId: 'msg1', offsetPx: 12, followTail: false })
    harness.gets[0].reject(new Error('network down'))
    await loadPromise
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('PRIVATE-UNSAVED')
    await advance(100) // 本机 merge 定时器到点：不得用空文本覆盖唯一副本
    const stored = readDraft(harness.scope, harness.authority, REF, 'w-test', { storage })
    expect(stored?.text).toBe('PRIVATE-UNSAVED')
    expect(harness.controller.getSnapshot().draftText).toBe('PRIVATE-UNSAVED')
  })

  it('仅锚点变化 + GET 响应非法：未同步稿仍被读回，不被空写清空', async () => {
    const storage = new MapStorage()
    seedPrivateDraft(storage)
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    harness.controller.setChatAnchor({ messageId: 'msg1', offsetPx: 40, followTail: true })
    harness.gets[0].resolve({ nonsense: true })
    await loadPromise
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('PRIVATE-UNSAVED')
    await advance(100)
    const stored = readDraft(harness.scope, harness.authority, REF, 'w-test', { storage })
    expect(stored?.text).toBe('PRIVATE-UNSAVED')
  })

  it('仅锚点变化 + editor_state_unreadable：未同步稿仍被读回，不被空写清空', async () => {
    const storage = new MapStorage()
    seedPrivateDraft(storage)
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    harness.controller.setChatAnchor({ messageId: 'msg1', offsetPx: 8, followTail: false })
    harness.gets[0].resolve(editorResponse({ state: null, hash: null, warnings: ['editor_state_unreadable'] }))
    await loadPromise
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('PRIVATE-UNSAVED')
    await advance(100)
    const stored = readDraft(harness.scope, harness.authority, REF, 'w-test', { storage })
    expect(stored?.text).toBe('PRIVATE-UNSAVED')
  })

  it('恢复被跳过（遮蔽中失败）时，本机 merge 也不得用空文本覆盖已有非空稿（防御性守卫）', async () => {
    const storage = new MapStorage()
    seedPrivateDraft(storage)
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    // 锚点变化安排 100ms 本机 merge；遮蔽中 getCacheAuthority() 为 null → 恢复读不到本机稿。
    harness.controller.setChatAnchor({ messageId: 'msg1', offsetPx: 12, followTail: false })
    harness.setRuntime({ phase: 'masked', ready: false })
    harness.gets[0].reject(new Error('network down'))
    await loadPromise
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('')
    harness.setRuntime({ phase: 'ready', ready: true })
    await flushMicrotasks()
    await advance(100)
    const stored = readDraft(harness.scope, harness.authority, REF, 'w-test', { storage })
    expect(stored?.text).toBe('PRIVATE-UNSAVED')
  })

  it('锚点 + 文本都变化 + GET 失败：不恢复，保留用户新输入', async () => {
    const storage = new MapStorage()
    seedPrivateDraft(storage)
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    harness.controller.setChatAnchor({ messageId: 'msg1', offsetPx: 12, followTail: false })
    harness.controller.setDraftText('USER-NEW')
    harness.gets[0].reject(new Error('network down'))
    await loadPromise
    await flushMicrotasks()
    expect(harness.controller.getSnapshot().draftText).toBe('USER-NEW')
    await advance(100)
    const stored = readDraft(harness.scope, harness.authority, REF, 'w-test', { storage })
    expect(stored?.text).toBe('USER-NEW')
  })

  it('正常无编辑 + GET 失败：恢复本机稿，且本机写与 storage 记录一致', async () => {
    const storage = new MapStorage()
    seedPrivateDraft(storage)
    const harness = createHarness({ storage })
    const loadPromise = harness.controller.load()
    await flushMicrotasks()
    harness.gets[0].reject(new Error('network down'))
    await loadPromise
    await flushMicrotasks()
    await advance(100)
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.draftText).toBe('PRIVATE-UNSAVED')
    const stored = readDraft(harness.scope, harness.authority, REF, 'w-test', { storage })
    expect(stored).not.toBeNull()
    expect(stored?.text).toBe(snapshot.draftText)
    expect(stored?.localVersion).toBe(snapshot.localVersion)
    expect(stored?.dirty).toBe(true)
  })
})

describe('verifier 第二轮回归：瞬时遮蔽不得丢弃排队 save/clear', () => {
  it('在途 T1 + 排队 T2：masked 期间 ACK 到达后保留排队项，unmask 后续派发一次', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('T1')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const t1 = lastPut(harness)
    harness.controller.setDraftText('T2')
    const flushPromise = harness.controller.flush('switch')
    expect(harness.puts.length).toBe(1)
    harness.setRuntime({ phase: 'masked', ready: false })
    t1.response.resolve(saveResponse(t1.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    // 排队项不被消费：仍无第二个 PUT，promise 未结算。
    expect(harness.puts.length).toBe(1)
    let settled = false
    void flushPromise.then(() => {
      settled = true
    })
    await advance(2000)
    expect(settled).toBe(false)
    harness.setRuntime({ phase: 'ready', ready: true })
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    const t2 = lastPut(harness)
    expect(t2.body.editor_state.draft.text).toBe('T2')
    expect(t2.body.expected_revision).toBe(6)
    t2.response.resolve(saveResponse(t2.body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    await expect(flushPromise).resolves.toBe('saved')
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.draftText).toBe('T2')
    expect(snapshot.dirty).toBe(false)
  })

  it('在途 T1 + 排队 clear：masked 期间 ACK 到达后保留 clear 与 hold，unmask 后续派发并正常结算', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('hello!')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const t1 = lastPut(harness)
    const before = harness.controller.getSnapshot()
    harness.controller.hold('submit', 'op-clear')
    const clearPromise = harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: before.draftToken, text: before.draftText },
      'op-clear',
    )
    expect(harness.puts.length).toBe(1)
    harness.setRuntime({ phase: 'masked', ready: false })
    t1.response.resolve(saveResponse(t1.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    // masked：clear 不派发、hold 不释放、promise 未结算。
    expect(harness.puts.length).toBe(1)
    expect(harness.controller.getSnapshot().holds).toHaveLength(1)
    let settled = false
    void clearPromise.then(() => {
      settled = true
    })
    await advance(2000)
    expect(settled).toBe(false)
    harness.setRuntime({ phase: 'ready', ready: true })
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    const clearCall = lastPut(harness)
    expect(clearCall.body.editor_state.draft.text).toBe('')
    expect(harness.controller.getSnapshot().holds).toHaveLength(1) // ACK 前不释放 hold
    clearCall.response.resolve(saveResponse(clearCall.body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    await expect(clearPromise).resolves.toBe('cleared')
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.draftText).toBe('')
    expect(snapshot.dirty).toBe(false)
    expect(snapshot.holds).toHaveLength(0)
  })

  it('排队 clear 期间仅锚点变化仍派发（不因 localVersion 变化取消）', async () => {
    const harness = createHarness()
    await loadHarness(harness)
    harness.controller.setDraftText('hello!')
    await advance(EDITOR_TEXT_DEBOUNCE_MS)
    const t1 = lastPut(harness)
    const before = harness.controller.getSnapshot()
    harness.controller.hold('submit', 'op-clear')
    const clearPromise = harness.controller.clearAfterSubmission(
      { sessionRef: REF, draftToken: before.draftToken, text: before.draftText },
      'op-clear',
    )
    harness.controller.setChatAnchor({ messageId: 'msg1', offsetPx: 16, followTail: false })
    t1.response.resolve(saveResponse(t1.body.mutation_id, { revision: 6 }))
    await flushMicrotasks()
    expect(harness.puts.length).toBe(2)
    expect(lastPut(harness).body.editor_state.draft.text).toBe('')
    lastPut(harness).response.resolve(saveResponse(lastPut(harness).body.mutation_id, { revision: 7 }))
    await flushMicrotasks()
    await expect(clearPromise).resolves.toBe('cleared')
  })
})
