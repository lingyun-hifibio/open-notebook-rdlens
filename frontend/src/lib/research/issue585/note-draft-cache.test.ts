/**
 * Note 独立草稿缓存单测（Issue #1046 PR4 / D2-B2）。
 *
 * 覆盖：命名空间与键单射转义、身份/项目/代际/权限授权门槛（离线不恢复）、
 * 记录闭合键集（结构上禁止令牌/对话混入）、未决 mutation 往返、quota/
 * SecurityError/超预算内存降级、受限清理（含多标签分支）、取回入口。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  NOTE_DRAFT_CACHE_PREFIX,
  NOTE_DRAFT_MAX_SERIALIZED_BYTES,
  canReadNoteDraft,
  clearNoteDraftMemoryFallback,
  createNoteDraftTabId,
  isValidNoteDraftCacheRecord,
  listRecoverableNoteDrafts,
  noteDraftCacheSegment,
  noteDraftKey,
  readNoteDraft,
  readNoteDraftForRetrieval,
  readOrCreateNoteDraftTabId,
  removeNoteDraft,
  removeNoteDraftsForNote,
  writeNoteDraft,
  type NoteDraftAuthority,
  type NoteDraftCacheStorage,
  type NoteDraftScope,
} from './note-draft-cache'
import { NOTE_DRAFT_STORAGE_NAMESPACE, type NoteDraftCacheRecord } from './types'

const HASH = 'a'.repeat(64)
const HASH2 = 'b'.repeat(64)

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

class ThrowingStorage extends FakeStorage {
  constructor(private readonly errorName: string) {
    super()
  }

  override setItem(): void {
    const error = new Error(this.errorName)
    error.name = this.errorName
    throw error
  }
}

function scope(overrides: Partial<NoteDraftScope> = {}): NoteDraftScope {
  return {
    ownerId: '7',
    projectId: 'proj_1',
    noteId: 'note_1',
    tabId: 'tab_1',
    ...overrides,
  }
}

function authority(overrides: Partial<NoteDraftAuthority> = {}): NoteDraftAuthority {
  return {
    authenticatedOwnerId: '7',
    currentProjectId: 'proj_1',
    authGeneration: 3,
    currentAuthGeneration: 3,
    permissionConfirmed: true,
    ...overrides,
  }
}

function record(overrides: Partial<NoteDraftCacheRecord> = {}): NoteDraftCacheRecord {
  return {
    v: 1,
    ownerId: '7',
    projectId: 'proj_1',
    noteId: 'note_1',
    title: '标题',
    content: '# 正文\n\n保留 空白 与 emoji 🚀',
    baseRevision: 2,
    baseSnapshotHash: HASH,
    localSeq: 4,
    pendingMutation: null,
    savedAt: '2026-11-05T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  clearNoteDraftMemoryFallback()
})

describe('namespace and key encoding', () => {
  it('uses the frozen namespace and escapes dots per segment (injective)', () => {
    expect(NOTE_DRAFT_CACHE_PREFIX).toBe(NOTE_DRAFT_STORAGE_NAMESPACE)
    expect(noteDraftCacheSegment('a.b')).toBe('a%2Eb')
    const left = noteDraftKey({ ownerId: 'a.b', projectId: 'c', noteId: 'n', tabId: 't' })
    const right = noteDraftKey({ ownerId: 'a', projectId: 'b.c', noteId: 'n', tabId: 't' })
    expect(left).not.toBe(right)
    expect(left.startsWith(`${NOTE_DRAFT_CACHE_PREFIX}.`)).toBe(true)
  })

  it('encodes owner/project/note/tab and refuses unusable scopes', () => {
    const key = noteDraftKey({ ownerId: 'o w', projectId: 'p/1', noteId: 'n#1', tabId: 't.1' })
    expect(key).toContain(encodeURIComponent('o w'))
    expect(key).toContain('p%2F1')
    expect(key).toContain('n%231')
    expect(key).toContain('t%2E1')
    const storage = new FakeStorage()
    const result = writeNoteDraft(scope({ ownerId: '' }), record({ ownerId: '' }), {
      storage,
    })
    expect(result.ok).toBe(false)
  })
})

describe('identity/permission gated restore', () => {
  it('round-trips a record for the current owner/project/generation', () => {
    const storage = new FakeStorage()
    const written = writeNoteDraft(scope(), record(), { storage })
    expect(written).toMatchObject({ ok: true, persisted: true, degraded: false })
    const restored = readNoteDraft(scope(), authority(), { storage })
    expect(restored).toEqual(record())
  })

  it('does not restore when permission is not confirmed (offline/403/404)', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })
    expect(
      readNoteDraft(scope(), authority({ permissionConfirmed: false }), { storage }),
    ).toBeNull()
    expect(canReadNoteDraft(scope(), authority({ permissionConfirmed: false }))).toBe(false)
  })

  it('does not restore for another viewer, another project, or stale generation', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })
    expect(
      readNoteDraft(scope(), authority({ authenticatedOwnerId: '8' }), { storage }),
    ).toBeNull()
    expect(
      readNoteDraft(scope(), authority({ currentProjectId: 'proj_2' }), { storage }),
    ).toBeNull()
    expect(
      readNoteDraft(scope(), authority({ currentAuthGeneration: 4 }), { storage }),
    ).toBeNull()
    expect(
      readNoteDraft(scope(), authority({ authGeneration: 0, currentAuthGeneration: 0 }), {
        storage,
      }),
    ).toBeNull()
  })

  it('retrieval path requires identity/generation but not current permission', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })
    expect(
      readNoteDraftForRetrieval(scope(), authority({ permissionConfirmed: false }), {
        storage,
      }),
    ).toEqual(record())
    expect(
      readNoteDraftForRetrieval(scope(), authority({ authenticatedOwnerId: '8' }), {
        storage,
      }),
    ).toBeNull()
    expect(
      readNoteDraftForRetrieval(scope(), authority({ currentAuthGeneration: 9 }), {
        storage,
      }),
    ).toBeNull()
  })

  it('switching project/viewer drops usage rights without reading old partitions', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })
    const switched = authority({
      authenticatedOwnerId: '9',
      currentProjectId: 'proj_2',
      authGeneration: 1,
      currentAuthGeneration: 1,
    })
    expect(readNoteDraft(scope(), switched, { storage })).toBeNull()
  })
})

describe('record validation (no tokens/conversations by construction)', () => {
  it('rejects records with extra sensitive keys and polluted persisted JSON', () => {
    const storage = new FakeStorage()
    const polluted = { ...record(), token: 'Bearer secret' }
    expect(isValidNoteDraftCacheRecord(polluted)).toBe(false)
    expect(
      writeNoteDraft(scope(), polluted as unknown as NoteDraftCacheRecord, { storage }),
    ).toMatchObject({ ok: false, reason: 'invalid' })
    // 直接写入被污染的持久值 → 读取时丢弃，不进入编辑器。
    storage.setItem(noteDraftKey(scope()), JSON.stringify(polluted))
    expect(readNoteDraft(scope(), authority(), { storage })).toBeNull()
  })

  it('rejects scope mismatches and wrong version', () => {
    expect(
      writeNoteDraft(scope(), record({ projectId: 'other' }), { storage: new FakeStorage() }),
    ).toMatchObject({ ok: false })
    expect(
      writeNoteDraft(scope(), record({ v: 2 as never }), { storage: new FakeStorage() }),
    ).toMatchObject({ ok: false })
    expect(
      writeNoteDraft(
        scope(),
        record({ baseSnapshotHash: 'not-a-hash' }),
        { storage: new FakeStorage() },
      ),
    ).toMatchObject({ ok: false })
  })

  it('round-trips a pending mutation (incl. copy source hash)', () => {
    const storage = new FakeStorage()
    writeNoteDraft(
      scope(),
      record({
        pendingMutation: {
          mutationId: 'nm_copy',
          kind: 'copy',
          noteId: 'note_1',
          expectedRevision: 2,
          title: 'T',
          content: 'local',
          createdAt: '2026-11-05T00:00:00.000Z',
          sourceSnapshotHash: HASH2,
        },
      }),
      { storage },
    )
    const restored = readNoteDraft(scope(), authority(), { storage })
    expect(restored?.pendingMutation).toMatchObject({
      mutationId: 'nm_copy',
      kind: 'copy',
      sourceSnapshotHash: HASH2,
    })
  })

  it('rejects malformed pending mutations', () => {
    expect(
      writeNoteDraft(
        scope(),
        record({
          pendingMutation: {
            mutationId: '',
            kind: 'save',
            noteId: null,
            expectedRevision: null,
            title: '',
            content: '',
            createdAt: '',
          },
        }),
        { storage: new FakeStorage() },
      ),
    ).toMatchObject({ ok: false })
  })
})

describe('quota / SecurityError / oversize degradation', () => {
  it('falls back to an in-memory draft on QuotaExceededError', () => {
    const storage = new ThrowingStorage('QuotaExceededError')
    const written = writeNoteDraft(scope(), record(), { storage })
    expect(written).toMatchObject({
      ok: true,
      persisted: false,
      degraded: true,
      reason: 'quota',
    })
    // 读回仍拿得到文本（内存降级副本优先），不丢用户草稿。
    expect(readNoteDraft(scope(), authority(), { storage })?.content).toBe(record().content)
  })

  it('falls back on SecurityError (private mode)', () => {
    const storage = new ThrowingStorage('SecurityError')
    expect(writeNoteDraft(scope(), record(), { storage })).toMatchObject({
      persisted: false,
      degraded: true,
      reason: 'security',
    })
  })

  it('keeps oversize drafts in memory with explicit reason', () => {
    const storage = new FakeStorage()
    const huge = 'x'.repeat(NOTE_DRAFT_MAX_SERIALIZED_BYTES + 1024)
    const written = writeNoteDraft(scope(), record({ content: huge }), { storage })
    expect(written).toMatchObject({
      ok: true,
      persisted: false,
      degraded: true,
      reason: 'oversize',
    })
    expect(storage.map.size).toBe(0)
    expect(readNoteDraft(scope(), authority(), { storage })?.content).toBe(huge)
  })

  it('reports unavailable when no storage exists at all', () => {
    const written = writeNoteDraft(scope(), record(), { storage: null })
    expect(written).toMatchObject({ persisted: false, reason: 'unavailable' })
    expect(readNoteDraft(scope(), authority(), { storage: null })?.content).toBe(record().content)
  })
})

describe('cleanup and tab branches', () => {
  it('removes a single draft and all tab branches for restricted notes', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope({ tabId: 't1' }), record(), { storage })
    writeNoteDraft(scope({ tabId: 't2' }), record({ localSeq: 9 }), { storage })
    writeNoteDraft(scope({ noteId: 'note_2' }), record({ noteId: 'note_2' }), { storage })

    expect(removeNoteDraft(scope({ tabId: 't1' }), { storage })).toBe(true)
    expect(readNoteDraft(scope({ tabId: 't1' }), authority(), { storage })).toBeNull()

    expect(removeNoteDraftsForNote('7', 'proj_1', 'note_1', { storage })).toBe(1)
    expect(readNoteDraft(scope({ tabId: 't2' }), authority(), { storage })).toBeNull()
    expect(
      readNoteDraft(scope({ noteId: 'note_2' }), authority(), { storage })?.noteId,
    ).toBe('note_2')
  })

  it('deletion tombstones prevent resurrection after failed removeItem', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })
    storage.removeItem = () => {
      throw new Error('remove failed')
    }
    removeNoteDraft(scope(), { storage })
    expect(readNoteDraft(scope(), authority(), { storage })).toBeNull()
  })

  it('tab id is stable within a tab and generated fresh for new tabs', () => {
    const session = new FakeStorage()
    const first = readOrCreateNoteDraftTabId(session)
    const second = readOrCreateNoteDraftTabId(session)
    expect(first).toBe(second)
    const fresh = readOrCreateNoteDraftTabId(new FakeStorage())
    expect(fresh).not.toBe(first)
    expect(createNoteDraftTabId()).not.toBe(createNoteDraftTabId())
  })
})

describe('recoverable draft listing (Issue #1136)', () => {
  it('lists current-tab drafts for the owner/project with summary fields only', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })
    writeNoteDraft(
      scope({ noteId: 'note_2' }),
      record({
        noteId: 'note_2',
        title: '',
        content: '第二条正文',
        savedAt: '2026-11-05T01:00:00.000Z',
      }),
      { storage },
    )

    const listed = listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority(), { storage })

    expect(listed.map((entry) => entry.noteId)).toEqual(['note_2', 'note_1'])
    expect(listed[0]).toEqual({
      noteId: 'note_2',
      title: '',
      savedAt: '2026-11-05T01:00:00.000Z',
    })
    // 摘要不得携带正文/令牌/未决 mutation 等记录字段（恢复正文仍走 openNote）。
    for (const entry of listed) {
      expect(Object.keys(entry).sort()).toEqual(['noteId', 'savedAt', 'title'])
    }
  })

  it('handles encoded note ids (dots/percent/unicode) and skips malformed keys', () => {
    const storage = new FakeStorage()
    const noteIds = ['note.a', 'note%2E', '笔记/一', 'note with space']
    for (const noteId of noteIds) {
      writeNoteDraft(
        scope({ noteId }),
        record({ noteId, title: `标题-${noteId}` }),
        { storage },
      )
    }
    // 畸形键：段数异常 / 非法百分号转义 / 内部字段与键作用域不一致。
    storage.setItem(`${NOTE_DRAFT_CACHE_PREFIX}.7.proj_1.onlynote`, '{}')
    storage.setItem(`${NOTE_DRAFT_CACHE_PREFIX}.7.proj_1.note_%ZZ.tab_1`, '{}')
    storage.setItem(
      `${NOTE_DRAFT_CACHE_PREFIX}.7.proj_1.note_other.tab_1`,
      JSON.stringify(record({ noteId: 'note_scope_mismatch' })),
    )

    const listed = listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority(), { storage })

    expect(listed.map((entry) => entry.noteId).sort()).toEqual([...noteIds].sort())
    expect(listed.find((entry) => entry.noteId === '笔记/一')?.title).toBe('标题-笔记/一')
  })

  it('lists memory-fallback drafts and respects deletion tombstones', () => {
    // storage=null：草稿只进内存兜底（quota/SecurityError 降级场景）。
    writeNoteDraft(scope(), record(), { storage: null })
    const fallbackListed = listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority(), {
      storage: null,
    })
    expect(fallbackListed.map((entry) => entry.noteId)).toEqual(['note_1'])

    // 删除后必须留墓碑：同键不得再出现在列表里。
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })
    expect(
      listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority(), { storage }),
    ).toHaveLength(1)
    removeNoteDraft(scope(), { storage })
    expect(
      listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority(), { storage }),
    ).toEqual([])
  })

  it('returns a stable fallback tab id when sessionStorage is unavailable', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error('SecurityError')
      },
      setItem: (): void => {
        throw new Error('SecurityError')
      },
    }
    const first = readOrCreateNoteDraftTabId(throwing)
    const second = readOrCreateNoteDraftTabId(throwing)
    expect(first).toBe(second)
    clearNoteDraftMemoryFallback()
    const afterReset = readOrCreateNoteDraftTabId(throwing)
    expect(afterReset).not.toBe(first)
  })

  it('isolates projects, owners, tabs and malformed records', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })
    writeNoteDraft(
      scope({ projectId: 'proj_2' }),
      record({ projectId: 'proj_2' }),
      { storage },
    )
    writeNoteDraft(
      scope({ ownerId: '8' }),
      record({ ownerId: '8' }),
      { storage },
    )
    writeNoteDraft(
      scope({ tabId: 'tab_2' }),
      record(),
      { storage },
    )
    // 污染记录（额外键）必须被拒绝，而不是展示为可恢复草稿。
    storage.setItem(
      noteDraftKey(scope({ noteId: 'note_poison' })),
      JSON.stringify({ ...record({ noteId: 'note_poison' }), token: 'secret' }),
    )

    const listed = listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority(), { storage })

    expect(listed.map((entry) => entry.noteId)).toEqual(['note_1'])
  })

  it('requires an authenticated owner, current generation and matching project', () => {
    const storage = new FakeStorage()
    writeNoteDraft(scope(), record(), { storage })

    expect(
      listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority({ authenticatedOwnerId: null }), {
        storage,
      }),
    ).toEqual([])
    expect(
      listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority({ authGeneration: 0, currentAuthGeneration: 0 }), {
        storage,
      }),
    ).toEqual([])
    expect(
      listRecoverableNoteDrafts('7', 'proj_1', 'tab_1', authority({ currentAuthGeneration: 4 }), {
        storage,
      }),
    ).toEqual([])
    expect(
      listRecoverableNoteDrafts('8', 'proj_1', 'tab_1', authority(), { storage }),
    ).toEqual([])
    expect(
      listRecoverableNoteDrafts('7', 'proj_2', 'tab_1', authority(), { storage }),
    ).toEqual([])
    expect(listRecoverableNoteDrafts('7', 'proj_1', '', authority(), { storage })).toEqual([])
  })
})
