/**
 * RWV2-23（Issue #43，U2 / D2）：Chat 答案 → generation_id 绑定的纯逻辑。
 *
 * - 恢复/重开行：message_id 形如 `msg_<generation_id>_assistant`，其中
 *   generation_id 必须匹配后端实际生成器 `gen_<32hex>`（`req_<16hex>` 等
 *   非生成形态一律拒绝，避免把 request_id 误当 origin_id 发往后端导致
 *   必然 404）；
 * - live 轮：在按阅读顺序合并的会话行里选择要绑定的 assistant 行：
 *   优先「content 与该轮 UI turn 完全一致（trim）且 delta/会话内前一
 *   user 行 content 与该轮 query 一致」；退而求其次 content 一致（取
 *   最新）；再其次前一 user 行一致（取最新）；无唯一命中返回 null ——
 *   绝不猜测（防迟到后台行/孤儿 user 行错绑到错误 generation 的
 *   Scope/模型/语言 provenance）。
 */
export interface ChatOriginRow {
  message_id: string | null | undefined
  role?: string | null | undefined
  content?: string | null | undefined
}

export interface ChatOriginCandidate {
  messageId: string
  generationId: string
}

/** 后端 generation_id 实际形状：`gen_` + 32 位 hex（router.py `gen_`+uuid4.hex）。 */
export const GENERATION_ID_PATTERN = /^gen_[0-9a-f]{32}$/

const ASSISTANT_MESSAGE_ID_PATTERN = /^msg_(gen_[0-9a-f]{32})_assistant$/

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isAssistant(row: ChatOriginRow): boolean {
  return row.role === 'assistant'
}

/**
 * 从持久化 assistant message_id 解析 generation_id。
 * 仅接受 `msg_<gen_...>_assistant` 且 generation_id 符合 `gen_<32hex>`
 * 形状；request_id 形态（`req_...`）或其它字符串返回 null。
 */
export function parseGenerationIdFromMessageId(
  messageId: string | null | undefined,
): string | null {
  if (typeof messageId !== 'string') return null
  const match = ASSISTANT_MESSAGE_ID_PATTERN.exec(messageId)
  if (match === null) return null
  const candidate = match[1]
  return GENERATION_ID_PATTERN.test(candidate) ? candidate : null
}

/**
 * 在（按阅读顺序合并的）会话行中选出要绑定的 assistant 行。
 *
 * @param rows           阅读顺序的行（可能只覆盖最近一次拉取的 delta）
 * @param query          该轮 UI user 消息内容（trim 比较）
 * @param expectedContent 该轮 UI assistant 消息内容（trim 比较；空则不可绑）
 * @returns 命中的 message_id 与解析出的 generation_id；无唯一命中返回 null。
 *
 * 优先级（last-wins）：
 *   1) content 一致 且 会话/前一 user 行 query 一致（最强约束，防同文双轮）；
 *   2) 仅 content 一致（delta 内无相邻 user 行——迟到/孤儿行被跳过）；
 *   3) 仅前一 user 行 query 一致。
 * 无任何命中 → null（调用方降级为“不可存”，不猜测）。
 */
export function selectBoundAssistantRow(
  rows: readonly ChatOriginRow[],
  query: string,
  expectedContent: string,
): ChatOriginCandidate | null {
  const q = text(query)
  const content = text(expectedContent)
  if (!content) return null
  let both: ChatOriginCandidate | null = null
  let contentOnly: ChatOriginCandidate | null = null
  let userOnly: ChatOriginCandidate | null = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!isAssistant(row)) continue
    if (typeof row.message_id !== 'string') continue
    const generationId = parseGenerationIdFromMessageId(row.message_id)
    if (generationId === null) continue
    const candidate: ChatOriginCandidate = { messageId: row.message_id, generationId }
    const contentHit = text(row.content) === content
    const prev = i > 0 ? rows[i - 1] : null
    const userHit = prev !== null && prev.role === 'user' && text(prev.content) === q
    if (contentHit && userHit) both = candidate
    else if (contentHit) contentOnly = candidate
    else if (userHit) userOnly = candidate
  }
  return both ?? contentOnly ?? userOnly
}
