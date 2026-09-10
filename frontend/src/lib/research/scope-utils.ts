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
import type { ResearchNote, ResearchSource } from '@/lib/types/research'
import { listNotes, listSources } from '@/lib/research/api'
import { collectResearchPages } from '@/lib/research/pagination'

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

export interface ResolvedResearchScope {
  sourceIds: string[]
  noteIds: string[]
  staleSourceCount: number
}

/** Empty scope is a typed, pre-dispatch rejection, never a broadening hint. */
export class EmptyEffectiveScopeError extends Error {
  readonly code = 'empty_effective_scope'

  constructor() {
    super('research scope has no effective Source or Note')
    this.name = 'EmptyEffectiveScopeError'
  }
}

function stableUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

function requireEffectiveScope(scope: ResolvedResearchScope): ResolvedResearchScope {
  if (scope.sourceIds.length + scope.noteIds.length === 0) {
    throw new EmptyEffectiveScopeError()
  }
  return scope
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
): Promise<ResolvedResearchScope> {
  if (snapshot.mode === 'selected') {
    return requireEffectiveScope({
      sourceIds: stableUnique(snapshot.sourceIds),
      noteIds: stableUnique(snapshot.noteIds),
      staleSourceCount: 0,
    })
  }
  const sources = await collectResearchPages<ResearchSource>(
    (cursor) => fetchers.listSources(projectId, {
      limit: ENUMERATION_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
    (item) => item.source_id,
  )
  const notes = await collectResearchPages<ResearchNote>(
    (cursor) => fetchers.listNotes(projectId, {
      limit: ENUMERATION_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
    (item) => item.note_id,
  )
  const selectableSources = sources.items.filter(
    (source) => source.status === 'ready' || source.status === 'stale',
  )
  return requireEffectiveScope({
    sourceIds: selectableSources.map((source) => source.source_id),
    noteIds: notes.items.map((note) => note.note_id),
    staleSourceCount: selectableSources.filter(
      (source) => source.status === 'stale',
    ).length,
  })
}
