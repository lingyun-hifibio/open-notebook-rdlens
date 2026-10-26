'use client'

/**
 * 研究会话运行时 Provider（RDLens #602 第三批 PR-1）。
 *
 * 规范来源：DESIGN §3.2（authGeneration 透传）、§3.4（运行时所有权/StrictMode/SSR）、
 * §9.2（Provider/useResearchSessionRuntime/useSessionSnapshot）、02 §8。
 *
 * 关键约束：
 * - provider 位于**已认证**根节点（shell），存活于项目工作区生命周期，
 *   不随 Tab/面板/Source 销毁（§3.4）；
 * - StrictMode 双挂载：第一次清理只中止本地读取/释放订阅（本骨架等价于
 *   取消延迟 dispose），第二次复用同一 runtime，bootstrap 按代际/项目去重；
 * - SSR：server snapshot 为模块级稳定空值，不在 render 阶段读浏览器存储；
 * - 认证切换（token refresh、viewer 变化）通过 `updateAuth` 驱动：
 *   同 viewer refresh 保留内存 dirty 与活动会话，viewer 变化立即遮蔽并清除。
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import {
  createSessionRuntime,
  getSessionRuntimeServerSnapshot,
  type SessionRuntime,
  type SessionRuntimeSnapshot,
  type SessionRuntimeTransport,
  type SessionRuntimeRole,
} from '@/lib/research/session-runtime'
import type { SessionCacheStorage } from '@/lib/research/session-cache'

export interface ResearchSessionRuntimeProviderProps {
  /** `SessionState.authEpoch`（认证代际，必须显式递增）。 */
  readonly authGeneration: number
  readonly projectId: string
  /** 已认证 viewer（claims.sub）；owner 必需，Admin 只读可缺省。 */
  readonly viewerUserId?: string | null
  readonly role: SessionRuntimeRole
  /** PR-1 默认未接线；测试/后续 PR 注入 bootstrap 端口。 */
  readonly transport?: SessionRuntimeTransport | null
  /** 测试注入存储；省略时解析 window.localStorage。 */
  readonly storage?: SessionCacheStorage | null
  /** 遮蔽态（曾认证后 error/refresh 失败时仍保持 Provider 挂载，§3.2）。 */
  readonly masked?: boolean
  /** 显式 QueryClient（缺省取最近的 QueryClientProvider）。 */
  readonly queryClient?: QueryClient | null
  readonly children?: ReactNode
}

interface RuntimeContextValue {
  readonly runtime: SessionRuntime
}

const ResearchSessionRuntimeContext = createContext<RuntimeContextValue | null>(null)

export function ResearchSessionRuntimeProvider(
  props: ResearchSessionRuntimeProviderProps,
): ReactNode {
  const {
    authGeneration,
    projectId,
    viewerUserId = null,
    role,
    transport = null,
    storage,
    masked = false,
    queryClient: explicitQueryClient,
    children,
  } = props
  const contextClient = useContext(QueryClientContext)
  const queryClient = explicitQueryClient !== undefined ? explicitQueryClient : contextClient ?? null

  const runtimeRef = useRef<SessionRuntime | null>(null)
  if (runtimeRef.current === null) {
    runtimeRef.current = createSessionRuntime({
      authGeneration,
      projectId,
      viewerUserId,
      role,
      queryClient,
      storage,
      transport,
    })
  }
  const runtime = runtimeRef.current
  const mountedRef = useRef(false)

  // 认证代际/项目/viewer/role 变化：运行时自行保留或清理内存态。
  useEffect(() => {
    runtime.updateAuth({ authGeneration, projectId, viewerUserId, role })
  }, [runtime, authGeneration, projectId, viewerUserId, role])

  // 遮蔽态：曾认证后进入 error 时保持挂载但遮蔽读取（§3.2）。
  useEffect(() => {
    runtime.setMasked(masked)
  }, [runtime, masked])

  // 启动/清理：StrictMode 第一次清理只安排“可撤销”的 unmount dispose，
  // 若同一次提交内重新挂载（mountedRef 重新置 true），microtask 会跳过 dispose。
  useEffect(() => {
    mountedRef.current = true
    runtime.start()
    return () => {
      mountedRef.current = false
      queueMicrotask(() => {
        if (!mountedRef.current) runtime.dispose('unmount')
      })
    }
  }, [runtime])

  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    getSessionRuntimeServerSnapshot,
  )

  const valueRef = useRef<RuntimeContextValue>({ runtime })
  valueRef.current = { runtime }

  // snapshot 仅用于保持 Provider 自身订阅（便于诊断/后续 PR 的门禁渲染）；
  // 消费者应通过 useSessionSnapshot 订阅。
  void snapshot

  return (
    <ResearchSessionRuntimeContext.Provider value={valueRef.current}>
      {children}
    </ResearchSessionRuntimeContext.Provider>
  )
}

/** 读取运行时实例；无 Provider 时抛错（与 workspace-context 一致）。 */
export function useResearchSessionRuntime(): SessionRuntime {
  const value = useContext(ResearchSessionRuntimeContext)
  if (!value) {
    throw new Error('research session runtime is not available')
  }
  return value.runtime
}

/** 可选读取（用于可独立测试的叶子组件）。 */
export function useResearchSessionRuntimeOptional(): SessionRuntime | null {
  return useContext(ResearchSessionRuntimeContext)?.runtime ?? null
}

/**
 * 订阅运行时快照（`useSyncExternalStore`）。
 * server snapshot 为模块级冻结常量，SSR/水合首帧稳定。
 */
export function useSessionSnapshot(): SessionRuntimeSnapshot {
  const value = useContext(ResearchSessionRuntimeContext)
  const runtime = value?.runtime ?? null
  const subscribe = runtime ? runtime.subscribe : subscribeNoop
  const getSnapshot = runtime ? runtime.getSnapshot : getSessionRuntimeServerSnapshot
  return useSyncExternalStore(subscribe, getSnapshot, getSessionRuntimeServerSnapshot)
}

function subscribeNoop(): () => void {
  return () => {}
}

export type { SessionRuntimeSnapshot }
