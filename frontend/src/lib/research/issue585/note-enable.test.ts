/**
 * 启用受保护编辑状态机单测（Issue #1135）。
 *
 * 覆盖：成功（含已受保护 receipt=null）、响应非 d2-v1 按结果未知、能力/Admin
 * 守卫不触网、403/404/409/503/网络错误分类与重试策略（unknown/dependency/
 * snapshot 同 mutation 重放；conflict 换新 mutation）、单在途防重入、取消/
 * 关闭复位、新一次启用不复用旧 mutation、dispose 后 no-op。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyNoteEnableError,
  createNoteEnableMachine,
  noteEnableBlockReason,
  type NoteEnableMachine,
  type NoteEnableMachineOptions,
} from './note-enable'
import type { NoteApiClient } from './note-client'
import type { NoteApiError, NoteCapabilities, NoteReceipt, ResearchNoteD2 } from './types'

const PROJECT = 'proj_1'
const NOTE = 'note_legacy'
const HASH = 'a'.repeat(64)

const CAPS_READY: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function note(overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 {
  return {
    note_id: NOTE,
    project_id: PROJECT,
    title: '旧笔记',
    content: '旧正文',
    note_type: 'human',
    created_at: null,
    updated_at: '2026-11-05T00:00:00.000Z',
    revision: 3,
    snapshot_hash: HASH,
    edit_schema: 'd2-v1',
    access_state: 'visible',
    ...overrides,
  }
}

function receipt(overrides: Partial<NoteReceipt> = {}): NoteReceipt {
  return {
    note_id: NOTE,
    mutation_id: 'nm1',
    applied_revision: 4,
    snapshot_hash: HASH,
    saved_at: '2026-11-05T00:00:00.000Z',
    replayed: false,
    ...overrides,
  }
}

function apiError(
  code: NoteApiError['code'],
  overrides: Partial<NoteApiError> = {},
): NoteApiError {
  return { code, message: '', retryable: false, status: 0, ...overrides }
}

/** axios 形状（走 normalizeNoteApiError 归一化路径）。 */
function httpError(
  status: number,
  code: NoteApiError['code'],
  retryable = false,
): Record<string, unknown> {
  return {
    response: {
      status,
      data: { detail: { code, message: '', retryable, request_id: 'req_1' } },
    },
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFakeClient() {
  return {
    listNotes: vi.fn(),
    getNote: vi.fn(),
    createNote: vi.fn(),
    saveNote: vi.fn(),
    deleteNote: vi.fn(),
    enableNoteEditing: vi.fn(),
    copyNote: vi.fn(),
  }
}

type FakeClient = ReturnType<typeof createFakeClient>

let client: FakeClient
let machine: NoteEnableMachine
let mutationSequence = 0

function buildMachine(overrides: Partial<NoteEnableMachineOptions> = {}): NoteEnableMachine {
  mutationSequence = 0
  return createNoteEnableMachine({
    projectId: PROJECT,
    isAdminReadonly: false,
    capabilities: CAPS_READY,
    client: client as unknown as NoteApiClient,
    nextMutationId: () => `nm${(mutationSequence += 1)}`,
    ...overrides,
  })
}

const state = () => machine.getState()
const actions = () => machine.getActions()

function expectEnableCalledWith(mutationId: string): void {
  expect(client.enableNoteEditing).toHaveBeenCalledWith(PROJECT, NOTE, {
    mutation_id: mutationId,
  })
}

describe('noteEnableBlockReason', () => {
  it('capabilities=null → capability_unknown（fail-closed）', () => {
    expect(noteEnableBlockReason(null)).toBe('capability_unknown')
  })

  it('note_editor 关闭 → 透传服务端 reason；无 reason → capability_unknown', () => {
    expect(
      noteEnableBlockReason({
        ...CAPS_READY,
        noteEditor: { available: false, reason: 'disabled_by_flag' },
      }),
    ).toBe('disabled_by_flag')
    expect(
      noteEnableBlockReason({
        ...CAPS_READY,
        noteEditor: { available: false, reason: null },
      }),
    ).toBe('capability_unknown')
  })

  it('note_editor.available=true → null（可启用）', () => {
    expect(noteEnableBlockReason(CAPS_READY)).toBeNull()
  })
})

describe('classifyNoteEnableError', () => {
  it('终态错误无重试（restricted/not_found/unsupported）', () => {
    expect(classifyNoteEnableError(apiError('note_access_restricted'))).toEqual({
      failureKind: 'restricted',
      retryMode: 'none',
    })
    expect(classifyNoteEnableError(apiError('note_not_found'))).toEqual({
      failureKind: 'not_found',
      retryMode: 'none',
    })
    expect(classifyNoteEnableError(apiError('note_edit_schema_unsupported'))).toEqual({
      failureKind: 'unsupported',
      retryMode: 'none',
    })
    expect(classifyNoteEnableError(apiError('note_request_invalid'))).toEqual({
      failureKind: 'unsupported',
      retryMode: 'none',
    })
  })

  it('冲突类换新 mutation 重试（409 非 retryable，但同一 id 会再次 mutation_id_reused）', () => {
    for (const code of [
      'mutation_id_reused',
      'note_revision_conflict',
      'note_revision_required',
      'note_revision_exhausted',
      'note_snapshot_fence_exhausted',
    ] as const) {
      expect(classifyNoteEnableError(apiError(code))).toEqual({
        failureKind: 'conflict',
        retryMode: 'new_mutation',
      })
    }
  })

  it('依赖/快照不可判定：可重试但必须同一 mutation（retryable 语义）', () => {
    expect(classifyNoteEnableError(apiError('note_dependency_unavailable', { retryable: true }))).toEqual(
      { failureKind: 'unavailable', retryMode: 'same_mutation' },
    )
    expect(classifyNoteEnableError(apiError('note_snapshot_unavailable', { retryable: true }))).toEqual(
      { failureKind: 'unavailable', retryMode: 'same_mutation' },
    )
  })

  it('store/网络/未知码按结果未知处理（同一 mutation 确认）', () => {
    for (const code of ['note_store_unavailable', 'network_error', 'unknown_error'] as const) {
      expect(classifyNoteEnableError(apiError(code))).toEqual({
        failureKind: 'unknown',
        retryMode: 'same_mutation',
      })
    }
  })
})

describe('createNoteEnableMachine', () => {
  beforeEach(() => {
    client = createFakeClient()
    machine = buildMachine()
  })

  it('初始 idle 且无 mutation', () => {
    expect(state()).toEqual({
      phase: 'idle',
      noteId: null,
      mutationId: null,
      error: null,
      failureKind: null,
      retryMode: 'none',
      blockReason: null,
    })
  })

  it('requestEnable → confirming（不发请求）；confirm 成功后返回 note_id 并回 idle', async () => {
    client.enableNoteEditing.mockResolvedValue({ note: note(), receipt: receipt() })

    actions().requestEnable(NOTE)
    expect(state().phase).toBe('confirming')
    expect(state().noteId).toBe(NOTE)
    expect(client.enableNoteEditing).not.toHaveBeenCalled()

    const result = await actions().confirmEnable()
    expect(result).toBe(NOTE)
    expectEnableCalledWith('nm1')
    expect(state().phase).toBe('idle')
    expect(state().mutationId).toBeNull()
    expect(state().error).toBeNull()
  })

  it('已受保护（receipt=null）按成功结算，不假装新建', async () => {
    client.enableNoteEditing.mockResolvedValue({ note: note({ revision: 3 }), receipt: null })

    actions().requestEnable(NOTE)
    await expect(actions().confirmEnable()).resolves.toBe(NOTE)
    expect(state().phase).toBe('idle')
    expect(client.enableNoteEditing).toHaveBeenCalledTimes(1)
  })

  it('响应 note 非 d2-v1 → 结果未知（error/unknown/same_mutation，保留 mutation）', async () => {
    client.enableNoteEditing.mockResolvedValue({
      note: note({ edit_schema: null }),
      receipt: null,
    })

    actions().requestEnable(NOTE)
    await expect(actions().confirmEnable()).resolves.toBeNull()
    expect(state().phase).toBe('error')
    expect(state().failureKind).toBe('unknown')
    expect(state().retryMode).toBe('same_mutation')
    expect(state().mutationId).toBe('nm1')
    expect(state().error?.code).toBe('unknown_error')
  })

  it('畸形响应（缺 note）→ 结果未知', async () => {
    client.enableNoteEditing.mockResolvedValue(undefined)

    actions().requestEnable(NOTE)
    await expect(actions().confirmEnable()).resolves.toBeNull()
    expect(state().failureKind).toBe('unknown')
    expect(state().retryMode).toBe('same_mutation')
  })

  it('Admin 守卫：error + blockReason=admin_readonly，不发请求', () => {
    machine = buildMachine({ isAdminReadonly: true })
    actions().requestEnable(NOTE)

    expect(state().phase).toBe('error')
    expect(state().blockReason).toBe('admin_readonly')
    expect(state().failureKind).toBe('restricted')
    expect(state().retryMode).toBe('none')
    expect(client.enableNoteEditing).not.toHaveBeenCalled()
  })

  it('capabilities=null 守卫：error + blockReason=capability_unknown，不发请求', () => {
    machine = buildMachine({ capabilities: null })
    actions().requestEnable(NOTE)

    expect(state().phase).toBe('error')
    expect(state().blockReason).toBe('capability_unknown')
    expect(state().failureKind).toBe('unavailable')
    expect(client.enableNoteEditing).not.toHaveBeenCalled()
  })

  it('note_editor 关闭守卫：透传能力 reason，不发请求；能力恢复后可再启用', () => {
    machine = buildMachine({
      capabilities: { ...CAPS_READY, noteEditor: { available: false, reason: 'disabled_by_flag' } },
    })
    actions().requestEnable(NOTE)
    expect(state().blockReason).toBe('disabled_by_flag')
    expect(client.enableNoteEditing).not.toHaveBeenCalled()

    machine.updateCapabilities(CAPS_READY)
    actions().requestEnable(NOTE)
    expect(state().phase).toBe('confirming')
  })

  it.each([
    ['note_access_restricted', 403, 'restricted', 'none', false],
    ['note_not_found', 404, 'not_found', 'none', false],
    ['note_edit_schema_unsupported', 409, 'unsupported', 'none', false],
    ['note_request_invalid', 422, 'unsupported', 'none', false],
    ['mutation_id_reused', 409, 'conflict', 'new_mutation', true],
    ['note_revision_conflict', 409, 'conflict', 'new_mutation', true],
    ['note_revision_required', 428, 'conflict', 'new_mutation', true],
    ['note_revision_exhausted', 409, 'conflict', 'new_mutation', true],
    ['note_snapshot_fence_exhausted', 409, 'conflict', 'new_mutation', true],
    ['note_dependency_unavailable', 503, 'unavailable', 'same_mutation', true],
    ['note_snapshot_unavailable', 503, 'unavailable', 'same_mutation', true],
    ['note_store_unavailable', 503, 'unknown', 'same_mutation', true],
    ['network_error', 0, 'unknown', 'same_mutation', true],
    ['unknown_error', 500, 'unknown', 'same_mutation', true],
  ] as const)(
    '错误码 %s（HTTP %s）→ %s / %s',
    async (code, status, failureKind, retryMode, retryable) => {
      if (status === 0) {
        client.enableNoteEditing.mockRejectedValue(apiError(code, { retryable }))
      } else {
        client.enableNoteEditing.mockRejectedValue(httpError(status, code, retryable))
      }

      actions().requestEnable(NOTE)
      await expect(actions().confirmEnable()).resolves.toBeNull()

      expect(state().phase).toBe('error')
      expect(state().failureKind).toBe(failureKind)
      expect(state().retryMode).toBe(retryMode)
      expect(state().mutationId).toBe('nm1')
      expect(state().error?.code).toBe(code)
      // 失败不得调用任何写路径之外的接口
      expect(client.saveNote).not.toHaveBeenCalled()
      expect(client.createNote).not.toHaveBeenCalled()
    },
  )

  it('未知结果重试复用同一 mutation_id，第二次成功', async () => {
    client.enableNoteEditing
      .mockRejectedValueOnce(apiError('network_error', { retryable: true }))
      .mockResolvedValueOnce({ note: note(), receipt: null })

    actions().requestEnable(NOTE)
    await expect(actions().confirmEnable()).resolves.toBeNull()
    expect(state().retryMode).toBe('same_mutation')

    await expect(actions().retry()).resolves.toBe(NOTE)
    expect(client.enableNoteEditing).toHaveBeenNthCalledWith(1, PROJECT, NOTE, {
      mutation_id: 'nm1',
    })
    expect(client.enableNoteEditing).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm1',
    })
    expect(state().phase).toBe('idle')
  })

  it('依赖不可判定重试复用同一 mutation_id（retryable 语义）', async () => {
    client.enableNoteEditing
      .mockRejectedValueOnce(httpError(503, 'note_dependency_unavailable', true))
      .mockResolvedValueOnce({ note: note(), receipt: null })

    actions().requestEnable(NOTE)
    await expect(actions().confirmEnable()).resolves.toBeNull()
    expect(state().failureKind).toBe('unavailable')

    await expect(actions().retry()).resolves.toBe(NOTE)
    expect(client.enableNoteEditing).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm1',
    })
  })

  it('冲突重试使用新 mutation_id（避免同一 id 再次 mutation_id_reused）', async () => {
    client.enableNoteEditing
      .mockRejectedValueOnce(httpError(409, 'mutation_id_reused'))
      .mockResolvedValueOnce({ note: note(), receipt: receipt() })

    actions().requestEnable(NOTE)
    await expect(actions().confirmEnable()).resolves.toBeNull()
    expect(state().failureKind).toBe('conflict')

    await expect(actions().retry()).resolves.toBe(NOTE)
    expect(client.enableNoteEditing).toHaveBeenNthCalledWith(1, PROJECT, NOTE, {
      mutation_id: 'nm1',
    })
    expect(client.enableNoteEditing).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm2',
    })
  })

  it('终态错误不可重试（restricted/not_found/unsupported）', async () => {
    client.enableNoteEditing.mockRejectedValue(httpError(403, 'note_access_restricted'))

    actions().requestEnable(NOTE)
    await expect(actions().confirmEnable()).resolves.toBeNull()
    expect(state().retryMode).toBe('none')

    await expect(actions().retry()).resolves.toBeNull()
    expect(client.enableNoteEditing).toHaveBeenCalledTimes(1)
  })

  it('单在途：pending 期间 confirm/retry/cancel/requestEnable 均 no-op', async () => {
    const pending = deferred<{ note: ResearchNoteD2; receipt: NoteReceipt | null }>()
    client.enableNoteEditing.mockReturnValue(pending.promise)

    actions().requestEnable(NOTE)
    const first = actions().confirmEnable()
    expect(state().phase).toBe('pending')

    await expect(actions().confirmEnable()).resolves.toBeNull()
    await expect(actions().retry()).resolves.toBeNull()
    actions().cancel()
    actions().requestEnable('note_other')
    expect(state().phase).toBe('pending')
    expect(state().noteId).toBe(NOTE)
    expect(client.enableNoteEditing).toHaveBeenCalledTimes(1)

    pending.resolve({ note: note(), receipt: null })
    await expect(first).resolves.toBe(NOTE)
    expect(state().phase).toBe('idle')
  })

  it('cancel 仅 confirming → idle 复位；confirm/retry 在 idle 下 no-op', async () => {
    actions().requestEnable(NOTE)
    actions().cancel()
    expect(state().phase).toBe('idle')
    expect(state().noteId).toBeNull()

    await expect(actions().confirmEnable()).resolves.toBeNull()
    await expect(actions().retry()).resolves.toBeNull()
    expect(client.enableNoteEditing).not.toHaveBeenCalled()
  })

  it('dismiss 仅 error → idle 并清 error/mutation', async () => {
    client.enableNoteEditing.mockRejectedValue(apiError('network_error', { retryable: true }))
    actions().requestEnable(NOTE)
    await actions().confirmEnable()
    expect(state().phase).toBe('error')

    actions().dismiss()
    expect(state()).toEqual({
      phase: 'idle',
      noteId: null,
      mutationId: null,
      error: null,
      failureKind: null,
      retryMode: 'none',
      blockReason: null,
    })
    // idle 下 dismiss 再次调用也无副作用
    actions().dismiss()
    expect(state().phase).toBe('idle')
  })

  it('新一次启用不复用旧 mutation_id', async () => {
    client.enableNoteEditing
      .mockRejectedValueOnce(apiError('network_error', { retryable: true }))
      .mockResolvedValueOnce({ note: note(), receipt: null })

    actions().requestEnable(NOTE)
    await actions().confirmEnable() // nm1 失败（unknown）
    actions().dismiss()
    actions().requestEnable(NOTE)
    await expect(actions().confirmEnable()).resolves.toBe(NOTE) // 新尝试 → nm2

    expect(client.enableNoteEditing).toHaveBeenNthCalledWith(1, PROJECT, NOTE, {
      mutation_id: 'nm1',
    })
    expect(client.enableNoteEditing).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm2',
    })
  })

  it('subscribe 在状态变化时通知，取消订阅后不再通知', async () => {
    const listener = vi.fn()
    const unsubscribe = machine.subscribe(listener)
    client.enableNoteEditing.mockResolvedValue({ note: note(), receipt: null })

    actions().requestEnable(NOTE)
    expect(listener).toHaveBeenCalled()
    const calls = listener.mock.calls.length

    unsubscribe()
    await actions().confirmEnable()
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it('dispose 后一切动作 no-op（在途结果丢弃）', async () => {
    const pending = deferred<{ note: ResearchNoteD2; receipt: NoteReceipt | null }>()
    client.enableNoteEditing.mockReturnValue(pending.promise)

    actions().requestEnable(NOTE)
    const inFlight = actions().confirmEnable()
    machine.dispose()

    actions().requestEnable('note_other')
    actions().cancel()
    actions().dismiss()
    expect(state().phase).toBe('pending')
    expect(state().noteId).toBe(NOTE)

    pending.resolve({ note: note(), receipt: null })
    await expect(inFlight).resolves.toBeNull()
    expect(state().phase).toBe('pending')
    expect(client.enableNoteEditing).toHaveBeenCalledTimes(1)
  })
})
