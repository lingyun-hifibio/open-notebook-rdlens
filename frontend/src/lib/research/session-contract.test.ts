import { describe, expect, it } from 'vitest'
import {
  CLIENT_ERROR_CODES,
  DETAIL_MESSAGE_MAX,
  SESSION_AUTH_ERROR_CODES,
  SESSION_CONTRACT_HEADER,
  SESSION_CONTRACT_VERSION,
  SESSION_LIST_MAX_ITEMS,
  SESSION_SERVER_ERROR_CODES,
  degradedCapabilities,
  deriveDetailSessionVisibility,
  parseCapabilities,
  parseEditorResponse,
  parseEditorState,
  parseListResponse,
  parseSaveResponse,
  parseSessionError,
  parseSessionRef,
  parseSubmissionResponse,
  projectMessage,
  projectRestrictedMessage,
  projectSessionVisibility,
  sessionKey,
} from './session-contract'

/**
 * 第三批 PR-1：会话契约校验与投影（DESIGN §3.3/§4.2/§4.6，第一批 rev6）。
 *
 * 证据级别：simulated（纯函数 + 冻结契约示例；未接真实服务端）。
 */

const HASH = 'a'.repeat(64)

const globalRef = {
  domain: 'research',
  kind: 'global',
  project_id: 'proj_1',
  session_id: 'sess_a',
  source_id: null,
}

const sourceRef = {
  domain: 'research',
  kind: 'source',
  project_id: 'proj_1',
  session_id: 'sess_a',
  source_id: 'src_a',
}

const globalEditorState = {
  schema_version: 1,
  base_scope: { mode: 'all', source_ids: [], single_source_id: null },
  single_source_id: null,
  note_ids: [],
  draft: { text: 'hello', token: 'draft_a' },
  chat_anchor: null,
  reader_anchor: null,
}

const capabilities = {
  sessions: {
    contract: SESSION_CONTRACT_VERSION,
    editor_ready: true,
    submission_ready: { global: true, source: false },
  },
}

describe('session-contract: 类型/键/能力（02 §3–§6）', () => {
  it('协议头与契约版本是冻结常量', () => {
    expect(SESSION_CONTRACT_HEADER).toBe('X-Research-Session-Contract')
    expect(SESSION_CONTRACT_VERSION).toBe('research-session-v1')
    expect(SESSION_LIST_MAX_ITEMS).toBe(100)
    expect(DETAIL_MESSAGE_MAX).toBe(100)
    expect(CLIENT_ERROR_CODES).toEqual({
      invalidResponse: 'invalid_response',
      positionUnavailable: 'position_unavailable',
    })
  })

  it('sessionKey 按段编码，空 source 显式空段（不产生歧义）', () => {
    expect(sessionKey({ domain: 'research', kind: 'global', projectId: 'p 1', sessionId: 's/1', sourceId: null })).toBe(
      'research.v1|p%201|global||s%2F1',
    )
    expect(sessionKey({ domain: 'research', kind: 'source', projectId: 'p1', sessionId: 's', sourceId: 'src 1' })).toBe(
      'research.v1|p1|source|src%201|s',
    )
  })

  it('parseSessionRef 严格拒绝：额外字段、global 带 source、source 空、非法 id', () => {
    expect(parseSessionRef(globalRef).ok).toBe(true)
    expect(parseSessionRef(sourceRef).ok).toBe(true)
    expect(parseSessionRef({ ...globalRef, project_id: '' }).ok).toBe(false)
    expect(parseSessionRef({ ...globalRef, session_id: 'a/b' }).ok).toBe(false)
    expect(parseSessionRef({ ...globalRef, source_id: 'src_a' }).ok).toBe(false)
    expect(parseSessionRef({ ...sourceRef, source_id: null }).ok).toBe(false)
    expect(parseSessionRef({ ...globalRef, extra: true }).ok).toBe(false)
    expect(parseSessionRef({ ...globalRef, domain: 'other' }).ok).toBe(false)
  })

  it('parseCapabilities fail-closed 降级（缺失/非法/契约不符都不抛错）', () => {
    expect(parseCapabilities(capabilities)).toMatchObject({
      contract: SESSION_CONTRACT_VERSION,
      editorReady: true,
      submissionReady: { global: true, source: false },
      degraded: false,
      reason: null,
    })
    for (const bad of [undefined, null, 'x', {}, { sessions: {} }, { sessions: { ...capabilities.sessions, editor_ready: 'yes' } }]) {
      const parsed = parseCapabilities(bad)
      expect(parsed.degraded).toBe(true)
      expect(parsed.editorReady).toBe(false)
      expect(parsed.submissionReady).toEqual({ global: false, source: false })
    }
    expect(parseCapabilities({ sessions: { ...capabilities.sessions, contract: 'v0' } })).toMatchObject({
      degraded: true,
      reason: 'contract_unsupported',
    })
    expect(degradedCapabilities('missing')).toMatchObject({ contract: null, degraded: true, reason: 'missing' })
  })
})

describe('session-contract: list_response', () => {
  const listItem = (ref: Record<string, unknown>, visibility: string, title: string | null = 'Title') => ({
    session_ref: ref,
    title,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    record_visibility: visibility,
    has_draft: null,
  })

  const response = (items: unknown[]) => ({
    items,
    next_cursor: null,
    viewer_user_id: 42,
    capabilities,
  })

  it('解析合法列表：两项、viewer 正整数、能力透传', () => {
    const parsed = parseListResponse(response([listItem(globalRef, 'visible'), listItem(sourceRef, 'restricted')]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.viewerUserId).toBe(42)
    expect(parsed.value.items).toHaveLength(2)
    expect(parsed.value.items[0].visibility).toBe('visible')
    expect(parsed.value.items[0].legacy).toBe(false)
    expect(parsed.value.items[0].visibilityDegraded).toBe(false)
    expect(parsed.value.items[1].visibility).toBe('restricted')
    expect(parsed.value.capabilities.editorReady).toBe(true)
  })

  it('拒绝：viewer_user_id 非正整数、items 超 100、额外字段、非法可见性', () => {
    expect(parseListResponse({ ...response([]), viewer_user_id: 0 }).ok).toBe(false)
    expect(parseListResponse({ ...response([]), viewer_user_id: 1.5 }).ok).toBe(false)
    expect(parseListResponse(response(new Array(101).fill(listItem(globalRef, 'visible')))).ok).toBe(false)
    expect(parseListResponse({ ...response([]), extra: 1 }).ok).toBe(false)
    expect(parseListResponse(response([listItem(globalRef, 'secret')])).ok).toBe(false)
  })

  it('legacy_session（无 session_ref）走降级路径：kind 固定 global、projectId 空、标记 degraded', () => {
    const legacy = {
      session_id: 'sess_legacy',
      title: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    }
    const parsed = parseListResponse(response([legacy]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.items[0]).toMatchObject({
      legacy: true,
      visibility: null,
      visibilityDegraded: true,
      ref: { kind: 'global', projectId: '', sessionId: 'sess_legacy', sourceId: null },
    })
  })
})

describe('session-contract: editor_response / save_response', () => {
  it('parseEditorState 接受 global 形状并投影 camelCase', () => {
    const parsed = parseEditorState(globalEditorState, 'global')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toMatchObject({
      kind: 'global',
      schemaVersion: 1,
      baseScope: { mode: 'all', sourceIds: [] },
      draft: { text: 'hello', token: 'draft_a' },
      chatAnchor: null,
      readerAnchor: null,
    })
  })

  it('parseEditorState 施加 kind 约束：source 要求 base_scope=null、single_source_id=null、note_ids 空', () => {
    const sourceState = {
      ...globalEditorState,
      base_scope: null,
      single_source_id: null,
      note_ids: [],
    }
    expect(parseEditorState(sourceState, 'source').ok).toBe(true)
    expect(parseEditorState(sourceState, 'global').ok).toBe(false)
    expect(parseEditorState(globalEditorState, 'source').ok).toBe(false)
    expect(parseEditorState({ ...globalEditorState, schema_version: 2 }, 'global').ok).toBe(false)
    expect(
      parseEditorState({ ...globalEditorState, note_ids: ['a', 'a'] }, 'global').ok,
    ).toBe(false)
  })

  it('parseEditorResponse：editor_state 可读 ⇔ hash 必填且无 unreadable 警告', () => {
    const readable = {
      session_ref: globalRef,
      editor_revision: 3,
      editor_state: globalEditorState,
      state_warnings: [],
      editor_intent_hash: HASH,
      viewer_user_id: 42,
      capabilities,
    }
    const parsed = parseEditorResponse(readable)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.editorRevision).toBe(3)
      expect(parsed.value.editorIntentHash).toBe(HASH)
      expect(parsed.value.editorState?.draft.token).toBe('draft_a')
    }
    // null state 必须 hash null 且带 warning
    expect(parseEditorResponse({ ...readable, editor_state: null, editor_intent_hash: null, state_warnings: ['editor_state_unreadable'] }).ok).toBe(true)
    expect(parseEditorResponse({ ...readable, editor_state: null, editor_intent_hash: null, state_warnings: [] }).ok).toBe(false)
    expect(parseEditorResponse({ ...readable, editor_state: null, editor_intent_hash: HASH, state_warnings: ['editor_state_unreadable'] }).ok).toBe(false)
    // 非 null 但 hash 缺失/非法 → 拒绝
    expect(parseEditorResponse({ ...readable, editor_intent_hash: null }).ok).toBe(false)
    expect(parseEditorResponse({ ...readable, editor_intent_hash: 'A'.repeat(64) }).ok).toBe(false)
    // unreadable 警告不得伴随可读 state
    expect(parseEditorResponse({ ...readable, state_warnings: ['editor_state_unreadable'] }).ok).toBe(false)
  })

  it('parseSaveResponse：mutation_id 与 saved_at 形状校验', () => {
    const save = {
      session_ref: globalRef,
      editor_revision: 4,
      editor_state: globalEditorState,
      mutation_id: 'mut_1',
      saved_at: '2026-10-02T00:00:00Z',
      editor_intent_hash: HASH,
    }
    const parsed = parseSaveResponse(save)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.mutationId).toBe('mut_1')
    expect(parseSaveResponse({ ...save, mutation_id: 'bad id' }).ok).toBe(false)
    expect(parseSaveResponse({ ...save, saved_at: 'not-a-date' }).ok).toBe(false)
    expect(parseSaveResponse({ ...save, editor_state: null }).ok).toBe(true)
  })
})

describe('session-contract: submission_response 状态矩阵', () => {
  const base = {
    session_ref: globalRef,
    draft_token: 'draft_initial',
    idempotency_key: `s1_${'b'.repeat(64)}`,
    acceptance_state: 'not_observed',
    generation_id: null,
    generation_state: null,
    accepted_editor_revision: null,
    editor_intent_hash: null,
    submitted_draft_text: null,
    context_report: null,
  }

  it('not_observed：全部派生字段为 null', () => {
    expect(parseSubmissionResponse(base).ok).toBe(true)
  })

  it('accepted：generation_state ∈ accepted/running/job_queued 且派生字段齐全', () => {
    const accepted = {
      ...base,
      acceptance_state: 'accepted',
      generation_id: 'gen_1',
      generation_state: 'job_queued',
      accepted_editor_revision: 5,
      editor_intent_hash: HASH,
      submitted_draft_text: 'hello',
    }
    const parsed = parseSubmissionResponse(accepted)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toMatchObject({
      acceptanceState: 'accepted',
      generationId: 'gen_1',
      generationState: 'job_queued',
      acceptedEditorRevision: 5,
      submittedDraftText: 'hello',
    })
    expect(parseSubmissionResponse({ ...accepted, generation_state: 'completed' }).ok).toBe(false)
  })

  it('terminal：只接受 completed/failed；outcome_unknown：只接受 outcome_unknown', () => {
    const terminal = {
      ...base,
      acceptance_state: 'terminal',
      generation_id: 'gen_1',
      generation_state: 'failed',
      accepted_editor_revision: 1,
      editor_intent_hash: HASH,
      submitted_draft_text: 'x',
    }
    expect(parseSubmissionResponse(terminal).ok).toBe(true)
    expect(parseSubmissionResponse({ ...terminal, generation_state: 'running' }).ok).toBe(false)
    const unknown = { ...terminal, acceptance_state: 'outcome_unknown', generation_state: 'outcome_unknown' }
    expect(parseSubmissionResponse(unknown).ok).toBe(true)
    expect(parseSubmissionResponse({ ...unknown, generation_state: 'failed' }).ok).toBe(false)
  })

  it('accepted 带完整 context_report：逐字段投影且非法形状被拒绝（review D3）', () => {
    const contextReport = {
      version: 1,
      status: 'trimmed',
      history: { available_turns: 8, included_turns: 5, omitted_turns: 3 },
      evidence: { included_chunks: 4, omitted_chunks: 2 },
      input_budget: 32000,
      serialized_input_tokens: 27890,
      estimator_version: 'est-v1',
      reason_codes: ['history_trimmed', 'budget_trimmed'],
      required_context_missing: false,
      measurement_scope: 'final_reasoning_call',
    }
    const accepted = {
      ...base,
      acceptance_state: 'accepted',
      generation_id: 'gen_ctx',
      generation_state: 'running',
      accepted_editor_revision: 9,
      editor_intent_hash: HASH,
      submitted_draft_text: '带上下文报告',
      context_report: contextReport,
    }
    const parsed = parseSubmissionResponse(accepted)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.contextReport).toEqual({
      version: 1,
      status: 'trimmed',
      history: { availableTurns: 8, includedTurns: 5, omittedTurns: 3 },
      evidence: { includedChunks: 4, omittedChunks: 2 },
      inputBudget: 32000,
      serializedInputTokens: 27890,
      estimatorVersion: 'est-v1',
      reasonCodes: ['history_trimmed', 'budget_trimmed'],
      requiredContextMissing: false,
      measurementScope: 'final_reasoning_call',
    })
    // 非法 context_report 不得静默透传
    expect(
      parseSubmissionResponse({ ...accepted, context_report: { ...contextReport, status: 'bogus' } }).ok,
    ).toBe(false)
    expect(
      parseSubmissionResponse({
        ...accepted,
        context_report: { ...contextReport, measurement_scope: 'bogus' },
      }).ok,
    ).toBe(false)
  })

  it('拒绝矩阵违例：not_observed 带派生值、非 not_observed 缺 hash/text/generation', () => {
    expect(parseSubmissionResponse({ ...base, generation_id: 'gen_1' }).ok).toBe(false)
    const accepted = {
      ...base,
      acceptance_state: 'accepted',
      generation_id: 'gen_1',
      generation_state: 'accepted',
      accepted_editor_revision: 1,
      editor_intent_hash: HASH,
      submitted_draft_text: 'x',
    }
    expect(parseSubmissionResponse({ ...accepted, generation_id: null }).ok).toBe(false)
    expect(parseSubmissionResponse({ ...accepted, editor_intent_hash: 'nope' }).ok).toBe(false)
    expect(parseSubmissionResponse({ ...accepted, submitted_draft_text: null }).ok).toBe(false)
    expect(parseSubmissionResponse({ ...base, acceptance_state: 'bogus' }).ok).toBe(false)
  })
})

describe('session-contract: parseSessionError 稳定码投影', () => {
  const body = (detail: Record<string, unknown>) => ({ detail })

  it('识别服务端稳定码并透传 retryable/request_id/current_revision/session_ref', () => {
    const parsed = parseSessionError(
      409,
      body({
        code: 'editor_revision_conflict',
        message: 'conflict',
        retryable: false,
        request_id: 'req_1',
        current_revision: 7,
        session_ref: globalRef,
      }),
    )
    expect(parsed).toMatchObject({
      status: 409,
      code: 'editor_revision_conflict',
      message: 'conflict',
      retryable: false,
      requestId: 'req_1',
      currentRevision: 7,
      recognized: true,
    })
    expect(parsed.ref?.sessionId).toBe('sess_a')
  })

  it('403 鉴权错误码与 02 §7 稳定码集合一致', () => {
    expect(SESSION_AUTH_ERROR_CODES).toEqual({
      ownerRequired: 'chat_owner_required',
      historyEgressNotAuthorized: 'history_egress_not_authorized',
    })
    expect(SESSION_SERVER_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'chat_owner_required',
        'session_not_found',
        'editor_revision_conflict',
        'session_contract_unsupported',
        'acceptance_outcome_unknown',
        'session_store_unavailable',
      ]),
    )
    expect(new Set(SESSION_SERVER_ERROR_CODES).size).toBe(SESSION_SERVER_ERROR_CODES.length)
  })

  it('缺失/非法 body 回落状态码语义：401→unauthenticated，5xx→retryable，unknown_error', () => {
    expect(parseSessionError(401, null)).toMatchObject({
      code: 'unauthenticated',
      retryable: false,
      recognized: false,
      requestId: null,
    })
    expect(parseSessionError(503, {})).toMatchObject({
      code: 'unknown_error',
      retryable: true,
      recognized: false,
    })
    expect(parseSessionError(400, body({ code: 'bogus_code', message: 'm' }))).toMatchObject({
      code: 'bogus_code',
      recognized: false,
    })
    // 非法 session_ref 不使整个投影失败，只丢 ref
    expect(parseSessionError(404, body({ code: 'session_not_found', session_ref: { bad: true } })).ref).toBeNull()
  })
})

describe('session-contract: 可见性投影（§4.6；评审 M5 补充用例）', () => {
  it('用例 1：列表 visible + 详情 restricted → 取更严 restricted', () => {
    expect(projectSessionVisibility('visible', 'restricted')).toMatchObject({
      visibility: 'restricted',
      degraded: false,
      source: 'detail',
      restrictedBy: 'detail',
    })
    // restricted 文案不得显示标题、不得渲染正文计量以外内容
    const copy = projectRestrictedMessage(projectSessionVisibility('visible', 'restricted'))
    expect(copy).toMatchObject({
      code: 'restricted',
      showsTitle: false,
      canOpen: true,
      onlyNonBodyMetrics: true,
      placeholderKey: 'research.session.visibility.restricted',
    })
  })

  it('用例 2：列表 restricted + 详情单页 visible → 仍 restricted（不得被详情放宽）', () => {
    expect(projectSessionVisibility('restricted', 'visible')).toMatchObject({
      visibility: 'restricted',
      degraded: false,
      source: 'list',
      restrictedBy: 'list',
    })
  })

  it('用例 3：两侧都缺字段 → 返回未知并显式 degraded（仅覆盖降级路径）', () => {
    // 说明：该用例只覆盖「无契约头旧 DTO / 字段缺失」的降级路径，
    // 不是第三批实际请求形状（第三批恒带契约头，字段恒可得）。
    // 若把「缺失才降级」改成无条件占位，本用例必须变红。
    expect(projectSessionVisibility(null, null)).toEqual({
      visibility: null,
      degraded: true,
      source: 'unknown',
      restrictedBy: null,
    })
    expect(projectSessionVisibility(undefined, undefined)).toMatchObject({ visibility: null, degraded: true })
    expect(projectRestrictedMessage(projectSessionVisibility(null, null))).toMatchObject({
      code: 'unknown',
      showsTitle: false,
      canOpen: false,
      placeholderKey: 'research.session.visibility.unknown',
      degraded: true,
    })
  })

  it('单侧缺失：保留已知一侧但标记 degraded；legacy 徽标保留标题', () => {
    expect(projectSessionVisibility(null, 'visible')).toMatchObject({
      visibility: 'visible',
      degraded: true,
      source: 'detail',
    })
    expect(projectSessionVisibility(undefined, 'legacy_context_unverifiable')).toMatchObject({
      visibility: 'legacy_context_unverifiable',
      degraded: true,
      source: 'detail',
    })
    expect(projectRestrictedMessage(projectSessionVisibility('legacy_context_unverifiable', 'visible'))).toMatchObject({
      code: 'legacy_context_unverifiable',
      showsTitle: true,
      badge: 'legacy_unverifiable',
    })
  })

  it('deriveDetailSessionVisibility 只看 assistant、页内任一受限即受限、缺失才未知', () => {
    const messages = [
      { message_id: 'm1', role: 'user', content: 'q', record_visibility: 'visible' },
      { message_id: 'm2', role: 'assistant', content: 'a', record_visibility: 'visible' },
    ]
    expect(deriveDetailSessionVisibility(messages).visibility).toBe('visible')
    expect(
      deriveDetailSessionVisibility([
        ...messages,
        { message_id: 'm3', role: 'assistant', content: 'b', record_visibility: 'restricted' },
      ]).visibility,
    ).toBe('restricted')
    // 没有 assistant 消息 → 未知（不得据此放宽为 visible）
    expect(deriveDetailSessionVisibility([messages[0]]).visibility).toBeNull()
    // assistant 消息缺可见性字段 → 未知
    expect(
      deriveDetailSessionVisibility([{ message_id: 'm1', role: 'assistant', content: 'a' }]).visibility,
    ).toBeNull()
  })

  it('projectMessage：restricted 消息不投影正文，visible 保留', () => {
    expect(
      projectMessage({ message_id: 'm1', role: 'assistant', content: 'secret', record_visibility: 'restricted' }),
    ).toEqual({ messageId: 'm1', role: 'assistant', visibility: 'restricted', content: null, displayable: false, degraded: false })
    expect(
      projectMessage({ message_id: 'm2', role: 'assistant', content: 'ok', record_visibility: 'visible' }),
    ).toMatchObject({ content: 'ok', displayable: true, degraded: false })
    expect(projectMessage({ message_id: 'm3', role: 'assistant', content: 'x' })).toMatchObject({
      visibility: null,
      displayable: true,
    })
  })
})
