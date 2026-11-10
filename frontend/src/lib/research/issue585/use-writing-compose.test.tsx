/**
 * Issue #1048 PR7：写作编排 hook 测试（不触网；ports 注入 fake）。
 *
 * 覆盖：默认值、会话创建（预生成 id/同 id 重试/不自动发送）、composer ACK
 * 顺序与身份桥接、11 键请求与历史/选区、422 容量可见、SSE 终态后实际输入
 * 回看、结果未知原身份重放、恢复（版本/权限）、错误门控。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applySseEvent, createSseState } from '@/lib/research/sse'
import type { ResearchSseEvent } from '@/lib/research/types'
import type { ResearchSessionRef } from '@/lib/research/session-contract'
import {
  clearWritingCacheMemoryFallback,
  createWritingCacheRecord,
  readOrCreateWritingCacheTabId,
  readWritingCacheRecord,
  resetWritingCacheTabId,
  writeWritingCacheRecord,
  type WritingCacheRecord,
  type WritingCacheScope,
} from './writing-cache'
import { buildWritingSubmissionRequest } from './writing-intent'
import type { WritingContextProjection, WritingSelection } from './writing-types'
import {
  useWritingCompose,
  type WritingComposePorts,
  type UseWritingComposeOptions,
} from './use-writing-compose'

const NOTE = {
  noteId: 'note_abc',
  revision: 4,
  snapshotHash: 'a'.repeat(64),
  content: 'abcdef',
}

const CURRENT_REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: 'p_demo',
  sessionId: 'sess_current',
  sourceId: null,
}

const PROJECTION: WritingContextProjection = {
  generation_id: 'gen_1',
  input_id: 'inp_' + 'd'.repeat(64),
  input_schema_version: 4,
  input_hash: 'e'.repeat(64),
  document_context: {
    note_id: 'note_abc',
    revision: 4,
    snapshot_hash: 'a'.repeat(64),
    selection_kind: 'range',
    start_utf16: 1,
    end_utf16: 3,
    selected_text: 'bc',
    selected_text_hash: 'f'.repeat(64),
  },
  history: { mode: 'none', adopted: [], excluded: [] },
  integrity: {
    document_context_hash: '2'.repeat(64),
    history_hash: '3'.repeat(64),
    envelope_hash: '4'.repeat(64),
  },
  capacity: { input_utf8_bytes: 10, envelope_utf8_bytes: 20, limit_utf8_bytes: 1048576 },
  writing_checks: { version: 1, missing_binding_ids: [], unavailable_reason: null },
  access_state: 'visible',
}

const SAVED = { ok: true as const, revision: 77, intentHash: 'b'.repeat(64), draftToken: 'draft_saved' }

interface FakeHarness {
  ports: WritingComposePorts
  calls: string[]
  submitCalls: Array<Parameters<WritingComposePorts['submitWriting']>[0]>
  callbacks: () => Parameters<WritingComposePorts['submitWriting']>[0] | null
  getContextCalls: string[]
  createCalls: Array<Parameters<WritingComposePorts['createSession']>[0]>
  emitEvent: (event: ResearchSseEvent) => void
  emitAccept: (generationId: string) => void
  emitHttpError: (status: number, body: unknown) => void
  emitNetworkError: () => void
  emitEnd: () => void
  verifyNoteCalls: Array<{ projectId: string; noteId: string }>
  ownerResolutionCalls: Array<Parameters<WritingComposePorts['resolveOwnerUserId']>[1]>
}

function makeHarness(): FakeHarness {
  const calls: string[] = []
  const submitCalls: Array<Parameters<WritingComposePorts['submitWriting']>[0]> = []
  const getContextCalls: string[] = []
  const createCalls: Array<Parameters<WritingComposePorts['createSession']>[0]> = []
  const verifyNoteCalls: Array<{ projectId: string; noteId: string }> = []
  const ownerResolutionCalls: Array<Parameters<WritingComposePorts['resolveOwnerUserId']>[1]> = []
  let current: Parameters<WritingComposePorts['submitWriting']>[0] | null = null
  const ports: WritingComposePorts = {
    createSession: vi.fn(async (input) => {
      calls.push('createSession')
      createCalls.push(input)
      return {
        ok: true as const,
        ref: {
          domain: 'research' as const,
          kind: input.kind,
          projectId: input.projectId,
          sessionId: input.sessionId,
          sourceId: input.sourceId ?? null,
        },
        created: true,
      }
    }),
    submitWriting: vi.fn((input) => {
      calls.push('submitWriting')
      submitCalls.push(input)
      current = input
      return vi.fn()
    }),
    getWritingContext: vi.fn(async (_projectId, generationId) => {
      getContextCalls.push(generationId)
      return { ok: true as const, projection: PROJECTION }
    }),
    verifyNote: vi.fn(async (projectId, noteId) => {
      verifyNoteCalls.push({ projectId, noteId })
      return {
        ok: true as const,
        revision: NOTE.revision,
        snapshotHash: NOTE.snapshotHash,
      }
    }),
    resolveOwnerUserId: vi.fn(async (_projectId, ref) => {
      ownerResolutionCalls.push(ref)
      return 42
    }),
  }
  return {
    ports,
    calls,
    submitCalls,
    callbacks: () => current,
    getContextCalls,
    createCalls,
    emitEvent: (event) => current?.onEvent(event),
    emitAccept: (generationId) =>
      current?.onAcceptReceipt?.({
        generationId,
        idempotencyKey: 'w1_key',
        editorRevision: 77,
        sessionRef: CURRENT_REF,
      }),
    emitHttpError: (status, body) => current?.onHttpError?.(status, body),
    emitNetworkError: () => current?.onNetworkError?.(new Error('offline')),
    emitEnd: () => current?.onEnd?.(),
    verifyNoteCalls,
    ownerResolutionCalls,
  }
}

function baseOptions(overrides: Partial<UseWritingComposeOptions> = {}): UseWritingComposeOptions {
  return {
    projectId: 'p_demo',
    viewerUserId: '42',
    language: 'zh-CN',
    modelId: 'm-local',
    currentRef: CURRENT_REF,
    sourceId: null,
    currentNote: NOTE,
    notePermission: 'visible',
    initialSelection: { kind: 'range', start_utf16: 1, end_utf16: 3 },
    newAttemptId: () => 'watt_fixed',
    newSessionId: () => 'sess_client_fixed',
    newIdempotencyKey: () => 'w1_fixed',
    ...overrides,
  }
}

function scope(): WritingCacheScope {
  return {
    ownerId: '42',
    projectId: 'p_demo',
    noteId: NOTE.noteId,
    tabId: readOrCreateWritingCacheTabId(),
  }
}

function cacheRecord(
  overrides: { choice?: WritingCacheRecord['choice']; lastSubmission?: WritingCacheRecord['lastSubmission'] } = {},
): WritingCacheRecord {
  const base = createWritingCacheRecord({ scope: scope(), now: '2026-11-11T00:00:00.000Z' })
  return { ...base, ...overrides }
}

function seedCache(record: WritingCacheRecord): void {
  const result = writeWritingCacheRecord(scope(), record)
  expect(result.ok).toBe(true)
}

function readCache(): WritingCacheRecord | null {
  return readWritingCacheRecord(scope(), {
    authority: {
      authenticatedOwnerId: '42',
      currentProjectId: 'p_demo',
      authGeneration: 0,
      currentAuthGeneration: 0,
      notePermission: 'visible',
    },
  })
}

function answerEvent(eventId: number, delta: string): ResearchSseEvent {
  return { event_id: eventId, type: 'answer', delta }
}

function doneEvent(eventId: number): ResearchSseEvent {
  return { event_id: eventId, type: 'done', completion_status: 'completed' }
}

beforeEach(() => {
  clearWritingCacheMemoryFallback()
  resetWritingCacheTabId()
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('默认值', () => {
  it('history 默认 none；有当前会话时默认当前会话；初始选区来自入口', () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    expect(result.current.historyMode).toBe('none')
    expect(result.current.sessionChoiceKind).toBe('current')
    expect(result.current.selection).toEqual({ kind: 'range', start_utf16: 1, end_utf16: 3 })
    expect(result.current.targetRef?.sessionId).toBe('sess_current')
    expect(result.current.query).toBe('')
  })

  it('无当前会话时默认新建会话', () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports, currentRef: null })),
    )
    expect(result.current.sessionChoiceKind).toBe('new')
    expect(result.current.targetRef).toBeNull()
  })
})

describe('会话创建：预生成 id、同 id 重试、不自动发送', () => {
  it('创建会话使用客户端预生成 id，且创建后不提交写作', async () => {
    const harness = makeHarness()
    const openSession = vi.fn(() => true)
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports, openSession })),
    )
    act(() => result.current.setSessionChoice('new'))
    let created = false
    await act(async () => {
      created = await result.current.createSession()
    })
    expect(created).toBe(true)
    expect(harness.createCalls).toHaveLength(1)
    expect(harness.createCalls[0].sessionId).toBe('sess_client_fixed')
    expect(result.current.createdSession?.sessionId).toBe('sess_client_fixed')
    expect(result.current.targetRef?.sessionId).toBe('sess_client_fixed')
    expect(openSession).toHaveBeenCalledTimes(1)
    // 创建/打开会话不自动发送。
    expect(harness.calls).not.toContain('submitWriting')
    // pending create 记录在成功后清理。
    expect(readCache()?.pendingSessionCreate ?? null).toBeNull()
  })

  it('创建失败后用同一 session_id 重试（禁止重复创建）', async () => {
    const harness = makeHarness()
    const create = vi.mocked(harness.ports.createSession)
    create.mockResolvedValueOnce({
      ok: false,
      error: { code: 'network_error', message: '', retryable: true, status: 0 },
    })
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports, currentRef: null })),
    )
    await act(async () => {
      await result.current.createSession()
    })
    expect(result.current.composeError?.code).toBe('session_create_failed')
    expect(readCache()?.pendingSessionCreate?.sessionId).toBe('sess_client_fixed')
    await act(async () => {
      await result.current.createSession()
    })
    expect(vi.mocked(harness.ports.createSession).mock.calls.map((call) => call[0].sessionId)).toEqual([
      'sess_client_fixed',
      'sess_client_fixed',
    ])
    expect(result.current.createdSession?.sessionId).toBe('sess_client_fixed')
  })
})

describe('composer 身份桥接与请求构造', () => {
  it('先保存 composer 等 ACK，再用已保存身份构造独立意图的 11 键请求', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setQuery('请改写选段'))
    const order: string[] = []
    const saveComposer = vi.fn(async () => {
      order.push('saveComposer')
      return SAVED
    })
    await act(async () => {
      await result.current.submit(saveComposer)
    })
    order.push(...harness.calls)
    expect(saveComposer).toHaveBeenCalledWith('请改写选段')
    expect(order).toEqual(['saveComposer', 'submitWriting'])
    expect(harness.submitCalls).toHaveLength(1)
    const request = harness.submitCalls[0].request
    expect(request.schema_version).toBe(1)
    expect(request.editor_revision).toBe(SAVED.revision)
    expect(request.editor_intent_hash).toBe(SAVED.intentHash)
    expect(request.draft_token).toBe(SAVED.draftToken)
    expect(request.query).toBe('请改写选段')
    expect(request.model).toBe('m-local')
    expect(request.response_language).toBe('zh')
    expect(request.work_purpose).toBe('writing')
    expect(request.history_mode).toBe('none')
    expect(request.document_context).toEqual({
      note_id: NOTE.noteId,
      revision: NOTE.revision,
      snapshot_hash: NOTE.snapshotHash,
      selection: { kind: 'range', start_utf16: 1, end_utf16: 3 },
    })
    expect(request.writing_intent_hash).toMatch(/^[0-9a-f]{64}$/)
    // 与独立重算一致（Note revision 只在 document_context 中）。
    const rebuilt = buildWritingSubmissionRequest({
      projectId: 'p_demo',
      ownerUserId: 42,
      sessionKind: 'global',
      sourceId: null,
      sessionId: 'sess_current',
      editorRevision: SAVED.revision,
      editorIntentHash: SAVED.intentHash,
      draftToken: SAVED.draftToken,
      query: request.query,
      modelId: request.model,
      responseLanguage: request.response_language,
      documentContext: request.document_context,
      historyMode: request.history_mode,
    })
    expect(rebuilt.ok).toBe(true)
    if (rebuilt.ok) {
      expect(rebuilt.value.request.writing_intent_hash).toBe(request.writing_intent_hash)
    }
    expect(harness.submitCalls[0].idempotencyKey).toBe('w1_fixed')
  })

  it('显式 history=current 与选区切换反映到请求', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => {
      result.current.setHistoryMode('current')
      result.current.setSelection({ kind: 'full' })
      result.current.setQuery('改写')
    })
    await act(async () => {
      await result.current.submit(async () => SAVED)
    })
    const request = harness.submitCalls[0].request
    expect(request.history_mode).toBe('current')
    expect(request.document_context.selection).toEqual({ kind: 'full' })
  })

  it('composer 保存失败 → 不提交、可见错误码（conflict 单独区分）', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setQuery('改写'))
    await act(async () => {
      await result.current.submit(async () => ({ ok: false, code: 'conflict' }))
    })
    expect(harness.submitCalls).toHaveLength(0)
    expect(result.current.composeError).toMatchObject({
      stage: 'composer',
      code: 'composer_conflict',
    })
  })

  it('无目标会话 → session_required（不保存 composer、不提交）', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports, currentRef: null })),
    )
    act(() => result.current.setQuery('改写'))
    const saveComposer = vi.fn(async () => SAVED)
    await act(async () => {
      await result.current.submit(saveComposer)
    })
    expect(result.current.composeError?.code).toBe('session_required')
    expect(saveComposer).not.toHaveBeenCalled()
    expect(harness.submitCalls).toHaveLength(0)
  })

  it('owner 身份无法验证（claims 非数字且服务端解析失败）→ owner_unknown（不保存 composer）', async () => {
    const harness = makeHarness()
    ;(harness.ports as { resolveOwnerUserId: unknown }).resolveOwnerUserId = vi.fn(
      async () => null,
    )
    const ownerUnknown = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports, viewerUserId: 'abc' })),
    )
    act(() => ownerUnknown.result.current.setQuery('改写'))
    await act(async () => {
      await ownerUnknown.result.current.submit(async () => SAVED)
    })
    expect(ownerUnknown.result.current.composeError?.code).toBe('owner_unknown')
    expect(harness.calls).toHaveLength(0)
  })

  it('未确认模型 → model_missing（不保存 composer）', async () => {
    const harness = makeHarness()
    const modelMissing = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports, modelId: null })),
    )
    act(() => modelMissing.result.current.setQuery('改写'))
    await act(async () => {
      await modelMissing.result.current.submit(async () => SAVED)
    })
    expect(modelMissing.result.current.composeError?.code).toBe('model_missing')
    expect(harness.calls).toHaveLength(0)
  })

  it('空写作指令 → query_required（不保存 composer）', async () => {
    const harness = makeHarness()
    const noQuery = renderHook(() => useWritingCompose(baseOptions({ ports: harness.ports })))
    await act(async () => {
      await noQuery.result.current.submit(async () => SAVED)
    })
    expect(noQuery.result.current.composeError?.code).toBe('query_required')
    expect(harness.calls).toHaveLength(0)
  })
})

describe('SSE 终态与实际输入回看', () => {
  it('accepted 绑定 generation → done 后拉取写作上下文并清理缓存', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setQuery('改写'))
    await act(async () => {
      await result.current.submit(async () => SAVED)
    })
    act(() => harness.emitAccept('gen_1'))
    expect(result.current.submission.generationId).toBe('gen_1')
    act(() => {
      harness.emitEvent(answerEvent(1, '改写'))
      harness.emitEvent(answerEvent(2, '结果'))
      harness.emitEvent(doneEvent(3))
    })
    await waitFor(() => expect(result.current.submission.stage).toBe('done'))
    expect(result.current.submission.answer).toBe('改写结果')
    expect(result.current.submission.terminal).toBe('done')
    expect(harness.getContextCalls).toEqual(['gen_1'])
    expect(result.current.submission.context?.generation_id).toBe('gen_1')
    expect(readCache()).toBeNull()
  })

  it('422 context_limit_exceeded → 可见错误且不改选全文/不截断', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setQuery('x'.repeat(10)))
    await act(async () => {
      await result.current.submit(async () => SAVED)
    })
    act(() =>
      harness.emitHttpError(422, {
        detail: { code: 'context_limit_exceeded', retryable: false },
      }),
    )
    await waitFor(() => expect(result.current.submission.stage).toBe('error'))
    expect(result.current.submission.error?.code).toBe('context_limit_exceeded')
    expect(result.current.query).toBe('x'.repeat(10))
    expect(result.current.selection).toEqual({ kind: 'range', start_utf16: 1, end_utf16: 3 })
    expect(harness.calls.filter((call) => call === 'submitWriting')).toHaveLength(1)
  })

  it('结果未知（网络错误）→ 原请求身份重放，不重新保存 composer', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setQuery('改写'))
    const saveComposer = vi.fn(async () => SAVED)
    await act(async () => {
      await result.current.submit(saveComposer)
    })
    const firstRequest = harness.submitCalls[0].request
    act(() => harness.emitNetworkError())
    await waitFor(() => expect(result.current.submission.stage).toBe('error'))
    saveComposer.mockClear()
    await act(async () => {
      await result.current.retrySameSubmission()
    })
    expect(harness.submitCalls).toHaveLength(2)
    expect(harness.submitCalls[1].request).toEqual(firstRequest)
    expect(harness.submitCalls[1].idempotencyKey).toBe(harness.submitCalls[0].idempotencyKey)
    expect(saveComposer).not.toHaveBeenCalled()
  })
})

describe('恢复：版本/权限重查与原意图', () => {
  const choice = (revision: number): WritingCacheRecord['choice'] => ({
    documentSelection: {
      note_id: NOTE.noteId,
      revision,
      snapshot_hash: NOTE.snapshotHash,
      selection: { kind: 'range', start_utf16: 1, end_utf16: 3 },
    },
    historyMode: 'current',
    sessionChoice: 'current',
    sessionKind: 'global',
    sourceId: null,
    currentSessionId: 'sess_current',
    query: '恢复的指令',
    modelId: 'm-local',
  })

  it('未发送选择与当前 Note 版本一致 → 恢复 prefill', async () => {
    seedCache(cacheRecord({ choice: choice(4) }))
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    await waitFor(() => expect(result.current.recovery?.kind).toBe('unsent'))
    expect(result.current.selection).toEqual({ kind: 'range', start_utf16: 1, end_utf16: 3 })
    expect(result.current.historyMode).toBe('current')
    expect(result.current.query).toBe('恢复的指令')
  })

  it('Note 版本已变化 → stale，且不静默改用当前正文', async () => {
    seedCache(cacheRecord({ choice: choice(3) }))
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    await waitFor(() => expect(result.current.recovery?.kind).toBe('stale'))
    expect(result.current.selection).toEqual({ kind: 'range', start_utf16: 1, end_utf16: 3 })
    expect(result.current.query).toBe('')
    expect(readCache()?.choice ?? null).toBeNull()
  })

  it('Note 权限受限 → 清理缓存，不恢复正文/选择', async () => {
    seedCache(cacheRecord({ choice: choice(4) }))
    const harness = makeHarness()
    renderHook(() =>
      useWritingCompose(
        baseOptions({ ports: harness.ports, notePermission: 'restricted' }),
      ),
    )
    await waitFor(() => expect(readCache()).toBeNull())
  })

  it('结果未知的 lastSubmission → recovery unknown，重放保持原 writing_intent_hash', async () => {
    const lastSubmissionSeed: NonNullable<WritingCacheRecord['lastSubmission']> = {
        sessionId: 'sess_current',
        sessionKind: 'global',
        sourceId: null,
        writingIntentHash: '',
        editorRevision: 12,
        editorIntentHash: 'c'.repeat(64),
        draftToken: 'draft_old',
        query: '原指令',
        modelId: 'm-local',
        responseLanguage: 'zh',
        documentContext: {
          note_id: NOTE.noteId,
          revision: 4,
          snapshot_hash: NOTE.snapshotHash,
          selection: { kind: 'full' },
        },
        historyMode: 'none',
        createdAt: '2026-11-11T00:00:01.000Z',
    }
    const rebuilt = buildWritingSubmissionRequest({
      projectId: 'p_demo',
      ownerUserId: 42,
      sessionKind: 'global',
      sourceId: null,
      sessionId: 'sess_current',
      editorRevision: 12,
      editorIntentHash: 'c'.repeat(64),
      draftToken: 'draft_old',
      query: '原指令',
      modelId: 'm-local',
      responseLanguage: 'zh',
      documentContext: {
        note_id: NOTE.noteId,
        revision: 4,
        snapshot_hash: NOTE.snapshotHash,
        selection: { kind: 'full' },
      },
      historyMode: 'none',
    })
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    seedCache(
      cacheRecord({
        lastSubmission: { ...lastSubmissionSeed, writingIntentHash: rebuilt.value.intentHash },
      }),
    )
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports, currentRef: CURRENT_REF })),
    )
    await waitFor(() => expect(result.current.recovery?.kind).toBe('unknown'))
    await act(async () => {
      await result.current.retrySameSubmission()
    })
    // 用原 intent 重放：同一 draft_token/editor 身份/writing_intent_hash，且
    // 不重新保存 composer、不生成新 token。
    expect(harness.submitCalls).toHaveLength(1)
    expect(harness.submitCalls[0].request.draft_token).toBe('draft_old')
    expect(harness.submitCalls[0].request.editor_revision).toBe(12)
    expect(harness.submitCalls[0].request.writing_intent_hash).toBe(
      rebuilt.value.request.writing_intent_hash,
    )
    expect(harness.submitCalls[0].sessionRef.sessionId).toBe('sess_current')
  })
})

describe('容量说明（含超限）', () => {
  it('按 UTF-8 字节展示选区/指令容量，超限标记', () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setSelection({ kind: 'full' }))
    expect(result.current.capacity.selectedTextBytes).toBe(NOTE.content.length)
    act(() => result.current.setQuery('😀'))
    expect(result.current.capacity.queryBytes).toBe(4)
    act(() => result.current.setQuery('x'.repeat(128 * 1024 + 1)))
    expect(result.current.capacity.overLimit).toBe(true)
    expect(result.current.capacity.overLimitParts).toContain('query')
  })
})

describe('SSE reducer 交叉校验（事件累积语义）', () => {
  it('乱序/重复事件经 applySseEvent 合并后为最终正文', () => {
    let state = createSseState()
    state = applySseEvent(state, answerEvent(2, 'b'))
    state = applySseEvent(state, answerEvent(1, 'a'))
    state = applySseEvent(state, answerEvent(2, 'b'))
    expect(state.answer).toBe('ab')
  })
})

describe('review round 1 修复回归', () => {
  it('MEDIUM-1：新建会话成功即持久化 confirmed，刷新/重开不重复创建', async () => {
    const harness = makeHarness()
    const options = baseOptions({
      ports: harness.ports,
      currentRef: null,
      sourceId: null,
    })
    const first = renderHook(() => useWritingCompose(options))
    act(() => first.result.current.setSelection({ kind: 'full' }))
    await act(async () => {
      await first.result.current.createSession()
    })
    expect(harness.createCalls).toHaveLength(1)
    const createdId = first.result.current.createdSession?.sessionId
    expect(createdId).toBe('sess_client_fixed')
    expect(readCache()?.confirmedSessionCreate).toMatchObject({
      sessionId: 'sess_client_fixed',
      sessionKind: 'global',
      sourceId: null,
    })
    first.unmount()

    const harness2 = makeHarness()
    const second = renderHook(() => useWritingCompose({ ...options, ports: harness2.ports }))
    await waitFor(() => expect(second.result.current.createdSession?.sessionId).toBe(createdId))
    // 刷新恢复：不再次创建（服务端不出现重复空会话）。
    expect(harness2.createCalls).toHaveLength(0)
  })

  it('MEDIUM-2：输入的 query 随 debounce 落盘，刷新后恢复', async () => {
    const harness = makeHarness()
    const first = renderHook(() => useWritingCompose(baseOptions({ ports: harness.ports })))
    act(() => first.result.current.setQuery('未发送的指令'))
    await waitFor(() => expect(readCache()?.choice?.query).toBe('未发送的指令'))
    first.unmount()

    const harness2 = makeHarness()
    const second = renderHook(() => useWritingCompose(baseOptions({ ports: harness2.ports })))
    await waitFor(() => expect(second.result.current.recovery?.kind).toBe('unsent'))
    expect(second.result.current.query).toBe('未发送的指令')
  })

  it('HIGH-2：缓存选择属于其它会话 → stale(session)，不静默改投当前会话', () => {
    seedCache(
      cacheRecord({
        choice: {
          documentSelection: {
            note_id: NOTE.noteId,
            revision: NOTE.revision,
            snapshot_hash: NOTE.snapshotHash,
            selection: { kind: 'range', start_utf16: 1, end_utf16: 3 },
          },
          historyMode: 'current',
          sessionChoice: 'current',
          sessionKind: 'global',
          sourceId: null,
          currentSessionId: 'sess_other',
          query: '旧会话的指令',
          modelId: 'm-local',
        },
      }),
    )
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    return waitFor(() => expect(result.current.recovery?.kind).toBe('stale')).then(() => {
      expect(result.current.recovery?.cause).toBe('session')
      expect(result.current.query).toBe('')
      expect(readCache()?.choice ?? null).toBeNull()
    })
  })

  it('HIGH-2：source 会话缓存不得在 global surface 恢复', async () => {
    seedCache(
      cacheRecord({
        choice: {
          documentSelection: {
            note_id: NOTE.noteId,
            revision: NOTE.revision,
            snapshot_hash: NOTE.snapshotHash,
            selection: { kind: 'full' },
          },
          historyMode: 'none',
          sessionChoice: 'current',
          sessionKind: 'source',
          sourceId: 'src_1',
          currentSessionId: 'sess_src',
          query: '来源指令',
          modelId: 'm-local',
        },
      }),
    )
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    await waitFor(() => expect(result.current.recovery?.kind).toBe('stale'))
    expect(result.current.recovery?.cause).toBe('session')
    expect(result.current.query).toBe('')
    expect(result.current.sessionChoiceKind).toBe('current')
  })

  it('MEDIUM-3：恢复前重查 Note；服务端受限 → 清理缓存并只显示受限', async () => {
    seedCache(
      cacheRecord({
        choice: {
          documentSelection: {
            note_id: NOTE.noteId,
            revision: NOTE.revision,
            snapshot_hash: NOTE.snapshotHash,
            selection: { kind: 'full' },
          },
          historyMode: 'none',
          sessionChoice: 'current',
          sessionKind: 'global',
          sourceId: null,
          currentSessionId: 'sess_current',
          query: '待恢复',
          modelId: 'm-local',
        },
      }),
    )
    const harness = makeHarness()
    ;(harness.ports as { verifyNote: unknown }).verifyNote = vi.fn(
      async () => ({ ok: false as const, reason: 'restricted' as const }),
    )
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    await waitFor(() => expect(result.current.recovery?.kind).toBe('restricted'))
    expect(harness.ports.verifyNote).toHaveBeenCalledWith('p_demo', NOTE.noteId)
    expect(readCache()).toBeNull()
    expect(result.current.query).toBe('')
  })

  it('MEDIUM-3：权限/版本暂不可判定 → unavailable，保留缓存不恢复正文', async () => {
    seedCache(
      cacheRecord({
        choice: {
          documentSelection: {
            note_id: NOTE.noteId,
            revision: NOTE.revision,
            snapshot_hash: NOTE.snapshotHash,
            selection: { kind: 'full' },
          },
          historyMode: 'none',
          sessionChoice: 'current',
          sessionKind: 'global',
          sourceId: null,
          currentSessionId: 'sess_current',
          query: '待恢复',
          modelId: 'm-local',
        },
      }),
    )
    const harness = makeHarness()
    ;(harness.ports as { verifyNote: unknown }).verifyNote = vi.fn(
      async () => ({ ok: false as const, reason: 'unavailable' as const }),
    )
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    await waitFor(() => expect(result.current.recovery?.kind).toBe('unavailable'))
    expect(result.current.query).toBe('')
    expect(readCache()?.choice?.query).toBe('待恢复')
  })

  it('MEDIUM-4：composer ACK 等待期间重复发送 → 单次保存/单次提交', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setQuery('改写'))
    let resolveSave: ((value: typeof SAVED) => void) | null = null
    const saveComposer = vi.fn(
      () =>
        new Promise<typeof SAVED>((resolve) => {
          resolveSave = resolve
        }),
    )
    let firstSubmit: Promise<void> | null = null
    act(() => {
      firstSubmit = result.current.submit(saveComposer)
    })
    expect(saveComposer).toHaveBeenCalledTimes(1)
    expect(result.current.submission.stage).toBe('preparing_composer')
    // 第二次点击：single-flight 直接忽略。
    await act(async () => {
      await result.current.submit(saveComposer)
    })
    expect(saveComposer).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveSave?.(SAVED)
      await firstSubmit
    })
    expect(harness.submitCalls).toHaveLength(1)
  })

  it('MEDIUM-5：EOF 无终态 → 结算为可重试错误；重放同原身份', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setQuery('改写'))
    await act(async () => {
      await result.current.submit(async () => SAVED)
    })
    act(() => {
      harness.emitAccept('gen_1')
      harness.emitEvent(answerEvent(1, '部分'))
      harness.emitEnd()
    })
    expect(result.current.submission.stage).toBe('error')
    expect(result.current.submission.error?.retryable).toBe(true)
    const firstIntent = harness.submitCalls[0].request.writing_intent_hash
    await act(async () => {
      await result.current.retrySameSubmission()
    })
    expect(harness.submitCalls).toHaveLength(2)
    expect(harness.submitCalls[1].request.writing_intent_hash).toBe(firstIntent)
    expect(harness.submitCalls[1].request.draft_token).toBe(harness.submitCalls[0].request.draft_token)
  })

  it('MEDIUM-6：422 未知码不冒充容量超限；session_contract_unsupported 原样可见', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(baseOptions({ ports: harness.ports })),
    )
    act(() => result.current.setQuery('改写'))
    await act(async () => {
      await result.current.submit(async () => SAVED)
    })
    act(() => {
      harness.emitHttpError(422, { detail: { code: 'session_contract_unsupported' } })
    })
    expect(result.current.submission.error?.code).toBe('session_contract_unsupported')
    act(() => {
      harness.emitHttpError(422, { detail: { code: 'new_422_code' } })
    })
    expect(result.current.submission.error?.code).toBe('invalid_request')
    act(() => {
      harness.emitHttpError(409, { detail: { code: 'new_conflict' } })
    })
    expect(result.current.submission.error?.code).toBe('conflict')
  })

  it('LOW-3：claims.sub 非数字时用服务端 viewer_user_id 解析 owner 并成功提交', async () => {
    const harness = makeHarness()
    const { result } = renderHook(() =>
      useWritingCompose(
        baseOptions({ ports: harness.ports, viewerUserId: 'user_1' }),
      ),
    )
    act(() => result.current.setQuery('改写'))
    await act(async () => {
      await result.current.submit(async () => SAVED)
    })
    expect(harness.ownerResolutionCalls).toHaveLength(1)
    expect(harness.submitCalls).toHaveLength(1)
    expect(harness.submitCalls[0].sessionRef.sessionId).toBe('sess_current')
  })
})

// 防止未使用导入告警（类型交叉引用）
const _selectionTypeCheck: WritingSelection = { kind: 'full' }
void _selectionTypeCheck
