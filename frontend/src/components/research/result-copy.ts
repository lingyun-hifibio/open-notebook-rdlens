/**
 * RWV2-23（Issue #43，D7）：结果 Copy 纯文本格式化。
 *
 * - 只含结果正文 + 编号 Citation（claim / original_text / 来源 / 页码）；
 * - Citation 输入应为「展示归一化后的行」（chat/search 的 display 结构或
 *   Transformation 经 normalizePersistedCitations 的行）；
 * - 仅消费声明的字段——即使运行时混入 credential/Secret 等未知键也不会
 *   进入输出（不暴露凭据）。
 */
export interface ResultCopyCitation {
  claim?: string | null | undefined
  original_text?: string | null | undefined
  doc_id?: string | null | undefined
  /** 0-based；输出为 “p. N” （N = page_idx + 1），null 不显示页码 */
  page_idx?: number | null | undefined
}

export function buildResultCopyText(opts: {
  content?: string | null | undefined
  citations?: readonly ResultCopyCitation[] | null | undefined
}): string {
  const parts: string[] = []
  const content = typeof opts.content === 'string' ? opts.content.trim() : ''
  if (content !== '') {
    parts.push(content)
  }
  const citations = Array.isArray(opts.citations) ? opts.citations : []
  const lines: string[] = []
  let emitted = 0
  citations.forEach((citation) => {
    const claim = typeof citation?.claim === 'string' ? citation.claim.trim() : ''
    const quote = typeof citation?.original_text === 'string'
      ? citation.original_text.trim()
      : ''
    const docId = typeof citation?.doc_id === 'string' ? citation.doc_id.trim() : ''
    const segments: string[] = []
    if (claim !== '') segments.push(claim)
    if (quote !== '') segments.push(`"${quote}"`)
    if (segments.length === 0 && docId === '') {
      return // 无内容行：跳过（不产生空行编号）
    }
    const meta: string[] = []
    if (docId !== '') meta.push(docId)
    if (typeof citation?.page_idx === 'number') {
      meta.push(`p. ${citation.page_idx + 1}`)
    }
    if (meta.length > 0) segments.push(meta.join(' · '))
    emitted += 1
    lines.push(`${emitted}. ${segments.join(' — ')}`)
  })
  const citationSection = lines.length > 0 ? ['Citations:', ...lines].join('\n') : ''
  return [content, citationSection].filter((part) => part !== '').join('\n\n')
}
