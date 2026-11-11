/**
 * Issue #1048 PR7：写作选择独立缓存测试。
 *
 * 覆盖：闭合键集（不可缓存令牌/历史正文/候选）、键逐段转义、读取授权
 * （owner/project/authGeneration/Note 可见）、quota 降级、同 id 重试记录、
 * 按 Note 清理全部分支。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  WRITING_CACHE_MAX_SERIALIZED_BYTES,
  clearWritingCacheMemoryFallback,
  createWritingCacheRecord,
  isValidWritingCacheRecord,
  readOrCreateWritingCacheTabId,
  readWritingCacheRecord,
  removeWritingCacheForNote,
  removeWritingCacheRecord,
  resetWritingCacheTabId,
  writingCacheKey,
  writeWritingCacheRecord,
  type WritingCacheAuthority,
  type WritingCacheRecord,
  type WritingCacheScope,
  type WritingCacheStorage,
} from './writing-cache'

class FakeStorage implements WritingCacheStorage {
  readonly map = new Map<string, string>()
  failNextWrite: unknown = null
  failReads = false

  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    if (this.failReads) throw new Error('read blocked')
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    if (this.failNextWrite !== null) {
      const error = this.failNextWrite
      this.failNextWrite = null
      throw error
    }
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

const SCOPE: WritingCacheScope = {
  ownerId: '42',
  projectId: 'p_demo',
  noteId: 'note_abc',
  tabId: 'wtab_1',
}

const AUTHORITY: WritingCacheAuthority = {
  authenticatedOwnerId: '42',
  currentProjectId: 'p_demo',
  authGeneration: 3,
  currentAuthGeneration: 3,
  notePermission: 'visible',
}

function validRecord(scope: WritingCacheScope = SCOPE): WritingCacheRecord {
  const base = createWritingCacheRecord({
    scope,
    now: '2026-11-11T00:00:00.000Z',
    authGeneration: AUTHORITY.currentAuthGeneration,
  })
  return {
    ...base,
    choice: {
      documentSelection: {
        note_id: scope.noteId,
        revision: 4,
        snapshot_hash: 'a'.repeat(64),
        selection: { kind: 'range', start_utf16: 1, end_utf16: 5 },
      },
      historyMode: 'none',
      sessionChoice: 'new',
      sessionKind: 'global',
      sourceId: null,
      currentSessionId: null,
      query: '请改写选段',
      modelId: 'm-local',
    },
    pendingSessionCreate: {
      attemptId: 'watt_1',
      sessionId: 'sess_pending',
      sessionKind: 'global',
      sourceId: null,
      createdAt: '2026-11-11T00:00:00.000Z',
    },
    lastSubmission: {
      sessionId: 'sess_a',
      sessionKind: 'global',
      sourceId: null,
      writingIntentHash: 'b'.repeat(64),
      editorRevision: 5,
      editorIntentHash: 'c'.repeat(64),
      draftToken: 'draft_a',
      query: '请改写选段',
      modelId: 'm-local',
      responseLanguage: 'zh',
      documentContext: {
        note_id: scope.noteId,
        revision: 4,
        snapshot_hash: 'a'.repeat(64),
        selection: { kind: 'full' },
      },
      historyMode: 'current',
      createdAt: '2026-11-11T00:00:01.000Z',
    },
  }
}

beforeEach(() => {
  clearWritingCacheMemoryFallback()
  resetWritingCacheTabId()
})

describe('键构造与逐段转义', () => {
  it('owner/note 段中的点号不会串读', () => {
    const first = writingCacheKey({ ...SCOPE, ownerId: 'a.b', noteId: 'c' })
    const second = writingCacheKey({ ...SCOPE, ownerId: 'a', noteId: 'b.c' })
    expect(first).not.toBe(second)
    expect(first.includes('%2E')).toBe(true)
  })

  it('tabId 由 sessionStorage 稳定复用', () => {
    const storage = new FakeStorage()
    const first = readOrCreateWritingCacheTabId({ sessionStorage: storage })
    const second = readOrCreateWritingCacheTabId({ sessionStorage: storage })
    expect(first).toBe(second)
    resetWritingCacheTabId()
    const third = readOrCreateWritingCacheTabId({ sessionStorage: storage })
    expect(third).toBe(first)
    expect(first.startsWith('wtab_') || first.startsWith('wtab_')).toBe(true)
  })
})

describe('记录形状：闭合键集', () => {
  it('合法记录可写入并读回', () => {
    const storage = new FakeStorage()
    const record = validRecord()
    expect(writeWritingCacheRecord(SCOPE, record, { storage })).toMatchObject({
      ok: true,
      persisted: true,
      degraded: false,
    })
    const read = readWritingCacheRecord(SCOPE, { storage, authority: AUTHORITY })
    expect(read).toEqual(record)
  })

  it('拒绝任意附加键（防止令牌/历史正文/候选被写入）', () => {
    const polluted = {
      ...validRecord(),
      token: 'Bearer xyz',
      history: ['全文历史'],
      candidates: [{ content: 'candidate' }],
    }
    expect(isValidWritingCacheRecord(polluted)).toBe(false)
    const storage = new FakeStorage()
    const result = writeWritingCacheRecord(SCOPE, polluted as unknown as WritingCacheRecord, {
      storage,
    })
    expect(result.ok).toBe(false)
    expect(storage.map.size).toBe(0)
  })

  it('choice/lastSubmission 内的未知键也会被拒绝', () => {
    const record = validRecord()
    const polluted = {
      ...record,
      lastSubmission: { ...record.lastSubmission, authorization: 'Bearer x' },
    }
    expect(isValidWritingCacheRecord(polluted)).toBe(false)
  })

  it('超预算记录拒绝（不静默截断 query）', () => {
    const record = validRecord()
    const oversized = {
      ...record,
      choice: { ...record.choice!, query: 'x'.repeat(WRITING_CACHE_MAX_SERIALIZED_BYTES + 10) },
      lastSubmission: null,
    }
    expect(isValidWritingCacheRecord(oversized)).toBe(true)
    const storage = new FakeStorage()
    const result = writeWritingCacheRecord(SCOPE, oversized, { storage })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('oversize')
  })
})

describe('读取授权（缓存不是授权凭据）', () => {
  const storage = new FakeStorage()
  beforeEach(() => {
    clearWritingCacheMemoryFallback()
    storage.map.clear()
    writeWritingCacheRecord(SCOPE, validRecord(), { storage })
  })

  it('owner/项目/authGeneration/Note 权限任一不符 → 不返回', () => {
    expect(
      readWritingCacheRecord(SCOPE, {
        storage,
        authority: { ...AUTHORITY, authenticatedOwnerId: '43' },
      }),
    ).toBeNull()
    expect(
      readWritingCacheRecord(SCOPE, {
        storage,
        authority: { ...AUTHORITY, currentProjectId: 'p_other' },
      }),
    ).toBeNull()
    expect(
      readWritingCacheRecord(SCOPE, {
        storage,
        authority: { ...AUTHORITY, currentAuthGeneration: 4 },
      }),
    ).toBeNull()
    expect(
      readWritingCacheRecord(SCOPE, {
        storage,
        authority: { ...AUTHORITY, notePermission: 'restricted' },
      }),
    ).toBeNull()
    expect(
      readWritingCacheRecord(SCOPE, {
        storage,
        authority: { ...AUTHORITY, notePermission: 'unknown' },
      }),
    ).toBeNull()
  })

  it('scope 不匹配（同 key 但记录身份不同）→ 不返回', () => {
    const otherScope = { ...SCOPE, tabId: 'wtab_2' }
    expect(
      readWritingCacheRecord(otherScope, { storage, authority: AUTHORITY }),
    ).toBeNull()
  })
})

describe('review round 1：确认会话/认证代际/旧记录归一', () => {
  it('confirmedSessionCreate（创建成功）持久化并可读回', () => {
    const storage = new FakeStorage()
    const record = validRecord()
    const withConfirmed: WritingCacheRecord = {
      ...record,
      pendingSessionCreate: null,
      confirmedSessionCreate: {
        sessionId: 'sess_confirmed',
        sessionKind: 'global',
        sourceId: null,
        createdAt: '2026-11-11T00:00:00.000Z',
      },
    }
    expect(writeWritingCacheRecord(SCOPE, withConfirmed, { storage }).ok).toBe(true)
    const read = readWritingCacheRecord(SCOPE, { storage, authority: AUTHORITY })
    expect(read?.confirmedSessionCreate?.sessionId).toBe('sess_confirmed')
    expect(read?.pendingSessionCreate).toBeNull()
  })

  it('authGeneration 不符（旧认证代）→ 读取为 null', () => {
    const storage = new FakeStorage()
    expect(writeWritingCacheRecord(SCOPE, validRecord(), { storage }).ok).toBe(true)
    expect(
      readWritingCacheRecord(SCOPE, {
        storage,
        authority: { ...AUTHORITY, currentAuthGeneration: AUTHORITY.authGeneration + 1 },
      }),
    ).toBeNull()
  })

  it('旧版 v1 记录（无 authGeneration/confirmedSessionCreate）归一后可读', () => {
    const storage = new FakeStorage()
    const record = validRecord()
    const {
      authGeneration: _authGeneration,
      confirmedSessionCreate: _confirmedSessionCreate,
      ...legacy
    } = record
    void _authGeneration
    void _confirmedSessionCreate
    storage.setItem(writingCacheKey(SCOPE), JSON.stringify(legacy))
    const read = readWritingCacheRecord(SCOPE, {
      storage,
      authority: { ...AUTHORITY, authGeneration: 0, currentAuthGeneration: 0 },
    })
    expect(read?.authGeneration).toBe(0)
    expect(read?.confirmedSessionCreate).toBeNull()
    expect(read?.choice?.query).toBe('请改写选段')
  })
})

describe('降级与清理', () => {
  it('quota/SecurityError → 内存降级但当前选择仍可读', () => {
    const quota = new DOMException('quota', 'QuotaExceededError')
    const storage = new FakeStorage()
    storage.failNextWrite = quota
    const record = validRecord()
    const result = writeWritingCacheRecord(SCOPE, record, { storage })
    expect(result).toMatchObject({ ok: true, persisted: false, degraded: true, reason: 'quota' })
    const read = readWritingCacheRecord(SCOPE, { storage, authority: AUTHORITY })
    expect(read).toEqual(record)
  })

  it('删除后读取返回 null（墓碑防止旧值复活）', () => {
    const storage = new FakeStorage()
    writeWritingCacheRecord(SCOPE, validRecord(), { storage })
    removeWritingCacheRecord(SCOPE, { storage })
    expect(readWritingCacheRecord(SCOPE, { storage, authority: AUTHORITY })).toBeNull()
  })

  it('按 Note 清理所有 tab 分支', () => {
    const storage = new FakeStorage()
    writeWritingCacheRecord(SCOPE, validRecord(), { storage })
    writeWritingCacheRecord({ ...SCOPE, tabId: 'wtab_2' }, validRecord({ ...SCOPE, tabId: 'wtab_2' }), {
      storage,
    })
    writeWritingCacheRecord({ ...SCOPE, noteId: 'note_other' }, validRecord({ ...SCOPE, noteId: 'note_other' }), {
      storage,
    })
    const removed = removeWritingCacheForNote(
      { ownerId: SCOPE.ownerId, projectId: SCOPE.projectId, noteId: SCOPE.noteId },
      { storage },
    )
    expect(removed).toBe(2)
    expect(readWritingCacheRecord(SCOPE, { storage, authority: AUTHORITY })).toBeNull()
    expect(
      readWritingCacheRecord({ ...SCOPE, noteId: 'note_other' }, { storage, authority: AUTHORITY }),
    ).not.toBeNull()
  })

  it('pendingSessionCreate 持久保存（同 id 重试依据）', () => {
    const storage = new FakeStorage()
    const record = validRecord()
    writeWritingCacheRecord(SCOPE, record, { storage })
    const read = readWritingCacheRecord(SCOPE, { storage, authority: AUTHORITY })
    expect(read?.pendingSessionCreate?.sessionId).toBe('sess_pending')
    expect(read?.pendingSessionCreate?.attemptId).toBe('watt_1')
  })
})
