'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import {
  useResearchSessionRuntimeOptional,
  useSessionSnapshot,
} from '@/lib/hooks/research-session-runtime'
import { useResearchSessions, type UseResearchSessionsResult } from '@/lib/hooks/use-research-sessions'
import { useResearchEditor, type UseResearchEditorResult } from '@/lib/hooks/use-research-editor'
import {
  useResearchChat,
  deriveScopeSnapshot,
  type ResearchChatSelection,
} from '@/lib/hooks/use-research-chat'
import { newIdempotencyKey } from '@/lib/research/api'
import { useResearchC05 } from '@/lib/hooks/use-research-c05'
import {
  researchModelBlockedHint,
  useResearchGlobalModel,
} from '@/lib/hooks/use-research-global-model'
import { useResearchSources, useResearchNotes } from '@/lib/hooks/use-research'
import { useTranslation } from '@/lib/hooks/use-translation'
import { readDisplayPointer, readPointer } from '@/lib/research/session-cache'
import {
  formatScopeLabel,
  useResearchScope,
  type ResearchScopeSnapshot,
} from '@/lib/research/scope'
import { buildSubmissionKey } from '@/lib/research/session-idempotency'
import type { ConversationController } from '@/lib/research/session-runtime'
import type { ResearchSessionRef } from '@/lib/research/session-contract'
import type { ResearchSource } from '@/lib/types/research'

/**
 * 目标工作台对话接线（W1 #1104；UI 规格 v1 §5.4/§5.5，DESIGN §9.6）。
 *
 * 复用既有能力、不新建协议：
 * - 会话（UI-16）：`useResearchSessions` + runtime 的 active/display 指针；
 *   刷新恢复读 display 指针（与旧壳同一读写路径，不产生第二套导航状态）；
 * - 草稿（UI-10）：`useResearchEditor`（会话级 editor，保存/冲突/按需回填）；
 * - 发送：装配了 runtime + 活动会话时走 `ConversationController.send`
 *   （research-session-v1）；否则退化为既有 legacy `useResearchChat.send`
 *   （单一连续会话），两条路径都由 `runGuarded` 承担外发同意与模型快照；
 * - 范围：唯一权威是 `ResearchScopeProvider`（D-UI-06/D-UI-07），本 hook
 *   只读快照并在派发时冻结。
 *
 * 本 hook 不实现在 W1 未就绪的能力（深入研究执行、Coverage 全选合成），
 * 调用方必须显式显示不可用说明，不建立假任务。
 */

export interface TargetConversationState {
  /** 当前协议是否已装配会话（false = legacy 单一连续会话） */
  sessionWired: boolean
  /** 运行时是否可用（无 Provider/未就绪 → false，历史/新对话如实不可用） */
  runtimeAvailable: boolean
  /** 会话列表能力（UI-16）；null = 无运行时 */
  sessions: UseResearchSessionsResult | null
  activeRef: ResearchSessionRef | null

  // —— ResearchChatPanel（消息面）绑定 ——
  turns: ReturnType<typeof useResearchChat>['turns']
  isStreaming: boolean
  backgroundNotice: ReturnType<typeof useResearchChat>['backgroundNotice']
  resolveChatOrigin: ReturnType<typeof useResearchChat>['resolveChatOrigin']
  conversation: ConversationController | null
  sessionMeta: ReturnType<typeof useResearchChat>['sessionMeta']
  sessionCards: ReturnType<typeof useResearchChat>['sessionCards']
  submissionLookup: ReturnType<typeof useResearchChat>['submissionLookup']
  markerWriteFailed: boolean
  refreshMarkerLookups: ReturnType<typeof useResearchChat>['refreshMarkerLookups']

  // —— composer（UI-10）绑定 ——
  editor: UseResearchEditorResult
  editorSnapshot: UseResearchEditorResult['snapshot']
  submissionReady: boolean | undefined
  canExecute: boolean
  blockedHint: string
  /** 空 selected 的阻断文字（null = 未阻断）；BEH-03 不静默扩大范围 */
  scopeBlockedText: string | null

  // —— 动作 ——
  send: (text: string) => Promise<boolean>
  openSession: (ref: ResearchSessionRef) => void
  newSession: () => Promise<void>
  /** 「只问此来源」（BEH-02）：绑定当前会话；无会话时进入待绑态 */
  pinSingleSource: (sourceId: string) => void
}

export function useTargetConversation(): TargetConversationState {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId } = useResearchWorkspace()
  const scopeApi = useResearchScope()
  const runtime = useResearchSessionRuntimeOptional()
  const runtimeSnapshot = useSessionSnapshot()

  const sessionRuntime = runtime
  const [activeRef, setActiveRef] = useState<ResearchSessionRef | null>(null)
  const [restored, setRestored] = useState(false)

  const sessions = useResearchSessions({
    runtime: sessionRuntime,
    surface: 'global',
    projectHistory: true,
  })
  const sessionWired = sessionRuntime !== null && activeRef !== null

  // —— 激活会话 / 刷新恢复（与旧壳组合根同一指针路径） ——
  const activate = useCallback(
    (ref: ResearchSessionRef | null): boolean => {
      if (sessionRuntime === null) return false
      if (ref === null) {
        sessionRuntime.activate('global', null)
        setActiveRef(null)
        return true
      }
      const accepted = sessionRuntime.activate('global', ref)
      if (!accepted) return false
      sessionRuntime.setDisplayPointer({ version: 1, surface: 'global', ref })
      setActiveRef(ref)
      return true
    },
    [sessionRuntime],
  )

  useEffect(() => {
    if (sessionRuntime === null) return
    if (restored) return
    const snapshot = sessionRuntime.getSnapshot()
    if (snapshot.phase !== 'ready') return
    const scope = sessionRuntime.cacheScope()
    const authority = sessionRuntime.cacheAuthority()
    if (!scope || !authority) return
    setRestored(true)
    const display = readDisplayPointer(scope, authority)
    if (display !== null && display.surface === 'global') {
      if (display.ref !== null) setActiveRef(display.ref)
      return
    }
    const pointer = readPointer(scope, authority, 'global', null)
    if (pointer?.ref) setActiveRef(pointer.ref)
  }, [sessionRuntime, restored])

  // 身份代际变化（换人/换项目）→ 丢弃上一身份的 active ref（不沿用）。
  const identityKey = runtimeSnapshot
    ? `${runtimeSnapshot.role}|${runtimeSnapshot.viewerUserId ?? ''}|${runtimeSnapshot.projectId}|${runtimeSnapshot.authGeneration}`
    : null
  const identityRef = useRef<string | null>(identityKey)
  useEffect(() => {
    if (identityRef.current === identityKey) return
    identityRef.current = identityKey
    setActiveRef(null)
    setRestored(false)
  }, [identityKey])

  // —— 草稿 editor + 对话控制器（DESIGN §9.6） ——
  const sessionId = activeRef?.sessionId ?? ''
  const editor = useResearchEditor({
    kind: 'global',
    sessionId,
    enabled: sessionWired,
  })
  const editorSnapshot = sessionWired ? editor.snapshot : null
  const submissionReady = sessionWired
    ? runtimeSnapshot.capabilities?.submissionReady.global
    : undefined
  // 清稿 ACK 必须结算给**发起清稿的** controller（切换会话后 ref 已变）。
  const chatControllerRef = useRef<ConversationController | null>(null)
  const pendingClearControllersRef = useRef(new Map<string, ConversationController>())
  const pendingSubmitTextRef = useRef<string | null>(null)

  const conversationSession = useMemo(() => {
    if (sessionRuntime === null || activeRef === null) return undefined
    return {
      runtime: sessionRuntime,
      ref: activeRef,
      onReleaseHold: (operationId: string) => editor.release(operationId),
      onClearAfterSubmission: (
        receipt: { ref: ResearchSessionRef; draftToken: string; editorRevision: number },
        operationId: string,
      ) => {
        void editor
          .clearAfterSubmission(
            {
              sessionRef: receipt.ref,
              draftToken: receipt.draftToken,
              editorRevision: receipt.editorRevision,
              text: pendingSubmitTextRef.current ?? '',
            },
            operationId,
          )
          .then((outcome) => {
            const controller =
              pendingClearControllersRef.current.get(operationId) ??
              chatControllerRef.current ??
              null
            pendingClearControllersRef.current.delete(operationId)
            const settled =
              outcome === 'cleared'
                ? 'cleared'
                : outcome === 'superseded' || outcome === 'cancelled'
                  ? 'superseded'
                  : outcome === 'unsynced'
                    ? 'failed'
                    : 'blocked'
            controller?.notifyClearSettled(operationId, settled)
          })
      },
    }
  }, [sessionRuntime, activeRef, editor])

  const c05 = useResearchC05(projectId ?? '')
  const bindSingleSession = scopeApi.bindSession
  const {
    turns,
    isStreaming,
    backgroundNotice,
    send: sendTurn,
    resolveChatOrigin,
    getCurrentSessionId,
    conversation: chatConversation,
    sessionMeta,
    sessionCards,
    submissionLookup,
    markerWriteFailed,
    refreshMarkerLookups,
  } = useResearchChat({
    projectId: projectId ?? '',
    c05DispatchReady: () => c05.dispatchReady('chat'),
    onBindSession: bindSingleSession,
    session: conversationSession,
  })
  chatControllerRef.current = chatConversation ?? null
  // 可达但未使用：让调用方冻结 wire 请求时能拿到当前会话身份（D-22）。
  void getCurrentSessionId

  const {
    runGuarded,
    canExecute,
    blockedReason,
    confirmedModelId,
    localModelUnavailableMessage,
  } = useResearchGlobalModel()
  const blockedHint = researchModelBlockedHint(blockedReason, t, localModelUnavailableMessage)

  // —— 范围有效性（BEH-03：空 selected 阻断资料查询，不静默扩大范围） ——
  const scopeSnapshot = scopeApi.getSnapshot()
  const scopeBlocked =
    scopeSnapshot.mode === 'selected' &&
    scopeSnapshot.sourceIds.length === 0 &&
    scopeSnapshot.noteIds.length === 0
  const scopeBlockedText = scopeBlocked ? t('research.target.composer.scopeBlocked') : null

  // —— 范围 reconcile：失效选中被移除后 toast（与旧壳同一 provider 语义） ——
  const sourcesQuery = useResearchSources(projectId ?? '')
  const notesQuery = useResearchNotes(projectId ?? '')
  const { reconcileSelection } = scopeApi
  useEffect(() => {
    if (!sourcesQuery.isSuccess && !notesQuery.isSuccess) return
    const sources = sourcesQuery.data?.items ?? []
    const notes = notesQuery.data?.items ?? []
    const removed = reconcileSelection(
      sourcesQuery.isSuccess
        ? sources
            .filter(
              (source): source is ResearchSource & { source_id: string } =>
                source.source_id !== null &&
                (source.status === 'ready' || source.status === 'stale'),
            )
            .map((source) => source.source_id)
        : undefined,
      notesQuery.isSuccess ? notes.map((note) => note.note_id) : undefined,
    )
    if (removed.sourceIds.length + removed.noteIds.length > 0) {
      toast({
        title: t('research.layout.scope.modeLabel'),
        description: t('research.layout.scope.reconciled'),
      })
    }
  }, [notesQuery.data, notesQuery.isSuccess, reconcileSelection, sourcesQuery.data, sourcesQuery.isSuccess, t, toast])

  const selectionFromSnapshot = useCallback((snapshot: ResearchScopeSnapshot): ResearchChatSelection => ({
    mode: snapshot.mode,
    sourceIds: [...snapshot.sourceIds],
    noteIds: [...snapshot.noteIds],
    singleSourceId: snapshot.singleSourceId,
  }), [])

  /**
   * session 模式发送（DESIGN §9.6/I4）：editor hold → flush → 快照复核 →
   * controller.send。任一步失败都保留输入并释放 hold（不静默丢稿）。
   */
  const sendSession = useCallback(
    async (query: string): Promise<boolean> => {
      if (chatConversation === null || chatConversation === undefined) return false
      if (activeRef === null) return false
      const targetSessionId = activeRef.sessionId
      if (!targetSessionId) return false
      const snapshot = scopeApi.getSnapshot()
      const selection = selectionFromSnapshot(snapshot)
      const base = deriveScopeSnapshot(selection)
      const frozenScope: ResearchScopeSnapshot = {
        mode: base.mode,
        sourceIds: [...base.sourceIds],
        noteIds: [...base.noteIds],
        singleSourceId: base.singleSourceId,
      }
      const scopeLabel = formatScopeLabel(frozenScope, t)
      const sent = await runGuarded(
        async (modelId) => {
          const operationId =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `op_${Date.now()}_${Math.random().toString(36).slice(2)}`
          editor.hold('submit', operationId)
          const flushed = await editor.flush('submit')
          // §9.3/I4：只有已保存/无需保存才允许发送（不以旧版本发出）。
          if (flushed !== 'saved' && flushed !== 'skipped') {
            editor.release(operationId)
            return false
          }
          const controller = editor.controller
          const fresh = controller?.getSnapshot() ?? null
          if (fresh === null || fresh.draftText !== query) {
            pendingSubmitTextRef.current = null
            editor.release(operationId)
            return false
          }
          const freshScope: ResearchScopeSnapshot =
            fresh.singleSourceId !== null
              ? {
                  mode: 'single',
                  sourceIds: [],
                  noteIds: [...fresh.noteIds],
                  singleSourceId: fresh.singleSourceId,
                }
              : {
                  mode: (fresh.baseScope?.mode ?? 'all') as ResearchScopeSnapshot['mode'],
                  sourceIds: fresh.baseScope !== null ? [...fresh.baseScope.sourceIds] : [],
                  noteIds: [...fresh.noteIds],
                  singleSourceId: null,
                }
          if (JSON.stringify(freshScope) !== JSON.stringify(frozenScope)) {
            pendingSubmitTextRef.current = null
            editor.release(operationId)
            return false
          }
          pendingSubmitTextRef.current = query
          let idempotencyKey: string
          try {
            idempotencyKey = buildSubmissionKey({
              projectId: projectId ?? '',
              ownerUserId: Number(runtimeSnapshot.viewerUserId),
              kind: 'global',
              sourceId: null,
              sessionId: targetSessionId,
              draftToken: fresh.draftToken,
            })
          } catch {
            pendingSubmitTextRef.current = null
            editor.release(operationId)
            return false
          }
          pendingClearControllersRef.current.set(operationId, chatConversation)
          const result = await chatConversation.send({
            query,
            modelId,
            sourceIds: frozenScope.sourceIds,
            noteIds: frozenScope.noteIds,
            scope: {
              mode: frozenScope.mode,
              sourceIds: frozenScope.sourceIds,
              singleSourceId: frozenScope.singleSourceId,
            },
            editorRevision: fresh.revision,
            draftToken: fresh.draftToken,
            editorIntentHash: fresh.intentHash ?? '',
            idempotencyKey,
            operationId,
          })
          if (result.status !== 'ok') {
            pendingSubmitTextRef.current = null
            pendingClearControllersRef.current.delete(operationId)
            editor.release(operationId)
            return false
          }
          return true
        },
        { scopeLabel },
      )
      return sent === true
    },
    [activeRef, chatConversation, editor, projectId, runGuarded, runtimeSnapshot.viewerUserId, scopeApi, selectionFromSnapshot, t],
  )

  /** legacy 发送：既有 SSE 单会话路径（runtime 未装配时的诚实回退）。 */
  const sendLegacy = useCallback(
    async (query: string): Promise<boolean> => {
      const snapshot = scopeApi.getSnapshot()
      const selection = selectionFromSnapshot(snapshot)
      const scopeLabel = formatScopeLabel(snapshot, t)
      const idempotencyKey = newIdempotencyKey()
      const contract = c05.dispatchReady('chat') ? 'c05-v1' : 'v1'
      const sent = await runGuarded(
        (modelId) => {
          sendTurn(query, selection, modelId, idempotencyKey, contract)
          return true
        },
        { scopeLabel },
      )
      return sent === true
    },
    [c05, runGuarded, scopeApi, selectionFromSnapshot, sendTurn, t],
  )

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const query = text
      if (query.trim().length === 0) return false
      if (!confirmedModelId) return false
      if (scopeBlocked) return false
      return sessionWired ? sendSession(query) : sendLegacy(query)
    },
    [confirmedModelId, scopeBlocked, sendLegacy, sendSession, sessionWired],
  )

  const openSession = useCallback(
    (ref: ResearchSessionRef) => {
      activate(ref)
    },
    [activate],
  )

  const create = sessions.create
  const newSession = useCallback(async () => {
    const created = await create()
    if (created) activate(created.ref)
  }, [activate, create])

  const pinSingleSource = useCallback(
    (sourceId: string) => {
      scopeApi.setSingle(sourceId, activeRef?.sessionId ?? null)
    },
    [activeRef?.sessionId, scopeApi],
  )

  return {
    sessionWired,
    runtimeAvailable: sessionRuntime !== null,
    sessions: sessionRuntime === null ? null : sessions,
    activeRef,
    turns,
    isStreaming,
    backgroundNotice,
    resolveChatOrigin,
    conversation: chatConversation ?? null,
    sessionMeta: sessionMeta ?? null,
    sessionCards: sessionCards ?? [],
    submissionLookup: submissionLookup ?? null,
    markerWriteFailed: markerWriteFailed === true,
    refreshMarkerLookups,
    editor,
    editorSnapshot,
    submissionReady,
    canExecute,
    blockedHint,
    scopeBlockedText,
    send,
    openSession,
    newSession,
    pinSingleSource,
  }
}
