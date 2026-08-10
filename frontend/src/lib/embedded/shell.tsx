'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { createEmbeddedSession, type SessionState } from './session'
import { getEmbeddedParentOrigins } from './config'

/**
 * ResearchWorkspaceShell（UI-01，设计 §4.1/§4.2；REQ-EMB-01/02）。
 *
 * 嵌入式 iframe 的会话外壳：挂载即与父页面（RDLens 主页面）完成
 * ready 握手，等待父页面经受约束 postMessage 交付 Research Token；
 * 会话就绪后渲染工作区内容（业务面板由 UI-02/03 提供）。
 *
 * 三态：加载（booting/ready）→ 错误（error）→ 就绪（authenticated）；
 * destroy 后清空渲染（无残留）。卸载时销毁会话。
 */
export function ResearchWorkspaceShell({ children }: { children?: React.ReactNode }) {
  const { t } = useTranslation()
  const [state, setState] = useState<SessionState | null>(null)

  useEffect(() => {
    const allowedOrigins = getEmbeddedParentOrigins()
    if (allowedOrigins.length === 0) {
      // fail-closed：未配置父页面 origin 无法建立会话，不发送 ready、
      // 不接受任何消息（部署配置错误，见 PR 说明）
      setState({
        status: 'error',
        errorCode: 'session_invalid',
        errorMessage: 'parent origin is not configured',
      })
      return
    }
    const session = createEmbeddedSession({
      allowedOrigins,
      parentOrigin: allowedOrigins[0],
    })
    setState(session.getState())
    const unsubscribe = session.subscribe(setState)
    return () => {
      unsubscribe()
      session.destroy()
    }
  }, [])

  if (!state || state.status === 'booting' || state.status === 'ready') {
    return (
      <div
        role="status"
        className="flex min-h-screen flex-col items-center justify-center gap-4"
      >
        <LoadingSpinner />
        <p className="text-sm text-muted-foreground">{t('research.loading')}</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-3 px-8 text-center"
      >
        <h1 className="text-lg font-semibold">{t('research.errorTitle')}</h1>
        <p className="text-sm text-destructive">{state.errorCode}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {t('research.errorMessage')}
        </p>
      </div>
    )
  }

  if (state.status === 'destroyed') {
    return null
  }

  return <>{children}</>
}
