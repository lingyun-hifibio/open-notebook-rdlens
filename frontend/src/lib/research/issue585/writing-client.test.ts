/**
 * Issue #1048 PR7：写作传输适配层测试。
 *
 * 覆盖：写作提交以 11 键冻结请求走 `openResearchWritingStream`（不自行拼
 * 聊天字段）、会话创建解析/同 id 语义、读投影严格解析（受限/缺失/多余键）、
 * 错误归一化、结果消息定位。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResearchSseEvent } from '@/lib/research/types'
import type { WritingContextProjection } from './writing-types'

const apiMocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  openResearchWritingStream: vi.fn(),
  buildResearchUrl: vi.fn(
    (projectId: string, path: string) => `/v1/research/projects/${projectId}${path}`,
  ),
  getResearchChatSession: vi.fn(),
  getSourceChatSession: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    createChatSession: apiMocks.createChatSession,
    openResearchWritingStream: apiMocks.openResearchWritingStream,
    buildResearchUrl: apiMocks.buildResearchUrl,
    getResearchChatSession: apiMocks.getResearchChatSession,
    getSourceChatSession: apiMocks.getSourceChatSession,
  }
})

const clientMocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>()
  return {
    ...actual,
    apiClient: { ...actual.apiClient, get: clientMocks.get },
  }
})

import {
  createWritingSession,
  getWritingContext,
  locateWritingResultMessage,
  normalizeWritingApiError,
  normalizeWritingHttpFailure,
  parseWritingContextProjection,
  resolveWritingResultMessage,
  submitWritingSubmission,
  writingOwnerUserId,
  writingResponseLanguage,
} from './writing-client'
import type { WritingSubmissionRequest } from './writing-types'

const DOC = {
  note_id: 'note_abc',
  revision: 4,
  snapshot_hash: 'a'.repeat(64),
  selection: { kind: 'range', start_utf16: 0, end_utf16: 3 },
} as const

const REQUEST: WritingSubmissionRequest = {
  schema_version: 1,
  editor_revision: 5,
  draft_token: 'draft_a',
  editor_intent_hash: 'b'.repeat(64),
  writing_intent_hash: 'c'.repeat(64),
  query: '请改写选段',
  model: 'm-local',
  response_language: 'zh',
  work_purpose: 'writing',
  document_context: DOC,
  history_mode: 'none',
}

function projection(overrides: Partial<WritingContextProjection> = {}): WritingContextProjection {
  return {
    generation_id: 'gen_1',
    input_id: 'inp_' + 'd'.repeat(64),
    input_schema_version: 4,
    input_hash: 'e'.repeat(64),
    document_context: {
      note_id: 'note_abc',
      revision: 4,
      snapshot_hash: 'a'.repeat(64),
      selection_kind: 'range',
      start_utf16: 0,
      end_utf16: 3,
      selected_text: 'ABC',
      selected_text_hash: 'f'.repeat(64),
    },
    history: {
      mode: 'current',
      adopted: [
        {
          message_id: 'msg_1',
          role: 'user',
          text: '之前的问题',
          text_hash: '1'.repeat(64),
        },
      ],
      excluded: [
        {
          message_id: 'msg_2',
          reason: 'history_budget_excluded',
        },
      ],
    },
    integrity: {
      document_context_hash: '2'.repeat(64),
      history_hash: '3'.repeat(64),
      envelope_hash: '4'.repeat(64),
    },
    capacity: {
      input_utf8_bytes: 100,
      envelope_utf8_bytes: 120,
      limit_utf8_bytes: 1048576,
    },
    writing_checks: {
      version: 1,
      missing_binding_ids: ['bind_1'],
      unavailable_reason: null,
    },
    access_state: 'visible',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('submitWritingSubmission：写作 11 键请求', () => {
  it('以 writing 协议/会话路径/冻结请求提交，并透传回调与中止函数', () => {
    const abort = vi.fn()
    apiMocks.openResearchWritingStream.mockReturnValue(abort)
    const onEvent = vi.fn<(event: ResearchSseEvent) => void>()
    const onAcceptReceipt = vi.fn()
    const returned = submitWritingSubmission({
      projectId: 'p_demo',
      sessionRef: {
        domain: 'research',
        kind: 'source',
        projectId: 'p_demo',
        sessionId: 'sess_a',
        sourceId: 'src_1',
      },
      request: REQUEST,
      idempotencyKey: 'w1_key',
      onEvent,
      onAcceptReceipt,
    })
    expect(returned).toBe(abort)
    expect(apiMocks.openResearchWritingStream).toHaveBeenCalledTimes(1)
    const options = apiMocks.openResearchWritingStream.mock.calls[0][0]
    expect(options.protocol).toBe('research-writing-v1')
    expect(options.projectId).toBe('p_demo')
    expect(options.request).toBe(REQUEST)
    expect(options.idempotencyKey).toBe('w1_key')
    expect(options.sessionRef.sessionId).toBe('sess_a')
    expect(options.onEvent).toBe(onEvent)
    expect(options.onAcceptReceipt).toBe(onAcceptReceipt)
  })
})

describe('createWritingSession：客户端预生成 id 的创建响应校验', () => {
  const input = {
    projectId: 'p_demo',
    sessionId: 'sess_client_1',
    kind: 'global' as const,
    sourceId: null,
  }
  const validResponse = {
    session_ref: {
      domain: 'research',
      kind: 'global',
      project_id: 'p_demo',
      session_id: 'sess_client_1',
      source_id: null,
    },
    editor_revision: 0,
    editor_state: null,
    state_warnings: [],
    created: true,
    editor_intent_hash: null,
  }

  it('合法 create_response → ok 并返回会话身份', async () => {
    apiMocks.createChatSession.mockResolvedValue(validResponse)
    const result = await createWritingSession(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ref.sessionId).toBe('sess_client_1')
    expect(result.created).toBe(true)
    expect(apiMocks.createChatSession).toHaveBeenCalledWith('p_demo', {
      kind: 'global',
      sourceId: null,
      sessionId: 'sess_client_1',
    })
  })

  it('同 id 重试返回 created=false 也是同一会话（禁止重复创建）', async () => {
    apiMocks.createChatSession.mockResolvedValue({ ...validResponse, created: false })
    const result = await createWritingSession(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toBe(false)
    expect(result.ref.sessionId).toBe('sess_client_1')
  })

  it('session_ref 不一致/多余键 → invalid_response（不冒充成功）', async () => {
    apiMocks.createChatSession.mockResolvedValue({
      ...validResponse,
      session_ref: { ...validResponse.session_ref, session_id: 'sess_other' },
    })
    const mismatched = await createWritingSession(input)
    expect(mismatched.ok).toBe(false)
    if (mismatched.ok) return
    expect(mismatched.error.code).toBe('invalid_response')

    apiMocks.createChatSession.mockResolvedValue({ ...validResponse, extra: true })
    const extra = await createWritingSession(input)
    expect(extra.ok).toBe(false)
  })

  it('传输失败归一化为写作错误码', async () => {
    apiMocks.createChatSession.mockRejectedValue({
      response: { status: 403, data: { detail: { code: 'chat_owner_required' } } },
    })
    const result = await createWritingSession(input)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('chat_owner_required')
  })
})

describe('getWritingContext / 读投影解析', () => {
  it('合法投影（含 writing_checks 缺失集）→ ok', async () => {
    clientMocks.get.mockResolvedValue({ data: projection() })
    const result = await getWritingContext('p_demo', 'gen_1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.projection.writing_checks?.missing_binding_ids).toEqual(['bind_1'])
    expect(
      clientMocks.get.mock.calls[0][0],
    ).toBe('/v1/research/projects/p_demo/writing-contexts/gen_1')
  })

  it('受限投影只能带 null 正文；带正文 → invalid_response', () => {
    const restricted = projection({
      access_state: 'restricted',
      document_context: {
        ...projection().document_context,
        selected_text: null,
      },
      history: {
        mode: 'current',
        adopted: [{ message_id: 'msg_1', role: 'user', text: null, text_hash: '1'.repeat(64) }],
        excluded: [],
      },
    })
    expect(parseWritingContextProjection(restricted).ok).toBe(true)

    const leaked = projection({
      access_state: 'restricted',
      history: {
        mode: 'none',
        adopted: [{ message_id: 'msg_1', role: 'user', text: '泄漏正文', text_hash: '1'.repeat(64) }],
        excluded: [],
      },
    })
    expect(parseWritingContextProjection(leaked).ok).toBe(false)
  })

  it('缺失/多余键、writing_checks 畸形 → invalid_response', () => {
    const valid = projection()
    expect(parseWritingContextProjection({ ...valid, extra: 1 }).ok).toBe(false)
    const { capacity: _capacity, ...missing } = valid
    void _capacity
    expect(parseWritingContextProjection(missing).ok).toBe(false)
    expect(
      parseWritingContextProjection({
        ...valid,
        writing_checks: { version: 2, missing_binding_ids: [], unavailable_reason: null },
      }).ok,
    ).toBe(false)
    expect(
      parseWritingContextProjection({
        ...valid,
        history: { mode: 'none', adopted: [], excluded: [{ message_id: 'm', reason: 'other' }] },
      }).ok,
    ).toBe(false)
    expect(
      parseWritingContextProjection({ ...valid, writing_checks: null }).ok,
    ).toBe(true)
    expect(
      parseWritingContextProjection({
        ...valid,
        writing_checks: { version: 1, missing_binding_ids: [], unavailable_reason: 'store_missing' },
      }).ok,
    ).toBe(true)
  })

  it('GET 失败 → 归一化错误码', async () => {
    clientMocks.get.mockRejectedValue({
      response: { status: 404, data: { detail: { code: 'session_not_found' } } },
    })
    const result = await getWritingContext('p_demo', 'gen_1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('session_not_found')
  })
})

describe('错误归一化', () => {
  it('422 context_limit_exceeded / 409 writing_context_changed / 503 → 稳定码', () => {
    expect(
      normalizeWritingApiError({
        response: {
          status: 422,
          data: { detail: { code: 'context_limit_exceeded', retryable: false } },
        },
      }),
    ).toMatchObject({ code: 'context_limit_exceeded', retryable: false, status: 422 })
    expect(
      normalizeWritingApiError({
        response: { status: 409, data: { detail: { code: 'writing_context_changed' } } },
      }).code,
    ).toBe('writing_context_changed')
    expect(
      normalizeWritingApiError({
        response: { status: 503, data: { detail: { code: 'writing_input_unavailable' } } },
      }),
    ).toMatchObject({ code: 'writing_input_unavailable', retryable: true })
    expect(normalizeWritingApiError(new Error('boom')).code).toBe('network_error')
    expect(
      normalizeWritingApiError({
        response: { status: 500, data: null },
      }),
    ).toMatchObject({ code: 'unknown_error', retryable: true })
  })

  it('未知 422/409/403 不再冒充容量/上下文变化：归一到通用码', () => {
    expect(
      normalizeWritingApiError({
        response: {
          status: 422,
          data: { detail: { code: 'some_new_422_code', retryable: false } },
        },
      }),
    ).toMatchObject({ code: 'invalid_request', retryable: false, status: 422 })
    expect(
      normalizeWritingApiError({
        response: { status: 409, data: { detail: { code: 'new_conflict' } } },
      }),
    ).toMatchObject({ code: 'conflict', status: 409 })
    expect(
      normalizeWritingApiError({
        response: { status: 403, data: { detail: { message: 'denied' } } },
      }),
    ).toMatchObject({ code: 'access_denied', status: 403 })
    // host 写作入口契约头拒绝：422 + session_contract_unsupported 稳定码。
    expect(
      normalizeWritingApiError({
        response: {
          status: 422,
          data: { detail: { code: 'session_contract_unsupported' } },
        },
      }),
    ).toMatchObject({ code: 'session_contract_unsupported', status: 422 })
    // 409 稳定码 session_busy 保留 retryable。
    expect(
      normalizeWritingApiError({
        response: {
          status: 409,
          data: { detail: { code: 'session_busy', retryable: true } },
        },
      }),
    ).toMatchObject({ code: 'session_busy', retryable: true, status: 409 })
  })

  it('共享传输层归一化 normalizeWritingHttpFailure 与 axios 路径一致', () => {
    expect(
      normalizeWritingHttpFailure(422, {
        detail: { code: 'session_contract_unsupported', retryable: false },
      }),
    ).toMatchObject({ code: 'session_contract_unsupported', status: 422 })
    expect(normalizeWritingHttpFailure(422, { detail: { code: 'x' } })).toMatchObject({
      code: 'invalid_request',
    })
    expect(normalizeWritingHttpFailure(503, null)).toMatchObject({
      code: 'writing_input_unavailable',
      retryable: true,
    })
  })
})

describe('结果消息定位（按 generation_id 精确匹配耐久 message_id）', () => {
  /**
   * host headed chat 投递的确定性 id 规则：
   * `msg_{generation_id}_assistant` / `msg_{generation_id}_user`
   * （`chat/delivery.py`）。
   */
  const detail = {
    session: {
      session_id: 'sess_a',
      title: null,
    },
    messages: [
      { message_id: 'msg_gen_1_user', role: 'user' as const, content: '请改写' },
      { message_id: 'msg_gen_1_assistant', role: 'assistant' as const, content: '改写结果' },
      // 同正文的其它轮次：按 generation 定位不得误取。
      { message_id: 'msg_gen_0_assistant', role: 'assistant' as const, content: '改写结果' },
      { message_id: 'msg_gen_1_assistant_dup', role: 'assistant' as const, content: '其它回答' },
    ],
    cards: [],
    next_cursor: null,
  }

  it('按 generation_id 返回对应 assistant/user；同正文重复轮次不影响', () => {
    expect(resolveWritingResultMessage(detail, '改写结果', 'gen_1')).toEqual({
      ok: true,
      messageId: 'msg_gen_1_assistant',
      content: '改写结果',
      userMessageId: 'msg_gen_1_user',
    })
  })

  it('generation 缺失 → no_generation（不按正文猜）', () => {
    expect(resolveWritingResultMessage(detail, '改写结果', null)).toEqual({
      ok: false,
      reason: 'no_generation',
    })
  })

  it('generation 对应消息不存在 → not_found', () => {
    expect(resolveWritingResultMessage(detail, '改写结果', 'gen_missing')).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('generation 对应消息正文不一致 → content_mismatch（不回退按正文搜索）', () => {
    expect(resolveWritingResultMessage(detail, '改写结果', 'gen_x')).toEqual({
      ok: false,
      reason: 'not_found',
    })
    const mismatchDetail = {
      ...detail,
      messages: [
        {
          message_id: 'msg_gen_x_assistant',
          role: 'assistant' as const,
          content: '别的正文',
        },
      ],
    }
    expect(resolveWritingResultMessage(mismatchDetail, '改写结果', 'gen_x')).toEqual({
      ok: false,
      reason: 'content_mismatch',
    })
  })

  it('locateWritingResultMessage 读取会话详情（desc 尾部窗口）并按 generation 定位', async () => {
    apiMocks.getResearchChatSession.mockResolvedValue(detail)
    const located = await locateWritingResultMessage(
      'p_demo',
      {
        domain: 'research',
        kind: 'global',
        projectId: 'p_demo',
        sessionId: 'sess_a',
        sourceId: null,
      },
      'gen_1',
      '改写结果',
    )
    expect(located.ok).toBe(true)
    expect(apiMocks.getResearchChatSession).toHaveBeenCalledWith('p_demo', 'sess_a', {
      order: 'desc',
      limit: 50,
    })
    expect(apiMocks.getSourceChatSession).not.toHaveBeenCalled()
  })

  it('source 会话使用 getSourceChatSession 定位（全局详情对 source 会话 404）', async () => {
    apiMocks.getSourceChatSession.mockResolvedValue(detail)
    const located = await locateWritingResultMessage(
      'p_demo',
      {
        domain: 'research',
        kind: 'source',
        projectId: 'p_demo',
        sessionId: 'sess_src',
        sourceId: 'src_1',
      },
      'gen_1',
      '改写结果',
    )
    expect(located.ok).toBe(true)
    expect(apiMocks.getSourceChatSession).toHaveBeenCalledWith(
      'p_demo',
      'src_1',
      'sess_src',
      { order: 'desc', limit: 50 },
    )
    expect(apiMocks.getResearchChatSession).not.toHaveBeenCalled()
  })

  it('source 会话缺少 sourceId → not_found（不退回全局接口）', async () => {
    const located = await locateWritingResultMessage(
      'p_demo',
      {
        domain: 'research',
        kind: 'source',
        projectId: 'p_demo',
        sessionId: 'sess_src',
        sourceId: null,
      },
      'gen_1',
      '改写结果',
    )
    expect(located).toEqual({ ok: false, reason: 'not_found' })
    expect(apiMocks.getResearchChatSession).not.toHaveBeenCalled()
  })
})

describe('语言与 owner 映射', () => {
  it('response_language 只接受 zh/en', () => {
    expect(writingResponseLanguage('zh-CN')).toBe('zh')
    expect(writingResponseLanguage('zh-TW')).toBe('zh')
    expect(writingResponseLanguage('ja-JP')).toBe('en')
    expect(writingResponseLanguage(null)).toBe('en')
  })

  it('owner_user_id 必须是正整数', () => {
    expect(writingOwnerUserId('42')).toBe(42)
    expect(writingOwnerUserId('0')).toBeNull()
    expect(writingOwnerUserId('-1')).toBeNull()
    expect(writingOwnerUserId('abc')).toBeNull()
    expect(writingOwnerUserId(null)).toBeNull()
  })
})
