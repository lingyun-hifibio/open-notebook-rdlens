import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_INSIGHT_KEY_MAX_AGE_MS,
  aiInsightRiskMarkerKey,
  attemptKeyAgeMs,
  buildAiInsightAttempt,
  clearAiInsightRiskMarker,
  decodeAiInsightRiskMarker,
  isAiInsightKeyRetryable,
  listAiInsightRiskMarkers,
  markAiInsightAttempt,
  markerActionForDisposition,
} from './ai-insight-risk'

// Issue #54 S3（FR-03/FR-04/C-06）：风险标记与冻结 attempt。
// - 每次尝试一个独立 marker；只清自己的 marker；写入失败不派发。
// - key 年龄用单调时钟；<24h 才允许同 key 重试，边界起禁止。

const USER = 'u1'
const PROJECT = 'proj_1'

function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k) },
    setItem: (k: string, v: string) => { map.set(k, v) },
  } as Storage
}

let storage: Storage

beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('markAiInsightAttempt（FR-03 写入失败不派发）', () => {
  it('写入成功：键按 user/project/attemptId 隔离，值只含白名单四字段', () => {
    expect(markAiInsightAttempt(USER, PROJECT, 'att_1', 'fresh', { storage, now: () => 1000 })).toBe(true)
    const raw = storage.getItem(aiInsightRiskMarkerKey(USER, PROJECT, 'att_1'))
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual({
      version: 1,
      markerId: 'att_1',
      kind: 'fresh',
      recordedAt: 1000,
    })
  })

  it('值不含正文/Scope/幂等 key（契约：marker 只记存在性）', () => {
    markAiInsightAttempt(USER, PROJECT, 'att_1', 'fresh', { storage, now: () => 1000 })
    const raw = storage.getItem(aiInsightRiskMarkerKey(USER, PROJECT, 'att_1')) as string
    for (const forbidden of ['content', 'source_ids', 'note_ids', 'idempotency', 'prompt']) {
      expect(raw).not.toContain(forbidden)
    }
  })

  it('storage 写入抛错 → 返回 false（调用方不得派发请求）', () => {
    const throwing = {
      ...fakeStorage(),
      setItem: () => { throw new Error('quota exceeded') },
    } as Storage
    expect(markAiInsightAttempt(USER, PROJECT, 'att_1', 'fresh', { storage: throwing })).toBe(false)
  })

  it('storage 取用抛错（隐私模式等）→ 返回 false', () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('access denied')
    })
    try {
      expect(markAiInsightAttempt(USER, PROJECT, 'att_1', 'fresh')).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('id 含特殊字符时键不碰撞（URI 编码）', () => {
    markAiInsightAttempt('u/1', PROJECT, 'att/1', 'fresh', { storage })
    const key = aiInsightRiskMarkerKey('u/1', PROJECT, 'att/1')
    expect(key).toContain('u%2F1')
    expect(key).toContain('att%2F1')
  })
})

describe('decode / list（FR-03 多标签页互不覆盖）', () => {
  it('两个标签页各自一个 marker，互不覆盖', () => {
    markAiInsightAttempt(USER, PROJECT, 'tab_a', 'fresh', { storage })
    markAiInsightAttempt(USER, PROJECT, 'tab_b', 'recovery', { storage })
    const markers = listAiInsightRiskMarkers(USER, PROJECT, { storage })
    expect(markers.map((m) => m.markerId).sort()).toEqual(['tab_a', 'tab_b'])
    expect(markers.map((m) => m.kind).sort()).toEqual(['fresh', 'recovery'])
  })

  it('畸形 JSON / 版本不符 / 缺字段 / 非本命名空间 → 一律忽略', () => {
    storage.setItem(aiInsightRiskMarkerKey(USER, PROJECT, 'bad_json'), '{oops')
    storage.setItem(
      aiInsightRiskMarkerKey(USER, PROJECT, 'bad_version'),
      JSON.stringify({ version: 2, markerId: 'bad_version', kind: 'fresh', recordedAt: 1 }),
    )
    storage.setItem(
      aiInsightRiskMarkerKey(USER, PROJECT, 'missing'),
      JSON.stringify({ version: 1, markerId: 'missing' }),
    )
    storage.setItem('rdlens.research.scope.v1/u1/proj_1', JSON.stringify({ version: 1 }))
    storage.setItem(
      aiInsightRiskMarkerKey(USER, PROJECT, 'ok'),
      JSON.stringify({ version: 1, markerId: 'ok', kind: 'fresh', recordedAt: 5 }),
    )
    expect(listAiInsightRiskMarkers(USER, PROJECT, { storage })).toEqual([
      { markerId: 'ok', kind: 'fresh', recordedAt: 5 },
    ])
    expect(decodeAiInsightRiskMarker('{oops')).toBeNull()
    expect(decodeAiInsightRiskMarker(JSON.stringify({ version: 9 }))).toBeNull()
  })

  it('他人/他项目的 marker 不计入（严格前缀）', () => {
    markAiInsightAttempt('u2', PROJECT, 'other_user', 'fresh', { storage })
    markAiInsightAttempt(USER, 'proj_2', 'other_project', 'fresh', { storage })
    markAiInsightAttempt(USER, PROJECT, 'mine', 'fresh', { storage })
    expect(listAiInsightRiskMarkers(USER, PROJECT, { storage }).map((m) => m.markerId)).toEqual(['mine'])
  })
})

describe('clearAiInsightRiskMarker（只清自己的）', () => {
  it('清自己的 marker，不动他人', () => {
    markAiInsightAttempt(USER, PROJECT, 'tab_a', 'fresh', { storage })
    markAiInsightAttempt(USER, PROJECT, 'tab_b', 'fresh', { storage })
    clearAiInsightRiskMarker(USER, PROJECT, 'tab_a', { storage })
    expect(listAiInsightRiskMarkers(USER, PROJECT, { storage }).map((m) => m.markerId)).toEqual(['tab_b'])
  })

  it('removeItem 抛错仍返回 false（调用方可知清理未生效）', () => {
    const throwing = {
      ...fakeStorage(),
      removeItem: () => { throw new Error('nope') },
    } as Storage
    expect(clearAiInsightRiskMarker(USER, PROJECT, 'tab_a', { storage: throwing })).toBe(false)
  })
})

describe('buildAiInsightAttempt / 24h 单调时钟（FR-04）', () => {
  const request = { title: 'T', content: 'prompt', model_id: 'm', source_ids: ['s'], note_ids: [] }

  it('冻结 request/key/attemptId/起始单调时刻；同 key 重试复用完整 request', () => {
    const attempt = buildAiInsightAttempt(request, { id: 'att_1', key: 'ui-k1', now: () => 100 })
    expect(attempt).toEqual({
      attemptId: 'att_1',
      idempotencyKey: 'ui-k1',
      request,
      startedAt: 100,
    })
    expect(attempt.request).toBe(request)
  })

  it('23:59:59.999 仍可同 key；24:00:00.000 起禁止', () => {
    const attempt = buildAiInsightAttempt(request, { id: 'att_1', key: 'ui-k1', now: () => 1000 })
    expect(attemptKeyAgeMs(attempt, 1000 + AI_INSIGHT_KEY_MAX_AGE_MS - 1)).toBe(AI_INSIGHT_KEY_MAX_AGE_MS - 1)
    expect(isAiInsightKeyRetryable(attempt, 1000 + AI_INSIGHT_KEY_MAX_AGE_MS - 1)).toBe(true)
    expect(isAiInsightKeyRetryable(attempt, 1000 + AI_INSIGHT_KEY_MAX_AGE_MS)).toBe(false)
  })

  it('单调时钟回拨（当前 < 起始）不产生负年龄，仍可重试', () => {
    const attempt = buildAiInsightAttempt(request, { id: 'att_1', key: 'ui-k1', now: () => 5000 })
    expect(attemptKeyAgeMs(attempt, 1000)).toBe(0)
    expect(isAiInsightKeyRetryable(attempt, 1000)).toBe(true)
  })

  it('AGE_MS 常量即 24 小时', () => {
    expect(AI_INSIGHT_KEY_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
  })
})

describe('markerActionForDisposition（S3 marker 生命周期）', () => {
  it('terminal（含成功后的确定性终局）→ clear', () => {
    expect(markerActionForDisposition('terminal')).toBe('clear')
  })

  it('retry_same_key / outcome_unknown → keep（崩溃后仍可见风险）', () => {
    expect(markerActionForDisposition('retry_same_key')).toBe('keep')
    expect(markerActionForDisposition('outcome_unknown')).toBe('keep')
  })

  it('protocol_conflict → escalate（保留且升级为需人工确认，禁止自动重发）', () => {
    expect(markerActionForDisposition('protocol_conflict')).toBe('escalate')
  })

  it('consent_invalid → clear_and_refresh_consent（清本次 + 刷新，新 key 重新确认）', () => {
    expect(markerActionForDisposition('consent_invalid')).toBe('clear_and_refresh_consent')
  })
})
