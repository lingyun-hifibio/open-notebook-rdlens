/**
 * d2-v1 Note 删除状态机单测（Issue #1134）。
 *
 * 覆盖：二次确认与冻结 revision、成功回执校验（目标一致才结算/清草稿）、
 * 回执畸形/错目标按结果未知、能力与 Admin 守卫不触网、缺 revision 守卫、
 * 403/404/409/503/网络错误分类与重试策略（unknown/dependency 同 mutation
 * 重放；revision 冲突刷新后 reconfirm；旧 mutation 冲突换新 id）、终态不可
 * 重试、单在途防重入、取消/关闭复位、每次新确认不复用旧 mutation、dispose
 * 后 no-op。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyNoteDeleteError,
  createNoteDeleteMachine,
  noteDeleteBlockReason,
  type NoteDeleteMachine,
  type NoteDeleteMachineOptions,
} from './note-delete'
import type { NoteApiClient } from './note-client'
import { writeNoteDraft } from './note-draft-cache'
import type { NoteApiError, NoteCapabilities, NoteReceipt } from './types'

const PROJECT = 'proj_1'
const NOTE = 'note_d2'
const TITLE = '受保护笔记'
const HASH = 'a'.repeat(64)

const CAPS_READY: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function receipt(overrides: Partial<NoteReceipt> = {}): NoteReceipt {
  return {
    note_id: NOTE,
    mutation_id: 'nm1',
    applied_revision: 3,
    snapshot_hash: null,
    saved_at: '2026-11-10T00:00:00.000Z',
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
  detail: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    response: {
      status,
      data: { detail: { code, message: '', retryable, request_id: 'req_1', ...detail } },
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
    insertFragment: vi.fn(),
    createNoteFragment: vi.fn(),
  }
}

type FakeClient = ReturnType<typeof createFakeClient>

let client: FakeClient
let machine: NoteDeleteMachine
let mutationSequence = 0
const clearDrafts = vi.fn()

function buildMachine(overrides: Partial<NoteDeleteMachineOptions> = {}): NoteDeleteMachine {
  mutationSequence = 0
  return createNoteDeleteMachine({
    projectId: PROJECT,
    ownerId: 'u1',
    isAdminReadonly: false,
    capabilities: CAPS_READY,
    client: client as unknown as NoteApiClient,
    nextMutationId: () => `nm${(mutationSequence += 1)}`,
    clearDrafts,
    ...overrides,
  })
}

const state = () => machine.getState()
const actions = () => machine.getActions()

/** 统计本测试 Note 在 sessionStorage 里的 versioned 草稿键数量。 */
function countDraftKeys(): number {
  const prefix = `rdlens.research.note.v1.u1.${PROJECT}.${NOTE}.`
  let count = 0
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key !== null && key.startsWith(prefix)) count += 1
  }
  return count
}

function requestDelete(revision: number | null = 3, noteId = NOTE, title = TITLE): void {
  actions().requestDelete(noteId, revision, title)
}

function expectDeleteCalledWith(mutationId: string, expectedRevision = 3): void {
  expect(client.deleteNote).toHaveBeenCalledWith(PROJECT, NOTE, {
    mutation_id: mutationId,
    expected_revision: expectedRevision,
  })
}

describe('noteDeleteBlockReason', () => {
  it('capabilities=null → capability_unknown（fail-closed）', () => {
    expect(noteDeleteBlockReason(null)).toBe('capability_unknown')
  })

  it('note_editor_existing 不可用 → 透传服务端 reason；无 reason → capability_unknown', () => {
    expect(
      noteDeleteBlockReason({
        ...CAPS_READY,
        noteEditorExisting: { available: false, reason: 'note_store_unavailable' },
      }),
    ).toBe('note_store_unavailable')
    expect(
      noteDeleteBlockReason({
        ...CAPS_READY,
        noteEditorExisting: { available: false, reason: null },
      }),
    ).toBe('capability_unknown')
  })

  it('note_editor 开关关闭但 existing 可用 → 可删（删除不是新建/首次启用入口）', () => {
    expect(
      noteDeleteBlockReason({
        ...CAPS_READY,
        noteEditor: { available: false, reason: 'disabled_by_flag' },
      }),
    ).toBeNull()
  })
})

describe('classifyNoteDeleteError', () => {
  it('终态错误无重试（restricted/not_found/unsupported）', () => {
    expect(classifyNoteDeleteError(apiError('note_access_restricted'))).toEqual({
      failureKind: 'restricted',
      retryMode: 'none',
    })
    expect(classifyNoteDeleteError(apiError('note_not_found'))).toEqual({
      failureKind: 'not_found',
      retryMode: 'none',
    })
    for (const code of [
      'note_edit_schema_unsupported',
      'note_request_invalid',
      'note_revision_required',
    ] as const) {
      expect(classifyNoteDeleteError(apiError(code))).toEqual({
        failureKind: 'unsupported',
        retryMode: 'none',
      })
    }
  })

  it('revision 冲突走 reconfirm（刷新后以当前 revision 重新二次确认）', () => {
    for (const code of [
      'note_revision_conflict',
      'note_revision_exhausted',
      'note_snapshot_fence_exhausted',
    ] as const) {
      expect(classifyNoteDeleteError(apiError(code))).toEqual({
        failureKind: 'conflict',
        retryMode: 'reconfirm',
      })
    }
  })

  it('旧 mutation 被占用 → stale_request（文案与 Retry 动作一致），换新 mutation 重试', () => {
    expect(classifyNoteDeleteError(apiError('mutation_id_reused'))).toEqual({
      failureKind: 'stale_request',
      retryMode: 'new_mutation',
    })
  })

  it('依赖/快照不可判定：可重试但必须同一 mutation（retryable 语义）', () => {
    for (const code of ['note_dependency_unavailable', 'note_snapshot_unavailable'] as const) {
      expect(classifyNoteDeleteError(apiError(code, { retryable: true }))).toEqual({
        failureKind: 'unavailable',
        retryMode: 'same_mutation',
      })
    }
  })

  it('store/网络/未知码按结果未知处理（同一 mutation 确认）', () => {
    for (const code of ['note_store_unavailable', 'network_error', 'unknown_error'] as const) {
      expect(classifyNoteDeleteError(apiError(code))).toEqual({
        failureKind: 'unknown',
        retryMode: 'same_mutation',
      })
    }
  })
})

describe('createNoteDeleteMachine', () => {
  beforeEach(() => {
    client = createFakeClient()
    clearDrafts.mockReset()
    machine = buildMachine()
  })

  it('初始 idle 且无 mutation/revision', () => {
    expect(state()).toEqual({
      phase: 'idle',
      noteId: null,
      noteTitle: '',
      noteContent: '',
      expectedRevision: null,
      mutationId: null,
      error: null,
      failureKind: null,
      retryMode: 'none',
      blockReason: null,
    })
  })

  it('requestDelete → confirming（冻结 revision 与复核用标题/正文，不发请求）', () => {
    actions().requestDelete(NOTE, 7, TITLE, '目标正文')
    expect(state().phase).toBe('confirming')
    expect(state().noteId).toBe(NOTE)
    expect(state().noteTitle).toBe(TITLE)
    expect(state().noteContent).toBe('目标正文')
    expect(state().expectedRevision).toBe(7)
    expect(client.deleteNote).not.toHaveBeenCalled()
    expect(clearDrafts).not.toHaveBeenCalled()
  })

  it('confirmDelete 成功后返回 note_id、清草稿、回 idle（回执 applied_revision=删除前 revision）', async () => {
    client.deleteNote.mockResolvedValue(receipt({ applied_revision: 7, snapshot_hash: null }))
    requestDelete(7)

    const result = await actions().confirmDelete()
    expect(result).toBe(NOTE)
    expectDeleteCalledWith('nm1', 7)
    expect(clearDrafts).toHaveBeenCalledTimes(1)
    expect(clearDrafts).toHaveBeenCalledWith(NOTE)
    expect(state().phase).toBe('idle')
    expect(state().expectedRevision).toBeNull()
    expect(state().mutationId).toBeNull()
  })

  it('每次确认都生成新 mutation_id（不复用旧 id）', async () => {
    client.deleteNote
      .mockResolvedValueOnce(receipt({ mutation_id: 'nm1' }))
      .mockResolvedValueOnce(receipt({ mutation_id: 'nm2' }))
    requestDelete(3)
    await actions().confirmDelete()
    requestDelete(3)
    await actions().confirmDelete()

    expect(client.deleteNote).toHaveBeenNthCalledWith(1, PROJECT, NOTE, {
      mutation_id: 'nm1',
      expected_revision: 3,
    })
    expect(client.deleteNote).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm2',
      expected_revision: 3,
    })
    expect(clearDrafts).toHaveBeenCalledTimes(2)
  })

  it('回执目标 note_id 不一致 → 结果未知（不清草稿、不按成功结算）', async () => {
    client.deleteNote.mockResolvedValue(receipt({ note_id: 'note_other' }))
    requestDelete(3)

    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().phase).toBe('error')
    expect(state().failureKind).toBe('unknown')
    expect(state().retryMode).toBe('same_mutation')
    expect(state().mutationId).toBe('nm1')
    expect(state().expectedRevision).toBe(3)
    expect(clearDrafts).not.toHaveBeenCalled()
  })

  it('回执缺字段 → 结果未知', async () => {
    client.deleteNote.mockResolvedValue({ note_id: NOTE })
    requestDelete(3)

    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().failureKind).toBe('unknown')
    expect(state().retryMode).toBe('same_mutation')
    expect(clearDrafts).not.toHaveBeenCalled()
  })

  it('回执 mutation_id 与本次请求不一致 → 结果未知（防御网关/代理错配）', async () => {
    client.deleteNote.mockResolvedValue(receipt({ mutation_id: 'nm_other' }))
    requestDelete(3)

    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().failureKind).toBe('unknown')
    expect(clearDrafts).not.toHaveBeenCalled()
  })

  it('回执 applied_revision 与冻结 expected_revision 不一致 → 结果未知', async () => {
    client.deleteNote.mockResolvedValue(receipt({ applied_revision: 4 }))
    requestDelete(3)

    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().failureKind).toBe('unknown')
    expect(clearDrafts).not.toHaveBeenCalled()
  })

  it('回执 snapshot_hash 非 null（混入 save 形状）→ 结果未知', async () => {
    client.deleteNote.mockResolvedValue(receipt({ snapshot_hash: HASH }))
    requestDelete(3)

    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().failureKind).toBe('unknown')
    expect(clearDrafts).not.toHaveBeenCalled()
  })

  it('Admin 守卫：error/restricted，不发请求也不清草稿', () => {
    machine = buildMachine({ isAdminReadonly: true })
    requestDelete(3)

    expect(state().phase).toBe('error')
    expect(state().blockReason).toBe('admin_readonly')
    expect(state().failureKind).toBe('restricted')
    expect(state().retryMode).toBe('none')
    expect(client.deleteNote).not.toHaveBeenCalled()
    expect(clearDrafts).not.toHaveBeenCalled()
  })

  it('capabilities=null 守卫：error/unavailable，不发请求', () => {
    machine = buildMachine({ capabilities: null })
    requestDelete(3)

    expect(state().phase).toBe('error')
    expect(state().blockReason).toBe('capability_unknown')
    expect(state().failureKind).toBe('unavailable')
    expect(client.deleteNote).not.toHaveBeenCalled()
  })

  it('note_editor_existing 不可用守卫：透传能力 reason，不发请求；恢复后可删', () => {
    machine = buildMachine({
      capabilities: {
        ...CAPS_READY,
        noteEditorExisting: { available: false, reason: 'note_store_unavailable' },
      },
    })
    requestDelete(3)
    expect(state().blockReason).toBe('note_store_unavailable')
    expect(client.deleteNote).not.toHaveBeenCalled()

    machine.updateCapabilities(CAPS_READY)
    requestDelete(3)
    expect(state().phase).toBe('confirming')
  })

  it('缺 revision 基线守卫：绝不退回旧无 revision 删除路径', () => {
    requestDelete(null)

    expect(state().phase).toBe('error')
    expect(state().blockReason).toBe('note_revision_required')
    expect(state().failureKind).toBe('unsupported')
    expect(state().retryMode).toBe('none')
    expect(client.deleteNote).not.toHaveBeenCalled()
  })

  it.each([
    ['note_access_restricted', 403, 'restricted', 'none'],
    ['note_not_found', 404, 'not_found', 'none'],
    ['note_edit_schema_unsupported', 409, 'unsupported', 'none'],
    ['note_request_invalid', 422, 'unsupported', 'none'],
    ['note_revision_required', 428, 'unsupported', 'none'],
    ['note_revision_conflict', 409, 'conflict', 'reconfirm'],
    ['note_revision_exhausted', 409, 'conflict', 'reconfirm'],
    ['note_snapshot_fence_exhausted', 409, 'conflict', 'reconfirm'],
    ['mutation_id_reused', 409, 'stale_request', 'new_mutation'],
    ['note_dependency_unavailable', 503, 'unavailable', 'same_mutation'],
    ['note_snapshot_unavailable', 503, 'unavailable', 'same_mutation'],
    ['note_store_unavailable', 503, 'unknown', 'same_mutation'],
    ['network_error', 0, 'unknown', 'same_mutation'],
    ['unknown_error', 500, 'unknown', 'same_mutation'],
  ] as const)(
    '错误码 %s（HTTP %s）→ %s / %s（保留 mutation/revision 供确认）',
    async (code, status, failureKind, retryMode) => {
      if (status === 0) {
        client.deleteNote.mockRejectedValue(apiError(code, { retryable: true }))
      } else {
        client.deleteNote.mockRejectedValue(httpError(status, code, status >= 500))
      }

      requestDelete(3)
      await expect(actions().confirmDelete()).resolves.toBeNull()

      expect(state().phase).toBe('error')
      expect(state().failureKind).toBe(failureKind)
      expect(state().retryMode).toBe(retryMode)
      expect(state().mutationId).toBe('nm1')
      expect(state().expectedRevision).toBe(3)
      expect(state().error?.code).toBe(code)
      expect(clearDrafts).not.toHaveBeenCalled()
      // 删除流程绝不调用保存/新建/启用等其他写路径。
      expect(client.saveNote).not.toHaveBeenCalled()
      expect(client.createNote).not.toHaveBeenCalled()
      expect(client.enableNoteEditing).not.toHaveBeenCalled()
    },
  )

  it('结果未知重试：同一 mutation_id + 同一 expected_revision 重放，第二次成功', async () => {
    client.deleteNote
      .mockRejectedValueOnce(apiError('network_error', { retryable: true }))
      .mockResolvedValueOnce(receipt({ replayed: true }))

    requestDelete(3)
    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().retryMode).toBe('same_mutation')

    await expect(actions().retry()).resolves.toBe(NOTE)
    expect(client.deleteNote).toHaveBeenNthCalledWith(1, PROJECT, NOTE, {
      mutation_id: 'nm1',
      expected_revision: 3,
    })
    expect(client.deleteNote).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm1',
      expected_revision: 3,
    })
    expect(clearDrafts).toHaveBeenCalledTimes(1)
    expect(state().phase).toBe('idle')
  })

  it('依赖不可判定重试：同一 mutation_id（retryable 语义）', async () => {
    client.deleteNote
      .mockRejectedValueOnce(httpError(503, 'note_dependency_unavailable', true))
      .mockResolvedValueOnce(receipt())

    requestDelete(3)
    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().failureKind).toBe('unavailable')

    await expect(actions().retry()).resolves.toBe(NOTE)
    expect(client.deleteNote).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm1',
      expected_revision: 3,
    })
  })

  it('旧 mutation 冲突重试：换新 mutation_id、同一 expected_revision', async () => {
    client.deleteNote
      .mockRejectedValueOnce(httpError(409, 'mutation_id_reused'))
      .mockResolvedValueOnce(receipt({ mutation_id: 'nm2' }))

    requestDelete(3)
    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().failureKind).toBe('stale_request')
    expect(state().retryMode).toBe('new_mutation')

    await expect(actions().retry()).resolves.toBe(NOTE)
    expect(client.deleteNote).toHaveBeenNthCalledWith(1, PROJECT, NOTE, {
      mutation_id: 'nm1',
      expected_revision: 3,
    })
    expect(client.deleteNote).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm2',
      expected_revision: 3,
    })
  })

  it('revision 冲突：retry 不触网；reconfirm(新 revision) → confirming → 确认用新 revision 与新 mutation', async () => {
    client.deleteNote
      .mockRejectedValueOnce(
        httpError(409, 'note_revision_conflict', false, {
          current_revision: 4,
          current_snapshot_hash: HASH,
        }),
      )
      .mockResolvedValueOnce(receipt({ mutation_id: 'nm2', applied_revision: 4 }))

    requestDelete(3)
    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().retryMode).toBe('reconfirm')
    expect(state().error?.currentRevision).toBe(4)

    // reconfirm 之前 retry 不触网（必须先刷新目录/复核）。
    await expect(actions().retry()).resolves.toBeNull()
    expect(client.deleteNote).toHaveBeenCalledTimes(1)

    actions().reconfirm(4, '刷新后标题', '刷新后正文')
    expect(state().phase).toBe('confirming')
    expect(state().expectedRevision).toBe(4)
    expect(state().noteTitle).toBe('刷新后标题')
    expect(state().noteContent).toBe('刷新后正文')
    expect(state().error).toBeNull()
    expect(state().mutationId).toBeNull()

    await expect(actions().confirmDelete()).resolves.toBe(NOTE)
    expect(client.deleteNote).toHaveBeenNthCalledWith(2, PROJECT, NOTE, {
      mutation_id: 'nm2',
      expected_revision: 4,
    })
  })

  it('reconfirm(null)：目标已消失 → 复位 idle（调用方负责刷新目录）', async () => {
    client.deleteNote.mockRejectedValueOnce(httpError(409, 'note_revision_conflict'))
    requestDelete(3)
    await expect(actions().confirmDelete()).resolves.toBeNull()

    actions().reconfirm(null)
    expect(state().phase).toBe('idle')
    expect(state().noteId).toBeNull()
  })

  it('终态错误不可重试（restricted/not_found/unsupported）', async () => {
    client.deleteNote.mockRejectedValue(httpError(403, 'note_access_restricted'))
    requestDelete(3)
    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(state().retryMode).toBe('none')

    await expect(actions().retry()).resolves.toBeNull()
    expect(client.deleteNote).toHaveBeenCalledTimes(1)
  })

  it('单在途：pending 期间 confirm/retry/cancel/requestDelete 均 no-op', async () => {
    const pending = deferred<NoteReceipt>()
    client.deleteNote.mockReturnValue(pending.promise)

    requestDelete(3)
    let confirming: Promise<string | null> | null = null
    confirming = actions().confirmDelete()
    expect(state().phase).toBe('pending')

    actions().requestDelete('note_other', 1, '另一个')
    actions().cancel()
    await expect(actions().retry()).resolves.toBeNull()
    expect(state().phase).toBe('pending')
    expect(state().noteId).toBe(NOTE)
    expect(client.deleteNote).toHaveBeenCalledTimes(1)

    pending.resolve(receipt())
    await expect(confirming).resolves.toBe(NOTE)
    expect(state().phase).toBe('idle')
  })

  it('pending 期间 confirmDelete 重入 no-op（单在途）', async () => {
    const pending = deferred<NoteReceipt>()
    client.deleteNote.mockReturnValue(pending.promise)

    requestDelete(3)
    const first = actions().confirmDelete()
    await expect(actions().confirmDelete()).resolves.toBeNull()
    expect(client.deleteNote).toHaveBeenCalledTimes(1)

    pending.resolve(receipt())
    await expect(first).resolves.toBe(NOTE)
  })

  it('cancel（confirming）与 dismiss（error）复位 idle', async () => {
    requestDelete(3)
    actions().cancel()
    expect(state().phase).toBe('idle')
    expect(client.deleteNote).not.toHaveBeenCalled()

    client.deleteNote.mockRejectedValue(httpError(403, 'note_access_restricted'))
    requestDelete(3)
    await expect(actions().confirmDelete()).resolves.toBeNull()
    actions().dismiss()
    expect(state().phase).toBe('idle')
  })

  it('dispose 后一切动作 no-op', async () => {
    machine.dispose()
    requestDelete(3)
    expect(state().phase).toBe('idle')
    await expect(actions().confirmDelete()).resolves.toBeNull()
    await expect(actions().retry()).resolves.toBeNull()
    expect(client.deleteNote).not.toHaveBeenCalled()
  })

  it('默认清理实现：删除成功后移除该 Note 全部 tab 的 versioned 草稿缓存', async () => {
    machine = buildMachine({ ownerId: 'u1', clearDrafts: undefined })
    for (const tabId of ['tab-a', 'tab-b']) {
      const writeResult = writeNoteDraft(
        { ownerId: 'u1', projectId: PROJECT, noteId: NOTE, tabId },
        {
          v: 1,
          ownerId: 'u1',
          projectId: PROJECT,
          noteId: NOTE,
          title: TITLE,
          content: '本地草稿',
          baseRevision: 3,
          baseSnapshotHash: HASH,
          localSeq: 1,
          pendingMutation: null,
          savedAt: '2026-11-10T00:00:00.000Z',
        },
      )
      expect(writeResult).toEqual({ ok: true, persisted: true, degraded: false, reason: null })
    }
    expect(countDraftKeys()).toBe(2)

    client.deleteNote.mockResolvedValue(receipt())
    requestDelete(3)
    await expect(actions().confirmDelete()).resolves.toBe(NOTE)
    expect(countDraftKeys()).toBe(0)
  })
})
