'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { createEmbeddedSession, type EmbeddedSession, type SessionState } from './session'
import type { SessionRuntime, SessionRuntimeTransport } from '@/lib/research/session-runtime'
import { createSessionRuntimeTransport } from '@/lib/research/session-runtime-transport'
import { createContext, useContext } from 'react'

/** PR5（D1/H8）：向子树暴露 requestIngest（面板「添加资料」按钮消费） */
const IngestRequestContext = createContext<(() => void) | null>(null)
export function useRequestIngest(): (() => void) | null {
  return useContext(IngestRequestContext)
}
import { getEmbeddedParentOrigins } from './config'
import { ResearchWorkspaceProvider } from './workspace-context'
import { ResearchSessionRuntimeProvider } from '@/lib/hooks/research-session-runtime'
import { ResearchGlobalModelProvider } from '@/lib/hooks/use-research-global-model'
import { ResearchScopeProvider } from '@/lib/research/scope'
import { useThemeStore } from '@/lib/stores/theme-store'

/**
 * ResearchWorkspaceShell（UI-01，设计 §4.1/§4.2；REQ-EMB-01/02）。
 *
 * 嵌入式 iframe 的会话外壳：挂载即与父页面（RDLens 主页面）完成
 * ready 握手，等待父页面经受约束 postMessage 交付 Research Token；
 * 会话就绪后渲染工作区内容（业务面板由 UI-02/03 提供）。
 *
 * 三态：加载（booting/ready）→ 错误（error）→ 就绪（authenticated）；
 * destroy 后清空渲染（无残留）。卸载时销毁会话。
 *
 * PR-8（6b 真实接入 P0）：认证后向 `ResearchSessionRuntimeProvider` 传入
 * bootstrap 传输——缺省为生产 `createSessionRuntimeTransport()`（真实
 * `GET /chat/sessions`），可用同一 prop 注入 mock 或显式 `null`（测试/离线
 * 场景不触网）。不改 embedded 消息、认证与主题语义。
 */
export function ResearchWorkspaceShell({
  children,
  transport,
}: {
  children?: React.ReactNode
  /**
   * 会话运行时 bootstrap 传输：`undefined`（缺省）= 生产实例；
   * `null` = 显式不接线（运行时不发起列表请求，owner 保持遮蔽）；
   * 传入对象 = 注入实现（测试）。实例保持稳定，不随渲染重建。
   *
   * 语义是**初始化参数**：Provider 在首次挂载（viewer/project 身份代际）
   * 时捕获该值，同一代际内后续重渲染不会替换 runtime 的 transport；需要
   * 换实现时请通过身份变化（重新认证）重建，而不是把 `null` 当动态开关。
   */
  transport?: SessionRuntimeTransport | null
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<SessionState | null>(null)
  const sessionRef = useRef<EmbeddedSession | null>(null)
  // 生产传输的稳定实例：useMemo 空依赖，每次挂载只创建一次，
  // 避免 Provider 因 transport 引用变化而重建 runtime（§3.4 生命周期）。
  const productionTransport = useMemo(() => createSessionRuntimeTransport(), [])
  const sessionTransport = transport === undefined ? productionTransport : transport
  // 认证失效需在 Provider 卸载前**同步** dispose 旧运行时（§3.4）：否则子
  // 组件 cleanup 只能报 'unmount'，旧 viewer 明文缓存与写入守卫会残留到
  // 下一个会话（review F1）。
  const runtimeHandleRef = useRef<SessionRuntime | null>(null)
  const setEmbeddedTheme = useThemeStore((s) => s.setEmbeddedTheme)

  // RWV2-50（RDLens #363）：父页主题仅在 authenticated 会话存续期间应用；
  // 离开 authenticated（logout/error/destroyed/卸载）一律还原独立 fallback。
  // 派生值不变时 store 侧 early-return，无冗余通知。
  const embeddedTheme = state?.status === 'authenticated' ? (state.embeddedTheme ?? null) : null
  useEffect(() => {
    setEmbeddedTheme(embeddedTheme)
  }, [embeddedTheme, setEmbeddedTheme])
  useEffect(() => () => setEmbeddedTheme(null), [setEmbeddedTheme])

  useEffect(() => {
    const allowedOrigins = getEmbeddedParentOrigins()
    if (allowedOrigins.length === 0) {
      // fail-closed：未配置父页面 origin 无法建立会话，不发送 ready、
      // 不接受任何消息（部署配置错误，见 PR 说明）
      setState({
        status: 'error',
        authEpoch: 0,
        errorCode: 'session_invalid',
        errorMessage: 'parent origin is not configured',
      })
      return
    }
    const session = createEmbeddedSession({
      allowedOrigins,
      parentOrigin: allowedOrigins[0],
    })
    sessionRef.current = session
    const initialState = session.getState()
    setState(initialState)
    const previousStateRef = { current: initialState as SessionState }
    const unsubscribe = session.subscribe((next) => {
      const previous = previousStateRef.current
      previousStateRef.current = next
      const runtime = runtimeHandleRef.current
      if (runtime) {
        const hadIdentity =
          previous.userId !== undefined &&
          previous.projectId !== undefined &&
          previous.role !== undefined
        const hasIdentity =
          next.userId !== undefined && next.projectId !== undefined && next.role !== undefined
        if (hadIdentity && !hasIdentity) {
          // logout / destroy（含曾认证后 error）：先失效写入并清本机分区，
          // 再让子树卸载。
          runtime.dispose('logout')
        } else if (
          previous.userId !== undefined &&
          next.userId !== undefined &&
          previous.userId !== next.userId
        ) {
          // viewer 变化：旧实例按 viewer-change 语义失效并清理旧 viewer 分区；
          // 项目切换由 Provider key 重建 runtime（旧实例走 unmount 语义），
          // 不得按换人清理同 viewer 的旧项目未同步草稿（review R4）。
          runtime.dispose('viewer-change')
        }
      }
      setState(next)
    })
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

  if (state.status === 'destroyed') {
    return null
  }

  // 认证后的身份元组（claims 注入）。第三批 PR-1：`error` 时若此前已认证
  // 成功，session.ts 会保留最后身份；此时保持 Provider 挂载并遮蔽
  // （DESIGN §3.2 / L1121），未认证过的 error 仍走纯错误页。
  const identity =
    state.userId !== undefined && state.projectId !== undefined && state.role !== undefined
      ? { userId: state.userId, projectId: state.projectId, role: state.role }
      : null

  const errorPanel =
    state.status === 'error' ? (
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
    ) : null

  if (identity === null) {
    return errorPanel
  }

  const masked = errorPanel !== null
  const authGeneration = state.authEpoch

  // UI-02：认证后把 Token claims 中的 projectId/role 注入工作台上下文
  // （Gateway 路径与 Owner 写/Admin 只读矩阵数据源）。
  // Issue #243 GMOD-FE-01：全局模型 provider 挂在已认证根节点，向下统一
  // 提供 confirmed 模型、Search 上下文默认值与外发 consent single-flight
  // guard（计划 §6.1/§6.8）；未认证时不挂载，避免空 projectId 查询。
  // R2-H8 修复：IngestRequestContext.Provider 必须真实包裹——否则
  // useRequestIngest 恒 null，「添加资料」按钮永远隐藏。
  // 第三批 PR-1：新增 authGeneration 透传（DESIGN §3.2）与会话运行时
  // Provider（§3.4：挂在已认证根节点、存活于项目工作区生命周期）。
  return (
    <IngestRequestContext.Provider value={() => sessionRef.current?.requestIngest()}>
      <ResearchWorkspaceProvider
        userId={identity.userId}
        projectId={identity.projectId}
        role={identity.role}
        authGeneration={authGeneration}
      >
        <ResearchSessionRuntimeProvider
          // viewer/project 变化必须重建 runtime 实例：旧实例已 dispose，
          // 复用会被拒绝 updateAuth/start（review N1）；authGeneration
          // 刷新同一 viewer 不换 key（保留 editor store/内存脏稿）。
          key={`${identity.userId}:${identity.projectId}`}
          authGeneration={authGeneration}
          projectId={identity.projectId}
          viewerUserId={identity.userId}
          role={identity.role}
          masked={masked}
          runtimeHandleRef={runtimeHandleRef}
          transport={sessionTransport}
        >
          <ResearchScopeProvider userId={identity.userId} projectId={identity.projectId}>
            <ResearchGlobalModelProvider>
              {errorPanel ?? children}
            </ResearchGlobalModelProvider>
          </ResearchScopeProvider>
        </ResearchSessionRuntimeProvider>
      </ResearchWorkspaceProvider>
    </IngestRequestContext.Provider>
  )
}
