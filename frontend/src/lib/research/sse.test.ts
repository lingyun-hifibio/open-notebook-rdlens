import { describe, expect, it } from 'vitest'
import {
  applySseEvent,
  createSseState,
  parseResearchEvent,
  parseSseFrame,
  RETRYABLE_SSE_ERROR_CODES,
  type ResearchSseState,
} from './sse'
import type { ResearchSseEvent } from './types'

// UI-03 Red：SSE 契约 reducer（契约 v0 §9）——乱序/重复事件容忍（按 event_id
// 去重与排序）、终态恰好一次、终态后不再接受事件、断线重连 Last-Event-ID
// 依据 lastEventId、retryable 错误码集合。

function ev(event_id: number, type: ResearchSseEvent['type'], extra: Partial<ResearchSseEvent> = {}): ResearchSseEvent {
  return { event_id, type, ...extra }
}

function stateAfter(events: ResearchSseEvent[]): ResearchSseState {
  return events.reduce((acc, e) => applySseEvent(acc, e), createSseState())
}

describe('sse reducer', () => {
  it('顺序事件累积 thinking/answer delta 并推进 lastEventId', () => {
    const s = stateAfter([
      ev(1, 'thinking', { delta: '思考中' }),
      ev(2, 'thinking', { delta: '继续' }),
      ev(3, 'answer', { delta: '答案' }),
      ev(4, 'answer', { delta: '补充' }),
    ])
    expect(s.thinking).toBe('思考中继续')
    expect(s.answer).toBe('答案补充')
    expect(s.lastEventId).toBe(4)
    expect(s.terminal).toBeNull()
  })

  it('重复事件（同 event_id 重放）被去重，delta 不重复追加', () => {
    const s = stateAfter([
      ev(1, 'thinking', { delta: 'A' }),
      ev(1, 'thinking', { delta: 'A' }),
      ev(2, 'answer', { delta: 'B' }),
      ev(2, 'answer', { delta: 'B' }),
    ])
    expect(s.thinking).toBe('A')
    expect(s.answer).toBe('B')
    expect(s.lastEventId).toBe(2)
  })

  it('乱序事件按 event_id 排序后应用（1,3,2 → 仍按 1、2、3 顺序合并）', () => {
    const s = stateAfter([
      ev(1, 'answer', { delta: '一' }),
      ev(3, 'answer', { delta: '三' }),
      ev(2, 'answer', { delta: '二' }),
    ])
    expect(s.answer).toBe('一二三')
    expect(s.lastEventId).toBe(3)
  })

  it('乱序中夹带重复事件仍去重且不丢顺序', () => {
    const s = stateAfter([
      ev(1, 'answer', { delta: '一' }),
      ev(4, 'answer', { delta: '四' }),
      ev(2, 'answer', { delta: '二' }),
      ev(3, 'answer', { delta: '三' }),
      ev(2, 'answer', { delta: '二' }),
    ])
    expect(s.answer).toBe('一二三四')
    expect(s.lastEventId).toBe(4)
  })

  it('缺号流（event 1 缺失）只缓冲不应用，顺序不被破坏（丢失靠重连恢复）', () => {
    const s = stateAfter([
      ev(3, 'answer', { delta: '三' }),
      ev(2, 'answer', { delta: '二' }),
    ])
    expect(s.answer).toBe('')
    expect(s.lastEventId).toBe(0)
    expect(s.pending.map((e) => e.event_id)).toEqual([2, 3])
  })

  it('citation 事件按 citation_id 合并去重', () => {
    const c1 = { citation_id: 1, claim: 'c1', doc_id: 'd', doc_version: 'v3', chunk_id: 'ch', page_idx: 3, original_text: 't', citation_type: 'direct', confidence: 'high' }
    const c2 = { ...c1, citation_id: 2, claim: 'c2' }
    const s = stateAfter([
      ev(1, 'citation', { citations: [c1] }),
      ev(2, 'citation', { citations: [c1, c2] }),
      ev(2, 'citation', { citations: [c1, c2] }),
    ])
    expect(s.citations).toHaveLength(2)
    expect(s.citations[0]).toEqual(c1)
    expect(s.citations[1]).toEqual(c2)
  })

  it('usage 事件记录用量与 resolved_mode（REQ-ENG-04）', () => {
    const s = stateAfter([
      ev(1, 'usage', { usage: { input_tokens: 1200, thinking_tokens: 400, output_tokens: 300 }, resolved_mode: 'hybrid_rag' }),
    ])
    expect(s.usage).toEqual({ input_tokens: 1200, thinking_tokens: 400, output_tokens: 300 })
    expect(s.resolvedMode).toBe('hybrid_rag')
  })

  it('done 终态记录 session/request/job 与 completion_status，且恰好一次', () => {
    const s = stateAfter([
      ev(1, 'answer', { delta: 'X' }),
      ev(2, 'done', { session_id: 's1', request_id: 'r1', job_id: 'job_1', completion_status: 'success' }),
    ])
    expect(s.terminal).toBe('done')
    expect(s.sessionId).toBe('s1')
    expect(s.requestId).toBe('r1')
    expect(s.jobId).toBe('job_1')
    expect(s.completionStatus).toBe('success')

    // 终态后的事件一律忽略（终态一次，契约 §9.3）
    const after = applySseEvent(s, ev(3, 'answer', { delta: '迟到' }))
    expect(after.answer).toBe('X')
    expect(after.lastEventId).toBe(2)
    expect(after.terminal).toBe('done')
  })

  it('error 终态记录 code/message；error 后再来的 done 被忽略', () => {
    const s = stateAfter([
      ev(1, 'error', { code: 'project_deleted', message: '项目已删除' }),
    ])
    expect(s.terminal).toBe('error')
    expect(s.errorCode).toBe('project_deleted')
    expect(s.errorMessage).toBe('项目已删除')
    const after = applySseEvent(s, ev(2, 'done', { session_id: 's' }))
    expect(after.terminal).toBe('error')
    expect(after.sessionId).toBeNull()
  })

  it('重连重放：lastEventId 之后的增量才被应用（Last-Event-ID 语义）', () => {
    const first = stateAfter([
      ev(1, 'thinking', { delta: 'A' }),
      ev(2, 'thinking', { delta: 'B' }),
    ])
    const resumed = stateAfter([
      ev(1, 'thinking', { delta: 'A' }), // 重放旧事件
      ev(2, 'thinking', { delta: 'B' }),
      ev(3, 'answer', { delta: 'C' }),
    ])
    expect(resumed.lastEventId).toBe(3)
    expect(resumed.thinking).toBe('AB')
    expect(resumed.answer).toBe('C')
    expect(resumed.thinking).toBe(first.thinking)
  })

  it('非法载荷（无 event_id / 非整数 id / 未知 type）被丢弃', () => {
    expect(parseResearchEvent({ type: 'answer', delta: 'x' })).toBeNull()
    expect(parseResearchEvent({ event_id: 1.5, type: 'answer', delta: 'x' })).toBeNull()
    expect(parseResearchEvent({ event_id: 1, type: 'mystery' })).toBeNull()
    expect(parseResearchEvent(null)).toBeNull()
    expect(parseResearchEvent('nope')).toBeNull()
  })

  it('retryable 错误码集合与契约 §9.4 一致', () => {
    expect(RETRYABLE_SSE_ERROR_CODES).toEqual(['admission_unavailable', 'admission_capacity', 'internal'])
    expect(RETRYABLE_SSE_ERROR_CODES).not.toContain('project_deleted')
    expect(RETRYABLE_SSE_ERROR_CODES).not.toContain('epoch_mismatch')
    expect(RETRYABLE_SSE_ERROR_CODES).not.toContain('job_cancelled')
  })
})

describe('parseSseFrame', () => {
  it('解析 event/data 单帧并返回规范化事件', () => {
    const frame = 'event: answer\ndata: {"event_id": 2, "type": "answer", "delta": "hi"}\n\n'
    expect(parseSseFrame(frame)).toEqual({ event_id: 2, type: 'answer', delta: 'hi' })
  })

  it('event 名与载荷 type 不一致时丢弃', () => {
    const frame = 'event: answer\ndata: {"event_id": 1, "type": "thinking", "delta": "x"}\n\n'
    expect(parseSseFrame(frame)).toBeNull()
  })

  it('多行 data 按 SSE 规范以换行拼接后解析为单个 JSON 载荷', () => {
    const frame = 'event: answer\ndata: {"event_id": 3, "type": "answer",\ndata: "delta": "multi"}\n\n'
    expect(parseSseFrame(frame)).toEqual({ event_id: 3, type: 'answer', delta: 'multi' })
  })

  it('忽略 id:/retry: 行；非法 JSON 返回 null', () => {
    const frame = 'id: 5\nretry: 1000\nevent: answer\ndata: not-json\n\n'
    expect(parseSseFrame(frame)).toBeNull()
    expect(parseSseFrame('')).toBeNull()
    expect(parseSseFrame('event: answer\ndata: 1\n\n')).toBeNull()
  })

  it('CRLF 行尾兼容', () => {
    const frame = 'event: usage\r\ndata: {"event_id": 1, "type": "usage", "usage": {"input_tokens": 1, "output_tokens": 1}, "resolved_mode": "direct_context"}\r\n\r\n'
    const event = parseSseFrame(frame)
    expect(event?.type).toBe('usage')
    expect(event?.resolved_mode).toBe('direct_context')
  })
})
