'use client'

/**
 * #1125（owner 2026-11-09「选A」，defect 修复）：主题概览在默认目标壳的接入点。
 *
 * 缺陷事实：`TopicOverviewEntry` + `TopicOverviewDialog`（#1016）此前只在
 * legacy 壳 `ResearchWorkspace`（`legacy=1` iframe）挂载；`/research` 默认
 * 目标壳 `TargetShell` 没有概览入口 → UI 规格 v1 BEH-12 / §5.4 /
 * D-UI-04=A（「轻量概览入口/内容位于中央对话起始位置，可回访卡片，
 * 不打开右栏、不新增一级导航」）在默认路径不可达。
 *
 * 本组件只做目标壳接线，不复制业务语义：
 * - 本地 `topicOverviewOpen`（与 legacy 一致：入口卡与 Dialog 兄弟、local
 *   state；不新增路由/右栏面板/一级导航/主区动作）；
 * - 复用既有 `TopicOverviewEntry`（能力位 fail-closed、Admin 只读隐藏、
 *   无概览→生成 / 已有→查看、范围摘要与时间、资料变化提示）；
 * - 复用既有 `TopicOverviewDialog`（四段正文/限制/canonical 引用、受限
 *   占位、生成与更新、409 换键提示；语义零改动）——不改 wire、hooks 或
 *   后端调用；
 * - `onCitationJump` → 目标壳既有引用跳转（右栏来源预览，W1 BEH-05；
 *   不新增原文阅读器，Dialog 内既有降级文案保持不变）；
 * - `editorHandle` → 目标壳既有 `useTargetConversation().editor.setDraftText`
 *   （「继续讨论」只写当前会话草稿，不新增 Chat/session wire）；
 * - `canExecute`/`blockedHint` 与 shell 同源（`TargetConversationState`），
 *   `isAdminReadonly` 来自 shell 的 workspace role，
 *   `confirmedModelIsExternal` 来自 shell 已有的 `useResearchGlobalModel()`
 *   ——概览生成与既有 Chat/Search 走同一条 `runGuarded` 链。
 *
 * 诚实边界（W1）：不绘制 W2/W3 阅读/编辑能力，不因本接入改变右栏行为。
 */

import { useMemo, useState } from 'react'

import { TopicOverviewEntry } from '../TopicOverviewEntry'
import { TopicOverviewDialog } from '../TopicOverviewDialog'

export interface TargetTopicOverviewProps {
  projectId: string
  /** 目标壳既有引用跳转（TargetShell `handleCitationJump` → 右栏来源预览）。 */
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
  /** 目标壳当前会话编辑器（`conversation.editor`）；null = 不显示继续讨论。 */
  editorHandle?: { setDraftText: (text: string) => void } | null
  /** 与 composer/次级操作同源的执行门禁（`conversation.canExecute`）。 */
  canExecute: boolean
  /** 禁用原因（`conversation.blockedHint`；与 composer 同源文案）。 */
  blockedHint?: string | null
  /** shell 的 workspace role：Admin 只读隐藏（与 legacy 一致，fail-closed）。 */
  isAdminReadonly: boolean
  /** 外部模型在 C-05 概览路径不可达：禁用生成/更新，不派发（同 legacy）。 */
  confirmedModelIsExternal: boolean
}

export function TargetTopicOverview({
  projectId,
  onCitationJump,
  editorHandle = null,
  canExecute,
  blockedHint = null,
  isAdminReadonly,
  confirmedModelIsExternal,
}: TargetTopicOverviewProps) {
  // 入口与 Dialog 是兄弟节点：open state 由本组件拥有（与 legacy 相同），
  // 不开右栏、不进路由、不提升到 shell/全局 store。
  const [topicOverviewOpen, setTopicOverviewOpen] = useState(false)

  // HIGH-1（round-1 审查）：概览 Dialog 是 Radix **modal**（fixed overlay
  // z-50），目标壳右栏来源预览无 z-index，若 Dialog 不关，跳转后的右栏被
  // 遮住、用户不可见/不可交互。跳转时先关闭概览 Dialog（同一次事件内），
  // 再交给 shell 既有 `handleCitationJump`（W1 右栏来源预览，不新增阅读器）。
  const handleCitationJump = (sourceId: string, pageIdx: number | null): void => {
    setTopicOverviewOpen(false)
    onCitationJump(sourceId, pageIdx)
  }

  // MEDIUM-1（round-1 审查）：「继续讨论」写的是当前会话草稿，Dialog 不关
  // 则用户看不到草稿；写入后关闭 Dialog（composer 在中央列底部可见）。
  // 无活动会话时 shell 传 `editorHandle=null`（fail-closed）→ Dialog 不渲染
  // 该动作（沿用 #1016「无 editorHandle 不显示」语义），不出现静默 no-op。
  const draftHandle = useMemo(
    () =>
      editorHandle === null || editorHandle === undefined
        ? null
        : {
            setDraftText: (text: string) => {
              editorHandle.setDraftText(text)
              setTopicOverviewOpen(false)
            },
          },
    [editorHandle],
  )

  return (
    <>
      <TopicOverviewEntry
        projectId={projectId}
        onOpen={() => setTopicOverviewOpen(true)}
      />
      <TopicOverviewDialog
        projectId={projectId}
        open={topicOverviewOpen}
        onOpenChange={setTopicOverviewOpen}
        onCitationJump={handleCitationJump}
        editorHandle={draftHandle}
        canExecute={canExecute}
        blockedHint={blockedHint}
        isAdminReadonly={isAdminReadonly}
        confirmedModelIsExternal={confirmedModelIsExternal}
      />
    </>
  )
}
