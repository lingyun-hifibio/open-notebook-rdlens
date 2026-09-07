/**
 * RWV2-23（Issue #43，U1）：`saveResultFromResult` 客户端契约（RWV2-22）。
 *
 * - POST `/v1/research/projects/{project_id}/save-result`，请求体为
 *   `SaveResultRequest`（snake_case、extra=forbid 域外字段不发送）；
 * - 携带 `X-Research-Contract: v1` 与确定性 `Idempotency-Key`（D3）；
 *   调用方可显式覆盖幂等键（幂等重放/测试用）；
 * - 201/200 响应为 note/insight detail 视图（含 citations + provenance），
 *   按 `note_id`/`insight_id` 判别。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalAxiosRequestConfig } from 'axios'
import { apiClient } from '@/lib/api/client'
import { saveIdempotencyKey } from './save-idempotency'
import { saveResultFromResult } from './api'

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: vi.fn(() => true),
  getEmbeddedGatewayUrl: vi.fn(() => 'https://gateway.example.com'),
}))

vi.mock('@/lib/embedded/token-store', () => ({
  getResearchToken: vi.fn(() => 'memory-token'),
}))

interface Captured {
  url: string
  method: string
  data: unknown
  headers: Record<string, string>
}

const calls: Captured[] = []

function installAdapter(responder: () => { status: number; data: unknown }) {
  apiClient.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const raw = config.data
    calls.push({
      url: String(config.url),
      method: String(config.method ?? 'get').toUpperCase(),
      data: typeof raw === 'string' ? JSON.parse(raw) : raw,
      headers: (config.headers ?? {}) as Record<string, string>,
    })
    const outcome = responder()
    return { data: outcome.data, status: outcome.status, statusText: 'OK', headers: {}, config }
  }
}

const P = 'p1'
const NOTE_RESPONSE = {
  note_id: 'note_digest1',
  project_id: P,
  title: 'Saved search result',
  content: 'conclusion text',
  note_type: 'human',
  created_at: '2026-09-08T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
  citations: [],
  provenance: {
    envelope_version: 1,
    kind: 'save_from_result',
    origin_kind: 'search',
    origin_id: 'gen_abc123',
    destination_kind: 'note',
    scope: { source_ids: ['d1'], note_ids: [] },
    model_id: 'qwen3.6-35b',
    response_language: 'en',
    saved_at: '2026-09-08T00:00:00Z',
    saved_by_user_id: 1,
    source_timestamps: { created_at: '2026-09-08T00:00:00Z' },
  },
}

const INSIGHT_RESPONSE = {
  insight_id: 'insight_digest2',
  project_id: P,
  title: 'Saved chat result',
  content: 'chat answer',
  insight_type: 'ai',
  model_id: 'qwen3.6-35b',
  created_at: '2026-09-08T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
  citations: [],
  provenance: {
    ...NOTE_RESPONSE.provenance,
    origin_kind: 'chat',
    destination_kind: 'insight',
  },
}

describe('saveResultFromResult（RWV2-22 客户端契约）', () => {
  beforeEach(() => {
    calls.length = 0
  })
  afterEach(() => {
    delete apiClient.defaults.adapter
    vi.clearAllMocks()
  })

  it('POST save-result：路径/方法/头（v1 + 确定性幂等键）/body', async () => {
    installAdapter(() => ({ status: 201, data: NOTE_RESPONSE }))
    const request = {
      origin_kind: 'search' as const,
      origin_id: 'gen_abc123',
      destination_kind: 'note' as const,
    }
    const saved = await saveResultFromResult(P, request)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.method).toBe('POST')
    expect(call.url).toBe('/v1/research/projects/p1/save-result')
    expect(call.data).toEqual(request)
    expect(call.headers['Idempotency-Key']).toBe(
      saveIdempotencyKey(P, 'search', 'gen_abc123', 'note'),
    )
    expect(call.headers['X-Research-Contract']).toBe('v1')
    expect(saved).toMatchObject({ note_id: 'note_digest1', note_type: 'human' })
    expect('insight_id' in saved).toBe(false)
  })

  it('显式 idempotencyKey 覆盖确定性键（幂等重放测试/调用方控制）', async () => {
    installAdapter(() => ({ status: 200, data: NOTE_RESPONSE }))
    await saveResultFromResult(P, {
      origin_kind: 'chat',
      origin_id: 'gen_xyz',
      destination_kind: 'note',
    }, { idempotencyKey: 'explicit-key' })
    expect(calls[0].headers['Idempotency-Key']).toBe('explicit-key')
  })

  it('title 空白时不发送 title 字段（服务端用 origin 派生/缺省）', async () => {
    installAdapter(() => ({ status: 201, data: NOTE_RESPONSE }))
    await saveResultFromResult(P, {
      origin_kind: 'transformation',
      origin_id: 'gen_abc',
      destination_kind: 'note',
      title: '   ',
    })
    expect(calls[0].data).toEqual({
      origin_kind: 'transformation',
      origin_id: 'gen_abc',
      destination_kind: 'note',
    })
  })

  it('insight 响应按 insight_id 判别', async () => {
    installAdapter(() => ({ status: 201, data: INSIGHT_RESPONSE }))
    const saved = await saveResultFromResult(P, {
      origin_kind: 'chat',
      origin_id: 'gen_xyz',
      destination_kind: 'insight',
    })
    expect('insight_id' in saved).toBe(true)
    expect(saved).toMatchObject({ insight_id: 'insight_digest2', insight_type: 'ai' })
  })
})
