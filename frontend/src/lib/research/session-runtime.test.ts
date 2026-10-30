/**
 * RDLens #892：会话消息「尾部窗口」读取的控制器语义（fork 侧）。
 *
 * 契约来源：`dev_docs/设计方案/Research/issue892_会话消息尾部窗口读取_20261030.md`
 * §2.2/§2.3/§3.2。
 *
 * 钉死的行为：
 * - `load()`（首读）= 尾部窗口：请求携带 `order=desc` + `limit=50`；
 * - `loadMore()` = 取**更早的一页**（后向游标），返回行 **prepend**；
 * - `durable_restored` 的 complete 判定在 desc 模式下不再要求
 *   `next_cursor === null`（首读即最新，游标非空只表示还有更早历史）；
 * - asc 模式的判定保持现状不变（前向游标未到尾页即不完整）；
 * - 合并去重：按 `message_id` 首见保留。
 */

import { describe, expect, it } from 'vitest'
import { createConversationController } from './session-runtime'
import type {
  ConversationStreamInput,
  ConversationTransport,
} from './session-runtime'
import { sessionKey, type ResearchSessionRef } from './session-contract'
import type { ResearchSseEvent } from './types'

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
const GEN = `gen_${'c'.repeat(32)}`

function sse(
  event_id: number,
  type: ResearchSseEvent['type'],
  extra: Record<string, unknown> = {},
): ResearchSseEvent {
  return { event_id, type, ...extra } as ResearchSseEvent
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

function sendInput(over: Record<string, unknown> = {}) {
  return {
    query: 'q1',
    modelId: 'model-1',
    sourceIds: [],
    noteIds: [],
    scope: { mode: 'all' as const, sourceIds: [] as string[], singleSourceId: null },
    editorRevision: 3,
    draftToken: TOKEN,
    editorIntentHash: HASH,
    idempotencyKey: KEY,
    operationId: 'op-1',
    ...over,
  }
}

interface DetailCall {
  readonly cursor: string | null
  readonly order: string | undefined
  readonly limit: number | undefined
}

interface Harness {
  readonly controller: ReturnType<typeof createConversationController>
  readonly detailCalls: DetailCall[]
  readonly streams: ConversationStreamInput[]
}

function harness(options: {
  readonly loadDetail?: (input: {
    sessionRef: ResearchSessionRef
    cursor?: string | null
    order?: 'asc' | 'desc'
    limit?: number
  }) => unknown
  readonly detailOrder?: 'asc' | 'desc'
  readonly submission?: () => unknown
} = {}): Harness {
  const detailCalls: DetailCall[] = []
  const streams: ConversationStreamInput[] = []
  const transport: ConversationTransport = {
    openStream: (input) => {
      streams.push(input)
      return { abort: () => {} }
    },
    getSubmission: () => submissionResponse(
      options.submission === undefined
        ? {}
        : (options.submission() as Record<string, unknown>),
    ),
    loadDetail: (input) => {
      detailCalls.push({
        cursor: input.cursor ?? null,
        order: input.order,
        limit: input.limit,
      })
      if (options.loadDetail === undefined) {
        return { messages: [], next_cursor: null }
      }
      return options.loadDetail(input)
    },
  }
  const controller = createConversationController({
    ref: REF,
    authGeneration: 1,
    transport,
    ...(options.detailOrder === undefined ? {} : { detailOrder: options.detailOrder }),
  })
  return { controller, detailCalls, streams }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

describe('#892 尾部窗口：首读与向更早一页', () => {
  it('load() 请求尾部窗口：order=desc + limit=50 + cursor=null', async () => {
    const h = harness({
      loadDetail: () => ({
        messages: [{ message_id: 'msg_new', role: 'assistant', content: '最新答案' }],
        next_cursor: 'back-1',
      }),
    })
    const result = await h.controller.load()
    expect(result.status).toBe('ok')
    expect(h.detailCalls).toEqual([{ cursor: null, order: 'desc', limit: 50 }])
    expect(h.controller.getSnapshot().detailMessages).toHaveLength(1)
    expect(h.controller.getSnapshot().detailCursor).toBe('back-1')
  })

  it('loadMore() 带后向游标取更早一页，并 prepend 到已有窗口之前（阅读顺序）', async () => {
    const h = harness({
      loadDetail: (input) => {
        if (input.cursor === null || input.cursor === undefined) {
          return {
            messages: [
              { message_id: 'msg_3', role: 'user', content: '第三问' },
              { message_id: 'msg_4', role: 'assistant', content: '第三个答案' },
            ],
            next_cursor: 'back-1',
          }
        }
        return {
          messages: [
            { message_id: 'msg_1', role: 'user', content: '第一问' },
            { message_id: 'msg_2', role: 'assistant', content: '第一个答案' },
          ],
          next_cursor: null,
        }
      },
    })
    await h.controller.load()
    const more = await h.controller.loadMore()
    expect(more.status).toBe('ok')
    // 后向游标 + 同方向（desc）→ 不得方向错配
    expect(h.detailCalls).toEqual([
      { cursor: null, order: 'desc', limit: 50 },
      { cursor: 'back-1', order: 'desc', limit: 50 },
    ])
    const ids = (h.controller.getSnapshot().detailMessages as Array<{ message_id: string }>)
      .map((row) => row.message_id)
    expect(ids).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_4'])
  })

  it('更早一页与已有窗口有重复 message_id 时按首见保留去重', async () => {
    const h = harness({
      loadDetail: (input) => {
        if (input.cursor === null || input.cursor === undefined) {
          return {
            messages: [{ message_id: 'msg_2', role: 'assistant', content: '答案' }],
            next_cursor: 'back-1',
          }
        }
        return {
          messages: [
            { message_id: 'msg_1', role: 'user', content: '问题' },
            { message_id: 'msg_2', role: 'assistant', content: '答案' },
          ],
          next_cursor: null,
        }
      },
    })
    await h.controller.load()
    await h.controller.loadMore()
    const ids = (h.controller.getSnapshot().detailMessages as Array<{ message_id: string }>)
      .map((row) => row.message_id)
    expect(ids).toEqual(['msg_1', 'msg_2'])
  })

  it('没有更早历史时 loadMore() 如实 blocked（no_more_detail）', async () => {
    const h = harness({
      loadDetail: () => ({
        messages: [{ message_id: 'msg_1', role: 'assistant', content: '答案' }],
        next_cursor: null,
      }),
    })
    await h.controller.load()
    const more = await h.controller.loadMore()
    expect(more.status).toBe('blocked')
    expect(more.status === 'blocked' ? more.error?.code : null).toBe('no_more_detail')
  })
})

describe('#892 尾部窗口：durable_restored 的 complete 判定', () => {
  /** 制造一个「已终态但 incomplete」的 turn（真实 SSE 缺口 → 查回 completed）。 */
  async function incompleteTurn(h: Harness): Promise<void> {
    await h.controller.send(sendInput())
    h.streams[0].onEvent(sse(1, 'answer', { delta: 'prefix' }))
    h.streams[0].onEvent(sse(2, 'answer', { delta: 'more' }))
    h.streams[0].onEvent(sse(4, 'answer', { delta: 'gap' }))
    h.controller.detach()
    await h.controller.reattach()
    await flush()
    await flush()
  }

  it('desc：窗口内已出现目标 generation 的 assistant 行 → 即完整（不要求 next_cursor=null）', async () => {
    const h = harness({
      submission: () => submissionResponse({
        acceptance_state: 'terminal',
        generation_id: GEN,
        generation_state: 'completed',
        accepted_editor_revision: 3,
        editor_intent_hash: HASH,
        submitted_draft_text: 'q1',
      }),
      loadDetail: () => ({
        messages: [{
          message_id: `msg_${GEN}_assistant`,
          role: 'assistant',
          content: '完整答案',
        }],
        // 还有更早的历史（非空）——desc 首读即最新，不得据此判定不完整
        next_cursor: 'back-1',
      }),
    })
    await incompleteTurn(h)
    expect(h.controller.getSnapshot().turn?.state).toBe('terminal')
    await flush()
    // 响应里 next_cursor 非空（还有更早的历史），但恢复目标已在尾部窗口内
    // → desc 模式判定为完整（asc 模式见下一用例：仍不完整）。
    expect(h.controller.getSnapshot().turn?.incomplete).toBe(false)
    expect(h.detailCalls[0]).toMatchObject({ order: 'desc', cursor: null })
  })

  it('desc：无目标 generation 时，窗口内存在有正文的 assistant 行 → 完整', async () => {
    const h = harness({
      // 冷启动 external 查回未观测到 generation（not_observed）→ 目标 generation
      // 为空，判定退到「窗口内存在有正文的 assistant 行」。
      submission: () => submissionResponse(),
      loadDetail: () => ({
        messages: [{
          message_id: 'msg_other_assistant',
          role: 'assistant',
          content: '别的答案',
        }],
        next_cursor: 'back-1',
      }),
    })
    await h.controller.lookupSubmission('tok_cold')
    await flush()
    expect(h.controller.getSnapshot().turn?.identity.generationId).toBeNull()
    expect(h.controller.getSnapshot().turn?.incomplete).toBe(true)
    await h.controller.load()
    expect(h.controller.getSnapshot().turn?.incomplete).toBe(false)
  })

  it('desc：窗口内没有目标 generation → 仍不完整', async () => {
    const h = harness({
      submission: () => submissionResponse({
        acceptance_state: 'terminal',
        generation_id: GEN,
        generation_state: 'completed',
        accepted_editor_revision: 3,
        editor_intent_hash: HASH,
        submitted_draft_text: 'q1',
      }),
      loadDetail: () => ({
        messages: [{ message_id: 'msg_other', role: 'user', content: '问题' }],
        next_cursor: 'back-1',
      }),
    })
    await incompleteTurn(h)
    await flush()
    expect(h.controller.getSnapshot().turn?.incomplete).toBe(true)
  })

  it('asc：判定保持现状——前向游标未到尾页即不完整', async () => {
    const h = harness({
      detailOrder: 'asc',
      submission: () => submissionResponse({
        acceptance_state: 'terminal',
        generation_id: GEN,
        generation_state: 'completed',
        accepted_editor_revision: 3,
        editor_intent_hash: HASH,
        submitted_draft_text: 'q1',
      }),
      loadDetail: () => ({
        messages: [{
          message_id: `msg_${GEN}_assistant`,
          role: 'assistant',
          content: '完整答案',
        }],
        next_cursor: 'c1',
      }),
    })
    await incompleteTurn(h)
    await flush()
    expect(h.detailCalls[0]).toMatchObject({ order: 'asc', cursor: null })
    expect(h.controller.getSnapshot().turn?.incomplete).toBe(true)
  })
})

describe('#892 尾部窗口：会话身份与代次守卫不变', () => {
  it('SESSION_KEY 与控制器一致（控制器按会话隔离）', () => {
    expect(SESSION_KEY).toBe('research.v1|proj_1|global||sess_1')
  })
})
