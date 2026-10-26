import { beforeEach, describe, expect, it } from 'vitest'
import {
  SESSION_CACHE_PREFIX,
  SESSION_DRAFT_VERSION,
  SESSION_PERSISTABLE_HEADERS,
  SESSION_SUBMISSION_MARKER_BUDGET,
  clearSessionCacheMemoryFallback,
  isViewerScopedCacheReadable,
  listDraftBranches,
  listSubmissionMarkers,
  persistableSubmissionHeaders,
  purgeViewer,
  purgeViewerScope,
  readActiveSubmission,
  readCandidatePointer,
  readDisplayPointer,
  readDraft,
  readPointer,
  readSubmissionMarker,
  removeDraft,
  removeDraftIfVersion,
  sessionCacheSegment,
  writeActiveSubmission,
  writeCandidatePointer,
  writeDisplayPointer,
  writeDraft,
  writePointer,
  writeSubmissionMarker,
  type SessionCacheAuthority,
  type SessionCacheScope,
  type SessionCacheStorage,
  type SessionDraftRecord,
  type SessionSubmissionRequestSnapshot,
  type SessionSubmissionMarker,
} from './session-cache'
import type { ResearchSessionRef } from './session-contract'
import { buildSubmissionKey } from './session-idempotency'

/**
 * 第三批 PR-1：本机缓存分区（DESIGN §3.5，02 §6）。
 *
 * 注意：本文件全部使用注入的 Map 存储，禁止读写真实 localStorage。
 * 证据级别：simulated（纯函数 + mock 存储；未接真实浏览器/服务端）。
 */

class MapStorage implements SessionCacheStorage {
  readonly map = new Map<string, string>()
  failWith: Error | null = null
  failRemove: Error | null = null

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
    if (this.failWith) throw this.failWith
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    if (this.failRemove) throw this.failRemove
    this.map.delete(key)
  }
}

const P = 'proj_1'
const VIEWER_A = '42'
const VIEWER_B = '43'

const scope: SessionCacheScope = { viewerUserId: VIEWER_A, projectId: P }

function authorityFor(overrides: Partial<SessionCacheAuthority> = {}): SessionCacheAuthority {
  return {
    authenticatedViewerUserId: VIEWER_A,
    projectId: P,
    authGeneration: 3,
    currentAuthGeneration: 3,
    ...overrides,
  }
}

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

function draftRecord(overrides: Partial<SessionDraftRecord> = {}): SessionDraftRecord {
  return {
    version: SESSION_DRAFT_VERSION,
    text: 'draft text',
    token: 'draft_token_1',
    baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
    singleSourceId: null,
    noteIds: [],
    localVersion: 1,
    baseRevision: 0,
    savedAt: '2026-10-02T00:00:00Z',
    dirty: true,
    ...overrides,
  }
}

function marker(
  overrides: Partial<SessionSubmissionMarker> = {},
  ref: ResearchSessionRef = globalRef,
): SessionSubmissionMarker {
  const draftToken = overrides.draftToken ?? 'draft_token_1'
  const idempotencyKey = buildSubmissionKey({
    projectId: ref.projectId,
    ownerUserId: Number(VIEWER_A),
    kind: ref.kind,
    sourceId: ref.sourceId,
    sessionId: ref.sessionId,
    draftToken,
  })
  const body =
    ref.kind === 'global'
      ? {
          session_id: ref.sessionId,
          editor_revision: 3,
          draft_token: draftToken,
          editor_intent_hash: 'a'.repeat(64),
          query: 'hi',
          model_id: 'm-local',
          context_level: 'focused',
          source_scope: { mode: 'all', source_ids: [], single_source_id: null },
          note_ids: [],
        }
      : {
          session_id: ref.sessionId,
          editor_revision: 3,
          draft_token: draftToken,
          editor_intent_hash: 'a'.repeat(64),
          query: 'hi',
          model_id: 'm-local',
          context_level: 'focused',
        }
  const path =
    ref.kind === 'global'
      ? `/v1/research/projects/${ref.projectId}/chat`
      : `/v1/research/projects/${ref.projectId}/sources/${ref.sourceId ?? ''}/chat`
  const merged: SessionSubmissionMarker = {
    version: 1,
    draftToken,
    idempotencyKey,
    acceptanceState: 'not_observed',
    request: {
      method: 'POST',
      path,
      headers: persistableSubmissionHeaders({
        'X-Research-Session-Contract': 'research-session-v1',
        'X-Research-Contract': ref.kind === 'global' ? 'c05-v1' : 'v1',
        'Idempotency-Key': idempotencyKey,
      }),
      body,
    },
    exactRequestAvailable: true,
    generationId: null,
    observedRevision: null,
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    terminalAt: null,
    ...overrides,
  }
  return merged
}

function isPlainObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

beforeEach(() => {
  clearSessionCacheMemoryFallback()
})

describe('session-cache: 键编码单射与读取授权', () => {
  it('键段转义 `.`，避免 a.b 项目与 a/b 项目串读', () => {
    expect(sessionCacheSegment('a.b')).toBe('a%2Eb')
    expect(sessionCacheSegment('a%2Eb')).toBe('a%252Eb')
    expect(sessionCacheSegment('a%2Eb')).not.toBe(sessionCacheSegment('a.b'))
    expect(sessionCacheSegment('proj.1') === 'proj.1').toBe(false)
    expect(SESSION_CACHE_PREFIX).toBe('rdlens.research.session.v1')
  })

  it('只有已认证、viewer/项目匹配且代际为当前代际才可读 viewer 分区', () => {
    expect(isViewerScopedCacheReadable(scope, authorityFor())).toBe(true)
    expect(isViewerScopedCacheReadable(scope, authorityFor({ authGeneration: 0, currentAuthGeneration: 0 }))).toBe(false)
    expect(isViewerScopedCacheReadable(scope, authorityFor({ authGeneration: 2 }))).toBe(false)
    expect(isViewerScopedCacheReadable(scope, authorityFor({ authenticatedViewerUserId: VIEWER_B }))).toBe(false)
    expect(isViewerScopedCacheReadable(scope, authorityFor({ authenticatedViewerUserId: null }))).toBe(false)
    expect(isViewerScopedCacheReadable(scope, authorityFor({ projectId: 'proj_2' }))).toBe(false)
  })
})

describe('session-cache: 指针分区（global/source/display/candidate）', () => {
  it('global 与 source 指针独立键、互不覆盖；display 单独键', () => {
    const storage = new MapStorage()
    expect(writePointer(scope, 'global', null, globalRef, '2026-10-02T00:00:00Z', { storage }).ok).toBe(true)
    expect(writePointer(scope, 'source', 'src_a', sourceRef, '2026-10-02T00:00:01Z', { storage }).ok).toBe(true)
    expect(writeDisplayPointer(scope, { version: 1, surface: 'source', sourceId: 'src_a', ref: sourceRef }, { storage }).ok).toBe(true)

    expect(readPointer(scope, authorityFor(), 'global', null, { storage })?.ref).toEqual(globalRef)
    expect(readPointer(scope, authorityFor(), 'source', 'src_a', { storage })?.ref).toEqual(sourceRef)
    expect(readDisplayPointer(scope, authorityFor(), { storage })).toEqual({
      version: 1,
      surface: 'source',
      sourceId: 'src_a',
      ref: sourceRef,
    })

    // 键确实分属不同段（清除前检查；写 null 会删键）
    const keys = [...storage.map.keys()]
    expect(keys.some((key) => key.startsWith(`${SESSION_CACHE_PREFIX}.global.`))).toBe(true)
    expect(keys.some((key) => key.startsWith(`${SESSION_CACHE_PREFIX}.source.`))).toBe(true)
    expect(keys.some((key) => key.startsWith(`${SESSION_CACHE_PREFIX}.display.`))).toBe(true)

    // 清除 global 不影响 source（写 null 即删键）
    writePointer(scope, 'global', null, null, '2026-10-02T00:00:02Z', { storage })
    expect(readPointer(scope, authorityFor(), 'global', null, { storage })).toBeNull()
    expect(readPointer(scope, authorityFor(), 'source', 'src_a', { storage })?.ref).toEqual(sourceRef)
  })

  it('越权/旧代/未认证读取一律返回 null（不抛错），旧 viewer 读不到新 viewer 指针', () => {
    const storage = new MapStorage()
    writePointer(scope, 'global', null, globalRef, '2026-10-02T00:00:00Z', { storage })
    expect(readPointer(scope, authorityFor({ authGeneration: 1 }), 'global', null, { storage })).toBeNull()
    expect(readPointer({ ...scope, viewerUserId: VIEWER_B }, authorityFor(), 'global', null, { storage })).toBeNull()
    expect(readPointer(scope, authorityFor({ authGeneration: 0, currentAuthGeneration: 0 }), 'global', null, { storage })).toBeNull()
  })

  it('candidate pointer 允许在 viewer 确认前读取，且不含正文/草稿', () => {
    const storage = new MapStorage()
    expect(writeCandidatePointer(P, globalRef, '2026-10-02T00:00:00Z', { storage }).ok).toBe(true)
    expect(readCandidatePointer(P, { storage })).toEqual({
      version: 1,
      ref: globalRef,
      savedAt: '2026-10-02T00:00:00Z',
    })
    const raw = [...storage.map.values()].join('')
    expect(raw).not.toContain('draft')
    expect(raw).not.toContain('Bearer')
  })
})

describe('session-cache: 草稿 writer 分支（§3.5 / §10.3）', () => {
  it('两个 writerId 同会话草稿互不删除；ACK 只清本 writer 且版本对应分支', () => {
    const storage = new MapStorage()
    writeDraft(scope, globalRef, 'writer_a', draftRecord({ localVersion: 3, token: 'draft_a' }), { storage })
    writeDraft(scope, globalRef, 'writer_b', draftRecord({ localVersion: 1, token: 'draft_b', savedAt: '2026-10-02T00:00:01Z' }), { storage })

    expect(listDraftBranches(scope, authorityFor(), globalRef, { storage })).toHaveLength(2)
    // A 保存成功：只清 A 分支
    expect(removeDraftIfVersion(scope, globalRef, 'writer_a', { localVersion: 3, token: 'draft_a' }, { storage })).toBe(true)
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_a', { storage })).toBeNull()
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_b', { storage })?.token).toBe('draft_b')
  })

  it('版本或 token 不匹配时保留分支；旧分支作为恢复候选不被静默删除', () => {
    const storage = new MapStorage()
    writeDraft(scope, globalRef, 'writer_a', draftRecord({ localVersion: 2, token: 'draft_a' }), { storage })
    expect(removeDraftIfVersion(scope, globalRef, 'writer_a', { localVersion: 1, token: 'draft_a' }, { storage })).toBe(false)
    expect(removeDraftIfVersion(scope, globalRef, 'writer_a', { localVersion: 2, token: 'draft_other' }, { storage })).toBe(false)
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_a', { storage })?.localVersion).toBe(2)
    // 显式 removeDraft 才删除
    expect(removeDraft(scope, globalRef, 'writer_a', { storage })).toBe(true)
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_a', { storage })).toBeNull()
  })

  it('listDraftBranches 按 savedAt 升序，包含全部 writer 分支（多标签恢复候选）', () => {
    const storage = new MapStorage()
    writeDraft(scope, globalRef, 'writer_late', draftRecord({ savedAt: '2026-10-02T00:00:02Z' }), { storage })
    writeDraft(scope, globalRef, 'writer_early', draftRecord({ savedAt: '2026-10-02T00:00:01Z' }), { storage })
    const branches = listDraftBranches(scope, authorityFor(), globalRef, { storage })
    expect(branches.map((branch) => branch.writerId)).toEqual(['writer_early', 'writer_late'])
  })

  it('草稿读取需要 viewer+代际授权；不同 viewer/旧代返回 null', () => {
    const storage = new MapStorage()
    writeDraft(scope, globalRef, 'writer_a', draftRecord(), { storage })
    expect(readDraft(scope, authorityFor({ authGeneration: 2 }), globalRef, 'writer_a', { storage })).toBeNull()
    expect(readDraft({ ...scope, viewerUserId: VIEWER_B }, authorityFor(), globalRef, 'writer_a', { storage })).toBeNull()
    expect(listDraftBranches(scope, authorityFor({ authGeneration: 2 }), globalRef, { storage })).toEqual([])
  })

  it('quota/隐私模式写入降级到内存：ok、persisted=false、degraded、文本不丢', () => {
    const storage = new MapStorage()
    const quotaError = new Error('quota exceeded')
    quotaError.name = 'QuotaExceededError'
    storage.failWith = quotaError
    const result = writeDraft(scope, globalRef, 'writer_a', draftRecord({ text: '不丢的草稿' }), { storage })
    expect(result).toEqual({ ok: true, persisted: false, degraded: true, reason: 'quota' })
    // 内存兜底仍可读（不因本机缓存不可用丢文本）
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_a', { storage })?.text).toBe('不丢的草稿')

    const securityError = new Error('blocked')
    securityError.name = 'SecurityError'
    storage.failWith = securityError
    expect(writePointer(scope, 'global', null, globalRef, '2026-10-02T00:00:00Z', { storage })).toMatchObject({
      ok: true,
      persisted: false,
      degraded: true,
      reason: 'security',
    })
  })
})

describe('session-cache: 提交标记与请求头白名单（§3.5 预算/头白名单）', () => {
  it('持久头白名单只允许两个协议头与幂等键；Authorization/Cookie 永不落盘', () => {
    expect(SESSION_PERSISTABLE_HEADERS).toEqual([
      'X-Research-Session-Contract',
      'X-Research-Contract',
      'Idempotency-Key',
    ])
    expect(
      persistableSubmissionHeaders({
        'x-research-session-contract': 'research-session-v1',
        'X-Research-Contract': 'c05-v1',
        'Idempotency-Key': 's1_x',
        Authorization: 'Bearer secret-token',
        Cookie: 'session=abc',
        'Content-Type': 'application/json',
      }),
    ).toEqual({
      'X-Research-Session-Contract': 'research-session-v1',
      'X-Research-Contract': 'c05-v1',
      'Idempotency-Key': 's1_x',
    })
    const persisted = JSON.stringify(
      persistableSubmissionHeaders({ Authorization: 'Bearer secret-token', Cookie: 'a=b' }),
    )
    expect(persisted).toBe('{}')
  })

  it('exactRequestAvailable=false 且带请求快照 → 拒绝写入（超预算只允许 lookup）', () => {
    const storage = new MapStorage()
    expect(
      writeSubmissionMarker(scope, globalRef, marker({ exactRequestAvailable: false, request: marker().request }), { storage }).ok,
    ).toBe(false)
    expect(
      writeSubmissionMarker(
        scope,
        globalRef,
        marker({ exactRequestAvailable: false, request: null, acceptanceState: 'outcome_unknown' }),
        { storage },
      ).ok,
    ).toBe(true)
  })

  it('多 token 标记并存，T1 仍可读回；active-submission 指针独立', () => {
    const storage = new MapStorage()
    const t1 = marker({ draftToken: 'draft_t1' })
    const t2 = marker({
      draftToken: 'draft_t2',
      acceptanceState: 'accepted',
      generationId: 'gen_1',
      observedRevision: 7,
    })
    expect(writeSubmissionMarker(scope, globalRef, t1, { storage }).ok).toBe(true)
    expect(writeSubmissionMarker(scope, globalRef, t2, { storage }).ok).toBe(true)
    expect(readSubmissionMarker(scope, authorityFor(), globalRef, 'draft_t1', { storage })?.acceptanceState).toBe('not_observed')
    expect(listSubmissionMarkers(scope, authorityFor(), globalRef, { storage })).toHaveLength(2)

    expect(writeActiveSubmission(scope, globalRef, 'draft_t2', { storage }).ok).toBe(true)
    expect(readActiveSubmission(scope, authorityFor(), globalRef, { storage })).toBe('draft_t2')
    // 旧代不可读
    expect(readSubmissionMarker(scope, authorityFor({ authGeneration: 2 }), globalRef, 'draft_t1', { storage })).toBeNull()
  })

  it('未结算标记预算：达到上限后拒绝新增，但已存在同 token 的更新仍允许', () => {
    const storage = new MapStorage()
    for (let index = 0; index < SESSION_SUBMISSION_MARKER_BUDGET; index += 1) {
      const result = writeSubmissionMarker(
        scope,
        globalRef,
        marker({ draftToken: `draft_${index}` }),
        { storage },
      )
      expect(result.ok).toBe(true)
    }
    expect(
      writeSubmissionMarker(scope, globalRef, marker({ draftToken: 'draft_overflow' }), { storage }).ok,
    ).toBe(false)
    // 已存在的 token 更新不受预算限制（不是新增）
    expect(
      writeSubmissionMarker(
        scope,
        globalRef,
        marker({ draftToken: 'draft_0', acceptanceState: 'terminal', generationId: 'gen_9' }),
        { storage },
      ).ok,
    ).toBe(true)
    // terminal 标记不占预算：再新增一条仍应失败（已有 19 未结算 + 1 terminal = 20 条，19 < 20）
    expect(
      writeSubmissionMarker(
        scope,
        globalRef,
        marker({ draftToken: 'draft_after_terminal' }),
        { storage },
      ).ok,
    ).toBe(true)
  })
})

describe('session-cache: purge 语义（登出/换 viewer）', () => {
  it('purgeViewer 清除其他 viewer 全部分区、保留当前 viewer 与 candidate', () => {
    const storage = new MapStorage()
    writePointer(scope, 'global', null, globalRef, '2026-10-02T00:00:00Z', { storage })
    writeDraft(scope, globalRef, 'writer_a', draftRecord(), { storage })
    writePointer({ viewerUserId: VIEWER_B, projectId: P }, 'global', null, globalRef, '2026-10-02T00:00:00Z', { storage })
    writeCandidatePointer(P, globalRef, '2026-10-02T00:00:00Z', { storage })

    const result = purgeViewer(VIEWER_A, { storage })
    expect(result.retainedViewerUserId).toBe(VIEWER_A)
    expect(readPointer(scope, authorityFor(), 'global', null, { storage })?.ref).toEqual(globalRef)
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_a', { storage })).not.toBeNull()
    expect(readPointer({ viewerUserId: VIEWER_B, projectId: P }, authorityFor({ authenticatedViewerUserId: VIEWER_B }), 'global', null, { storage })).toBeNull()
    expect(readCandidatePointer(P, { storage })).not.toBeNull()
    expect(result.decisions.some((decision) => decision.reason === 'candidate-pointer' && decision.action === 'retained')).toBe(true)
    expect(result.removed).toBeGreaterThan(0)
  })

  it('purgeViewerScope 只清指定 viewer+项目（登出语义），不影响其他项目/viewer', () => {
    const storage = new MapStorage()
    writeDraft(scope, globalRef, 'writer_a', draftRecord(), { storage })
    writeDraft({ viewerUserId: VIEWER_A, projectId: 'proj_2' }, { ...globalRef, projectId: 'proj_2' }, 'writer_a', draftRecord(), { storage })
    writeDraft({ viewerUserId: VIEWER_B, projectId: P }, globalRef, 'writer_a', draftRecord(), { storage })

    expect(purgeViewerScope(scope, { storage })).toBeGreaterThan(0)
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_a', { storage })).toBeNull()
    // 其他项目保留下次授权不同，直接检查存储键仍存在
    const keys = [...storage.map.keys()]
    expect(keys.some((key) => key.includes('proj_2'))).toBe(true)
  })
})

// ── review 补证：编码分区清理、quota 降级优先级、提交标记写入边界（F7/F8/F10） ──

describe('session-cache: review 补证（编码分区 / quota 优先级 / 写入边界）', () => {
  it('项目/viewer 含 `.` 时清理仍按同一编码比较（F7）', () => {
    const storage = new MapStorage()
    const dottedScope: SessionCacheScope = { viewerUserId: 'user.101', projectId: 'org.team' }
    const dottedRef: ResearchSessionRef = { ...globalRef, projectId: 'org.team' }
    writeDraft(dottedScope, dottedRef, 'writer_a', draftRecord(), { storage })
    writeDraft({ viewerUserId: 'user.101', projectId: P }, globalRef, 'writer_a', draftRecord(), { storage })
    const removed = purgeViewerScope(dottedScope, { storage })
    expect(removed).toBeGreaterThanOrEqual(1)
    // 同一编码分区已清；其他项目分区不受影响
    expect(
      [...storage.map.keys()].some((key) => key.includes('user%2E101') && key.includes('org%2Eteam')),
    ).toBe(false)
    expect([...storage.map.keys()].some((key) => key.includes(`${P}`))).toBe(true)
    // purgeViewer 的 keep 比较同样走编码段
    writeDraft({ viewerUserId: 'user.202', projectId: P }, globalRef, 'writer_b', draftRecord(), { storage })
    const result = purgeViewer('user.101', { storage })
    expect(result.removed).toBeGreaterThanOrEqual(1)
    expect([...storage.map.keys()].some((key) => key.includes('user%2E202'))).toBe(false)
    expect([...storage.map.keys()].some((key) => key.includes('user%2E101'))).toBe(true)
  })

  it('更新写入遇到 quota 降级时，读回必须是本进程最新文本（F8）', () => {
    const storage = new MapStorage()
    expect(writeDraft(scope, globalRef, 'writer_a', draftRecord({ text: '第一次' }), { storage }).ok).toBe(true)
    storage.failWith = Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
    const degraded = writeDraft(scope, globalRef, 'writer_a', draftRecord({ text: '第二次', localVersion: 2 }), {
      storage,
    })
    expect(degraded.ok).toBe(true)
    expect(degraded.persisted).toBe(false)
    expect(degraded.degraded).toBe(true)
    expect(degraded.reason).toBe('quota')
    // 旧持久值仍存在于 storage，但读取必须优先返回最近降级副本
    expect(storage.getItem([...storage.map.keys()][0])).toContain('第一次')
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_a', { storage })?.text).toBe('第二次')
  })

  it('writeSubmissionMarker：真实执行端点与完整 wire 请求可持久化，鉴权头被过滤（F10/R1/R2）', () => {
    const storage = new MapStorage()
    const base = marker()
    const request = base.request
    if (request === null) throw new Error('fixture requires request')
    const body = request.body as Record<string, unknown>
    const withCredentials = {
      ...base,
      request: {
        ...request,
        headers: {
          ...persistableSubmissionHeaders({
            'X-Research-Session-Contract': 'research-session-v1',
            'X-Research-Contract': 'c05-v1',
            'Idempotency-Key': base.idempotencyKey,
          }),
          Authorization: 'Bearer secret-token',
          Cookie: 'session=abc',
        },
      },
    }
    expect(writeSubmissionMarker(scope, globalRef, withCredentials, { storage }).ok).toBe(true)
    const persisted = readSubmissionMarker(scope, authorityFor(), globalRef, 'draft_token_1', { storage })
    expect(persisted?.request?.headers).toEqual({
      'X-Research-Session-Contract': 'research-session-v1',
      'X-Research-Contract': 'c05-v1',
      'Idempotency-Key': base.idempotencyKey,
    })
    expect(JSON.stringify(persisted)).not.toContain('secret-token')
    expect(JSON.stringify(persisted)).not.toContain('session=abc')

    // source 执行端点正例（source_chat_request 无 source_scope/note_ids）
    const sourceMarker = marker({ draftToken: 'draft_source' }, sourceRef)
    expect(writeSubmissionMarker(scope, sourceRef, sourceMarker, { storage }).ok).toBe(true)
    // global ref 配 source 路径不得通过
    expect(
      writeSubmissionMarker(
        scope,
        globalRef,
        { ...base, request: { ...request, path: '/v1/research/projects/proj_1/sources/src_a/chat' } },
        { storage },
      ).ok,
    ).toBe(false)

    const reject = (candidate: SessionSubmissionMarker): void => {
      expect(writeSubmissionMarker(scope, globalRef, candidate, { storage }).ok).toBe(false)
    }
    const withRequest = (
      overrides: Partial<SessionSubmissionRequestSnapshot>,
    ): SessionSubmissionMarker => ({ ...base, request: { ...request, ...overrides } })
    const withBody = (overrides: Record<string, unknown>): SessionSubmissionMarker =>
      withRequest({ body: { ...body, ...overrides } })

    reject(withRequest({ path: '/v1/research/projects/proj_1/chat/sessions/sess_global/submissions' }))
    reject(withRequest({ path: '/v1/research/projects/proj_other/chat' }))
    reject(withRequest({ method: 'PUT' as unknown as 'POST' }))
    reject(withRequest({ body: new Map([['a', 1]]) as unknown as Record<string, unknown> }))
    reject(withBody({ n: Number.NaN }))
    reject(withBody({ session_id: 'sess_other' }))
    reject(withBody({ draft_token: 'draft_other' }))
    reject(withBody({ query: '' }))
    reject(withBody({ model_id: '' }))
    reject(withBody({ context_level: 'deep' }))
    reject(withBody({ unknown_field: 1 }))
    // 不完整的 wire body：缺必填字段即不得声明 exactRequestAvailable
    reject(
      withRequest({
        body: { session_id: 'sess_global', draft_token: 'draft_token_1' },
      }),
    )
    reject(withBody({ source_scope: { mode: 'single', source_ids: [], single_source_id: null } }))
    reject(withBody({ source_scope: { mode: 'all', source_ids: ['src_a'], single_source_id: null } }))
    reject(withBody({ note_ids: ['n1', 'n1'] }))
    reject(
      withRequest({
        headers: { 'X-Research-Session-Contract': 'research-session-v1' },
      }),
    )
    reject(
      withRequest({
        headers: { ...request.headers, 'Idempotency-Key': `s1_${'d'.repeat(64)}` },
      }),
    )
    reject(
      withRequest({
        headers: { ...request.headers, 'X-Research-Contract': 'v1' },
      }),
    )
    reject(
      withRequest({
        headers: { ...request.headers, 'X-Research-Session-Contract': 'research-session-v0' },
      }),
    )
    reject(
      withRequest({
        headers: { ...request.headers, 'X-Research-Contract': undefined as unknown as string },
      }),
    )
    // 幂等键必须与 project/viewer/kind/source/session/token 一致（不能只信头）
    reject({ ...base, idempotencyKey: `s1_${'e'.repeat(64)}` })
    // 同时伪造 marker 与请求头仍必须因重算不一致而拒绝（review N1 复核）
    const forgedKey = `s1_${'f'.repeat(64)}`
    reject({
      ...base,
      idempotencyKey: forgedKey,
      request: {
        ...request,
        headers: { ...request.headers, 'Idempotency-Key': forgedKey },
      },
    })
    // source 请求体带 global 专属字段也不得通过（用 sourceRef 写入口，证明 kind 专属键校验）
    const sourceRequest = sourceMarker.request
    if (sourceRequest === null) throw new Error('fixture requires source request')
    expect(
      writeSubmissionMarker(
        scope,
        sourceRef,
        {
          ...sourceMarker,
          request: {
            ...sourceRequest,
            body: { ...(sourceRequest.body as Record<string, unknown>), note_ids: [] },
          },
        },
        { storage },
      ).ok,
    ).toBe(false)
    // ref 项目与 scope 项目不一致不得写入错误分区（review N1）
    const foreignScope = { viewerUserId: scope.viewerUserId, projectId: 'proj_other' }
    expect(writeSubmissionMarker(foreignScope, globalRef, marker(), { storage }).ok).toBe(false)
    expect([...storage.map.keys()].some((key) => key.includes('proj_other'))).toBe(false)
  })

  it('取消草稿时持久删除失败也不得让旧值复活（review F8）', () => {
    const storage = new MapStorage()
    // T1 成功持久化
    expect(writeDraft(scope, globalRef, 'writer_a', draftRecord({ text: 'T1' }), { storage }).persisted).toBe(true)
    // T2 降级写内存兜底
    storage.failWith = new Error('quota')
    expect(writeDraft(scope, globalRef, 'writer_a', draftRecord({ text: 'T2' }), { storage }).persisted).toBe(false)
    storage.failWith = null
    // 删除持久值失败（例如隐私模式/配额清理异常）
    storage.failRemove = new Error('remove failed')
    expect(removeDraft(scope, globalRef, 'writer_a', { storage })).toBe(true)
    storage.failRemove = null
    // 墓碑生效：不得读回旧持久值 T1
    expect(readDraft(scope, authorityFor(), globalRef, 'writer_a', { storage })).toBeNull()
  })
})
