'use client'

/**
 * Issue #1046 PR4（D2-B2）：成果目录 hook（d2-v1 列表 + 词法搜索）。
 *
 * 权威依据：契约 §3（读投影）/§7.1（`GET /notes?q=`）；方案 §4.1 成果目录；
 * Lead D4/D7（目录同时包含旧未保护 Note 与 d2-v1 受保护 Note）。
 *
 * 设计要点：
 * - 使用独立查询键段 `'d2-v1'`：d2-v1 响应是旧投影的**超集**，但请求头不同
 *   即表示不同表示，不能与旧 headless 列表共用缓存（否则旧形状可能被当作
 *   d2-v1 投影消费，导致受保护 Note 被误判为未保护）；
 * - 键仍保留 `['research', projectId, 'notes', ...]` 前缀：既有
 *   `invalidateQueries({queryKey: QUERY_KEYS.researchNotes(projectId)})` 会一并
 *   刷新目录；
 * - 工作台内追加身份段（viewer/authGeneration）；旧代响应不得回填；
 * - 游标分页按服务端顺序合并，重复游标/重复 id 防御。
 */

import { useCallback, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  QUERY_KEYS,
  adminReadonlyResearchIdentity,
  ownerResearchIdentity,
  researchQueryKey,
  type ResearchQueryIdentity,
} from '@/lib/api/query-client'
import { useResearchWorkspaceOptional } from '@/lib/embedded/workspace-context'
import { collectResearchPages, RESEARCH_PAGE_LIMIT } from '@/lib/research/pagination'
import { listNotesD2, normalizeNoteApiError } from './note-client'
import type { NoteApiError, ResearchNoteD2, UseNoteCatalogResult } from './types'

/** 目录查询键（identity 段在尾部；保 `research.notes` 前缀失效）。 */
export function noteCatalogQueryKey(
  projectId: string,
  search: string,
  identity: ResearchQueryIdentity | null,
): readonly unknown[] {
  if (identity !== null) return researchQueryKey(identity, 'notes', 'd2-v1', search)
  return [...QUERY_KEYS.researchNotes(projectId), 'd2-v1', search]
}

export function useNoteCatalog(options: {
  projectId: string
  search: string
}): UseNoteCatalogResult {
  const { projectId, search } = options
  const workspace = useResearchWorkspaceOptional()
  const hasWorkspace = workspace !== null
  const identity = useMemo<ResearchQueryIdentity | null>(() => {
    if (!workspace) return null
    const generation = workspace.authGeneration ?? 0
    if (workspace.role === 'admin_readonly') {
      return adminReadonlyResearchIdentity(workspace.projectId, generation)
    }
    if (!workspace.userId) return null
    return ownerResearchIdentity(workspace.projectId, workspace.userId, generation)
  }, [workspace])
  const generationRef = useRef<number>(identity?.authGeneration ?? 0)
  generationRef.current = identity?.authGeneration ?? 0

  const queryKey = useMemo(
    () => noteCatalogQueryKey(projectId, search, identity),
    [projectId, search, identity],
  )

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const page = await collectResearchPages(
        (cursor) =>
          listNotesD2(
            projectId,
            {
              ...(search.length > 0 ? { q: search } : {}),
              limit: RESEARCH_PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            },
            signal,
          ),
        (note) => note.note_id,
      )
      if (identity !== null && generationRef.current !== identity.authGeneration) {
        throw new Error('note catalog query superseded by new auth generation')
      }
      return page.items
    },
    // 工作台内身份未确认（owner 无 viewer）时 fail-closed；孤立渲染沿用旧行为。
    enabled: !!projectId && (!hasWorkspace || identity !== null),
  })

  const items: ResearchNoteD2[] = query.data ?? []
  const error = useMemo<NoteApiError | null>(
    () => (query.error ? normalizeNoteApiError(query.error) : null),
    [query.error],
  )
  const refetch = query.refetch
  const refresh = useCallback(async (): Promise<void> => {
    await refetch()
  }, [refetch])

  return {
    items,
    isLoading: query.isLoading,
    error,
    refresh,
  }
}
