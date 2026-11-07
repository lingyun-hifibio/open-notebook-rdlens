/**
 * 目标工作台共享类型（W1 #1104；UI 规格 v1 §2.2/§5.6）。
 */

import type { ResearchCitationDisplayItem } from '@/lib/research/types'

/** UI-12 按需右栏：同一时刻只承担一项辅助内容，默认收起。 */
export type TargetRightPaneKind =
  | 'citation'
  | 'source'
  | 'conversations'
  | 'outcomes'
  | 'tasks'

/** UI-07 中央列：默认对话；次级操作打开既有面板作为中央次级视图。 */
export type TargetCenterView = 'conversation' | 'evidence-search' | 'compare'

/**
 * 引用预览数据（UI-13）：点击回答内引用 → 右栏预览（来源、定位、摘录）。
 * `sourceId` 可能无法解析（引用失效/权限受限时如实说明，不编造原文）。
 */
export interface TargetCitationPreview {
  citation: ResearchCitationDisplayItem
  sourceId: string | null
}

/** 右栏面板标题区（eyebrow + 标题）的稳定文案 key。 */
export const TARGET_RIGHT_PANE_TITLE_KEYS: Record<TargetRightPaneKind, string> = {
  citation: 'research.target.rightPane.citationTitle',
  source: 'research.target.rightPane.sourceTitle',
  conversations: 'research.target.rightPane.conversationsTitle',
  outcomes: 'research.target.rightPane.outcomesTitle',
  tasks: 'research.target.rightPane.tasksTitle',
}
