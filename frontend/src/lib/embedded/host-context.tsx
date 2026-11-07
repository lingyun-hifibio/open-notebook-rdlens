'use client'

import { createContext, useContext } from 'react'
import type { HostLanguage } from './messages'

/**
 * W1 宿主契约 v1：父页面经嵌入会话协议下发的宿主级上下文。
 *
 * - `language`：宿主级语言偏好（D-UI-02），工作台不设第二套语言开关；
 *   语言应用本身由 shell 通过 i18next `changeLanguage` 完成，本上下文只
 *   提供当前生效值（渲染/测试可观察）。
 * - `projectName`：宿主项目可读名（D-UI-01，token/refresh 可选字段）；
 *   `null` 表示宿主未提供（顶栏回退到通用「Research」，不伪造身份）。
 *
 * 本上下文与主题一样**只在 authenticated 会话存续期间**由 shell 提供；
 * 无 Provider（旧测试/孤立渲染）时读取返回 `null`，调用方自行回退。
 */

export interface ResearchHostValue {
  /** 宿主下发并已应用的语言；null = 未收到 language 消息（嵌入式默认 en-US） */
  language: HostLanguage | null
  /** 宿主项目可读名；null = 缺失/未认证（不伪造项目身份） */
  projectName: string | null
}

const ResearchHostContext = createContext<ResearchHostValue | null>(null)

export function ResearchHostProvider({
  language,
  projectName,
  children,
}: {
  language?: HostLanguage | null
  projectName?: string | null
  children: React.ReactNode
}): React.ReactNode {
  const value: ResearchHostValue = {
    language: language ?? null,
    projectName: projectName ?? null,
  }
  return (
    <ResearchHostContext.Provider value={value}>{children}</ResearchHostContext.Provider>
  )
}

/** 读取宿主上下文；无 Provider 返回 null（fail-open 到通用文案，不抛错）。 */
export function useResearchHostOptional(): ResearchHostValue | null {
  return useContext(ResearchHostContext)
}

/** 严格读取（顶栏等必须有宿主上下文的组件）；无 Provider 抛错。 */
export function useResearchHost(): ResearchHostValue {
  const value = useContext(ResearchHostContext)
  if (value === null) {
    throw new Error('research host context is not available')
  }
  return value
}
