'use client'

/**
 * 研究会话编辑器 hook（RDLens #602 第三批 PR-3）。
 *
 * 规范来源：DESIGN §5（编辑状态与保存协议）、§9.2（EditorHandle）、§3.2（认证代际）。
 *
 * 本 hook 是「运行时 → 编辑器控制器」的接线层：
 * - 每次文档实例（刷新/新标签/复制标签）生成新的 writerId（本机草稿分支）；
 * - transport 用当前运行时代际的身份组装，只返回原始 JSON，解析在 editor-machine；
 * - 组件卸载/会话切换时释放控制器（尽力写本机草稿，不发服务端 cancel）；
 * - 状态机、CAS 保存队列、hold/release、清稿协议全部在 editor-machine.ts。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getEditorState, putEditorState, type EditorStateTarget } from '@/lib/research/api'
import {
  type EditorController,
  type EditorTransport,
  type SubmissionReadiness,
} from '@/lib/research/editor-machine'
import { createDraftWriterId, type SessionCacheStorage } from '@/lib/research/session-cache'
import type {
  ResearchSessionKind,
  ResearchSessionRef,
  WireChatAnchor,
  WireReaderAnchor,
} from '@/lib/research/session-contract'
import type {
  AcceptedReceipt,
  ClearOutcome,
  EditorFlushReason,
  EditorHold,
  EditorSnapshot,
  SaveOutcome,
  ScopeEdit,
} from '@/lib/research/types'
import { useResearchSessionRuntimeOptional } from './research-session-runtime'

/** hook 入参；`kind=source` 时必须提供 `sourceId`。 */
export interface UseResearchEditorOptions {
  readonly kind: ResearchSessionKind
  readonly sessionId: string
  /** `kind=source` 时必填（绑定来源，不可变）。 */
  readonly sourceId?: string | null
  /** false 时不创建控制器（例如会话尚未存在）。 */
  readonly enabled?: boolean
  /** 仅测试注入：本机草稿存储。 */
  readonly storage?: SessionCacheStorage | null
}

/** hook 返回值；控制器操作在未就绪时为安全空操作。 */
export interface UseResearchEditorResult {
  /** `null` 表示尚未接线（无运行时/未启用/ref 不完整）。 */
  readonly snapshot: EditorSnapshot | null
  readonly controller: EditorController | null
  readonly transportWired: boolean
  setDraftText(text: string): void
  setScope(edit: ScopeEdit): void
  setChatAnchor(anchor: WireChatAnchor | null): void
  setReaderAnchor(anchor: WireReaderAnchor | null): void
  flush(reason: EditorFlushReason): Promise<SaveOutcome>
  hold(reason: EditorHold['reason'], operationId: string): void
  release(operationId: string): void
  retrySave(): Promise<SaveOutcome>
  adoptServerVersion(): Promise<SaveOutcome>
  saveLocalOverServer(): Promise<SaveOutcome>
  clearAfterSubmission(receipt: AcceptedReceipt, operationId: string): Promise<ClearOutcome>
  markTokenConsumed(token: string): void
  canSubmit(): SubmissionReadiness
  restoreDraft(writerId: string): void
  refreshDraftCandidates(): void
  releaseDocument(): void
}

const BLOCKED: SaveOutcome = 'blocked'
const INVALID: ClearOutcome = 'invalid'
const NOT_LOADED: SubmissionReadiness = { allowed: false, reason: 'not_loaded' }

/**
 * 取某研究会话的编辑器控制器。
 *
 * 调用方必须处在 `ResearchSessionRuntimeProvider` 内；无 Provider 时返回空操作。
 */
export function useResearchEditor(options: UseResearchEditorOptions): UseResearchEditorResult {
  const runtime = useResearchSessionRuntimeOptional()
  const enabled = options.enabled ?? true
  const kind = options.kind
  const sessionId = options.sessionId
  const sourceId = kind === 'source' ? (options.sourceId ?? null) : null

  const runtimeSnapshot = runtime === null ? null : runtime.getSnapshot()
  const projectId = runtimeSnapshot === null ? null : runtimeSnapshot.projectId
  const usable =
    enabled && runtime !== null && projectId !== null && (kind !== 'source' || sourceId !== null)

  // 文档实例 writerId：同一个组件实例内稳定；刷新/新标签/复制标签自然重新生成。
  const writerIdRef = useRef<string | null>(null)
  if (writerIdRef.current === null) writerIdRef.current = createDraftWriterId()

  // 存储只在首次创建控制器时采用（测试注入）；避免对象不稳定导致重建。
  const storageRef = useRef<SessionCacheStorage | null | undefined>(options.storage)
  if (options.storage !== undefined) storageRef.current = options.storage

  const controllerRef = useRef<EditorController | null>(null)
  const [snapshot, setSnapshot] = useState<EditorSnapshot | null>(null)

  const transport = useMemo<EditorTransport | null>(() => {
    if (!usable || projectId === null) return null
    const target: EditorStateTarget = { kind, sessionId, sourceId }
    return {
      getEditorState: () => getEditorState(projectId, target),
      putEditorState: (body) => putEditorState(projectId, target, body),
    }
  }, [usable, projectId, kind, sessionId, sourceId])

  useEffect(() => {
    if (!usable || runtime === null || projectId === null) return
    const ref: ResearchSessionRef = { domain: 'research', kind, projectId, sessionId, sourceId }
    const controller = runtime.editor(ref, {
      transport,
      writerId: writerIdRef.current ?? undefined,
      storage: storageRef.current,
    })
    controllerRef.current = controller
    const unsubscribe = controller.subscribe(() => {
      setSnapshot(controller.getSnapshot())
    })
    setSnapshot(controller.getSnapshot())
    void controller.load()
    return () => {
      unsubscribe()
      if (controllerRef.current === controller) controllerRef.current = null
      setSnapshot(null)
      // 释放本组件实例的控制器：调用方重挂（StrictMode/面板切换）会重新调用
      // runtime.editor() 并以惰性的 writerId 继续同一条草稿分支。
      runtime.releaseEditor(ref, controller)
    }
  }, [usable, runtime, projectId, kind, sessionId, sourceId, transport])

  // 页面隐藏/卸载：尽力写本机草稿（不发服务端 cancel、不阻塞卸载）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handlePageHide = (): void => {
      const controller = controllerRef.current
      if (controller === null) return
      controller.persistLocal()
      void controller.flush('switch')
    }
    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [])

  const current = useCallback((): EditorController | null => controllerRef.current, [])

  const setDraftText = useCallback((text: string) => {
    controllerRef.current?.setDraftText(text)
  }, [])
  const setScope = useCallback((edit: ScopeEdit) => {
    controllerRef.current?.setScope(edit)
  }, [])
  const setChatAnchor = useCallback((anchor: WireChatAnchor | null) => {
    controllerRef.current?.setChatAnchor(anchor)
  }, [])
  const setReaderAnchor = useCallback((anchor: WireReaderAnchor | null) => {
    controllerRef.current?.setReaderAnchor(anchor)
  }, [])
  const flush = useCallback(async (reason: EditorFlushReason): Promise<SaveOutcome> => {
    const controller = controllerRef.current
    if (controller === null) return BLOCKED
    return controller.flush(reason)
  }, [])
  const hold = useCallback((reason: EditorHold['reason'], operationId: string) => {
    controllerRef.current?.hold(reason, operationId)
  }, [])
  const release = useCallback((operationId: string) => {
    controllerRef.current?.release(operationId)
  }, [])
  const retrySave = useCallback(async (): Promise<SaveOutcome> => {
    const controller = controllerRef.current
    if (controller === null) return BLOCKED
    return controller.retrySave()
  }, [])
  const adoptServerVersion = useCallback(async (): Promise<SaveOutcome> => {
    const controller = controllerRef.current
    if (controller === null) return BLOCKED
    return controller.adoptServerVersion()
  }, [])
  const saveLocalOverServer = useCallback(async (): Promise<SaveOutcome> => {
    const controller = controllerRef.current
    if (controller === null) return BLOCKED
    return controller.saveLocalOverServer()
  }, [])
  const clearAfterSubmission = useCallback(
    async (receipt: AcceptedReceipt, operationId: string): Promise<ClearOutcome> => {
      const controller = controllerRef.current
      if (controller === null) return INVALID
      return controller.clearAfterSubmission(receipt, operationId)
    },
    [],
  )
  const markTokenConsumed = useCallback((token: string) => {
    controllerRef.current?.markTokenConsumed(token)
  }, [])
  const canSubmit = useCallback((): SubmissionReadiness => {
    const controller = controllerRef.current
    if (controller === null) return NOT_LOADED
    return controller.canSubmit()
  }, [])
  const restoreDraft = useCallback((writerId: string) => {
    controllerRef.current?.restoreDraft(writerId)
  }, [])
  const refreshDraftCandidates = useCallback(() => {
    controllerRef.current?.refreshDraftCandidates()
  }, [])
  const releaseDocument = useCallback(() => {
    const controller = controllerRef.current
    if (controller === null) return
    runtime?.releaseEditor(controller.getSnapshot().ref, controller)
    controllerRef.current = null
    setSnapshot(null)
  }, [runtime])

  return {
    snapshot,
    controller: current(),
    transportWired: snapshot?.transportAvailable ?? transport !== null,
    setDraftText,
    setScope,
    setChatAnchor,
    setReaderAnchor,
    flush,
    hold,
    release,
    retrySave,
    adoptServerVersion,
    saveLocalOverServer,
    clearAfterSubmission,
    markTokenConsumed,
    canSubmit,
    restoreDraft,
    refreshDraftCandidates,
    releaseDocument,
  }
}
