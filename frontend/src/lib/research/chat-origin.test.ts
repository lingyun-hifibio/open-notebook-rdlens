/**
 * RWV2-23（Issue #43，U2）：chat-origin 绑定纯逻辑。
 *
 * 覆盖：message_id 形状守卫（gen vs req）；恢复行解析；live 轮
 * content/前一 user 行双约束；同文双轮取最新；迟到后台行（无相邻
 * user 行）被 content 约束跳过；孤儿 user 行不误绑；无唯一命中 null。
 */
import { describe, expect, it } from 'vitest'
import {
  parseGenerationIdFromMessageId,
  selectBoundAssistantRow,
  type ChatOriginRow,
} from './chat-origin'

const GEN_A = 'gen_' + 'a'.repeat(32)
const GEN_B = 'gen_' + 'b'.repeat(32)
const GEN_C = 'gen_' + 'c'.repeat(32)

function assistant(id: string, content: string): ChatOriginRow {
  return { message_id: id, role: 'assistant', content }
}
function user(content: string): ChatOriginRow {
  return { message_id: `msg_${GEN_A}_user`, role: 'user', content }
}

describe('parseGenerationIdFromMessageId', () => {
  it('解析合法 assistant message_id', () => {
    expect(parseGenerationIdFromMessageId(`msg_${GEN_A}_assistant`)).toBe(GEN_A)
  })
  it('拒绝 request_id 形态（msg_req_..._assistant）', () => {
    expect(parseGenerationIdFromMessageId(`msg_req_${'1'.repeat(16)}_assistant`)).toBeNull()
  })
  it('拒绝非 assistant / 非 msg_ 前缀 / 缺后缀 / 非字符串', () => {
    expect(parseGenerationIdFromMessageId(`msg_${GEN_A}_user`)).toBeNull()
    expect(parseGenerationIdFromMessageId(`${GEN_A}_assistant`)).toBeNull()
    expect(parseGenerationIdFromMessageId(`msg_${GEN_A}`)).toBeNull()
    expect(parseGenerationIdFromMessageId(null)).toBeNull()
    expect(parseGenerationIdFromMessageId(undefined)).toBeNull()
  })
})

describe('selectBoundAssistantRow', () => {
  it('content + 前一 user 行双约束命中', () => {
    const rows: ChatOriginRow[] = [
      user('what is ORR?'),
      assistant(`msg_${GEN_A}_assistant`, 'ORR was 45%.'),
    ]
    expect(selectBoundAssistantRow(rows, 'what is ORR?', 'ORR was 45%.')).toEqual({
      messageId: `msg_${GEN_A}_assistant`,
      generationId: GEN_A,
    })
  })

  it('同文双轮：约束 1 取最新（最后一对）', () => {
    const rows: ChatOriginRow[] = [
      user('same question'),
      assistant(`msg_${GEN_A}_assistant`, 'first answer'),
      user('same question'),
      assistant(`msg_${GEN_B}_assistant`, 'second answer'),
    ]
    expect(selectBoundAssistantRow(rows, 'same question', 'second answer')).toEqual({
      messageId: `msg_${GEN_B}_assistant`,
      generationId: GEN_B,
    })
  })

  it('迟到后台行（无 in-delta 相邻 user 行）不因 query 误绑；content 约束优先', () => {
    // 迟到行 A 前面没有 user 行（其 user 行早于游标）；我们这轮 user+assistant 在后。
    const rows: ChatOriginRow[] = [
      assistant(`msg_${GEN_A}_assistant`, 'old background answer'),
      user('fresh query'),
      assistant(`msg_${GEN_C}_assistant`, 'fresh answer text'),
    ]
    // 目标 = fresh answer（content 命中且前一 user 命中）→ 命中 C。
    expect(selectBoundAssistantRow(rows, 'fresh query', 'fresh answer text')).toEqual({
      messageId: `msg_${GEN_C}_assistant`,
      generationId: GEN_C,
    })
    // 若用户想保存迟到行（content=old background answer），行 A 无相邻 user 行且
    // query 不匹配，但 content 唯一命中 → 仍可取（诚实可存）。
    expect(selectBoundAssistantRow(rows, 'unrelated query', 'old background answer')).toEqual({
      messageId: `msg_${GEN_A}_assistant`,
      generationId: GEN_A,
    })
  })

  it('仅前一 user 行命中而 content 不同：可作为最后兜底命中（不误报已存）', () => {
    const rows: ChatOriginRow[] = [
      user('question text'),
      assistant(`msg_${GEN_B}_assistant`, 'server answer (normalized text)'),
    ]
    // UI content 与服务端不一致（如历史版本），仍有相邻 user 行约束可绑定。
    expect(selectBoundAssistantRow(rows, 'question text', 'different rendered text')).toEqual({
      messageId: `msg_${GEN_B}_assistant`,
      generationId: GEN_B,
    })
  })

  it('空 expected content / 无匹配 → null', () => {
    const rows: ChatOriginRow[] = [
      user('q'),
      assistant(`msg_${GEN_A}_assistant`, 'answer'),
    ]
    expect(selectBoundAssistantRow(rows, 'q', '   ')).toBeNull()
    expect(selectBoundAssistantRow(rows, 'another query', 'another content')).toBeNull()
    expect(selectBoundAssistantRow([], 'q', 'a')).toBeNull()
  })

  it('request_id 形态的 message_id 永不作为候选', () => {
    const rows: ChatOriginRow[] = [
      user('q'),
      { message_id: `msg_req_${'1'.repeat(16)}_assistant`, role: 'assistant', content: 'answer' },
    ]
    expect(selectBoundAssistantRow(rows, 'q', 'answer')).toBeNull()
  })
})
