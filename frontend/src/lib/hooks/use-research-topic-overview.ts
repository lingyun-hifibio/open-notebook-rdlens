'use client'

/**
 * #1016（D1-G 主单）主题概览回访/生成 hook 组。
 *
 * 三个消费面（计划 §2.8/§2.9、WIRE_CONTRACT §4）：
 *
 * 1. `useResearchTopicOverviewCapability`：消费 `GET .../models` 的加性
 *    `capabilities.topic_overview`，**严格 `=== true`** 才渲染入口（缺失/
 *    非法/false 一律 fail-closed）；与模型目录共享同 query key/缓存，不新增
 *    请求、不新增缓存分区。
 * 2. `useResearchTopicOverview`：回访读面（Owner 专属）。空态由 API 层把
 *    404 `topic_overview_not_found` 归一为 `null`，查询本身成功；其它故障
 *    照常进入 error 态（不把故障伪装成「未生成」）。
 * 3. `useGenerateTopicOverview`：生成/更新 mutation（有界单次、无 202 分支）。
 *    每次 mutate/mutateAsync 生成**新** Idempotency-Key；`retry: 0`（失败
 *    不自动重试——409 `topic_overview_scope_exceeds_limit` 后由用户手动
 *    重试并换新键）；成功后刷新读缓存（Entry/Dialog 状态立即一致）。
 *
 * 查询键纪律（query-client DESIGN §3.2）：工作台内使用尾随身份段的判别键
 * （owner 带 viewer、Admin 只读不带 viewer），认证代际/viewer 变化后旧缓存
 * 不可见；孤立渲染（无 Provider / owner 无 viewer）沿用既有非判别键。
 *
 * 回读面范式：`staleTime: 0`、`retry: false`——概览正文与「声明范围 vs 实际
 * 纳入证据」随现行权限/来源状态变化，每次读都取当前结论；未启用/存储故障
 * 重试不会改变结果，避免重试风暴（由用户显式「重试」）。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  QUERY_KEYS,
  RESEARCH_MUTATION_OPTIONS,
  adminReadonlyResearchIdentity,
  ownerResearchIdentity,
  researchModelCatalogIdentityKey,
  researchTopicOverviewIdentityKey,
  type ResearchQueryIdentity,
} from '@/lib/api/query-client'
import { useResearchWorkspaceOptional } from '@/lib/embedded/workspace-context'
import {
  createTopicOverview,
  getTopicOverview,
  listModels,
  newIdempotencyKey,
} from '@/lib/research/api'
import type { C05RequestScope } from '@/lib/research/c05-request'
import {
  buildTopicOverviewRequest,
  readTopicOverviewCapability,
} from '@/lib/research/topic-overview'

/**
 * Entry 的「生成中」观测键：Entry 与 Dialog 是兄弟节点，Entry 只有
 * `{projectId, onOpen}` 两个 prop，无法从 Dialog 取得 `isPending`；因此
 * mutation 使用稳定 mutationKey，Entry 以
 * `useIsMutating({ mutationKey: ['research', projectId, 'topic-overview', 'generate'] }) > 0`
 * 渲染生成中/禁用。
 */
export function topicOverviewGenerateMutationKey(projectId: string): readonly unknown[] {
  return ['research', projectId, 'topic-overview', 'generate']
}

interface TopicOverviewQueryIdentity {
  identity: ResearchQueryIdentity | null
  hasWorkspace: boolean
}

/** 复用既有身份判别约定：owner 带 viewer；Admin 只读不带 viewer。 */
function useTopicOverviewQueryIdentity(): TopicOverviewQueryIdentity {
  const workspace = useResearchWorkspaceOptional()
  if (!workspace) return { identity: null, hasWorkspace: false }
  const generation = workspace.authGeneration ?? 0
  if (workspace.role === 'admin_readonly') {
    return {
      identity: adminReadonlyResearchIdentity(workspace.projectId, generation),
      hasWorkspace: true,
    }
  }
  if (!workspace.userId) return { identity: null, hasWorkspace: true }
  return {
    identity: ownerResearchIdentity(
      workspace.projectId,
      workspace.userId,
      generation,
    ),
    hasWorkspace: true,
  }
}

/**
 * 主题概览能力位（fail-closed）：仅 `capabilities.topic_overview === true`
 * 视为启用。与模型目录共享同一 query key/缓存（不新增请求）。
 */
export function useResearchTopicOverviewCapability(projectId: string): boolean {
  const { identity } = useTopicOverviewQueryIdentity()
  const modelsQuery = useQuery({
    queryKey: identity
      ? researchModelCatalogIdentityKey(identity)
      : QUERY_KEYS.researchModelCatalog(projectId),
    queryFn: () => listModels(projectId),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
  })
  return readTopicOverviewCapability(modelsQuery.data?.capabilities)
}

/**
 * 主题概览回访（Owner 专属，只读）。
 *
 * `data === null` 表示服务端明确没有概览（404 `topic_overview_not_found`），
 * 不是错误；`enabled` 允许 Dialog 关闭时不发起请求。
 */
export function useResearchTopicOverview(
  projectId: string,
  options: { enabled?: boolean } = {},
) {
  const { identity, hasWorkspace } = useTopicOverviewQueryIdentity()
  return useQuery({
    queryKey: identity
      ? researchTopicOverviewIdentityKey(identity)
      : QUERY_KEYS.researchTopicOverview(projectId),
    queryFn: ({ signal }) => getTopicOverview(projectId, { signal }),
    // 工作台内身份未确认（owner 无 viewer）时 fail-closed；孤立渲染沿用旧行为。
    enabled: !!projectId && (options.enabled ?? true) && (!hasWorkspace || identity !== null),
    // 回访按现行权限/最新概览读取：不消费旧缓存。
    staleTime: 0,
    retry: false,
  })
}

/** 生成/更新概览的 mutation 变量（请求体由 hook 经专用 builder 组装）。 */
export interface GenerateTopicOverviewVariables {
  /** 关注问题（可空；空 = 固定默认概览指令）。 */
  focus: string
  /** 本地模型 id（外部模型由既有 C-05 守卫拦截，不在此派发）。 */
  modelId: string
  /** C-05 唯一范围真源：`useResearchScope().getSnapshot()`。 */
  scope: C05RequestScope
  responseLanguage?: 'zh' | 'en'
}

/**
 * 生成/更新主题概览（POST）。`data` 为归一化后的 wire；citations/sections
 * 等展示字段与 GET 同一形状。
 *
 * 成功后：先 `setQueriesData` 立即更新已缓存概览（Entry 的 GET 状态立刻变
 * 「查看概览」），再 `invalidateQueries` 触发权威重读（现行权限/来源状态）。
 */
export function useGenerateTopicOverview(projectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    // 稳定 mutationKey（见 `topicOverviewGenerateMutationKey` 注释）。
    mutationKey: topicOverviewGenerateMutationKey(projectId),
    mutationFn: (variables: GenerateTopicOverviewVariables) => {
      const body = buildTopicOverviewRequest(variables.scope, {
        focus: variables.focus,
        modelId: variables.modelId,
        ...(variables.responseLanguage !== undefined
          ? { responseLanguage: variables.responseLanguage }
          : {}),
        // 概览无目的选择器：显式 document_qa（缺失时服务器同样缺省为它）。
        workPurpose: 'document_qa',
      })
      // 每次 mutate/mutateAsync 都是新执行：新幂等键（用户手动重试换新键，
      // 不复用 409 场景的旧键）。
      return createTopicOverview(projectId, body, {
        idempotencyKey: newIdempotencyKey(),
      })
    },
    ...RESEARCH_MUTATION_OPTIONS,
    onSuccess: (overview) => {
      const overviewKey = QUERY_KEYS.researchTopicOverview(projectId)
      // 前缀匹配所有身份段变体（owner/admin_readonly/无身份）：Entry 与
      // Dialog 共享缓存，状态立即一致。
      queryClient.setQueriesData<typeof overview>(
        { queryKey: overviewKey },
        overview,
      )
      // 权威重读：GET 会按现行权限返回 ready/restricted 投影。
      return queryClient.invalidateQueries({ queryKey: overviewKey })
    },
  })
}
