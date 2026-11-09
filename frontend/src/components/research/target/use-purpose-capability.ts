'use client'

/**
 * W1 #1106 PR-B：composer「本次用途」能力位（fail-closed）。
 *
 * 消费 GET `/v1/research/projects/{project_id}/models` 顶层加性
 * `capabilities.purpose_inference`（PR-A 只在 inference flag on 且 D1-C on
 * 时出现且为 true）。与 `useResearchGlobalModel`/搜索历史共用同一
 * identity 判别 query key，不产生额外请求；缺失/非法/旧后端 → false。
 *
 * 目标壳从 TargetShell 注入 `useTargetConversation`，避免改公共模型 hook
 * （#1106 PR-B 写作用域只覆盖 target 目录与列出的 lib 文件）。
 */

import { useQuery } from '@tanstack/react-query'

import {
  QUERY_KEYS,
  adminReadonlyResearchIdentity,
  ownerResearchIdentity,
  researchModelCatalogIdentityKey,
} from '@/lib/api/query-client'
import { useResearchWorkspaceOptional } from '@/lib/embedded/workspace-context'
import { listModels } from '@/lib/research/api'
import { readPurposeInferenceCapability } from '@/lib/research/types'

export function useResearchPurposeCapability(projectId: string): boolean {
  const workspace = useResearchWorkspaceOptional()
  const generation = workspace?.authGeneration ?? 0
  const identity = workspace === null || workspace === undefined
    ? null
    : workspace.role === 'admin_readonly'
      ? adminReadonlyResearchIdentity(projectId, generation)
      : workspace.userId
        ? ownerResearchIdentity(projectId, workspace.userId, generation)
        : null
  const modelsQuery = useQuery({
    queryKey: identity
      ? researchModelCatalogIdentityKey(identity)
      : QUERY_KEYS.researchModelCatalog(projectId),
    queryFn: () => listModels(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })
  return readPurposeInferenceCapability(modelsQuery.data?.capabilities)
}
