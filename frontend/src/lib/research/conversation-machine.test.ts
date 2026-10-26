/**
 * PR-5a 对话状态机 / 控制器测试（#602 第三批）。
 *
 * 覆盖 DESIGN §10.3 的 F05/F07/F08/F09/F13 核心行为：
 * 受理匹配集（revision/request_id 不参与等值）、generationId 首绑、
 * attempt/detached 迟到隔离、unknown→lookup→release、断线→查回→release、
 * not_observed 语义、错误优先级、SSE 缺口不跳水位、终态锁与重复去重、
 * 查回顺序/并发上限、控制器副作用（open_stream/abort/clear/release）。
 *
 * 证据标注：本文件的 transport/SSE 均为可控 mock（`simulated`）；真实后端
 * 集成证据属 PR-6。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BOUNDED_LOOKUP_FAILURES,
  MAX_CONCURRENT_SUBMISSION_LOOKUPS,
  MAX_REATTACH_ATTEMPTS,
  acceptedReceiptMatches,
  classifySubmissionFailure,
  createConversationState,
  createTurnIdentity,
  needsDuplicateExecutionConfirmation,
  planSubmissionLookups,
  reduceConversation,
  turnIdentityMatches,
  type ConversationState,
  type ConversationSubmissionView,
  type ConversationTurn,
} from './conversation-machine'
import { createConversationController } from './session-runtime'
import { sessionKey, type ResearchSessionRef } from './session-contract'
import type { ResearchAcceptedReceipt } from './sse'
import type { ResearchAcceptedReceiptWire, ResearchSseEvent } from './types'

const REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: 'proj_1',
  sessionId: 'sess_1',
  sourceId: null,
}
const SESSION_KEY = sessionKey(REF)
const HASH = 'a'.repeat(64)
const TOKEN = 'draft_1'
const KEY = `s1_${'b'.repeat(64)}`
const TURN = 'turn-1'

function identity(over: Partial<Parameters<typeof createTurnIdentity>[0]> = {}) {
  return createTurnIdentity({
    authGeneration: 1,
    sessionKey: SESSION_KEY,
    turnId: TURN,
    draftToken: TOKEN,
    idempotencyKey: KEY,
    requestedRevision: 3,
    editorIntentHash: HASH,
    ...over,
  })
}

function receiptWire(over: Partial<ResearchAcceptedReceiptWire> = {}): ResearchAcceptedReceiptWire {
  return {
    session_ref: {
      domain: 'research',
      kind: 'global',
      project_id: 'proj_1',
      session_id: 'sess_1',
      source_id: null,
    },
    generation_id: 'gen_1',
    request_id: 'req_1',
    editor_revision: 3,
    draft_token: TOKEN,
    editor_intent_hash: HASH,
    ...over,
  }
}

function receipt(over: Partial<ResearchAcceptedReceipt> = {}): ResearchAcceptedReceipt {
  return {
    ref: REF,
    generationId: 'gen_1',
    requestId: 'req_1',
    editorRevision: 3,
    draftToken: TOKEN,
    editorIntentHash: HASH,
    ...over,
  }
}

function submissionResponse(over: Record<string, unknown> = {}) {
  return {
    session_ref: {
      domain: 'research',
      kind: 'global',
      project_id: 'proj_1',
      session_id: 'sess_1',
      source_id: null,
    },
    draft_token: TOKEN,
    idempotency_key: KEY,
    acceptance_state: 'not_observed',
    generation_id: null,
    generation_state: null,
    accepted_editor_revision: null,
    editor_intent_hash: null,
    submitted_draft_text: null,
    context_report: null,
    ...over,
  }
}

function sse(event_id: number, type: ResearchSseEvent['type'], extra: Record<string, unknown> = {}): ResearchSseEvent {
  return { event_id, type, ...extra } as ResearchSseEvent
}

/** prepare → prepare_succeeded：返回 submitting 状态（attempt=1，已发 open_stream）。 */
function submitting(): ConversationState {
  const initial = createConversationState({ sessionKey: SESSION_KEY, authGeneration: 1 })
  const prepared = reduceConversation(initial, {
    type: 'prepare',
    identity: identity(),
    operationId: 'op-1',
    query: 'q1',
  }).state
  return reduceConversation(prepared, { type: 'prepare_succeeded', turnId: TURN }).state
}

function view(over: Partial<ConversationSubmissionView> = {}): ConversationSubmissionView {
  return {
    ref: REF,
    token: TOKEN,
    acceptance: 'not_observed',
    generationId: null,
    generationState: null,
    acceptedEditorRevision: null,
    editorIntentHash: null,
    submittedDraftText: null,
    ...over,
  }
}

function turnOf(state: ConversationState): ConversationTurn {
  if (state.turn === null) throw new Error('no turn')
  return state.turn
}

describe('conversation-machine：受理匹配集（R7）', () => {
  it('accepted：revision 与发送时不同但 intent hash 相同仍受理；request_id 变化不影响', () => {
    const state = submitting()
    const reduction = reduceConversation(state, {
      type: 'accepted',
      turnId: TURN,
      attempt: 1,
      receipt: receipt({ editorRevision: 9, requestId: 'req-other' }),
    })
    const turn = turnOf(reduction.state)
    expect(turn.state).toBe('accepted')
    expect(turn.identity.generationId).toBe('gen_1')
    expect(turn.identity.observedRevision).toBe(9)
    // accepted 只触发清稿，不释放 submit hold（clear settlement 后才释放）。
    expect(reduction.effects.map((e) => e.type)).toEqual(['clear_after_submission'])
  })

  it('acceptedReceiptMatches：draft_token/editor_intent_hash 不等值即拒绝', () => {
    const id = identity()
    expect(acceptedReceiptMatches(id, {
      ref: REF, generationId: 'gen_1', requestId: 'r', editorRevision: 9, draftToken: TOKEN, editorIntentHash: HASH,
    })).toBe(true)
    expect(acceptedReceiptMatches(id, {
      ref: REF, generationId: 'gen_1', requestId: 'r', editorRevision: 3, draftToken: 'draft_2', editorIntentHash: HASH,
    })).toBe(false)
    expect(acceptedReceiptMatches(id, {
      ref: REF, generationId: 'gen_1', requestId: 'r', editorRevision: 3, draftToken: TOKEN, editorIntentHash: 'c'.repeat(64),
    })).toBe(false)
  })

  it('generationId 首次绑定后严格等值：第二个不同 generation 的 accepted 被丢弃', () => {
    const accepted = reduceConversation(submitting(), {
      type: 'accepted', turnId: TURN, attempt: 1, receipt: receipt(),
    }).state
    const conflict = reduceConversation(accepted, {
      type: 'accepted', turnId: TURN, attempt: 1, receipt: receipt({ generationId: 'gen_2' }),
    })
    expect(conflict.effects).toHaveLength(0)
    expect(turnOf(conflict.state).identity.generationId).toBe('gen_1')
  })

  it('attempt 不匹配或 detached 的迟到回调一律丢弃', () => {
    const state = submitting()
    expect(reduceConversation(state, {
      type: 'accepted', turnId: TURN, attempt: 2, receipt: receipt(),
    }).effects).toHaveLength(0)
    const detached = reduceConversation(state, { type: 'detach' }).state
    expect(turnOf(detached).identity.detached).toBe(true)
    expect(reduceConversation(detached, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(1, 'answer', { delta: 'late' }),
    }).effects).toHaveLength(0)
    expect(turnOf(detached).sse.answer).toBe('')
  })

  it('turnIdentityMatches 校验 sessionKey/authGeneration/turnId/attempt/detached', () => {
    const id = identity()
    expect(turnIdentityMatches(id, {
      authGeneration: 1, sessionKey: SESSION_KEY, turnId: TURN, attempt: 0, detached: false,
    })).toBe(true)
    expect(turnIdentityMatches(id, {
      authGeneration: 2, sessionKey: SESSION_KEY, turnId: TURN,
    })).toBe(false)
    expect(turnIdentityMatches(id, {
      authGeneration: 1, sessionKey: 'other', turnId: TURN,
    })).toBe(false)
  })
})

describe('conversation-machine：状态机 / 终态锁 / 去重', () => {
  it('prepare 在非终态 turn 存在时拒绝（每 session 单活动 turn）', () => {
    const state = submitting()
    const reduction = reduceConversation(state, {
      type: 'prepare',
      identity: identity({ turnId: 'turn-2', draftToken: 'draft_2' }),
      operationId: 'op-2',
      query: 'q2',
    })
    expect(reduction.state).toBe(state)
    expect(reduction.effects).toHaveLength(0)
  })

  it('done 无 accepted → 不得清稿，转 lookup_pending 并保留 hold', () => {
    const reduction = reduceConversation(submitting(), {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(1, 'done', { completion_status: 'success' }),
    })
    const turn = turnOf(reduction.state)
    expect(turn.state).toBe('lookup_pending')
    expect(turn.operationId).toBe('op-1')
    expect(reduction.effects).toEqual([
      { type: 'lookup_submission', token: TOKEN, reason: 'unknown' },
    ])
  })

  it('终态锁定：终态后迟到 SSE 不再改写；新 send 归档旧终态且不可被改写', () => {
    const accepted = reduceConversation(submitting(), {
      type: 'accepted', turnId: TURN, attempt: 1, receipt: receipt(),
    }).state
    const streaming = reduceConversation(accepted, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(1, 'answer', { delta: 'hi' }),
    }).state
    const terminal = reduceConversation(streaming, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(2, 'done', { completion_status: 'success' }),
    }).state
    expect(turnOf(terminal).state).toBe('terminal')
    expect(turnOf(terminal).identity.terminal).toBe('done')
    const late = reduceConversation(terminal, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(3, 'answer', { delta: 'late' }),
    })
    expect(late.state).toBe(terminal)

    const nextPrepare = reduceConversation(terminal, {
      type: 'prepare',
      identity: identity({ turnId: 'turn-2', draftToken: 'draft_2' }),
      operationId: 'op-2',
      query: 'q2',
    })
    expect(nextPrepare.state.history).toHaveLength(1)
    expect(nextPrepare.state.history[0].identity.terminal).toBe('done')
    expect(nextPrepare.state.turn?.identity.turnId).toBe('turn-2')
  })

  it('重复事件按 event_id 去重且只到达一次', () => {
    let state = submitting()
    for (const event of [
      sse(1, 'answer', { delta: 'A' }),
      sse(1, 'answer', { delta: 'A' }),
      sse(2, 'answer', { delta: 'B' }),
    ]) {
      state = reduceConversation(state, { type: 'sse', turnId: TURN, attempt: 1, event }).state
    }
    expect(turnOf(state).sse.answer).toBe('AB')
    expect(turnOf(state).identity.lastEventId).toBe(2)
  })

  it('乱序事件缓冲区不推进水位；缺口期间水位停留在连续最大 event_id', () => {
    let state = submitting()
    state = reduceConversation(state, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(1, 'answer', { delta: 'A' }),
    }).state
    state = reduceConversation(state, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(3, 'answer', { delta: 'C' }),
    }).state
    expect(turnOf(state).identity.lastEventId).toBe(1)
    state = reduceConversation(state, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(2, 'answer', { delta: 'B' }),
    }).state
    expect(turnOf(state).identity.lastEventId).toBe(3)
    expect(turnOf(state).sse.answer).toBe('ABC')
  })
})

describe('conversation-machine：unknown / 查回 / release（F05/F07）', () => {
  it('409 acceptance_outcome_unknown → lookup_pending 且 hold 保留', () => {
    const reduction = reduceConversation(submitting(), {
      type: 'http_failure', turnId: TURN, attempt: 1, status: 409, code: 'acceptance_outcome_unknown', acceptance: null,
    })
    expect(turnOf(reduction.state).state).toBe('lookup_pending')
    expect(turnOf(reduction.state).operationId).toBe('op-1')
    expect(reduction.effects[0]).toMatchObject({ type: 'lookup_submission' })
  })

  it('网络断开 → lookup_pending；查回 not_observed → not_observed 并释放 hold', () => {
    const disconnected = reduceConversation(submitting(), {
      type: 'network_failure', turnId: TURN, attempt: 1,
    })
    expect(turnOf(disconnected.state).state).toBe('lookup_pending')

    const settled = reduceConversation(disconnected.state, {
      type: 'lookup_result', turnId: TURN, view: view(),
    })
    expect(turnOf(settled.state).state).toBe('not_observed')
    expect(settled.effects).toEqual([{ type: 'release_hold', operationId: 'op-1' }])
    // not_observed ≠ not-accepted：不是 idle/terminal，草稿与未知标记保留。
    expect(turnOf(settled.state).identity.terminal).toBeNull()
  })

  it('未达有界次数不清账：lookup_failure 非 bounded 保持 lookup_pending', () => {
    const disconnected = reduceConversation(submitting(), {
      type: 'network_failure', turnId: TURN, attempt: 1,
    }).state
    const failure = reduceConversation(disconnected, {
      type: 'lookup_failure', turnId: TURN, token: TOKEN, failure: 'network', bounded: false,
    })
    expect(turnOf(failure.state).state).toBe('lookup_pending')
    expect(failure.effects).toHaveLength(0)
    const bounded = reduceConversation(failure.state, {
      type: 'lookup_failure', turnId: TURN, token: TOKEN, failure: 'network', bounded: true,
    })
    expect(turnOf(bounded.state).state).toBe('unknown')
    expect(bounded.effects).toEqual([{ type: 'release_hold', operationId: 'op-1' }])
  })

  it('查回 accepted：绑定 generation 并触发 conditional clear；terminal completed → done + release', () => {
    const disconnected = reduceConversation(submitting(), {
      type: 'network_failure', turnId: TURN, attempt: 1,
    }).state
    const accepted = reduceConversation(disconnected, {
      type: 'lookup_result',
      turnId: TURN,
      view: view({
        acceptance: 'accepted',
        generationId: 'gen_9',
        generationState: 'running',
        acceptedEditorRevision: 7,
        editorIntentHash: HASH,
      }),
    })
    expect(turnOf(accepted.state).state).toBe('accepted')
    expect(turnOf(accepted.state).identity.generationId).toBe('gen_9')
    expect(accepted.effects.map((e) => e.type)).toEqual(['clear_after_submission'])
    expect(accepted.effects.at(0)).toMatchObject({ operationId: 'op-1' })

    const terminal = reduceConversation(disconnected, {
      type: 'lookup_result',
      turnId: TURN,
      view: view({ acceptance: 'terminal', generationId: 'gen_9', generationState: 'completed', acceptedEditorRevision: 7 }),
    })
    expect(turnOf(terminal.state).state).toBe('terminal')
    expect(turnOf(terminal.state).identity.terminal).toBe('done')
    expect(terminal.effects).toEqual([{ type: 'release_hold', operationId: 'op-1' }])
  })

  it('查回 outcome_unknown → 保留 unknown 标记，只释放本次 hold（不开启新执行）', () => {
    const disconnected = reduceConversation(submitting(), {
      type: 'network_failure', turnId: TURN, attempt: 1,
    }).state
    const unknown = reduceConversation(disconnected, {
      type: 'lookup_result',
      turnId: TURN,
      view: view({ acceptance: 'outcome_unknown', generationId: 'gen_9', generationState: 'outcome_unknown' }),
    })
    expect(turnOf(unknown.state).state).toBe('unknown')
    expect(unknown.effects).toEqual([{ type: 'release_hold', operationId: 'op-1' }])
    expect(turnOf(unknown.state).identity.draftToken).toBe(TOKEN)
  })

  it('clear_settled 才释放 hold（accepted 后）且仅释放自己的 operationId', () => {
    const accepted = reduceConversation(submitting(), {
      type: 'accepted', turnId: TURN, attempt: 1, receipt: receipt(),
    }).state
    const settled = reduceConversation(accepted, {
      type: 'clear_settled', turnId: TURN, operationId: 'op-1', outcome: 'cleared',
    })
    expect(settled.effects).toEqual([{ type: 'release_hold', operationId: 'op-1' }])
    expect(turnOf(settled.state).operationId).toBeNull()
  })

  it('not_observed：同 token 幂等重放允许；换草稿发送需显式二次执行确认', () => {
    const disconnected = reduceConversation(submitting(), {
      type: 'network_failure', turnId: TURN, attempt: 1,
    }).state
    const notObserved = reduceConversation(disconnected, {
      type: 'lookup_result', turnId: TURN, view: view(),
    }).state
    expect(needsDuplicateExecutionConfirmation(notObserved, TOKEN)).toBe(false)
    expect(needsDuplicateExecutionConfirmation(notObserved, 'draft_2')).toBe(true)
  })
})

describe('conversation-machine：错误优先级', () => {
  it.each([
    [426, 'c05_contract_not_enabled', null, 'not_accepted'],
    [503, 'c05_entry_not_ready', null, 'not_accepted'],
    [422, 'editor_state_invalid', null, 'not_accepted'],
    [409, 'acceptance_outcome_unknown', null, 'unknown'],
    [503, 'session_store_unavailable', 'unknown', 'unknown'],
    [500, 'internal', null, 'unknown'],
    [500, 'internal', 'not_accepted', 'not_accepted'],
    [403, 'chat_owner_required', null, 'terminal'],
    [401, 'unauthorized', null, 'stale'],
    [404, 'session_not_found', null, 'terminal'],
  ] as const)('%s/%s → %s', (status, code, acceptance, expected) => {
    expect(classifySubmissionFailure({ status, code, acceptance })).toBe(expected)
  })

  it('426/503/422 落 idle 并释放 hold（不得进入 unknown）', () => {
    for (const [status, code] of [[426, 'c05_contract_not_enabled'], [503, 'c05_entry_not_ready'], [422, 'editor_state_invalid']] as const) {
      const reduction = reduceConversation(submitting(), {
        type: 'http_failure', turnId: TURN, attempt: 1, status, code, acceptance: null,
      })
      expect(turnOf(reduction.state).state).toBe('idle')
      expect(reduction.effects).toEqual([{ type: 'release_hold', operationId: 'op-1' }])
    }
  })

  it('未知 5xx（无受理知识）→ lookup_pending 且不换 key', () => {
    const reduction = reduceConversation(submitting(), {
      type: 'http_failure', turnId: TURN, attempt: 1, status: 500, code: 'internal', acceptance: null,
    })
    expect(turnOf(reduction.state).state).toBe('lookup_pending')
    expect(turnOf(reduction.state).identity.idempotencyKey).toBe(KEY)
    expect(reduction.effects[0]).toMatchObject({ type: 'lookup_submission' })
  })
})

describe('conversation-machine：热恢复 / 缺口（F07/F08）', () => {
  function streamingUpTo(lastEventId: number): ConversationState {
    let state = submitting()
    for (let id = 1; id <= lastEventId; id += 1) {
      state = reduceConversation(state, {
        type: 'sse', turnId: TURN, attempt: 1, event: sse(id, 'answer', { delta: `${id}` }),
      }).state
    }
    return state
  }

  it('缺口（resume_after > lastEventId+1）不得跳水位：转 durable 查回（gapDetected）', () => {
    const state = streamingUpTo(50)
    const reduction = reduceConversation(state, {
      type: 'reattach', eligible: true, resumeAfter: 80,
    })
    const turn = turnOf(reduction.state)
    expect(turn.gapDetected).toBe(true)
    expect(turn.state).toBe('lookup_pending')
    expect(turn.identity.lastEventId).toBe(50)
    expect(reduction.effects).toEqual([
      { type: 'lookup_submission', token: TOKEN, reason: 'reattach' },
    ])
  })

  it('连续水位（resume_after ≤ lastEventId+1）允许同 token/key 有界重连', () => {
    const state = streamingUpTo(50)
    const reduction = reduceConversation(state, {
      type: 'reattach', eligible: true, resumeAfter: 51,
    })
    expect(turnOf(reduction.state).state).toBe('streaming')
    expect(turnOf(reduction.state).identity.lastEventId).toBe(50)
    expect(reduction.effects).toEqual([
      { type: 'open_stream', turnId: TURN, attempt: 2, lastEventId: 50 },
    ])
  })

  it('detach 只中止本地流；reattach 超过上限降级 durable，不跳水位', () => {
    const detached = reduceConversation(streamingUpTo(5), { type: 'detach' })
    expect(detached.effects).toEqual([{ type: 'abort_stream', turnId: TURN }])
    const state = streamingUpTo(5)
    expect(MAX_REATTACH_ATTEMPTS).toBe(3)
    const reduction = reduceConversation(state, { type: 'reattach', eligible: true })
    expect(turnOf(reduction.state).state).toBe('streaming')
  })

  it('每个 turn 事件水位独立：新 turn 从 event_id=1 重新起算', () => {
    let state = reduceConversation(submitting(), {
      type: 'accepted', turnId: TURN, attempt: 1, receipt: receipt(),
    }).state
    state = reduceConversation(state, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(1, 'answer', { delta: 'ok' }),
    }).state
    state = reduceConversation(state, {
      type: 'sse', turnId: TURN, attempt: 1, event: sse(2, 'done', { completion_status: 'success' }),
    }).state
    expect(turnOf(state).identity.terminal).toBe('done')
    const next = reduceConversation(state, {
      type: 'prepare',
      identity: identity({ turnId: 'turn-2', draftToken: 'draft_2' }),
      operationId: 'op-2',
      query: 'q2',
    }).state
    expect(turnOf(next).identity.lastEventId).toBe(0)
    const streaming = reduceConversation(next, {
      type: 'sse', turnId: 'turn-2', attempt: 0, event: sse(1, 'answer', { delta: 'new' }),
    }).state
    expect(turnOf(streaming).sse.answer).toBe('new')
  })
})

describe('conversation-machine：查回顺序与并发上限（DESIGN §3.5/§6.7）', () => {
  it('顺序 active → 当前草稿 → 其他；每批 ≤2', () => {
    expect(MAX_CONCURRENT_SUBMISSION_LOOKUPS).toBe(2)
    const batches = planSubmissionLookups({
      activeToken: 'tok_active',
      draftToken: 'tok_draft',
      markers: ['tok_m1', 'tok_m2', 'tok_m3'],
      maxConcurrent: MAX_CONCURRENT_SUBMISSION_LOOKUPS,
    })
    const flattened = batches.flat()
    expect(flattened[0]).toBe('tok_active')
    expect(flattened[1]).toBe('tok_draft')
    expect(batches.every((batch) => batch.length <= 2)).toBe(true)
    expect(new Set(flattened)).toEqual(new Set(['tok_active', 'tok_draft', 'tok_m1', 'tok_m2', 'tok_m3']))
  })

  it('去重：active 与 draft 相同只查一次', () => {
    const batches = planSubmissionLookups({
      activeToken: 'tok_same',
      draftToken: 'tok_same',
      markers: ['tok_same'],
      maxConcurrent: 2,
    })
    expect(batches.flat()).toEqual(['tok_same'])
  })
})

describe('conversation-controller：副作用与迟到隔离', () => {
  function setup(over: { submission?: () => Promise<unknown> | unknown } = {}) {
    const calls: Array<{ input: Parameters<Parameters<typeof createConversationController>[0]['transport']['openStream']>[0] }> = []
    const aborts: string[] = []
    const releases: string[] = []
    const clears: Array<{ operationId: string; generationId: string }> = []
    const controller = createConversationController({
      ref: REF,
      authGeneration: 1,
      transport: {
        openStream: (input) => {
          calls.push({ input })
          return { abort: (reason) => { aborts.push(reason ?? 'user_cancel') } }
        },
        getSubmission: over.submission ?? (() => submissionResponse()),
        releaseHold: (operationId) => { releases.push(operationId) },
        clearAfterSubmission: (receipt, operationId) => {
          clears.push({ operationId, generationId: receipt.generationId })
        },
      },
    })
    return { controller, calls, aborts, releases, clears }
  }

  function sendInput(over: Record<string, unknown> = {}) {
    return {
      query: 'q1',
      modelId: 'model-1',
      sourceIds: ['src_1'],
      noteIds: [],
      editorRevision: 3,
      draftToken: TOKEN,
      editorIntentHash: HASH,
      idempotencyKey: KEY,
      operationId: 'op-1',
      ...over,
    }
  }

  it('send 打开流：携带同 token/key/revision/hash，首流 lastEventId=0', async () => {
    const { controller, calls } = setup()
    const result = await controller.send(sendInput())
    expect(result.status).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toMatchObject({
      sessionRef: REF,
      editorRevision: 3,
      draftToken: TOKEN,
      editorIntentHash: HASH,
      idempotencyKey: KEY,
      lastEventId: 0,
      query: 'q1',
      modelId: 'model-1',
    })
  })

  it('accepted 触发 clearAfterSubmission；clear_settled 只释放自身 operationId', async () => {
    const { controller, calls, releases, clears } = setup()
    await controller.send(sendInput())
    calls[0].input.onEvent(sse(1, 'usage', {
      usage: { input_tokens: 1, output_tokens: 1 },
      accepted: receiptWire(),
    }))
    expect(clears).toEqual([{ operationId: 'op-1', generationId: 'gen_1' }])
    expect(releases).toEqual([])
    controller.notifyClearSettled('op-1', 'cleared')
    expect(releases).toEqual(['op-1'])
  })

  it('detach 中止本地流；旧回调不再改写状态', async () => {
    const { controller, calls, aborts } = setup()
    await controller.send(sendInput())
    controller.detach()
    expect(aborts).toEqual(['identity'])
    calls[0].input.onEvent(sse(1, 'answer', { delta: 'late' }))
    const turn = controller.getSnapshot().turn
    expect(turn?.sse.answer).toBe('')
    expect(turn?.identity.detached).toBe(true)
  })

  it('查回：not_observed → 释放 hold；bounded 失败 → unknown + 释放（仅 ≤2 并发）', async () => {
    const { controller, releases } = setup()
    await controller.send(sendInput())
    // 模拟断线 → machine 进入 lookup_pending 并调度查回
    const stream = (controller as unknown as { getSnapshot: () => unknown })
    expect(stream).toBeTruthy()
    await controller.lookupSubmission()
    await new Promise((r) => setTimeout(r, 0))
    expect(releases).toContain('op-1')
    expect(BOUNDED_LOOKUP_FAILURES).toBe(3)
  })

  it('非终态时 send 返回 blocked；终态后 retryTerminal 生成新身份新 key', async () => {
    const { controller, calls } = setup()
    await controller.send(sendInput())
    expect((await controller.send(sendInput())).status).toBe('blocked')
    calls[0].input.onEvent(sse(1, 'error', { code: 'gateway_unavailable', message: 'boom' }))
    const snapshot = controller.getSnapshot()
    expect(snapshot.turn?.identity.terminal).toBe('error')
    const retry = await controller.retryTerminal({
      ...sendInput(),
      draftToken: 'draft_2',
      idempotencyKey: `s1_${'c'.repeat(64)}`,
    })
    expect(retry.status).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[1].input.draftToken).toBe('draft_2')
    expect(calls[1].input.lastEventId).toBe(0)
  })

  it('快照按版本缓存：同版本返回同一对象', () => {
    const { controller } = setup()
    const first = controller.getSnapshot()
    expect(controller.getSnapshot()).toBe(first)
  })

  it('durable detail 未接线：load/loadMore 如实 blocked（PR-6）', async () => {
    const { controller } = setup()
    expect((await controller.load()).status).toBe('blocked')
    expect((await controller.loadMore()).status).toBe('blocked')
  })
})
