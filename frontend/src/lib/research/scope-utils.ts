/**
 * RWV2-12：Transformation 运行的共享 Scope 解析工具。
 *
 * - `detectResponseLanguage`：RFC §4.2 检测规则——Transformation 无独立
 *   Run instruction，按模板单 Prompt 检测；与 RDLens `agent/prompts.py`
 *   `detect_lang` 同语义（CJK 计数 > ASCII 字母 → zh，否则 en）。请求
 *   字段/后端快照由 RWV2-M3（RWV2-31）接线，本工具只在派发时刻固定值。
 * - `resolveScopeSelection`：把共享 Scope 快照解析为显式
 *   `sourceIds`/`noteIds` 全集。`entire_project` 经分页枚举全部授权
 *   source/note（limit=100 + cursor，后端分页上限 1..100）；`selected`
 *   原样透传副本。解析结果在派发时一次性冻结，供 runGuarded 与请求
 *   载荷共用（不能二次解析，否则在途快照会漂移）。
 */

import type { ResearchScopeSnapshot } from '@/lib/research/scope'
import type { ResearchNote, ResearchPage, ResearchSource } from '@/lib/types/research'
import { listNotes, listSources } from '@/lib/research/api'

export interface ScopeSelectionFetchers {
  listSources: typeof listSources
  listNotes: typeof listNotes
}

const ENUMERATION_PAGE_SIZE = 100

/** RFC §4.2：CJK（U+4E00-U+9FFF）多于 ASCII 字母 → 'zh'，否则 'en'。 */
export function detectResponseLanguage(text: string): 'zh' | 'en' {
  let cjk = 0
  let asciiAlpha = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk += 1
    } else if (/[a-zA-Z]/.test(ch)) {
      asciiAlpha += 1
    }
  }
  return cjk > asciiAlpha ? 'zh' : 'en'
}

/**
 * 游标分页收集全部 id（契约 §3.4 keyset 分页）。
 *
 * 终止条件：`next_cursor === null`；并显式断言游标严格前进——keyset
 * 单调性是后端实现保证，前端不依赖「同 cursor 重复出现」的未定义语义，
 * 一旦游标不前进按协议错误抛错，避免无界翻页。
 */
async function collectIds<T>(
  fetchPage: (cursor: string | null) => Promise<ResearchPage<T>>,
  pickId: (item: T) => string,
): Promise<string[]> {
  const ids: string[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const page = await fetchPage(cursor)
    for (const item of page.items) {
      const id = pickId(item)
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    if (page.next_cursor === null) break
    if (page.next_cursor === cursor) {
      throw new Error('pagination cursor did not advance')
    }
    cursor = page.next_cursor
  }
  return ids
}

/**
 * 把 Scope 快照解析为显式 Source/Note id 全集（派发时调用一次并冻结）。
 *
 * - `selected`：原样返回副本（与快照不共享引用，防冻结数组泄漏）。
 * - `entire_project`：分页枚举项目全部授权 source/note；空项目返回
 *   空列表由调用方阻断引导；枚举中途失败向上冒泡（调用方 toast）。
 */
export async function resolveScopeSelection(
  projectId: string,
  snapshot: ResearchScopeSnapshot,
  fetchers: ScopeSelectionFetchers = { listSources, listNotes },
): Promise<{ sourceIds: string[]; noteIds: string[] }> {
  if (snapshot.mode === 'selected') {
    return {
      sourceIds: [...snapshot.sourceIds],
      noteIds: [...snapshot.noteIds],
    }
  }
  const sourceIds = await collectIds<ResearchSource>(
    (cursor) =>
      fetchers.listSources(projectId, {
        limit: ENUMERATION_PAGE_SIZE,
        ...(cursor !== null ? { cursor } : {}),
      }),
    (item) => item.source_id,
  )
  const noteIds = await collectIds<ResearchNote>(
    (cursor) =>
      fetchers.listNotes(projectId, {
        limit: ENUMERATION_PAGE_SIZE,
        ...(cursor !== null ? { cursor } : {}),
      }),
    (item) => item.note_id,
  )
  return { sourceIds, noteIds }
}
