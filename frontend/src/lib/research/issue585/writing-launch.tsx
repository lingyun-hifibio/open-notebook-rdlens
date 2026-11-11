'use client'

/**
 * Issue #1048 PR7（D2-B4）：写作入口的会话导航上下文。
 *
 * Notes 编辑器位于工作台左栏，写作入口需要知道“当前显示的会话”与“新建会话
 * 保存后的激活方式”。这些状态由页面级组合根（`app/research/page.tsx`）持有，
 * 因此用窄 context 注入——不改动两个 Chat 面板的既有职责。
 *
 * 无 Provider 的宿主（单元测试/旧壳）返回 null：对话框只能新建全局会话或在
 * 无当前会话时显示明确原因，绝不猜测/伪造当前会话。
 */

import { createContext, useContext } from 'react'
import type { ResearchSessionRef } from '@/lib/research/session-contract'

export interface WritingLaunchValue {
  /** 当前显示中的会话（source focus 时是 source 会话；否则 global）。 */
  readonly currentRef: ResearchSessionRef | null
  /** 当前 source surface 的来源 id（null = global surface）。 */
  readonly sourceId: string | null
  /**
   * 激活一个会话（新建/选择后显示；**不**发送）。返回 false 表示导航被拒绝
   * （无 runtime/身份失效），调用方应如实提示而不是假装已打开。
   */
  readonly openSession: (ref: ResearchSessionRef) => boolean
}

const WritingLaunchContext = createContext<WritingLaunchValue | null>(null)

export function WritingLaunchProvider({
  value,
  children,
}: {
  value: WritingLaunchValue
  children: React.ReactNode
}): React.ReactNode {
  return (
    <WritingLaunchContext.Provider value={value}>
      {children}
    </WritingLaunchContext.Provider>
  )
}

/** 可选读取；无 Provider 返回 null（写作入口 fail-closed 到“新全局会话”）。 */
export function useWritingLaunchOptional(): WritingLaunchValue | null {
  return useContext(WritingLaunchContext)
}
