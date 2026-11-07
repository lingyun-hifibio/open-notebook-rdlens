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
  type ResearchScopeMode,
} from '@/lib/research/scope'
import { buildSubmissionKey } from '@/lib/research/session-idempotency'
import type { ConversationController } from '@/lib/research/session-runtime'
import type { ResearchWorkPurpose } from '@/lib/research/work-purpose'
import type { EditorSnapshot, ScopeEdit } from '@/lib/research/types'
import type { ResearchSessionRef } from '@/lib/research/session-contract'
import type { ResearchSource } from '@/lib/types/research'

/**
 * 目标工作台对话接线（W1 #1104；UI 规格 v1 §5.4/§5.5，DESIGN §9.6）。
 *
 * 复用既有能力、不新建协议：
 * - 会话（UI-16）：`useResearchSessions` + runtime 的 active/display 指针；
 *   刷新恢复读 display 指针（与旧壳 `page.tsx` 同一路径与依赖）；
 * - 草稿（UI-10）：`useResearchEditor`（会话级 editor，保存/冲突/按需回填）；
 * - 范围（BEH-01/D-UI-06）：UI 唯一权威是 `ResearchScopeProvider`；左栏任何
 *   范围变更都会通过 `editor.setScope` 同步进会话 editor（镜像旧壳
 *   `ResearchWorkspace.tsx` 的 `onChangeScope` 接线），派发时两者必须一致，
 *   不再出现"UI 改了范围、editor 没改 → selected/single 发不出去"；
 * - 发送：runtime 可用且**存在活动会话**时走 `ConversationController.send`
 *   （research-session-v1）；runtime 可用但无活动会话时**明确阻断**（提示
 *   新建/选择会话），绝不静默退化到 legacy 单连续会话（F3）；
 *   仅当 runtime 完全不可用（非嵌入/孤立渲染）才保留 legacy `useResearchChat.send`
 *   的诚实回退；
 * - 门禁：模型可用性（canExecute）与 submission capability（仅 `=== true`
 *   放行）都进入 composer 门禁，不能"可点但静默无反应"（F5/F12）。
 *
 * 本 hook 不实现在 W1 未就绪的能力（深入研究执行、Coverage 全选合成）；
 * 「本次用途」（#1106 UI-11）在此接线：显式 purpose 随 ConversationSendInput
 * 透传（自动判断 = 省略字段），能力位严格 true 才由 composer 渲染控件。
 */

/** 范围快照 → editor scope 变更序列（基础范围 + 单篇；notes 一并同步）。 */
export function scopeSnapshotToEditorEdits(
  snapshot: ResearchScopeSnapshot,
  singleBaseMode: Exclude<ResearchScopeMode, 'single'> | null,
): ScopeEdit[] {
  if (snapshot.mode === 'single' && snapshot.singleSourceId !== null) {
    const base: ScopeEdit =
      singleBaseMode === 'selected'
        ? { mode: 'selected', sourceIds: [...snapshot.sourceIds], noteIds: [...snapshot.noteIds] }
        : { mode: 'all' }
    return [base, { mode: 'single', sourceId: snapshot.singleSourceId }]
  }
  if (snapshot.mode === 'all') {
    return [{ mode: 'all' }, { mode: 'note', noteIds: [...snapshot.noteIds] }]
  }
  return [
    { mode: 'selected', sourceIds: [...snapshot.sourceIds], noteIds: [...snapshot.noteIds] },
  ]
}

/**
 * W1 #1104（第 `3` 轮审查 H1）：wire 选择归一化。
 *
 * 后端 §5.3 对 `mode==='single'` 只要求 `source_ids=[]`（禁止 source 集合），
 * **不禁止 note_ids**（scope.py 只拒绝 legacy_source_ids/legacy_note_ids 字段）；
 * C-05 builder 也只构造 source_scope、不归一 note_ids。而 provider 快照在
 * single 态会同时携带 base（selected）的 sourceIds/noteIds。**raw 快照**用于
 * editor 同步与 frozen/fresh 一致性比较；**wire 选择**只把 source_ids 归一为
 * `[]`，note_ids 原样保留——否则用户显式选择的 Note 上下文会被静默删除
 * （M04「不静默删必要上下文」），且写坏 marker（sanitize 仅拒绝 single 的
 * 非空 source_ids）。
 */
export interface WireChatSelection {
  readonly mode: ResearchScopeMode
  readonly sourceIds: string[]
  readonly noteIds: string[]
  readonly singleSourceId: string | null
}

export function normalizeSelectionForWire(
  selection: ResearchChatSelection,
): WireChatSelection {
  const mode: ResearchScopeMode = selection.mode ?? 'all'
  if (mode !== 'single') {
    // 非 single：显式给出空数组/null，避免 undefined 进入 wire 构造。
    return {
      mode,
      sourceIds: [...(selection.sourceIds ?? [])],
      noteIds: [...(selection.noteIds ?? [])],
      singleSourceId: null,
    }
  }
  return {
    mode: 'single',
    // 只归一 source 集合；note_ids 属于显式用户上下文，single 下保留。
    sourceIds: [],
    noteIds: [...(selection.noteIds ?? [])],
    singleSourceId: selection.singleSourceId ?? null,
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** editor 快照是否已与 provider 范围一致（避免重复 setScope/循环保存）。 */
export function editorScopeMatchesSnapshot(
  snapshot: EditorSnapshot,
  provider: ResearchScopeSnapshot,
  singleBaseMode: Exclude<ResearchScopeMode, 'single'> | null,
): boolean {
  const notesMatch = sameIds(snapshot.noteIds, provider.noteIds)
  if (provider.mode === 'single' && provider.singleSourceId !== null) {
    return (
      snapshot.singleSourceId === provider.singleSourceId &&
      notesMatch &&
      (singleBaseMode === 'selected'
        ? snapshot.baseScope?.mode === 'selected' &&
          sameIds(snapshot.baseScope.sourceIds, provider.sourceIds)
        : snapshot.baseScope?.mode === 'all')
    )
  }
  if (provider.mode === 'all') {
    return snapshot.singleSourceId === null && snapshot.baseScope?.mode === 'all' && notesMatch
  }
  return (
    snapshot.singleSourceId === null &&
    snapshot.baseScope?.mode === 'selected' &&
    sameIds(snapshot.baseScope.sourceIds, provider.sourceIds) &&
    notesMatch
  )
}

export interface TargetConversationState {
  /** 是否已装配会话（runtime 可用且存在活动会话；composer 的 session 分支） */
  sessionWired: boolean
  /** 运行时是否可用（无 Provider/未初始化 → false） */
  runtimeAvailable: boolean
  /** runtime 可用但当前无活动会话（F3：明确阻断，不静默走 legacy） */
  noActiveSession: boolean
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
  /** session 模式：capabilities 明确 `true` 才放行（undefined → false，F12） */
  submissionReady: boolean | undefined
  canExecute: boolean
  blockedHint: string
  /** 空 selected 的阻断文字（null = 未阻断）；BEH-03 不静默扩大范围 */
  scopeBlockedText: string | null
  /** 最近一次发送被阻断/失败的可视原因（null = 无）；composer 必须展示 */
  sendError: string | null
  /** 单篇 pin 只允许绑定到当前活动会话（BEH-02/F3） */
  canPinSingleSource: boolean

  // —— composer「本次用途」（#1106 UI-11）——
  /** 下一请求的显式工作目的；null = 自动判断（省略请求字段）。 */
  workPurpose: ResearchWorkPurpose | null
  /** 修改用途：只作用于**下一请求**（不改写已生成回答/历史记录）。 */
  setWorkPurpose: (purpose: ResearchWorkPurpose | null) => void
  /** 后端是否声明严格 `purpose_inference === true`（fail-closed）。 */
  purposeInferenceAvailable: boolean

  // —— 动作 ——
  send: (text: string) => Promise<boolean>
  /**
   * #1106/D6：带显式 purpose 的同一文本重发（422 scope_selected_empty 的
   * 「改为探索讨论」纠正动作；新请求，旧记录不变）。
   */
  sendWithPurpose: (text: string, purpose: ResearchWorkPurpose | null) => Promise<boolean>
  clearSendError: () => void
  openSession: (ref: ResearchSessionRef) => void
  newSession: () => Promise<void>
  /** 「只问此来源」：无活动会话时返回 false（不制造未绑定 pin） */
  pinSingleSource: (sourceId: string) => boolean
}

export function useTargetConversation(): TargetConversationState {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId } = useResearchWorkspace()
  const scopeApi = useResearchScope()
  const runtime = useResearchSessionRuntimeOptional()
  const runtimeSnapshot = useSessionSnapshot()
  const runtimePhase = runtimeSnapshot.phase

  const sessionRuntime = runtime
  const [activeRef, setActiveRef] = useState<ResearchSessionRef | null>(null)
  const [restored, setRestored] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  /**
   * #1106（W1 PR-B）：本次用途（UI-11）。null = 自动判断（请求省略
   * `work_purpose`，由服务端推断）；显式选择只作用于**下一请求**，发送成功
   * 后回到自动判断（计划 §9「无会话级 purpose 记忆」）。
   */
  const [workPurpose, setWorkPurposeState] = useState<ResearchWorkPurpose | null>(null)
  const setWorkPurpose = useCallback((purpose: ResearchWorkPurpose | null) => {
    setWorkPurposeState(purpose)
  }, [])

  const sessions = useResearchSessions({
    runtime: sessionRuntime,
    surface: 'global',
    projectHistory: true,
  })
  const sessionWired = sessionRuntime !== null && activeRef !== null
  const runtimeAvailable = sessionRuntime !== null
  const noActiveSession = runtimeAvailable && activeRef === null

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

  // F2：runtime bootstrap 是异步的（初始 masked/未 ready）——依赖必须包含
  // runtime 快照的 phase，否则 ready 后 effect 不再重跑、刷新恢复永远失败。
  // `restored` 只在真正成功读取指针后置 true（phase 未 ready 时不消费）。
  useEffect(() => {
    if (sessionRuntime === null || restored) return
    if (runtimePhase !== 'ready') return
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
  }, [sessionRuntime, runtimePhase, restored])

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
  // F12：capability 只有明确就绪（=== true）才放行；undefined/未加载一律 false。
  const submissionReady = sessionWired
    ? runtimeSnapshot.capabilities?.submissionReady.global === true
    : undefined

  // —— F1：范围变更贯通到会话 editor（唯一权威：provider → editor 同步） ——
  const scopeSnapshot = scopeApi.getSnapshot()
  const singleBaseMode = scopeApi.singlePin?.baseMode ?? null
  const providerScopeKey = JSON.stringify({
    mode: scopeSnapshot.mode,
    sourceIds: scopeSnapshot.sourceIds,
    noteIds: scopeSnapshot.noteIds,
    singleSourceId: scopeSnapshot.singleSourceId,
  })
  const editorScopeKey =
    editorSnapshot === null
      ? ''
      : JSON.stringify({
          baseMode: editorSnapshot.baseScope?.mode ?? null,
          baseSourceIds: editorSnapshot.baseScope?.sourceIds ?? [],
          noteIds: editorSnapshot.noteIds,
          singleSourceId: editorSnapshot.singleSourceId,
        })
  const editorScopeReady =
    editorSnapshot !== null &&
    !editorSnapshot.loading &&
    !editorSnapshot.invalidated &&
    !editorSnapshot.readOnly
  useEffect(() => {
    if (!sessionWired || editorSnapshot === null || !editorScopeReady) return
    if (editorScopeMatchesSnapshot(editorSnapshot, scopeSnapshot, singleBaseMode)) return
    for (const edit of scopeSnapshotToEditorEdits(scopeSnapshot, singleBaseMode)) {
      editor.setScope(edit)
    }
    // 依赖使用序列化 key（provider 值/editor 快照变化才重跑，避免对象身份抖动）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionWired, providerScopeKey, editorScopeKey, editorScopeReady, editor])

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
  void getCurrentSessionId

  const {
    runGuarded,
    canExecute,
    blockedReason,
    confirmedModelId,
    localModelUnavailableMessage,
    purposeInferenceAvailable,
  } = useResearchGlobalModel()
  const blockedHint = researchModelBlockedHint(blockedReason, t, localModelUnavailableMessage)

  // —— 范围有效性（BEH-03：空 selected 阻断资料查询，不静默扩大范围） ——
  // #1106/D5：headed global Chat 上空 selected 的放行条件——
  // - 显式 exploration/writing：后端 D5 放行（零检索）；
  // - 自动判断（null）且 inference 能力可用：交给服务端推断（强讨论信号 →
  //   inferred exploration 放行；无强信号 → 422 scope_selected_empty 可纠正）。
  // inference off/能力未知时保持现行本地阻断；显式 document_qa 仍本地阻断。
  const scopeEmptySelected =
    scopeSnapshot.mode === 'selected' &&
    scopeSnapshot.sourceIds.length === 0 &&
    scopeSnapshot.noteIds.length === 0
  const isScopeBlockedFor = useCallback(
    (purpose: ResearchWorkPurpose | null): boolean =>
      scopeEmptySelected &&
      !(purpose === 'exploration' || purpose === 'writing') &&
      !(purpose === null && purposeInferenceAvailable),
    [scopeEmptySelected, purposeInferenceAvailable],
  )
  const scopeBlocked = isScopeBlockedFor(workPurpose)
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
   * controller.send。任一步失败都释放 hold、保留输入，并给出**可见原因**
   * （不再静默 `return false`）。
   */
  const sendSession = useCallback(
    async (query: string, purpose: ResearchWorkPurpose | null): Promise<boolean> => {
      if (chatConversation === null || chatConversation === undefined) {
        setSendError(t('research.target.composer.noActiveSession'))
        return false
      }
      if (activeRef === null) {
        setSendError(t('research.target.composer.noActiveSession'))
        return false
      }
      const targetSessionId = activeRef.sessionId
      if (!targetSessionId) {
        setSendError(t('research.target.composer.noActiveSession'))
        return false
      }
      const snapshot = scopeApi.getSnapshot()
      const selection = selectionFromSnapshot(snapshot)
      const base = deriveScopeSnapshot(selection)
      const frozenScope: ResearchScopeSnapshot = {
        mode: base.mode,
        sourceIds: [...base.sourceIds],
        noteIds: [...base.noteIds],
        singleSourceId: base.singleSourceId,
      }
      // H1：raw frozenScope 保留 base IDs 用于 fresh 一致性比较；wire 归一为
      // 互斥形态（single → source_ids=[] / note_ids=[]）。
      const wireSelection = normalizeSelectionForWire(selection)
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
            setSendError(t('research.target.composer.draftNotSaved'))
            return false
          }
          const controller = editor.controller
          const fresh = controller?.getSnapshot() ?? null
          if (fresh === null || fresh.draftText !== query) {
            pendingSubmitTextRef.current = null
            editor.release(operationId)
            setSendError(t('research.target.composer.draftNotSaved'))
            return false
          }
          const freshScope: ResearchScopeSnapshot =
            fresh.singleSourceId !== null
              ? {
                  // N1：single 叠加在 selected 基础范围上时，frozenScope 保留
                  // provider 的 base sourceIds（deriveScopeSnapshot 同形），
                  // freshScope 也必须保留同一组 base IDs 才能通过一致性复核
                  // （此前强制 [] 导致「先选资料再只问此来源」永远 sendError）。
                  mode: 'single',
                  sourceIds:
                    fresh.baseScope?.mode === 'selected'
                      ? [...fresh.baseScope.sourceIds]
                      : [],
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
            // F1 可见反馈：范围在派发瞬间被改变（含 editor 保存竞态）。
            setSendError(t('research.target.composer.scopeChanged'))
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
            setSendError(t('research.target.composer.sendFailed'))
            return false
          }
          pendingClearControllersRef.current.set(operationId, chatConversation)
          const result = await chatConversation.send({
            query,
            modelId,
            sourceIds: [...wireSelection.sourceIds],
            noteIds: [...wireSelection.noteIds],
            scope: {
              mode: wireSelection.mode,
              sourceIds: [...wireSelection.sourceIds],
              singleSourceId: wireSelection.singleSourceId,
            },
            editorRevision: fresh.revision,
            draftToken: fresh.draftToken,
            editorIntentHash: fresh.intentHash ?? '',
            idempotencyKey,
            operationId,
            // #1106（W1 PR-B）：显式用途随冻结意图一起透传；null → 省略字段
            // （自动判断，绝不发送显式 null）。controller 的 sameSubmissionIntent
            // 会把 purpose 纳入重放一致性判定（防静默改意图）。
            workPurpose: purposeInferenceAvailable === true ? purpose : null,
          })
          if (result.status !== 'ok') {
            pendingSubmitTextRef.current = null
            pendingClearControllersRef.current.delete(operationId)
            editor.release(operationId)
            setSendError(t('research.target.composer.sendFailed'))
            return false
          }
          // D7/§9：显式用途只作用于刚派发的这一请求；下一请求回到自动判断
          // （不扩 EditorStateWire，不做会话级记忆）。
          setWorkPurposeState(null)
          return true
        },
        { scopeLabel },
      )
      if (sent !== true) {
        // consent 取消/身份失效：runGuarded 未派发（零副作用），原因可见。
        setSendError((current) => current ?? t('research.target.composer.sendFailed'))
        return false
      }
      return true
    },
    [activeRef, chatConversation, editor, projectId, purposeInferenceAvailable, runGuarded, runtimeSnapshot.viewerUserId, scopeApi, selectionFromSnapshot, t],
  )

  /** legacy 发送：仅 runtime 完全不可用时的诚实回退（非嵌入/孤立渲染）。 */
  const sendLegacy = useCallback(
    async (query: string): Promise<boolean> => {
      const snapshot = scopeApi.getSnapshot()
      const selection = normalizeSelectionForWire(selectionFromSnapshot(snapshot))
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
      if (sent !== true) {
        setSendError((current) => current ?? t('research.target.composer.sendFailed'))
        return false
      }
      return true
    },
    [c05, runGuarded, scopeApi, selectionFromSnapshot, sendTurn, t],
  )

  const clearSendError = useCallback(() => setSendError(null), [])

  const runSend = useCallback(
    async (text: string, purpose: ResearchWorkPurpose | null): Promise<boolean> => {
      const query = text
      if (query.trim().length === 0) return false
      setSendError(null)
      if (noActiveSession) {
        setSendError(t('research.target.composer.noActiveSession'))
        return false
      }
      if (!canExecute) {
        setSendError(blockedHint.length > 0 ? blockedHint : t('research.target.composer.modelUnavailable'))
        return false
      }
      if (!confirmedModelId) {
        setSendError(t('research.target.composer.modelUnavailable'))
        return false
      }
      // 空 selected 的放行与本次**实际派发**的 purpose 同源判定（而非上一次
      // 渲染的 state），保证「改为探索讨论并重发」在状态提交前也能正确放行。
      if (isScopeBlockedFor(purpose)) {
        setSendError(t('research.target.composer.scopeBlocked'))
        return false
      }
      if (sessionRuntime === null) return sendLegacy(query)
      return sendSession(query, purpose)
    },
    [
      blockedHint,
      canExecute,
      confirmedModelId,
      isScopeBlockedFor,
      noActiveSession,
      sendLegacy,
      sendSession,
      sessionRuntime,
      t,
    ],
  )

  const send = useCallback(
    (text: string): Promise<boolean> => runSend(text, workPurpose),
    [runSend, workPurpose],
  )

  /**
   * #1106/D6/D7：带显式 purpose 的重发（422 `scope_selected_empty` 的
   * 「改为探索讨论」纠正动作）。先落 UI 状态再以同一文本派发；旧回答/历史
   * 不重写。422 为零写入（无受理行），重发不会产生同键不同 purpose 的 409；
   * 成功后 editor 清稿会轮换 draft token（新请求身份），失败保留输入。
   */
  const sendWithPurpose = useCallback(
    async (text: string, purpose: ResearchWorkPurpose | null): Promise<boolean> => {
      setWorkPurposeState(purpose)
      return runSend(text, purpose)
    },
    [runSend],
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
    if (created) {
      activate(created.ref)
      // BEH-02：新对话不继承单篇限定（显式核验会话身份，与旧壳一致）。
      scopeApi.bindSession(created.ref.sessionId)
    }
  }, [activate, create, scopeApi])

  const pinSingleSource = useCallback(
    (sourceId: string): boolean => {
      if (activeRef === null) return false
      scopeApi.setSingle(sourceId, activeRef.sessionId)
      return true
    },
    [activeRef, scopeApi],
  )

  return {
    sessionWired,
    runtimeAvailable,
    noActiveSession,
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
    sendError,
    canPinSingleSource: sessionWired,
    workPurpose,
    setWorkPurpose,
    purposeInferenceAvailable,
    send,
    sendWithPurpose,
    clearSendError,
    openSession,
    newSession,
    pinSingleSource,
  }
}
