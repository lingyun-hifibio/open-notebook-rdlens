'use client'

/**
 * Issue #1046 PR4（D2-B2）：服务端能力投影读取（方案 §8.2，D4）。
 *
 * 权威依据：契约 §7（`note_editor` / `note_editor_existing` /
 * `markdown_export` / `writing_local` / `writing_external` 加性键，形状
 * `{available: bool, reason: str|null}`）；Lead D4：复用既有 /models 查询键
 * 共享缓存、失败 fail-closed、绝不按环境变量/开关名推断。
 *
 * 解析规则：
 * - 键缺失/形状非法 → `{available:false, reason:'capability_unknown'}`（fail-closed）；
 * - available=true 时 reason 原则上为 null；available=false 且无 reason →
 *   `capability_unknown`（UI 映射兜底文案）；
 * - /models 请求失败 → `capabilities:null` + `error`（UI 显示明确阻断态与重试，
 *   d2-v1 文档不得退回无 revision 旧表单；旧未保护 Note 行为不变）。
 */

import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  QUERY_KEYS,
  adminReadonlyResearchIdentity,
  ownerResearchIdentity,
  researchModelCatalogIdentityKey,
  type ResearchQueryIdentity,
} from '@/lib/api/query-client'
import { useResearchWorkspaceOptional } from '@/lib/embedded/workspace-context'
import { listModels } from '@/lib/research/api'
import { normalizeNoteApiError } from './note-client'
import type {
  NoteApiError,
  NoteCapabilities,
  NoteCapability,
  NoteCapabilitiesResult,
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 单个能力位严格解析（缺失/畸形 → 不可用 + capability_unknown）。 */
export function readNoteCapability(raw: unknown): NoteCapability {
  if (!isRecord(raw) || typeof raw.available !== 'boolean') {
    return { available: false, reason: 'capability_unknown' }
  }
  const reason = typeof raw.reason === 'string' && raw.reason.length > 0 ? raw.reason : null
  if (raw.available) return { available: true, reason }
  return { available: false, reason: reason ?? 'capability_unknown' }
}

/** `/models.capabilities` 原始块 → 冻结的 camelCase 能力投影。 */
export function readNoteCapabilities(raw: unknown): NoteCapabilities {
  const record = isRecord(raw) ? raw : {}
  return {
    noteEditor: readNoteCapability(record.note_editor),
    noteEditorExisting: readNoteCapability(record.note_editor_existing),
    markdownExport: readNoteCapability(record.markdown_export),
    writingLocal: readNoteCapability(record.writing_local),
    writingExternal: readNoteCapability(record.writing_external),
  }
}

/** 当前工作台身份（owner 带 viewer/Admin 只读不带；无 Provider → null）。 */
function useResearchIdentity(): {
  identity: ResearchQueryIdentity | null
  hasWorkspace: boolean
} {
  const workspace = useResearchWorkspaceOptional()
  const identity = useMemo<ResearchQueryIdentity | null>(() => {
    if (!workspace) return null
    const generation = workspace.authGeneration ?? 0
    if (workspace.role === 'admin_readonly') {
      return adminReadonlyResearchIdentity(workspace.projectId, generation)
    }
    if (!workspace.userId) return null
    return ownerResearchIdentity(workspace.projectId, workspace.userId, generation)
  }, [workspace])
  return { identity, hasWorkspace: workspace !== null }
}

export function useNoteCapabilities(projectId: string): NoteCapabilitiesResult {
  const { identity, hasWorkspace } = useResearchIdentity()
  // 复用既有 /models 查询键（与 use-research-global-model / useResearchC05 /
  // useResearchD1e 共享缓存、零额外请求）；身份段保证旧代缓存不可见。
  const queryKey = useMemo(
    () =>
      identity
        ? researchModelCatalogIdentityKey(identity)
        : QUERY_KEYS.researchModelCatalog(projectId),
    [identity, projectId],
  )
  const query = useQuery({
    queryKey,
    queryFn: () => listModels(projectId),
    enabled: !!projectId && (!hasWorkspace || identity !== null),
    refetchOnWindowFocus: true,
  })

  const capabilities = useMemo<NoteCapabilities | null>(() => {
    if (query.data === undefined) return null
    return readNoteCapabilities(
      (query.data as { capabilities?: unknown } | undefined)?.capabilities,
    )
  }, [query.data])

  const error = useMemo<NoteApiError | null>(
    () => (query.error ? normalizeNoteApiError(query.error) : null),
    [query.error],
  )

  const refetch = query.refetch
  const refresh = useCallback(async (): Promise<void> => {
    await refetch()
  }, [refetch])

  return {
    capabilities: query.data === undefined ? null : capabilities,
    isLoading: query.isLoading,
    error,
    refresh,
  }
}
