'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import {
  ResearchDraftComposer,
  deriveResearchDraftGate,
  researchDraftGateReasonKey,
} from './ResearchDraftComposer'
import {
  useResearchSessionRuntimeOptional,
  useSessionSnapshot,
} from '@/lib/hooks/research-session-runtime'
import { useResearchEditor } from '@/lib/hooks/use-research-editor'
import {
  useResearchSourceChat,
  type ResearchSourceChatTurn,
  type UseResearchSourceChatSessionOptions,
} from '@/lib/hooks/use-research-source-chat'
import { buildSubmissionKey } from '@/lib/research/session-idempotency'
import type { ResearchConversationSnapshot } from '@/lib/research/types'
import type { ConversationController, ConversationSnapshot } from '@/lib/research/session-runtime'
import type { ConversationTurn } from '@/lib/research/conversation-machine'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { formatScopeLabel } from '@/lib/research/scope'
import { userErrorMessageKey } from '@/lib/research/errors'

/**
 * Source-scoped Chat 面板（Issue #182，/research 下半屏选中 Source 时）。
 *
 * 最小会话 UI：「新会话」+ 会话选择（title + updated_at，首页列表）；
 * 消息气泡展示 thinking（折叠）/answer/citation/usage 元数据徽标
 * （resolved_mode、降级原因、source_ref.document_version）；streaming 中
 * 输入禁用；断线重连与两类错误（活动冲突 / Gateway 不可用）状态条。
 *
 * Citation 点击 → `onHighlightPage(page_idx)` 联动上半屏 SourceDetailPanel
 * 高亮对应 chunk/page（0-based 存储仅展示 +1）。浏览器断开 ≠ 取消——
 * 本面板没有「取消 Chat」入口。
 */
export function ResearchSourceChatPanel({
  projectId,
  sourceId,
  onHighlightPage,
}: {
  projectId: string
  sourceId: string
  onHighlightPage: (pageIdx: number) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // #243 §6.4：模型来自顶层全局设置；外部模型需确认时由守卫登记并弹窗，
  // 未确认不发请求（不变量 9）。
  const { canExecute, runGuarded } = useResearchGlobalModel()
  const canExecuteModel = canExecute
  // PR-5b（D5 / Codex P1-#3）：Source 面板补编辑器草稿 + composer。运行时
  // 存在时草稿、发送与提交身份统一由该 source 会话 controller 承担；否则
  // 保留 legacy 单行入口（未接线宿主）。
  const sessionRuntime = useResearchSessionRuntimeOptional()
  const runtimeSnapshot = useSessionSnapshot()
  const sourceRef = sessionRuntime?.active('source') ?? null
  const sourceSessionId = sourceRef?.sessionId ?? ''
  const editorEnabled =
    sessionRuntime !== null && sourceRef !== null && sourceRef.sourceId === sourceId
  const editor = useResearchEditor({
    kind: 'source',
    sessionId: sourceSessionId,
    sourceId,
    enabled: editorEnabled,
  })
  // 提交时的草稿文本快照（ResearchAcceptedReceipt 不含正文，清稿核对需要）。
  const pendingSubmitTextRef = useRef<string | null>(null)
  // PR-5b（Codex 第 2 轮 P1-#1/#3）：清稿 ACK 必须结算给**发起清稿的** controller
  // （切换会话后 chatControllerRef 已指向新会话，不能拿“当前”实例结算）。
  const pendingClearControllersRef = useRef(new Map<string, ConversationController>())
  const sourceControllerRef = useRef<ConversationController | null>(null)
  // 仅有可绑定的持久 session_id 时才启用 controller：新会话仍由 legacy
  // 路径创建（PR-6 负责新会话与新协议的统一创建）。
  const chatSession = useMemo<UseResearchSourceChatSessionOptions | undefined>(() => {
    if (sessionRuntime === null || sourceRef === null || sourceSessionId === '') {
      return undefined
    }
    return {
      runtime: sessionRuntime,
      ref: sourceRef,
      onReleaseHold: (operationId: string) => editor.release(operationId),
      onClearAfterSubmission: (receipt, operationId) => {
        // Lead 核对 P2-7：runtime 存活时重挂后 map 不跨实例；回退到当前
        // controller（同一 runtime/session 复用同一实例）保证 ACK 仍被结算。
        const controller =
          pendingClearControllersRef.current.get(operationId) ??
          sourceControllerRef.current ??
          null
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
            pendingSubmitTextRef.current = null
            pendingClearControllersRef.current.delete(operationId)
            // 失败/被覆盖也必须结算，否则 clearPending 永挂、首轮后无法再发。
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
  }, [sessionRuntime, sourceRef, sourceSessionId, editor])
  const chat = useResearchSourceChat({ projectId, sourceId, session: chatSession })
  sourceControllerRef.current = chat.conversation ?? null
  const editorSnapshot = editorEnabled ? editor.snapshot : null
  const wired = editorSnapshot !== null
  // Codex P1-#3（围绕同一身份）：session 模式下 busy/streaming 以 controller
  // 快照为权威，legacy isStreaming 在 controller 执行时为 idle 会误开放发送。
  const [sessionBusy, setSessionBusy] = useState(false)
  const sessionConversation = chat.conversation ?? null
  useEffect(() => {
    if (sessionConversation === null) {
      setSessionBusy(false)
      return
    }
    const sync = (): void => {
      const turn = sessionConversation.getSnapshot().turn
      // Codex 第 2 轮 N1：idle/not_observed 表示明确未受理，必须允许重试。
      setSessionBusy(
        turn !== null &&
          (turn.clearPending ||
            turn.state === 'preparing' ||
            turn.state === 'submitting' ||
            turn.state === 'accepted' ||
            turn.state === 'streaming' ||
            turn.state === 'lookup_pending' ||
            turn.state === 'unknown'),
      )
    }
    sync()
    return sessionConversation.subscribe(sync)
  }, [sessionConversation])
  // PR-5b（Codex 第 2 轮 P1-#3）：消息区必须消费 controller 的当前轮/history
  // （新协议问答不写入 legacy chat.turns），并与 durable 消息去重。
  const [liveSnapshot, setLiveSnapshot] = useState<ConversationSnapshot | null>(null)
  useEffect(() => {
    const controller = chat.conversation ?? null
    if (controller === null) {
      setLiveSnapshot(null)
      return
    }
    const sync = (): void => setLiveSnapshot(controller.getSnapshot())
    sync()
    return controller.subscribe(sync)
  }, [chat.conversation])
  const controllerTurns: ResearchSourceChatTurn[] = (() => {
    if (liveSnapshot === null) return []
    const rows: ResearchSourceChatTurn[] = []
    const push = (turn: ConversationTurn): void => {
      const terminalStatus: ResearchSourceChatTurn['status'] =
        turn.sse.terminal === 'error' ? 'error' : 'done'
      const status =
        turn.state === 'terminal'
          ? terminalStatus
          : turn.state === 'unknown' || turn.state === 'lookup_pending'
            ? 'streaming'
            : 'streaming'
      rows.push(
        {
          id: `user_${turn.identity.turnId}`,
          role: 'user',
          content: turn.query,
          thinking: '',
          citations: [],
          usage: null,
          resolvedMode: null,
          degradationReasons: [],
          sourceRef: null,
          status: 'done',
          reconnectCount: 0,
          errorCode: null,
          errorMessage: null,
        },
        {
          id: turn.identity.turnId,
          role: 'assistant',
          content: turn.sse.answer,
          thinking: turn.sse.thinking,
          citations: turn.sse.citations as ResearchSourceChatTurn['citations'],
          usage: turn.sse.usage,
          resolvedMode: turn.sse.resolvedMode,
          degradationReasons: [],
          sourceRef: null,
          status,
          reconnectCount: 0,
          errorCode: turn.sse.errorCode ?? turn.errorCode,
          errorMessage: turn.sse.errorMessage ?? turn.errorMessage,
        },
      )
    }
    for (const turn of liveSnapshot.history) push(turn)
    if (liveSnapshot.turn !== null) push(liveSnapshot.turn)
    return rows
  })()
  const renderedSourceTurns: ResearchSourceChatTurn[] = (() => {
    // Lead 核对（Codex 复核 P2）：不能只用“角色+正文”证明执行身份——不同
    // 历史轮次可能答案相同。改为成对（user→assistant）匹配，且 durable 中该
    // 成对内容唯一时才去重；空 content 的 controller assistant（冷启动外部
    // 查回）与唯一 durable 成对答案合并，避免完整答案旁出现空占位。
    const durable = [...chat.turns]
    const pairKey = (user: string, assistant: string): string =>
      `${user}\u0000${assistant}`
    const durablePairKeys = new Set<string>()
    const durablePairCounts = new Map<string, number>()
    const durableUserCounts = new Map<string, number>()
    for (let index = 0; index < durable.length; index += 1) {
      const turn = durable[index]
      if (turn.role === 'user') {
        durableUserCounts.set(turn.content, (durableUserCounts.get(turn.content) ?? 0) + 1)
        continue
      }
      if (turn.role !== 'assistant') continue
      const previous = index > 0 ? durable[index - 1] : null
      if (previous === null || previous.role !== 'user') continue
      const key = pairKey(previous.content, turn.content)
      durablePairKeys.add(key)
      durablePairCounts.set(key, (durablePairCounts.get(key) ?? 0) + 1)
    }
    const consumed = new Set<string>()
    const merged = controllerTurns.map((row, index) => {
      if (row.role !== 'assistant' || row.content.trim() !== '') return row
      const previous = index > 0 ? controllerTurns[index - 1] : null
      if (previous === null || previous.role !== 'user') return row
      // 同问题多份历史稿时无法证明是哪一次执行 → 不合并（宁可 displayed empty）。
      if ((durableUserCounts.get(previous.content) ?? 0) !== 1) return row
      const userIndex = durable.findIndex(
        (turn) => turn.role === 'user' && turn.content === previous.content,
      )
      const candidate = userIndex >= 0 ? durable[userIndex + 1] : undefined
      if (
        candidate === undefined ||
        candidate.role !== 'assistant' ||
        candidate.content.trim() === ''
      ) {
        return row
      }
      consumed.add(candidate.id)
      return { ...row, content: candidate.content }
    })
    const controllerPairKeys = new Set<string>()
    for (let index = 0; index < merged.length; index += 1) {
      const turn = merged[index]
      if (turn.role !== 'user') continue
      const next = merged[index + 1]
      if (next !== undefined && next.role === 'assistant') {
        controllerPairKeys.add(pairKey(turn.content, next.content))
      }
    }
    const controllerUserContents = new Set(
      merged.filter((turn) => turn.role === 'user').map((turn) => turn.content),
    )
    const remaining = durable.filter((turn) => {
      if (consumed.has(turn.id)) return false
      const index = durable.indexOf(turn)
      const previous = index > 0 ? durable[index - 1] : null
      if (turn.role === 'user' && controllerUserContents.has(turn.content)) return false
      if (turn.role === 'assistant' && previous !== null && previous.role === 'user') {
        const key = pairKey(previous.content, turn.content)
        // 只有“唯一且被 controller 成对覆盖”的 durable 副本才丢弃。
        if ((durablePairCounts.get(key) ?? 0) === 1 && controllerPairKeys.has(key)) {
          return false
        }
      }
      return true
    })
    return [...remaining, ...merged]
  })()
  const conversationSnapshot: ResearchConversationSnapshot = {
    isBusy: sessionConversation !== null ? sessionBusy : chat.isStreaming,
    isStreaming: sessionConversation !== null ? sessionBusy : chat.isStreaming,
    activeTurnId: null,
    phase: (sessionConversation !== null ? sessionBusy : chat.isStreaming)
      ? 'streaming'
      : 'idle',
  }
  const baseGate = deriveResearchDraftGate({ editorSnapshot, conversationSnapshot })
  const draftGate =
    baseGate.allowed && !canExecuteModel
      ? { allowed: false as const, reason: 'submission_not_ready' as const }
      : baseGate
  const draftGateReasonText =
    draftGate.allowed || draftGate.reason === null || draftGate.reason === undefined
      ? null
      : t(researchDraftGateReasonKey(draftGate.reason))

  /**
   * PR-5b（D5 / Codex P1-#3）：session 模式发送——正文来自 editor 草稿，
   * 且必须 hold→flush（确认保存结果）→用保存后快照发送；清稿由提交回执
   * 核对后触发，保存失败/用户在途中改动时**绝不清空**草稿。
   */
  const submitEditorDraft = () => {
    if (!wired || editorSnapshot === null || !draftGate.allowed) return
    const text = editorSnapshot.draftText
    if (text.trim().length === 0) return
    const conversation = chat.conversation ?? null
    void runGuarded(
      async (modelId) => {
        if (conversation === null) {
          // 新 source 会话：controller 尚无持久 session（PR-6 统一创建）。
          // Codex 第 2 轮 P1-#3：legacy 路径在受理前不得清稿（看不到 ACK），
          // 保留草稿让用户显式处理。
          chat.send(text, modelId)
          return true
        }
        const operationId =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `op_${Date.now()}_${Math.random().toString(36).slice(2)}`
        editor.hold('submit', operationId)
        const flushed = await editor.flush('submit')
        if (flushed !== 'saved' && flushed !== 'skipped') {
          editor.release(operationId)
          return false
        }
        const current = editor.controller?.getSnapshot() ?? null
        if (current === null || current.draftText !== text) {
          editor.release(operationId)
          return false
        }
        let idempotencyKey: string
        try {
          idempotencyKey = buildSubmissionKey({
            projectId,
            ownerUserId: Number(runtimeSnapshot.viewerUserId),
            kind: 'source',
            sourceId,
            sessionId: sourceSessionId,
            draftToken: current.draftToken,
          })
        } catch {
          editor.release(operationId)
          return false
        }
        pendingSubmitTextRef.current = text
        pendingClearControllersRef.current.set(operationId, conversation)
        const result = await conversation.send({
          query: text,
          modelId,
          sourceIds: [sourceId],
          noteIds: [],
          scope: { mode: 'selected', sourceIds: [sourceId], singleSourceId: null },
          editorRevision: current.revision,
          draftToken: current.draftToken,
          editorIntentHash: current.intentHash ?? '',
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
      {
        scopeLabel: formatScopeLabel(
          { mode: 'selected', sourceIds: [sourceId], noteIds: [], singleSourceId: null },
          t,
        ),
      },
    )
  }

  /**
   * PR-5b（Codex 第 2 轮 P1-#3）：会话切换必须同时切换 runtime 身份，否则消息
   * 列表（legacy）与 editor/controller（session）指向不同会话。已有会话切到
   * 对应 ref；新会话清空 source 活动（PR-6 再统一新协议创建）。
   */
  const selectSourceSession = (next: string | null): void => {
    chat.selectSession(next)
    const runtime = sessionRuntime
    if (runtime === null) return
    // PR-5b（Lead 核对 P1-2）：从“新会话态”（active('source') === null）返回
    // 历史会话时也必须重新 activate，否则 editor/controller 继续禁用、发送
    // 落回 legacy。目标 ref 与当前 active 不一致才切换（含 null→ref / ref→null）。
    const target = next === null
      ? null
      : {
          domain: 'research' as const,
          kind: 'source' as const,
          projectId,
          sessionId: next,
          sourceId,
        }
    const current = runtime.active('source')
    const sameSession =
      current === null
        ? target === null
        : target !== null &&
          current.kind === 'source' &&
          current.sessionId === target.sessionId &&
          current.sourceId === target.sourceId
    if (!sameSession) runtime.activate('source', target)
  }

  const submit = () => {
    const trimmed = query.trim()
    if (!trimmed || chat.isStreaming) return
    // 确认通过后才清空输入：取消/待确认不留任何痕迹（不变量 9）
    void runGuarded(
      (modelId) => {
        chat.send(trimmed, modelId)
        setQuery('')
      },
      // RWV2-42（D5a）：Source Chat 载荷固定绑定 sourceId（可证明快照），
      // consent Scope 行必须展示该来源摘要
      {
        scopeLabel: formatScopeLabel(
          { mode: 'selected', sourceIds: [sourceId], noteIds: [], singleSourceId: null },
          t,
        ),
      },
    )
  }

  const localizedError = (turn: ResearchSourceChatTurn): string | null => {
    if (turn.errorCode === 'conflict_busy') return t('research.sourceChat.conflictBusy')
    if (turn.errorCode === 'gateway_unavailable') return t('research.sourceChat.errorGatewayUnavailable')
    return null
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="srcchat-panel">
      {/* RWV2-UIOPT-A：顶栏右侧为 ResearchLayout 展开/恢复按钮预留固定宽度
          （lg:pr-36 ≥ 按钮宽 + right-3 偏移）——New session 不被按钮遮挡，
          预留真实空间而非 z-index 遮盖；与按钮可见性同条件（compact
          <1024px 按钮隐藏，恢复原始 px-4）。 */}
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2 lg:pr-36" data-testid="srcchat-topbar">
        <h2 className="text-sm font-semibold">{t('research.sourceChat.title')}</h2>
        <Button
          size="sm"
          variant="outline"
          data-testid="srcchat-new-session"
          onClick={() => selectSourceSession(null)}
        >
          {t('research.sourceChat.newSession')}
        </Button>
      </div>

      {chat.loadDetailError && (
        <div className="px-4 py-2 text-xs text-destructive" role="alert">
          {t('research.workbench.loadFailed')}: {chat.loadDetailError}
        </div>
      )}

      {chat.sessions.length > 0 && (
        <ul className="max-h-24 space-y-1 overflow-y-auto border-b px-4 py-2" data-testid="srcchat-sessions">
          {chat.sessions.map((session) => (
            <li key={session.session_id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-left text-xs hover:bg-accent"
                data-testid={`srcchat-session-${session.session_id}`}
                aria-current={session.session_id === chat.activeSessionId}
                onClick={() => selectSourceSession(session.session_id)}
              >
                <span className="font-medium">{session.title ?? session.session_id}</span>
                <span className="ml-2 text-muted-foreground">{session.updated_at}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {chat.turns.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('research.sourceChat.emptyState')}</p>
        )}
        {renderedSourceTurns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-lg bg-primary/10 px-3 py-2 text-sm">
                {turn.content}
              </div>
            </div>
          ) : (
            <div key={turn.id} className="space-y-2">
              {turn.thinking && (
                <details className="rounded-lg border px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                    {t('research.chatThinking')}
                  </summary>
                  {/* COV-09：raw Thinking 防御性丢弃——只展示固定进度摘要，
                      不渲染后端 thinking 内容（§12.3） */}
                  <div className="mt-2 text-sm text-muted-foreground">
                    {t('research.chatThinkingNotice')}
                  </div>
                </details>
              )}
              <div className="rounded-lg border px-3 py-2 text-sm">
                {turn.content ? (
                  <MarkdownRenderer>{turn.content}</MarkdownRenderer>
                ) : (
                  <span className="text-muted-foreground">{t('research.chatNoAnswer')}</span>
                )}
              </div>

              {(turn.usage || turn.resolvedMode || turn.degradationReasons.length > 0 || turn.sourceRef) && (
                <div
                  className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                  data-testid={`srcchat-turn-meta-${turn.id}`}
                >
                  {turn.resolvedMode && (
                    <Badge variant="outline">
                      {t('research.sourceChat.modeLabel')}: {turn.resolvedMode}
                    </Badge>
                  )}
                  {turn.degradationReasons.length > 0 && (
                    <Badge variant="secondary">{t('research.sourceChat.degradedBadge')}</Badge>
                  )}
                  {turn.sourceRef && (
                    <span>
                      {t('research.sourceChat.sourceVersionLabel')}: {turn.sourceRef.documentVersion}
                    </span>
                  )}
                  {turn.usage && (
                    <span>
                      {t('research.chatUsage')}: {turn.usage.input_tokens} in
                      {turn.usage.thinking_tokens ? ` / ${turn.usage.thinking_tokens} think` : ''}
                      {' / '}
                      {turn.usage.output_tokens} out
                    </span>
                  )}
                </div>
              )}

              <ResearchCitationList
                citations={turn.citations}
                onCitationClick={(citation) => {
                  if (typeof citation.page_idx === 'number') {
                    onHighlightPage(citation.page_idx)
                  }
                }}
              />

              {turn.status === 'reconnecting' && (
                <p className="text-xs font-medium text-amber-600" data-testid="srcchat-reconnecting">
                  {t('research.sourceChat.disconnected', { count: turn.reconnectCount })}
                </p>
              )}

              {turn.status === 'error' && (
                <div
                  className="space-y-1 rounded-lg border border-destructive/50 px-3 py-2 text-xs"
                  data-testid="srcchat-error"
                >
                  {/* RWV2-42（AC8/M1）：已知码 → sourceChat 专用文案或集中映射；
                      未知码 → generic 主文案；raw code/message 仅次级诊断 */}
                  <p className="font-medium text-destructive">
                    {localizedError(turn) ?? t(userErrorMessageKey(turn.errorCode))}
                  </p>
                  {!localizedError(turn) && (turn.errorMessage || turn.errorCode) && (
                    <p className="text-muted-foreground">
                      {turn.errorMessage || turn.errorCode}
                    </p>
                  )}
                  {chat.retryableQuery !== null && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="srcchat-error-retry"
                      onClick={chat.retry}
                    >
                      {t('research.sourceChat.retry')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ),
        )}
        {chat.isStreaming && (
          <p className="text-xs text-muted-foreground" data-testid="srcchat-streaming">
            {t('research.chatStreaming')}
          </p>
        )}
      </div>

      {wired && (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground" data-testid="srcchat-draft-scope">
          <span className="font-medium">{t('research.sourceChat.title')}</span>
          {' · '}
          <code>{sourceId}</code>
        </div>
      )}
      {wired ? (
        <div className="border-t p-3">
          <ResearchDraftComposer
            editorSnapshot={editorSnapshot}
            conversationSnapshot={conversationSnapshot}
            gate={draftGate}
            gateReasonText={draftGateReasonText}
            onDraftChange={editor.setDraftText}
            onSend={submitEditorDraft}
            onRetrySave={editor.retrySave}
            onRestoreDraft={editor.restoreDraft}
          />
        </div>
      ) : (
      <div className="flex gap-2 border-t p-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
          disabled={chat.isStreaming || !canExecute}
          placeholder={t('research.sourceChat.placeholder')}
          data-testid="srcchat-input"
        />
        <Button
          onClick={submit}
          disabled={!query.trim() || chat.isStreaming || !canExecute}
          data-testid="srcchat-send"
        >
          {t('research.sourceChat.send')}
        </Button>
      </div>
      )}
    </div>
  )
}
