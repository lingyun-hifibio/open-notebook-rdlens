/**
 * 编辑器状态机单测（Issue #1046 PR4 / D2-B2，方案 v4 §4.1–§4.4）。
 *
 * 覆盖：800ms debounce、同一文档单在途、ACK 只对应发送快照（不覆盖新编辑）、
 * 过期回调丢弃（切文档/代际）、ACK 乱序/旧代、IME composition、冲突暂停自动
 * 保存且三选项、未知结果同 mutation 确认、失败重试、受限/删除、能力阻断与
 * 恢复、草稿恢复/刷新、撤销后以当前 revision 保存、单次另存 copies、离开保护。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTE_SAVE_DEBOUNCE_MS,
  createNoteEditorMachine,
  isUnfinishedSaveStatus,
  type NoteEditorMachine,
  type NoteEditorMachineOptions,
} from './note-editor-machine'
import {
  clearNoteDraftMemoryFallback,
  readNoteDraft,
  writeNoteDraft,
  type NoteDraftAuthority,
  type NoteDraftCacheStorage,
  type NoteDraftScope,
} from './note-draft-cache'
import type { NoteApiClient } from './note-client'
import type {
  NoteCapabilities,
  NoteReceipt,
  PendingNoteMutation,
  ResearchNoteD2,
} from './types'

const PROJECT = 'proj_1'
const VIEWER = '7'
const GEN = 1
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const TAB = 'tab_1'

// ── fixtures ──

class FakeStorage implements NoteDraftCacheStorage {
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

class QuotaStorage extends FakeStorage {
  override setItem(): void {
    const error = new Error('quota')
    error.name = 'QuotaExceededError'
    throw error
  }
}

const CAPS_READY: NoteCapabilities = {
  noteEditor: { available: true, reason: null },
  noteEditorExisting: { available: true, reason: null },
  markdownExport: { available: false, reason: 'not_ready' },
  writingLocal: { available: false, reason: 'not_ready' },
  writingExternal: { available: false, reason: 'not_ready' },
}

function note(overrides: Partial<ResearchNoteD2> = {}): ResearchNoteD2 {
  return {
    note_id: 'n1',
    project_id: PROJECT,
    title: '原标题',
    content: '服务端正文',
    note_type: 'human',
    created_at: null,
    updated_at: '2026-11-05T00:00:00.000Z',
    revision: 1,
    snapshot_hash: HASH_A,
    edit_schema: 'd2-v1',
    access_state: 'visible',
    ...overrides,
  }
}

function receipt(overrides: Partial<NoteReceipt> = {}): NoteReceipt {
  return {
    note_id: 'n1',
    mutation_id: 'nm1',
    applied_revision: 2,
    snapshot_hash: HASH_B,
    saved_at: '2026-11-05T00:00:00.000Z',
    replayed: false,
    ...overrides,
  }
}

function conflictError(
  currentRevision: number,
  currentSnapshotHash: string,
): Record<string, unknown> {
  return {
    response: {
      status: 409,
      data: {
        detail: {
          code: 'note_revision_conflict',
          message: 'revision conflict',
          retryable: false,
          request_id: 'req_conflict',
          current_revision: currentRevision,
          current_snapshot_hash: currentSnapshotHash,
        },
      },
    },
  }
}

function apiError(status: number, code: string, retryable = false): Record<string, unknown> {
  return {
    response: {
      status,
      data: { detail: { code, message: code, retryable, request_id: 'req_x' } },
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
let storage: FakeStorage
let machine: NoteEditorMachine
let clipboard: ReturnType<typeof vi.fn>
let download: ReturnType<typeof vi.fn>
let mutationSequence = 0

function buildMachine(overrides: Partial<NoteEditorMachineOptions> = {}): NoteEditorMachine {
  mutationSequence = 0
  return createNoteEditorMachine({
    projectId: PROJECT,
    viewerUserId: VIEWER,
    isAdminReadonly: false,
    authGeneration: GEN,
    capabilities: CAPS_READY,
    client: client as unknown as NoteApiClient,
    storage,
    tabId: TAB,
    now: () => new Date(Date.now()),
    nextMutationId: () => `nm${(mutationSequence += 1)}`,
    writeClipboard: clipboard as unknown as (text: string) => Promise<void>,
    downloadMarkdown: download as unknown as (input: {
      title: string
      content: string
    }) => void,
    ...overrides,
  })
}

const state = () => machine.getState()
const actions = () => machine.getActions()

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

function openReady(): void {
  client.getNote.mockResolvedValue(note())
}

async function openNote(noteId = 'n1'): Promise<void> {
  await actions().openNote(noteId)
}

function draftScope(noteId = 'n1'): NoteDraftScope {
  return { ownerId: VIEWER, projectId: PROJECT, noteId, tabId: TAB }
}

function authority(permissionConfirmed = true): NoteDraftAuthority {
  return {
    authenticatedOwnerId: VIEWER,
    currentProjectId: PROJECT,
    authGeneration: GEN,
    currentAuthGeneration: GEN,
    permissionConfirmed,
  }
}

function readCachedDraft(noteId = 'n1') {
  return readNoteDraft(draftScope(noteId), authority(), { storage })
}

function seedDraft(
  overrides: Partial<{
    title: string
    content: string
    baseRevision: number
    baseSnapshotHash: string
    localSeq: number
    pendingMutation: PendingNoteMutation | null
  }> = {},
): void {
  writeNoteDraft(
    draftScope(),
    {
      v: 1,
      ownerId: VIEWER,
      projectId: PROJECT,
      noteId: 'n1',
      title: overrides.title ?? '草稿标题',
      content: overrides.content ?? '本地草稿正文',
      baseRevision: overrides.baseRevision ?? 1,
      baseSnapshotHash: overrides.baseSnapshotHash ?? HASH_A,
      localSeq: overrides.localSeq ?? 3,
      pendingMutation: overrides.pendingMutation ?? null,
      savedAt: '2026-11-05T00:00:00.000Z',
    },
    { storage },
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  clearNoteDraftMemoryFallback()
  storage = new FakeStorage()
  client = createFakeClient()
  clipboard = vi.fn(async () => {})
  download = vi.fn()
  mutationSequence = 0
  machine = buildMachine()
})

afterEach(() => {
  machine.dispose()
  vi.useRealTimers()
})

// ── 打开与基础状态 ──

describe('open note', () => {
  it('loads a d2-v1 note into a ready/saved editor state', async () => {
    openReady()
    await openNote()
    expect(state()).toMatchObject({
      status: 'ready',
      title: '原标题',
      content: '服务端正文',
      saveStatus: 'saved',
      pendingMutationId: null,
      blockReason: null,
      restoredFromCache: false,
      authGeneration: GEN,
    })
    expect(state().note?.revision).toBe(1)
  })

  it('opens legacy (edit_schema=null) notes read-only blocked, never revision-less editing', async () => {
    client.getNote.mockResolvedValue(note({ edit_schema: null, revision: null, snapshot_hash: null }))
    await openNote()
    expect(state()).toMatchObject({
      status: 'ready',
      saveStatus: 'blocked',
      blockReason: 'note_edit_schema_unsupported',
    })
    actions().setContent('试图编辑')
    expect(state().content).toBe('服务端正文')
  })

  it('drops a superseded open response after another note is opened', async () => {
    const first = deferred<ResearchNoteD2>()
    const second = deferred<ResearchNoteD2>()
    client.getNote
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const firstOpen = actions().openNote('n1')
    const secondOpen = actions().openNote('n2')
    first.resolve(note({ note_id: 'n1', content: 'stale n1' }))
    second.resolve(note({ note_id: 'n2', content: 'fresh n2' }))
    await firstOpen
    await secondOpen
    expect(state().note?.note_id).toBe('n2')
    expect(state().content).toBe('fresh n2')
  })

  it('retries openNote after an error without requiring a new note id', async () => {
    client.getNote.mockRejectedValueOnce(apiError(503, 'note_store_unavailable', true))
    await openNote()
    expect(state()).toMatchObject({ status: 'error', saveStatus: 'failed' })
    client.getNote.mockResolvedValueOnce(note())
    await openNote()
    expect(state().status).toBe('ready')
    expect(client.getNote).toHaveBeenCalledTimes(2)
  })
})

// ── debounce / 单在途 / ACK 快照 ──

describe('autosave', () => {
  beforeEach(async () => {
    openReady()
    await openNote()
    client.saveNote.mockResolvedValue(receipt())
  })

  it('debounces ordinary input for 800ms then sends a full snapshot with expected revision', async () => {
    actions().setContent('hello')
    expect(state().saveStatus).toBe('pending')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS - 1)
    expect(client.saveNote).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    expect(client.saveNote.mock.calls[0][2]).toEqual({
      mutation_id: 'nm1',
      expected_revision: 1,
      title: '原标题',
      content: 'hello',
    })
    await settle()
    expect(state().saveStatus).toBe('saved')
  })

  it('keeps at most one in-flight write and sends the newest snapshot after ACK', async () => {
    const first = deferred<NoteReceipt>()
    const second = deferred<NoteReceipt>()
    client.saveNote.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    actions().setContent('a')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    expect(state().saveStatus).toBe('saving')

    actions().setContent('ab')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    // 同一文档最多一个在途写：第二次编辑排队，不并发派发。
    expect(client.saveNote).toHaveBeenCalledTimes(1)

    first.resolve(receipt({ applied_revision: 2, snapshot_hash: HASH_B }))
    await settle()
    // ACK 不覆盖更新中的编辑区，并立即以新 revision 发送最新草稿。
    expect(state().content).toBe('ab')
    expect(client.saveNote).toHaveBeenCalledTimes(2)
    expect(client.saveNote.mock.calls[1][2]).toMatchObject({
      expected_revision: 2,
      content: 'ab',
    })
    second.resolve(receipt({ applied_revision: 3, snapshot_hash: HASH_C }))
    await settle()
    expect(state().saveStatus).toBe('saved')
    expect(state().content).toBe('ab')
  })

  it('does not auto-save while IME composition is active (but caches locally)', async () => {
    actions().beginComposition()
    actions().setContent('あい')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS * 2)
    expect(client.saveNote).not.toHaveBeenCalled()
    expect(readCachedDraft()?.content).toBe('あい')
    actions().endComposition()
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    expect(client.saveNote.mock.calls[0][2].content).toBe('あい')
  })

  it('tracks dirty locally and persists the draft on every edit', () => {
    actions().setContent('本地未保存')
    expect(state().saveStatus).toBe('pending')
    const cached = readCachedDraft()
    expect(cached).not.toBeNull()
    expect(cached?.content).toBe('本地未保存')
    expect(cached?.localSeq).toBe(1)
  })
})

// ── 过期回调 / 代际 ──

describe('stale callbacks', () => {
  it('drops ACK from an old auth generation and keeps the mutation for confirmation', async () => {
    openReady()
    await openNote()
    const pending = deferred<NoteReceipt>()
    client.saveNote.mockReturnValueOnce(pending.promise)
    actions().setContent('a')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(state().saveStatus).toBe('saving')

    machine.setIdentity({
      projectId: PROJECT,
      viewerUserId: VIEWER,
      authGeneration: 2,
      isAdminReadonly: false,
    })
    expect(state()).toMatchObject({ saveStatus: 'unknown', authGeneration: 2 })
    expect(state().pendingMutationId).not.toBeNull()

    pending.resolve(receipt())
    await settle()
    // 旧代 ACK 被丢弃：状态仍是未知结果，等待新代同 mutation 确认。
    expect(state().saveStatus).toBe('unknown')
    expect(state().content).toBe('a')
  })

  it('drops in-flight save when identity switches project/viewer and clears local view', async () => {
    openReady()
    await openNote()
    const pending = deferred<NoteReceipt>()
    client.saveNote.mockReturnValueOnce(pending.promise)
    actions().setContent('a')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)

    machine.setIdentity({
      projectId: 'proj_2',
      viewerUserId: '8',
      authGeneration: 3,
      isAdminReadonly: false,
    })
    expect(state()).toMatchObject({ status: 'idle', content: '', note: null })
    pending.resolve(receipt())
    await settle()
    expect(state().status).toBe('idle')
    expect(state().content).toBe('')
  })
})

// ── 冲突 ──

describe('conflict', () => {
  beforeEach(async () => {
    openReady()
    await openNote()
    client.saveNote.mockRejectedValueOnce(conflictError(5, HASH_B))
    actions().setContent('本地修改')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()
  })

  it('pauses autosave, keeps local snapshot and exposes authorized current revision/hash', () => {
    expect(state()).toMatchObject({
      saveStatus: 'conflict',
      content: '本地修改',
      conflict: { currentRevision: 5, currentSnapshotHash: HASH_B },
    })
    actions().setContent('继续本地编辑')
    expect(state().content).toBe('继续本地编辑')
    vi.advanceTimersByTime(NOTE_SAVE_DEBOUNCE_MS * 3)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    expect(state().saveStatus).toBe('conflict')
  })

  it('exposes the three explicit recovery options (copy / save-as-copy / load latest)', async () => {
    await actions().copyLocalContent()
    expect(clipboard).toHaveBeenCalledWith('本地修改')

    const copied = deferred<NoteReceipt>()
    client.copyNote.mockReturnValueOnce(copied.promise)
    const copyPromise = actions().saveAsCopy()
    await settle()
    expect(client.copyNote).toHaveBeenCalledTimes(1)
    const copyBody = client.copyNote.mock.calls[0][2]
    expect(copyBody).toMatchObject({
      source_revision: 1,
      source_snapshot_hash: HASH_A,
      title: '原标题',
      content: '本地修改',
    })
    copied.resolve(receipt({ note_id: 'copy_1', applied_revision: 1 }))
    client.getNote.mockResolvedValueOnce(note({ revision: 5, snapshot_hash: HASH_B, content: '服务端更新' }))
    const copyId = await copyPromise
    await settle()
    expect(copyId).toBe('copy_1')
    expect(state()).toMatchObject({ content: '服务端更新', saveStatus: 'saved', conflict: null })
  })

  it('load latest replaces local edits and clears the conflict', async () => {
    client.getNote.mockResolvedValueOnce(
      note({ revision: 5, snapshot_hash: HASH_B, content: '服务端更新' }),
    )
    await actions().loadLatest()
    expect(state()).toMatchObject({
      saveStatus: 'saved',
      content: '服务端更新',
      conflict: null,
    })
    expect(readCachedDraft()).toBeNull()
  })

  it('discardLocal restores the last server-confirmed baseline', () => {
    actions().discardLocal()
    expect(state()).toMatchObject({
      saveStatus: 'saved',
      content: '服务端正文',
      title: '原标题',
      conflict: null,
    })
    expect(readCachedDraft()).toBeNull()
  })

  it('blocks in-app navigation silently switching to another note', async () => {
    await openNote('n2')
    expect(state().leaveBlockReason).toBe('conflict')
    expect(state().note?.note_id).toBe('n1')
    expect(client.getNote).toHaveBeenCalledTimes(1)
  })
})

// ── 未知结果 ──

describe('unknown result', () => {
  beforeEach(async () => {
    openReady()
    await openNote()
    client.saveNote.mockRejectedValueOnce(apiError(503, 'note_store_unavailable', true))
    actions().setContent('第一版')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()
  })

  it('keeps the same mutation id and blocks new writes until confirmed', async () => {
    expect(state()).toMatchObject({ saveStatus: 'unknown', content: '第一版' })
    const pendingId = state().pendingMutationId
    expect(pendingId).not.toBeNull()
    const cached = readCachedDraft()
    expect(cached?.pendingMutation?.mutationId).toBe(pendingId)

    actions().setContent('第二版')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS * 2)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    expect(await actions().flushBeforeLeave()).toBe('unknown')
    // 确认前禁止静默导航：切文档被阻断；加载最新版也不得丢弃未决写。
    await actions().openNote('n2')
    expect(state().note?.note_id).toBe('n1')
    await actions().loadLatest()
    expect(client.getNote).toHaveBeenCalledTimes(1)
    expect(state().pendingMutationId).toBe(pendingId)
  })

  it('replays the exact frozen request with the same mutation id', async () => {
    client.saveNote.mockResolvedValueOnce(receipt({ applied_revision: 2, snapshot_hash: HASH_B }))
    const pendingId = state().pendingMutationId
    await actions().confirmPendingMutation()
    await settle()
    expect(client.saveNote).toHaveBeenCalledTimes(2)
    expect(client.saveNote.mock.calls[1][2]).toEqual({
      mutation_id: pendingId,
      expected_revision: 1,
      title: '原标题',
      content: '第一版',
    })
    expect(state().pendingMutationId).toBeNull()
    expect(state().saveStatus).toBe('saved')
  })

  it('after replay ACK, sends the newer local text as the next save', async () => {
    actions().setContent('第二版')
    client.saveNote
      .mockResolvedValueOnce(receipt({ applied_revision: 4, snapshot_hash: HASH_C }))
      .mockResolvedValueOnce(receipt({ applied_revision: 5, snapshot_hash: HASH_A }))
    await actions().confirmPendingMutation()
    await settle()
    expect(client.saveNote).toHaveBeenCalledTimes(3)
    expect(client.saveNote.mock.calls[2][2]).toMatchObject({
      expected_revision: 4,
      content: '第二版',
    })
    expect(state().content).toBe('第二版')
  })

  it('blocks saving new documents while an unknown mutation is pending', async () => {
    expect(await actions().createBlankNote()).toBeNull()
    expect(client.createNote).not.toHaveBeenCalled()
    expect(state().leaveBlockReason).toBe('unknown')
  })
})

// ── 明确失败重试 ──

describe('definite failure', () => {
  it('keeps local text and retries with a fresh mutation on request rejection', async () => {
    openReady()
    await openNote()
    client.saveNote.mockRejectedValueOnce(apiError(422, 'note_request_invalid', false))
    actions().setContent('坏请求')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()
    expect(state()).toMatchObject({ saveStatus: 'failed', content: '坏请求' })
    expect(state().pendingMutationId).toBeNull()

    client.saveNote.mockResolvedValueOnce(receipt())
    await actions().retrySave()
    await settle()
    expect(client.saveNote).toHaveBeenCalledTimes(2)
    const firstMutation = client.saveNote.mock.calls[0][2].mutation_id
    const secondMutation = client.saveNote.mock.calls[1][2].mutation_id
    expect(secondMutation).not.toBe(firstMutation)
    expect(state().saveStatus).toBe('saved')
  })
})

// ── 权限受限 / 删除 ──

describe('restricted and deleted notes', () => {
  it('blocks editing on 403 and clears persistent drafts for that note', async () => {
    seedDraft()
    client.getNote.mockRejectedValueOnce(apiError(403, 'note_access_restricted'))
    await openNote()
    expect(state()).toMatchObject({
      status: 'error',
      saveStatus: 'restricted',
      blockReason: 'note_access_restricted',
      content: '',
    })
    expect(readCachedDraft()).toBeNull()
    actions().setContent('不能编辑')
    expect(state().content).toBe('')
  })

  it('fails explicitly on 404 but keeps local text retrievable and never auto-creates', async () => {
    seedDraft({ content: '删除后仍可复制' })
    client.getNote.mockRejectedValueOnce(apiError(404, 'note_not_found'))
    await openNote()
    expect(state()).toMatchObject({
      status: 'error',
      saveStatus: 'failed',
      blockReason: 'note_not_found',
      content: '删除后仍可复制',
    })
    await actions().copyLocalContent()
    expect(clipboard).toHaveBeenCalledWith('删除后仍可复制')
    expect(await actions().createBlankNote()).toBeNull()
    expect(client.createNote).not.toHaveBeenCalled()
    actions().downloadLocalMarkdown()
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ content: '删除后仍可复制' }),
    )
  })

  it('blocks admin readonly writers while still showing content', async () => {
    machine.dispose()
    machine = buildMachine({ isAdminReadonly: true })
    openReady()
    await openNote()
    expect(state()).toMatchObject({
      saveStatus: 'restricted',
      blockReason: 'note_access_restricted',
      content: '服务端正文',
    })
    actions().setContent('admin edit')
    expect(state().content).toBe('服务端正文')
    await actions().saveNow()
    expect(client.saveNote).not.toHaveBeenCalled()
  })
})

// ── 能力阻断/恢复 ──

describe('capability gating', () => {
  it('fail-closes when capabilities are unavailable and retains the draft', async () => {
    machine.dispose()
    machine = buildMachine({ capabilities: null })
    seedDraft({ content: '能力恢复前的草稿' })
    openReady()
    await openNote()
    expect(state()).toMatchObject({
      saveStatus: 'blocked',
      blockReason: 'capability_unknown',
    })
    // 草稿保留（可恢复），不因能力故障删除。
    expect(readCachedDraft()?.content).toBe('能力恢复前的草稿')
  })

  it('recovers the draft and resumes autosave when note_editor_existing becomes available', async () => {
    machine.dispose()
    machine = buildMachine({ capabilities: null })
    seedDraft({ content: '能力恢复前的草稿' })
    openReady()
    await openNote()
    client.saveNote.mockResolvedValueOnce(receipt())
    machine.updateCapabilities(CAPS_READY)
    expect(state().restoredFromCache).toBe(true)
    expect(state().content).toBe('能力恢复前的草稿')
    expect(state().saveStatus).toBe('pending')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
  })

  it('keeps existing d2-v1 notes editable when only the create flag is off', async () => {
    machine.dispose()
    machine = buildMachine({
      capabilities: {
        ...CAPS_READY,
        noteEditor: { available: false, reason: 'disabled_by_flag' },
      },
    })
    openReady()
    await openNote()
    expect(state().saveStatus).toBe('saved')
    client.saveNote.mockResolvedValueOnce(receipt())
    actions().setContent('flag off 仍可安全保存')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    expect(await actions().createBlankNote()).toBeNull()
    expect(state().blockReason).toBe('disabled_by_flag')
    expect(client.createNote).not.toHaveBeenCalled()
  })
})

// ── 草稿恢复 ──

describe('draft restore', () => {
  it('restores a same-base local draft and resumes autosave with current revision', async () => {
    seedDraft({ content: '刷新前的草稿', localSeq: 3 })
    openReady()
    await openNote()
    expect(state()).toMatchObject({
      restoredFromCache: true,
      content: '刷新前的草稿',
      saveStatus: 'pending',
    })
    client.saveNote.mockResolvedValueOnce(receipt())
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(client.saveNote.mock.calls[0][2]).toMatchObject({
      expected_revision: 1,
      content: '刷新前的草稿',
    })
  })

  it('restores a persisted pending mutation as unknown result (needs confirmation)', async () => {
    seedDraft({
      title: '原标题',
      content: '未知结果草稿',
      localSeq: 5,
      pendingMutation: {
        mutationId: 'nm_stuck',
        kind: 'save',
        noteId: 'n1',
        expectedRevision: 1,
        title: '原标题',
        content: '未知结果草稿',
        createdAt: '2026-11-05T00:00:00.000Z',
      },
    })
    openReady()
    await openNote()
    expect(state()).toMatchObject({
      saveStatus: 'unknown',
      pendingMutationId: 'nm_stuck',
      content: '未知结果草稿',
    })
    client.saveNote.mockResolvedValueOnce(receipt({ applied_revision: 2 }))
    await actions().confirmPendingMutation()
    await settle()
    expect(client.saveNote.mock.calls[0][2]).toMatchObject({
      mutation_id: 'nm_stuck',
      expected_revision: 1,
      content: '未知结果草稿',
    })
    expect(state().saveStatus).toBe('saved')
  })

  it('surfaces a conflict when the draft is based on another server revision (no silent overwrite)', async () => {
    seedDraft({ content: '基于旧版草稿', baseSnapshotHash: HASH_B, localSeq: 2 })
    client.getNote.mockResolvedValueOnce(note({ revision: 2, snapshot_hash: HASH_C }))
    await openNote()
    expect(state()).toMatchObject({
      saveStatus: 'conflict',
      conflict: { currentRevision: 2, currentSnapshotHash: HASH_C },
      content: '基于旧版草稿',
    })
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS * 2)
    expect(client.saveNote).not.toHaveBeenCalled()
  })

  it('does not restore a draft from a previous auth generation', async () => {
    seedDraft({ content: '旧代草稿' })
    openReady()
    await openNote()
    expect(state().restoredFromCache).toBe(true)
    machine.setIdentity({
      projectId: PROJECT,
      viewerUserId: VIEWER,
      authGeneration: 2,
      isAdminReadonly: false,
    })
    // 代际变化时保留本地编辑（同 viewer refresh），不重新读取缓存正文。
    expect(state().content).toBe('旧代草稿')
    expect(state().authGeneration).toBe(2)
  })
})

// ── 撤销 ──

describe('undo', () => {
  it('restores local text and saves against the current revision', async () => {
    openReady()
    await openNote()
    client.saveNote.mockResolvedValueOnce(receipt({ applied_revision: 2, snapshot_hash: HASH_B }))
    actions().setContent('abc')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()
    expect(state().saveStatus).toBe('saved')
    expect(state().canUndo).toBe(true)

    actions().setContent('abcd')
    client.saveNote.mockResolvedValueOnce(receipt({ applied_revision: 3, snapshot_hash: HASH_C }))
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()

    actions().undo()
    expect(state().content).toBe('abc')
    expect(state().saveStatus).toBe('pending')
    client.saveNote.mockResolvedValueOnce(receipt({ applied_revision: 4, snapshot_hash: HASH_A }))
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(client.saveNote.mock.calls[2][2]).toMatchObject({
      expected_revision: 3,
      content: 'abc',
    })
  })

  it('undo while a save is in flight waits for the ACK before saving the undone text', async () => {
    openReady()
    await openNote()
    const pending = deferred<NoteReceipt>()
    client.saveNote.mockReturnValueOnce(pending.promise)
    actions().setContent('abc')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(state().saveStatus).toBe('saving')

    actions().undo()
    expect(state().content).toBe('服务端正文')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS * 2)
    expect(client.saveNote).toHaveBeenCalledTimes(1)

    client.saveNote.mockResolvedValueOnce(receipt({ applied_revision: 2, snapshot_hash: HASH_B }))
    pending.resolve(receipt({ applied_revision: 2, snapshot_hash: HASH_B }))
    await settle()
    expect(client.saveNote).toHaveBeenCalledTimes(2)
    expect(client.saveNote.mock.calls[1][2]).toMatchObject({
      expected_revision: 2,
      content: '服务端正文',
    })
  })

  it('does not clear undo history on autosave ACK (only doc switch/discard does)', async () => {
    openReady()
    await openNote()
    client.saveNote.mockResolvedValue(receipt())
    actions().setContent('one')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()
    expect(state().canUndo).toBe(true)
    actions().setContent('two')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()
    expect(state().canUndo).toBe(true)
  })
})

// ── 新建 / 另存 ──

describe('createBlankNote / saveAsCopy', () => {
  it('creates a blank note, loads its projection and stays saved', async () => {
    client.createNote.mockResolvedValueOnce(receipt({ note_id: 'new_1', applied_revision: 1, snapshot_hash: HASH_B }))
    client.getNote.mockResolvedValueOnce(note({ note_id: 'new_1', title: '未命名成果', content: '', revision: 1, snapshot_hash: HASH_B }))
    const noteId = await actions().createBlankNote()
    expect(noteId).toBe('new_1')
    expect(client.createNote).toHaveBeenCalledWith(PROJECT, { mutation_id: 'nm1' })
    expect(state().status).toBe('ready')
    expect(state().note?.note_id).toBe('new_1')
    expect(state().saveStatus).toBe('saved')
  })

  it('replays the same create mutation when the result is unknown', async () => {
    client.createNote.mockRejectedValueOnce(apiError(503, 'note_store_unavailable', true))
    expect(await actions().createBlankNote()).toBeNull()
    expect(state().saveStatus).toBe('unknown')
    const pendingId = state().pendingMutationId
    expect(pendingId).toBe('nm1')

    client.createNote.mockResolvedValueOnce(receipt({ note_id: 'new_2', applied_revision: 1, snapshot_hash: HASH_B }))
    client.getNote.mockResolvedValueOnce(note({ note_id: 'new_2', title: '未命名成果', content: '', snapshot_hash: HASH_B }))
    const noteId = await actions().createBlankNote()
    expect(noteId).toBe('new_2')
    expect(client.createNote).toHaveBeenCalledTimes(2)
    expect(client.createNote.mock.calls[1][1]).toEqual({ mutation_id: pendingId })
  })

  it('saveAsCopy surfaces unknown results and replays the same mutation', async () => {
    openReady()
    await openNote()
    client.saveNote.mockRejectedValueOnce(conflictError(5, HASH_B))
    actions().setContent('本地修改')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()

    client.copyNote.mockRejectedValueOnce(apiError(503, 'note_store_unavailable', true))
    expect(await actions().saveAsCopy()).toBeNull()
    expect(state().saveStatus).toBe('unknown')
    expect(state().pendingMutationId).not.toBeNull()
    const stored = readCachedDraft()
    expect(stored?.pendingMutation?.kind).toBe('copy')
    expect(stored?.pendingMutation?.sourceSnapshotHash).toBe(HASH_A)

    client.copyNote.mockResolvedValueOnce(receipt({ note_id: 'copy_2', applied_revision: 1 }))
    client.getNote.mockResolvedValueOnce(note({ revision: 5, snapshot_hash: HASH_B, content: '服务端更新' }))
    const copyId = await actions().saveAsCopy()
    expect(copyId).toBe('copy_2')
    expect(client.copyNote).toHaveBeenCalledTimes(2)
    expect(client.copyNote.mock.calls[1][2].mutation_id).toBe(
      client.copyNote.mock.calls[0][2].mutation_id,
    )
  })
})

// ── 离开保护 / 关闭 ──

describe('leave protection', () => {
  it('flushes dirty text on flushBeforeLeave and allows the switch', async () => {
    openReady()
    await openNote()
    client.saveNote.mockResolvedValueOnce(receipt())
    client.getNote.mockResolvedValueOnce(note({ note_id: 'n2', content: 'n2 body' }))
    actions().setContent('待保存')
    expect(await actions().flushBeforeLeave()).toBeNull()
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    await openNote('n2')
    expect(state().note?.note_id).toBe('n2')
  })

  it('closeEditor returns false on conflict and true after a successful flush', async () => {
    openReady()
    await openNote()
    client.saveNote.mockRejectedValueOnce(conflictError(2, HASH_B))
    actions().setContent('冲突文本')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    await settle()
    expect(await actions().closeEditor()).toBe(false)
    expect(state().leaveBlockReason).toBe('conflict')

    actions().discardLocal()
    expect(await actions().closeEditor()).toBe(true)
    expect(state().status).toBe('idle')
  })

  it('reports unfinished work for beforeunload and persists drafts on pagehide', async () => {
    openReady()
    await openNote()
    expect(machine.hasUnfinishedWork()).toBe(false)
    actions().setContent('未保存')
    expect(machine.hasUnfinishedWork()).toBe(true)
    expect(isUnfinishedSaveStatus(state().saveStatus)).toBe(true)
    storage.map.clear()
    machine.persistLocalDraft()
    expect(readCachedDraft()?.content).toBe('未保存')
  })

  it('degrades to memory-only cache status on quota errors and keeps autosaving', async () => {
    machine.dispose()
    machine = buildMachine({ storage: new QuotaStorage() })
    openReady()
    client.getNote.mockResolvedValueOnce(note())
    await openNote()
    client.saveNote.mockResolvedValueOnce(receipt())
    actions().setContent('quota 场景')
    await settle()
    expect(state().cacheStatus).toBe('memory_only')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    expect(state().saveStatus).toBe('saved')
  })
})

// ── 生命周期（React StrictMode 安全） ──

describe('lifecycle / StrictMode safety', () => {
  it('stop() is non-permanent and clears scheduled autosave only', async () => {
    openReady()
    await openNote()
    expect(machine.isDisposed()).toBe(false)
    actions().setContent('stop 前输入')
    machine.stop()
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS * 2)
    expect(client.saveNote).not.toHaveBeenCalled()
    expect(machine.isDisposed()).toBe(false)

    client.saveNote.mockResolvedValueOnce(receipt())
    actions().setContent('stop 后继续编辑')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS)
    expect(client.saveNote).toHaveBeenCalledTimes(1)
    expect(client.saveNote.mock.calls[0][2].content).toBe('stop 后继续编辑')
    expect(state().saveStatus).toBe('saved')
  })

  it('stop() before first open does not block later open (mount cleanup semantics)', async () => {
    openReady()
    machine.stop()
    await openNote()
    expect(client.getNote).toHaveBeenCalledTimes(1)
    expect(state().status).toBe('ready')
  })

  it('dispose() is permanent: actions become no-ops and no further requests are sent', async () => {
    openReady()
    await openNote()
    machine.dispose()
    expect(machine.isDisposed()).toBe(true)
    await actions().openNote('n2')
    actions().setContent('dispose 后输入')
    await vi.advanceTimersByTimeAsync(NOTE_SAVE_DEBOUNCE_MS * 2)
    expect(client.getNote).toHaveBeenCalledTimes(1)
    expect(client.saveNote).not.toHaveBeenCalled()
    expect(state().content).toBe('服务端正文')
  })
})
