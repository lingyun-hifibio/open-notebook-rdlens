import { describe, expect, it } from 'vitest'
import {
  CLIENT_ERROR_CODES,
  DETAIL_MESSAGE_MAX,
  MESSAGE_PROJECTION_D1C,
  MESSAGE_PROJECTION_D1E,
  SELECTION_CONTEXT_KEYS,
  SELECTION_PROJECTION_KEYS,
  SESSION_AUTH_ERROR_CODES,
  SESSION_CONTRACT_HEADER,
  SESSION_CONTRACT_VERSION,
  SESSION_LIST_MAX_ITEMS,
  SESSION_SERVER_ERROR_CODES,
  degradedCapabilities,
  deriveDetailSessionVisibility,
  messageKeyCountMatches,
  parseCapabilities,
  parseEditorResponse,
  parseEditorState,
  parseListResponse,
  parseMessageSelection,
  parseSaveResponse,
  parseSelectionContext,
  parseSelectionProjection,
  parseSessionError,
  observeMessageProjectionVersion,
  parseSessionRef,
  parseSubmissionResponse,
  projectMessage,
  projectRestrictedMessage,
  projectSessionVisibility,
  readMessageWorkPurpose,
  resolveMessageProjectionVersion,
  selectionAsVisibleProjection,
  selectionContextToWire,
  sessionKey,
} from './session-contract'
import { d1eRoundtripReady, readD1eCapability } from './c05-contract'

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


// ---------------------------------------------------------------------------
// Issue #1013（D1-E-2）F12：选段读取影/消息投影版本 + F04 能力 fail-closed
// ---------------------------------------------------------------------------

const SELECTION = {
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  chunk_id: 'chunk_1',
  chunk_ordinal: 2,
  page_idx: 0,
  start_offset: 6,
  end_offset: 11,
  quote: 'world',
  quote_hash: '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7',
  content_hash: HASH,
}

function selectionProjection(overrides: Record<string, unknown> = {}) {
  return {
    ...SELECTION,
    visibility: 'visible',
    reason_code: null,
    ...overrides,
  }
}

describe('Issue #1013 F12：消息投影版本（d1e-message-v4 fail-closed）', () => {
  it('缺头 → legacy；d1c/d1e 精确匹配；未知值 → invalid_response（不猜键集）', () => {
    expect(resolveMessageProjectionVersion(null)).toEqual({ ok: true, value: 'legacy' })
    expect(resolveMessageProjectionVersion('')).toEqual({ ok: true, value: 'legacy' })
    expect(resolveMessageProjectionVersion(MESSAGE_PROJECTION_D1C)).toEqual({
      ok: true,
      value: 'd1c',
    })
    expect(resolveMessageProjectionVersion(MESSAGE_PROJECTION_D1E)).toEqual({
      ok: true,
      value: 'd1e',
    })
    const unknown = resolveMessageProjectionVersion('d1e-message-v5')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe(CLIENT_ERROR_CODES.invalidResponse)
  })

  it('键数：legacy 15 / d1c 17|19 / d1e 16|18|20', () => {
    const record = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]))
    expect(messageKeyCountMatches(record(15), 'legacy')).toBe(true)
    expect(messageKeyCountMatches(record(17), 'd1c')).toBe(true)
    expect(messageKeyCountMatches(record(19), 'd1c')).toBe(true)
    expect(messageKeyCountMatches(record(16), 'd1e')).toBe(true)
    expect(messageKeyCountMatches(record(18), 'd1e')).toBe(true)
    expect(messageKeyCountMatches(record(20), 'd1e')).toBe(true)
    expect(messageKeyCountMatches(record(15), 'd1e')).toBe(false)
    expect(messageKeyCountMatches(record(17), 'd1e')).toBe(false)
    expect(messageKeyCountMatches(null, 'd1e')).toBe(false)
  })

  it('d1e 消息必须有 selection_context 键（缺失 → fail-closed，不猜键集）', () => {
    const without = { message_id: 'm1', role: 'user', content: 'q' }
    const missing = parseMessageSelection(without, 'd1e')
    expect(missing.ok).toBe(false)
    expect(parseMessageSelection({ ...without, selection_context: null }, 'd1e')).toEqual({
      ok: true,
      value: null,
    })
    expect(
      parseMessageSelection({ ...without, selection_context: selectionProjection() }, 'd1e'),
    ).toMatchObject({ ok: true, value: { visibility: 'visible', quote: 'world' } })
  })

  it('legacy/d1c 消息出现 selection_context → invalid_response（版本头不匹配不得容忍）', () => {
    const withKey = { message_id: 'm1', role: 'user', selection_context: null }
    expect(parseMessageSelection(withKey, 'legacy').ok).toBe(false)
    expect(parseMessageSelection(withKey, 'd1c').ok).toBe(false)
    expect(parseMessageSelection({ message_id: 'm1', role: 'user' }, 'legacy')).toEqual({
      ok: true,
      value: null,
    })
  })
})

describe('Issue #1013 F12：选段对象/读投影严格解析', () => {
  it('11 键请求对象：合法通过；未知键/缺键一律 invalid_response', () => {
    expect(parseSelectionContext(SELECTION)).toMatchObject({ ok: true })
    expect(Object.keys(SELECTION).sort()).toEqual([...SELECTION_CONTEXT_KEYS].sort())
    const withVisibility = { ...SELECTION, visibility: 'visible' }
    expect(parseSelectionContext(withVisibility).ok).toBe(false)
    const { quote_hash: _omit, ...missing } = SELECTION
    void _omit
    expect(parseSelectionContext(missing).ok).toBe(false)
  })

  it('限额/布尔/偏移：end-start 必须等于 quote UTF-16 长度；bool 不是 int', () => {
    expect(parseSelectionContext({ ...SELECTION, start_offset: true }).ok).toBe(false)
    expect(parseSelectionContext({ ...SELECTION, end_offset: 10 }).ok).toBe(false)
    expect(parseSelectionContext({ ...SELECTION, end_offset: 6 }).ok).toBe(false)
    expect(
      parseSelectionContext({ ...SELECTION, quote: 'x'.repeat(2001), end_offset: 2001 }),
    ).toMatchObject({ ok: false })
    expect(parseSelectionContext({ ...SELECTION, page_idx: null })).toMatchObject({ ok: true })
    expect(parseSelectionContext({ ...SELECTION, page_idx: -1 }).ok).toBe(false)
  })

  it('13 键读投影：visible/restricted/position_unavailable 语义与 quote 可空规则', () => {
    expect(Object.keys(selectionProjection()).sort()).toEqual([...SELECTION_PROJECTION_KEYS].sort())
    expect(parseSelectionProjection(selectionProjection())).toMatchObject({
      ok: true,
      value: { visibility: 'visible', reasonCode: null, quote: 'world' },
    })
    // restricted：quote/quote_hash 都为 null，reason 必须 content_restricted
    expect(
      parseSelectionProjection(
        selectionProjection({
          visibility: 'restricted',
          reason_code: 'content_restricted',
          quote: null,
          quote_hash: null,
        }),
      ),
    ).toMatchObject({ ok: true, value: { visibility: 'restricted', quote: null, quoteHash: null } })
    // restricted 仍带 quote → 拒绝（不得以哈希/摘录变相确认撤权内容）
    expect(
      parseSelectionProjection(
        selectionProjection({ visibility: 'restricted', reason_code: 'content_restricted' }),
      ).ok,
    ).toBe(false)
    // position_unavailable：保留 quote/quote_hash
    expect(
      parseSelectionProjection(
        selectionProjection({ visibility: 'position_unavailable', reason_code: 'position_unavailable' }),
      ),
    ).toMatchObject({ ok: true, value: { visibility: 'position_unavailable', quote: 'world' } })
    // visible 带 reason / 未知 visibility → 拒绝
    expect(
      parseSelectionProjection(selectionProjection({ reason_code: 'position_unavailable' })).ok,
    ).toBe(false)
    expect(parseSelectionProjection(selectionProjection({ visibility: 'gone' })).ok).toBe(false)
  })

  it('wire 序列化：snake_case 严格 11 键（请求体 additionalProperties:false）', () => {
    const wire = selectionContextToWire({
      sourceId: SELECTION.source_id,
      documentId: SELECTION.document_id,
      documentVersion: SELECTION.document_version,
      chunkId: SELECTION.chunk_id,
      chunkOrdinal: SELECTION.chunk_ordinal,
      pageIdx: SELECTION.page_idx,
      startOffset: SELECTION.start_offset,
      endOffset: SELECTION.end_offset,
      quote: SELECTION.quote,
      quoteHash: SELECTION.quote_hash,
      contentHash: SELECTION.content_hash,
    })
    expect(Object.keys(wire).sort()).toEqual([...SELECTION_CONTEXT_KEYS].sort())
    expect(parseSelectionContext(wire)).toMatchObject({ ok: true })
    expect(selectionAsVisibleProjection({
      sourceId: SELECTION.source_id,
      documentId: SELECTION.document_id,
      documentVersion: SELECTION.document_version,
      chunkId: SELECTION.chunk_id,
      chunkOrdinal: SELECTION.chunk_ordinal,
      pageIdx: SELECTION.page_idx,
      startOffset: SELECTION.start_offset,
      endOffset: SELECTION.end_offset,
      quote: SELECTION.quote,
      quoteHash: SELECTION.quote_hash,
      contentHash: SELECTION.content_hash,
    })).toMatchObject({ visibility: 'visible', reasonCode: null })
  })

  it('新增 9 个稳定错误码进入会话错误码集合（未知码仍回落 generic）', () => {
    for (const code of [
      'd1e_contract_not_enabled',
      'd1e_submission_required',
      'selection_invalid',
      'selection_position_unavailable',
      'selection_version_unavailable',
      'selection_source_unavailable',
      'selection_source_restricted',
      'source_access_restricted',
      'source_ref_mismatch',
    ]) {
      expect(SESSION_SERVER_ERROR_CODES).toContain(code)
    }
  })
})

describe('Issue #1013 F04：D1-E 能力键 fail-closed', () => {
  it('缺失/畸形/契约不符 → null / ready=false', () => {
    expect(readD1eCapability(undefined)).toBeNull()
    expect(readD1eCapability(null)).toBeNull()
    expect(readD1eCapability({ enabled: true })).toBeNull()
    expect(readD1eCapability({ contract: 'c05-v1', enabled: true })).toBeNull()
    expect(readD1eCapability({ contract: 'd1e-roundtrip-v1', enabled: 'yes' })).toBeNull()
    expect(d1eRoundtripReady(undefined)).toBe(false)
    expect(d1eRoundtripReady({ contract: 'd1e-roundtrip-v1', enabled: false })).toBe(false)
  })

  it('合法声明：enabled=false → 能力块存在但不可用；true → 就绪', () => {
    expect(readD1eCapability({ contract: 'd1e-roundtrip-v1', enabled: false })).toEqual({
      contract: 'd1e-roundtrip-v1',
      enabled: false,
    })
    expect(d1eRoundtripReady({ contract: 'd1e-roundtrip-v1', enabled: true })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RDLens #1151：详情响应头观察——跨域不可读 ≠ frozen legacy 15 键投影
// ---------------------------------------------------------------------------

describe('#1151 投影头观察：头缺失/不可读 → 未知（不得降级为 legacy）', () => {
  const headersWith = (value: string | null) => ({ get: () => value })

  /** 生产 d1e-message-v4 的 20 键助手行（2026-11-09 目标环境实测键集）。 */
  const PRODUCTION_ROW_KEYS = [
    'message_id', 'role', 'resolved_mode', 'degradation_reasons',
    'background_generation_id', 'generation_id', 'created_at',
    'record_visibility', 'content', 'thinking', 'citations', 'source_ref',
    'usage', 'context_coverage', 'context_report', 'work_purpose',
    'work_purpose_source', 'verification', 'evidence_degraded',
    'selection_context',
  ] as const

  function productionAssistantRow(): Record<string, unknown> {
    const row: Record<string, unknown> = Object.fromEntries(
      PRODUCTION_ROW_KEYS.map((key) => [key, null]),
    )
    return {
      ...row,
      message_id: 'msg_gen_prod_assistant',
      role: 'assistant',
      content: '答案',
      citations: [],
      work_purpose: 'exploration',
      work_purpose_source: 'inferred',
    }
  }

  it('头缺失（CORS 未暴露/旧传输）→ null 未知态，不是 legacy', () => {
    expect(observeMessageProjectionVersion(headersWith(null))).toBeNull()
    expect(observeMessageProjectionVersion(headersWith(''))).toBeNull()
    expect(observeMessageProjectionVersion(null)).toBeNull()
    expect(observeMessageProjectionVersion(undefined)).toBeNull()
  })

  it('可读头 → 精确版本；未知版本串 → null（fail-closed，不猜键集）', () => {
    expect(observeMessageProjectionVersion(headersWith(MESSAGE_PROJECTION_D1C))).toBe('d1c')
    expect(observeMessageProjectionVersion(headersWith(MESSAGE_PROJECTION_D1E))).toBe('d1e')
    expect(observeMessageProjectionVersion(headersWith('d1e-message-v5'))).toBeNull()
  })

  it('未知态读生产 20 键行：purpose 两键仍投影；误判 legacy 才会 not_recorded', () => {
    const row = productionAssistantRow()
    expect(Object.keys(row)).toHaveLength(20)
    expect(
      readMessageWorkPurpose(row, observeMessageProjectionVersion(headersWith(null))),
    ).toEqual({ workPurpose: 'exploration', workPurposeSource: 'inferred' })
    // 对照（修复前行为）：头不可读被当成 legacy → 20 键形状不符 → 未记录。
    expect(readMessageWorkPurpose(row, 'legacy')).toEqual({
      workPurpose: null,
      workPurposeSource: 'not_recorded',
    })
  })
})
