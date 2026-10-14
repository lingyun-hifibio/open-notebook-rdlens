/**
 * Issue #601 PR5（D-16）：以"文档"为计量单位的下游必须按 `document_id`
 * 去重；以"精确版本"为语义处（`source_scope.selected.source_ids`、引用、
 * Coverage 按来源计数）**不得**去重。
 *
 * 修掉的既有缺陷：`ComparePanel` 用 Source 行数当文档数（不去重），
 * 同文档 v1+v2 共选时"比较两份文献"退化为"同一文献与自己比较"。
 */

export interface DocumentKeyed {
  document_id: string
}

export interface DocumentCountResult {
  /** 去重后的唯一文档数 */
  uniqueDocumentCount: number
  /** 输入的 Source 行数（= 精确版本选择数） */
  selectionCount: number
  /** 去重前后不一致 = 存在同文档多版本共选 */
  mergedDuplicates: boolean
}

export function countUniqueDocuments(items: readonly DocumentKeyed[] | undefined): DocumentCountResult {
  const list = items ?? []
  const unique = new Set<string>()
  for (const item of list) {
    if (typeof item.document_id === 'string' && item.document_id) {
      unique.add(item.document_id)
    }
  }
  return {
    uniqueDocumentCount: unique.size,
    selectionCount: list.length,
    mergedDuplicates: unique.size !== list.length,
  }
}

/** 从选中 Source 集合解析唯一 `document_id` 集合（Compare 的 `document_ids` 输入） */
export function uniqueDocumentIds(items: readonly DocumentKeyed[] | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items ?? []) {
    if (typeof item.document_id === 'string' && item.document_id && !seen.has(item.document_id)) {
      seen.add(item.document_id)
      result.push(item.document_id)
    }
  }
  return result
}
