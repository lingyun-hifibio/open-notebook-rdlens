'use client'

/**
 * Issue #1048 PR7（D2-B4）：本地写作编排 hook。
 *
 * 顺序（方案 §6.1/§6.1.2，不得打乱）：
 * 1. **会话**：当前会话或新建会话（客户端预生成并持久保存 session_id；失败
 *    同 id 重试，禁止重复创建；创建/打开/选择不自动发送）；
 * 2. **composer 身份桥接**：发送前经既有 session editor CAS 保存 query/
 *    draft_token 并等待 ACK，再从**已保存 composer** 读取 editor_revision /
 *    editor_intent_hash（不得用 Note revision 或旧 schema1 哈希）；
 * 3. **独立意图**：`writing_intent_hash` 由闭合 15 键意图对象计算（composer
 *    身份 + document_context + history_mode），Note revision 只在 document_context；
 * 4. **提交**：`POST .../writing` 两步传输（202 → attach SSE），终态后拉取
 *    `GET .../writing-contexts/{generation_id}` 展示实际输入；
 * 5. **恢复**：未发送选择刷新后先重查 Note 版本与权限；已冻结/结果未知用
 *    原请求身份重放（不生成新 token、不重新取当前正文）。
 *
 * 传输/副作用经 ports 注入：生产用 `writing-client.ts`，测试用 fake（不进网）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { generateSessionId } from '@/lib/hooks/use-research-sessions'
import { applySseEvent, createSseState } from '@/lib/research/sse'
import type { ResearchSseEvent } from '@/lib/research/types'
import type { ResearchSessionKind, ResearchSessionRef } from '@/lib/research/session-contract'
import {
  IDLE_WRITING_SUBMISSION,
  type WritingApiError,
  type WritingDocumentContext,
  type WritingHistoryMode,
  type WritingNoteVerification,
  type WritingSelection,
  type WritingSessionCreateResult,
  type WritingSubmissionRequest,
  type WritingSubmissionView,
} from './writing-types'
import {
  buildWritingSubmissionRequest,
  measureWritingCapacity,
  normalizeWritingDocumentContext,
  selectedWritingText,
  writingUtf8Bytes,
} from './writing-intent'
import {
  createWritingCacheRecord,
  readWritingCacheRecord,
  readOrCreateWritingCacheTabId,
  removeWritingCacheRecord,
  removeWritingCacheForNote,
  writeWritingCacheRecord,
  type WritingCacheRecord,
  type WritingCacheScope,
  type WritingCachedChoice,
  type WritingCachedSubmission,
  type WritingConfirmedSessionCreate,
} from './writing-cache'
import {
  createWritingSession,
  getWritingContext,
  normalizeWritingHttpFailure,
  resolveWritingOwnerUserId,
  submitWritingSubmission,
  verifyWritingNote,
  writingApiError,
  writingOwnerUserId,
  writingResponseLanguage,
  type CreateWritingSessionInput,
  type SubmitWritingInput,
  type WritingContextResult,
} from './writing-client'

// ── Ports（测试注入；生产默认实现直接调用 writing-client） ──

export interface WritingComposePorts {
  readonly createSession: (input: CreateWritingSessionInput) => Promise<WritingSessionCreateResult>
  readonly submitWriting: (input: SubmitWritingInput) => (reason?: 'user_cancel') => void
  readonly getWritingContext: (projectId: string, generationId: string) => Promise<WritingContextResult>
  /**
   * 恢复未发送选择前重新读取 Note 权限与版本（方案 §6.1.2）。
   * 缺省实现：d2-v1 `GET /notes/{id}`（受限/不存在/不可用如实返回）。
   */
  readonly verifyNote: (projectId: string, noteId: string) => Promise<WritingNoteVerification>
  /**
   * 解析契约 `owner_user_id`（优先服务端 editor-state `viewer_user_id`）。
   * 缺省实现不依赖宿主 claims.sub 是数字串（review LOW-3）。 */
  readonly resolveOwnerUserId: (
    projectId: string,
    sessionRef: ResearchSessionRef,
  ) => Promise<number | null>
}

const DEFAULT_PORTS: WritingComposePorts = {
  createSession: createWritingSession,
  submitWriting: (input) => submitWritingSubmission(input),
  getWritingContext,
  verifyNote: verifyWritingNote,
  resolveOwnerUserId: resolveWritingOwnerUserId,
}

// ── composer 保存 port（由持有编辑器控制器的调用方适配） ──

export type ComposerSaveFailureCode =
  | 'not_ready'
  | 'not_loaded'
  | 'dirty'
  | 'saving'
  | 'conflict'
  | 'blocked'
  | 'readonly'
  | 'invalidated'
  | 'no_transport'
  | 'consumed'
  | 'invalid'
  | 'failed'
  | 'unknown'

export type ComposerSaveResult =
  | {
      readonly ok: true
      /** 已保存 composer 的 revision（ACK 后读取）。 */
      readonly revision: number
      readonly intentHash: string
      readonly draftToken: string
    }
  | { readonly ok: false; readonly code: ComposerSaveFailureCode }

// ── 编排错误（阶段 + 稳定码；UI 映射文案，不展示服务端 detail） ──

export type WritingComposeErrorCode =
  | 'note_required'
  | 'selection_invalid'
  | 'owner_unknown'
  | 'model_missing'
  | 'query_required'
  | 'query_too_large'
  | 'session_required'
  | 'session_create_failed'
  | 'session_unauthorized'
  | 'composer_not_ready'
  | 'composer_conflict'
  | 'composer_blocked'
  | 'composer_failed'
  | 'invalid_request'
  | 'unknown'

export type WritingComposeErrorStage = 'session' | 'composer' | 'submit' | 'validation'

export interface WritingComposeError {
  readonly stage: WritingComposeErrorStage
  readonly code: WritingComposeErrorCode
  readonly apiError: WritingApiError | null
}

export type WritingRecoveryKind =
  | 'unsent'
  | 'stale'
  | 'unknown'
  /** 当前 Note 权限受限：不恢复，只显示受限说明。 */
  | 'restricted'
  /** 权限/版本暂时无法判定：不恢复正文/选择，保留缓存并可稍后重试。 */
  | 'unavailable'

export interface WritingRecoveryNotice {
  readonly kind: WritingRecoveryKind
  /** stale 的具体原因：Note 版本变化 / 目标会话身份不再匹配。 */
  readonly cause: 'note' | 'session' | null
  /** 缓存中的原始选择（stale 时仅用于展示版本号，不得据此重新提交）。 */
  readonly choice: WritingCachedChoice | null
  readonly submission: WritingCachedSubmission | null
}

// ── 输入 ──

export interface WritingComposeCurrentNote {
  readonly noteId: string
  readonly revision: number
  readonly snapshotHash: string
  readonly content: string
}

export interface UseWritingComposeOptions {
  readonly projectId: string
  /** 已认证 viewer（claims.sub 字符串；owner_user_id 需为正整数）。 */
  readonly viewerUserId: string | null
  /** 认证代际（缓存读取授权；缺省 0 仅用于测试/历史宿主）。 */
  readonly authGeneration?: number
  /** UI 语言（→ response_language 'zh'|'en'）。 */
  readonly language: string
  /** 已确认模型（required；缺失时可见阻断，不伪造发送）。 */
  readonly modelId: string | null
  /** 当前显示中的会话（source focus 时是 source 会话）。 */
  readonly currentRef: ResearchSessionRef | null
  /** 当前 source surface 的来源 id（null = global surface）。 */
  readonly sourceId: string | null
  /** 当前打开的 Note（用于恢复时重新检查版本）；null = 文档未加载。 */
  readonly currentNote: WritingComposeCurrentNote | null
  /** 当前 Note 的权限投影；restricted/unknown 时不得恢复缓存正文/选择。 */
  readonly notePermission: 'visible' | 'restricted' | 'unknown'
  /** 写作入口初始选择（打开对话框时捕获；用户可在对话框内调整）。 */
  readonly initialSelection: WritingSelection
  readonly ports?: Partial<WritingComposePorts>
  readonly openSession?: (ref: ResearchSessionRef) => boolean
  /** 测试注入时钟/随机源。 */
  readonly now?: () => string
  readonly newAttemptId?: () => string
  readonly newSessionId?: () => string
  readonly newIdempotencyKey?: () => string
}

export interface UseWritingComposeResult {
  readonly selection: WritingSelection
  readonly historyMode: WritingHistoryMode
  readonly sessionChoiceKind: 'current' | 'new'
  readonly query: string
  /** 已创建的新会话身份（未创建为 null）。 */
  readonly createdSession: ResearchSessionRef | null
  /** 当前解析出的目标会话（currentRef 或已创建的新会话）。 */
  readonly targetRef: ResearchSessionRef | null
  readonly submission: WritingSubmissionView
  readonly composeError: WritingComposeError | null
  readonly recovery: WritingRecoveryNotice | null
  readonly cacheDegraded: boolean
  /** 最近一次已提交写作请求的 query（结果消息按 generation 定位时的完整性校验）。 */
  readonly lastSubmittedQuery: string | null
  /** 输入选择与实际容量（UTF-8 字节；超限发送前即提示）。 */
  readonly capacity: ReturnType<typeof measureWritingCapacity>
  setSelection: (selection: WritingSelection) => void
  setHistoryMode: (mode: WritingHistoryMode) => void
  setSessionChoice: (choice: 'current' | 'new') => void
  setQuery: (query: string) => void
  /** 新建会话（客户端预生成 id；失败同 id 重试；**不**发送）。 */
  createSession: () => Promise<boolean>
  /** 保存 composer 并提交写作（顺序固定；失败时如实展示）。 */
  submit: (saveComposer: (query: string) => Promise<ComposerSaveResult>) => Promise<void>
  /** 结果未知/已冻结：用原请求身份重放（不重新保存 composer）。 */
  retrySameSubmission: () => Promise<void>
  /** 本地中止读取（服务端可能仍在执行；不冒充取消）。 */
  cancel: () => void
  /** 丢弃恢复建议（清理该标签页缓存记录）。 */
  discardRecovery: () => void
  /** 重置为新的写作尝试（关对话框/重新开始）。 */
  reset: () => void
}

function randomSuffix(): string {
  const cryptoObject =
    typeof globalThis === 'object' ? (globalThis as { crypto?: Crypto }).crypto : undefined
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID().replace(/-/g, '')
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function defaultAttemptId(): string {
  return `watt_${randomSuffix()}`
}

function defaultIdempotencyKey(): string {
  return `w1_${randomSuffix()}`
}

function toDocumentContext(
  note: WritingComposeCurrentNote,
  selection: WritingSelection,
): WritingDocumentContext {
  return {
    note_id: note.noteId,
    revision: note.revision,
    snapshot_hash: note.snapshotHash,
    selection,
  }
}

function normalizeHttpError(status: number, body: unknown): WritingApiError {
  // 共享归一化：已知稳定码优先，未知码按状态兜底；不再把 422 一律当容量、
  // 409 一律当 context changed（review MEDIUM-6）。
  return normalizeWritingHttpFailure(status, body)
}

/**
 * 本地写作编排。所有失败都体现在 `composeError` / `submission` 上，不抛异常。
 */
export function useWritingCompose(options: UseWritingComposeOptions): UseWritingComposeResult {
  const {
    projectId,
    viewerUserId,
    authGeneration = 0,
    language,
    modelId,
    currentRef,
    sourceId,
    currentNote,
    notePermission,
    initialSelection,
    ports: injectedPorts,
    openSession,
    now,
    newAttemptId,
    newSessionId,
    newIdempotencyKey,
  } = options

  const ports = useMemo<WritingComposePorts>(
    () => ({ ...DEFAULT_PORTS, ...injectedPorts }),
    [injectedPorts],
  )
  // 稳定引用：这些回调进入 useCallback/useEffect 依赖，内联函数会让每次
  // render 都重建依赖并触发多余的缓存写入。
  const clock = useMemo(() => now ?? (() => new Date().toISOString()), [now])
  const makeAttemptId = useMemo(() => newAttemptId ?? defaultAttemptId, [newAttemptId])
  const makeSessionId = useMemo(() => newSessionId ?? generateSessionId, [newSessionId])
  const makeIdempotencyKey = useMemo(
    () => newIdempotencyKey ?? defaultIdempotencyKey,
    [newIdempotencyKey],
  )

  const ownerUserId = useMemo(() => writingOwnerUserId(viewerUserId), [viewerUserId])
  const noteId = currentNote?.noteId ?? ''
  const cacheScope = useMemo<WritingCacheScope | null>(() => {
    if (ownerUserId === null || noteId.length === 0) return null
    return {
      ownerId: String(ownerUserId),
      projectId,
      noteId,
      tabId: readOrCreateWritingCacheTabId(),
    }
  }, [ownerUserId, projectId, noteId])

  const [selection, setSelectionState] = useState<WritingSelection>(initialSelection)
  const [historyMode, setHistoryModeState] = useState<WritingHistoryMode>('none')
  const [sessionChoiceKind, setSessionChoiceKindState] = useState<'current' | 'new'>(
    currentRef !== null ? 'current' : 'new',
  )
  const [query, setQueryState] = useState('')
  const [createdSession, setCreatedSession] = useState<ResearchSessionRef | null>(null)
  const [submission, setSubmission] = useState<WritingSubmissionView>(IDLE_WRITING_SUBMISSION)
  const [composeError, setComposeError] = useState<WritingComposeError | null>(null)
  const [recovery, setRecovery] = useState<WritingRecoveryNotice | null>(null)
  const [cacheDegraded, setCacheDegraded] = useState(false)
  const [lastSubmittedQuery, setLastSubmittedQuery] = useState<string | null>(null)

  /** 供应 session 创建的尝试 id（同一次尝试重试复用）。 */
  const attemptIdRef = useRef<string | null>(null)
  /** 当前提交的幂等键（同一次提交的 attach/重试复用）。 */
  const idempotencyKeyRef = useRef<string | null>(null)
  /** SSE 累积状态（避免闭包过期）。 */
  const sseRef = useRef(createSseState())
  /** 最近一次 accepted 的 generation_id（严格等值推进）。 */
  const generationIdRef = useRef<string | null>(null)
  const abortRef = useRef<((reason?: 'user_cancel') => void) | null>(null)
  const mountedRef = useRef(true)
  /** 当前最近一次提交使用的目标会话（重放时仍用它）。 */
  const submittedTargetRef = useRef<ResearchSessionRef | null>(null)
  /** 最近一次提交请求（结果未知时用于原样重放）。 */
  const storedRequestRef = useRef<WritingSubmissionRequest | null>(null)
  /** 恢复逻辑只对当前 (身份, 项目, 文档) 作用域执行一次。 */
  const restoredScopeRef = useRef<string | null>(null)
  /**
   * 恢复命中期间抑制“未发送选择”自动回写：否则 stale/restricted 清理后会被
   * 当前默认选择立即重新写回，形成虚假的可恢复状态。
   */
  const suppressChoicePersistRef = useRef(false)
  /** 最新 query（写缓存时避免把每次键入都作为 effect 依赖）。 */
  const queryRef = useRef(query)
  queryRef.current = query
  /** 提交 single-flight：composer ACK/传输期间重复点击不得并发提交。 */
  const submitInFlightRef = useRef(false)
  /** 新建会话 single-flight：重复点击不得并发创建。 */
  const createInFlightRef = useRef(false)
  /** 每次恢复/提交的取消代际（旧的异步恢复结果不得覆盖新状态）。 */
  const restoreRequestSeqRef = useRef(0)
  /** query debounce 定时器。 */
  const queryPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.('user_cancel')
      abortRef.current = null
      if (queryPersistTimerRef.current !== null) {
        clearTimeout(queryPersistTimerRef.current)
        queryPersistTimerRef.current = null
      }
    }
  }, [])

  const cacheAuthority = useMemo(
    () => ({
      authenticatedOwnerId: ownerUserId !== null ? String(ownerUserId) : null,
      currentProjectId: projectId,
      authGeneration,
      currentAuthGeneration: authGeneration,
      notePermission,
    }),
    [ownerUserId, projectId, authGeneration, notePermission],
  )

  const readCacheRecord = useCallback((): WritingCacheRecord | null => {
    if (cacheScope === null) return null
    return readWritingCacheRecord(cacheScope, { authority: cacheAuthority })
  }, [cacheScope, cacheAuthority])

  const persistRecord = useCallback(
    (patch: Partial<WritingCacheRecord>): void => {
      if (cacheScope === null) return
      // 缓存不是授权凭据：权限未知/受限时不得写入（清理仍可用 remove）。
      if (notePermission !== 'visible') return
      const existing = readCacheRecord()
      const base =
        existing ??
        createWritingCacheRecord({
          scope: cacheScope,
          now: clock(),
          authGeneration,
        })
      const next: WritingCacheRecord = {
        ...base,
        ...patch,
        v: 1,
        ownerId: cacheScope.ownerId,
        projectId: cacheScope.projectId,
        noteId: cacheScope.noteId,
        tabId: cacheScope.tabId,
        updatedAt: clock(),
      }
      const result = writeWritingCacheRecord(cacheScope, next)
      if (result.ok) setCacheDegraded(!result.persisted)
    },
    [cacheScope, readCacheRecord, clock, notePermission, authGeneration],
  )

  // ── 目标解析 ──

  const targetRef = useMemo<ResearchSessionRef | null>(() => {
    if (sessionChoiceKind === 'current') return currentRef
    return createdSession
  }, [sessionChoiceKind, currentRef, createdSession])

  const effectiveKind: ResearchSessionKind =
    sessionChoiceKind === 'current'
      ? (currentRef?.kind ?? (sourceId !== null ? 'source' : 'global'))
      : currentRef?.kind === 'source' || sourceId !== null
        ? 'source'
        : 'global'
  const effectiveSourceId =
    effectiveKind === 'source'
      ? (currentRef?.kind === 'source' ? (currentRef.sourceId ?? sourceId) : sourceId)
      : null

  const buildChoice = useCallback(
    (
      targetSelection: WritingSelection,
      targetHistory: WritingHistoryMode,
      targetQuery: string,
    ): WritingCachedChoice | null => {
      if (currentNote === null) return null
      return {
        documentSelection: toDocumentContext(currentNote, targetSelection),
        historyMode: targetHistory,
        sessionChoice: sessionChoiceKind,
        sessionKind: effectiveKind,
        sourceId: effectiveSourceId,
        currentSessionId: currentRef?.sessionId ?? null,
        query: targetQuery,
        modelId: modelId ?? '',
      }
    },
    [currentNote, sessionChoiceKind, effectiveKind, effectiveSourceId, currentRef, modelId],
  )

  // ── 恢复：刷新后重新检查 Note 版本/权限与目标会话身份 ──

  /**
   * 缓存选择的目标会话是否与当前上下文一致（方案 §6.1.1/§6.1.2）。
   *
   * - `sessionChoice='current'`：缓存的 session_id/kind/source 必须与当前
   *   显示的会话完全一致；当前没有会话 → 不恢复；
   * - `sessionChoice='new'`：缓存的 kind/source 必须与当前 surface 解析出的
   *   新会话绑定一致（来源 surface 的新会话不能投到 global，反之亦然）。
   */
  function choiceTargetMatchesCurrent(
    choice: WritingCachedChoice,
    current: ResearchSessionRef | null,
    expectedKind: ResearchSessionKind,
    expectedSourceId: string | null,
  ): boolean {
    if (choice.sessionChoice === 'current') {
      if (current === null) return false
      if (choice.currentSessionId !== current.sessionId) return false
      if (choice.sessionKind !== current.kind) return false
      const choiceSource = choice.sessionKind === 'source' ? choice.sourceId : null
      const currentSource = current.kind === 'source' ? (current.sourceId ?? null) : null
      return choiceSource === currentSource
    }
    return choice.sessionKind === expectedKind && choice.sourceId === expectedSourceId
  }

  const confirmedTargetMatches = useCallback(
    (confirmed: WritingConfirmedSessionCreate): boolean =>
      confirmed.sessionKind === effectiveKind && confirmed.sourceId === effectiveSourceId,
    [effectiveKind, effectiveSourceId],
  )

  const restoreScopeKey = `${projectId}|${noteId}|${viewerUserId ?? ''}|${authGeneration}`
  useEffect(() => {
    if (cacheScope === null) return
    if (currentNote === null) return
    if (notePermission === 'unknown') return
    if (restoredScopeRef.current === restoreScopeKey) return
    restoredScopeRef.current = restoreScopeKey
    // 对话/缓存授权已知受限：立即清理，不发任何请求、不恢复正文/选择。
    if (notePermission === 'restricted') {
      suppressChoicePersistRef.current = true
      removeWritingCacheForNote({
        ownerId: cacheScope.ownerId,
        projectId: cacheScope.projectId,
        noteId: cacheScope.noteId,
      })
      setRecovery({ kind: 'restricted', cause: null, choice: null, submission: null })
      return
    }
    // 恢复是异步的（先服务端重查 Note）：在它完成前抑制“未发送选择自动落盘”，
    // 否则默认选择会在 await 窗口内覆盖待恢复的缓存记录。
    suppressChoicePersistRef.current = true
    // 同步快照读取：缓存记录必须在任何 await 之前捕获，避免被自动落盘改写。
    const recordAtStart = readCacheRecord()
    if (recordAtStart === null) {
      // 没有可恢复记录：无需服务端重查 Note，允许选择正常落盘。
      suppressChoicePersistRef.current = false
      return
    }
    const requestSeq = (restoreRequestSeqRef.current += 1)
    const stillCurrent = (): boolean =>
      mountedRef.current && restoreRequestSeqRef.current === requestSeq
    void (async () => {
      // 第一步：重新读取 Note 当前权限与版本（缓存不是授权凭据）。
      let verified: WritingNoteVerification | null = null
      try {
        verified = await ports.verifyNote(projectId, currentNote.noteId)
      } catch {
        verified = { ok: false, reason: 'unavailable' }
      }
      if (!stillCurrent()) return
      if (verified === null) {
        setRecovery({ kind: 'unavailable', cause: null, choice: null, submission: null })
        return
      }
      if (!verified.ok && verified.reason === 'restricted') {
        suppressChoicePersistRef.current = true
        removeWritingCacheForNote({
          ownerId: cacheScope.ownerId,
          projectId: cacheScope.projectId,
          noteId: cacheScope.noteId,
        })
        setRecovery({ kind: 'restricted', cause: null, choice: null, submission: null })
        return
      }
      if (!verified.ok && verified.reason === 'not_found') {
        suppressChoicePersistRef.current = true
        removeWritingCacheForNote({
          ownerId: cacheScope.ownerId,
          projectId: cacheScope.projectId,
          noteId: cacheScope.noteId,
        })
        setRecovery({ kind: 'stale', cause: 'note', choice: null, submission: null })
        return
      }
      if (!verified.ok) {
        // 暂时不可判定：不恢复正文/选择，保留缓存并显示可重试说明。
        setRecovery({ kind: 'unavailable', cause: null, choice: null, submission: null })
        return
      }
      // 服务端确认的版本必须与打开对话框时捕获的版本一致；否则不静默改用
      // 当前正文（要求用户重新确认）。
      if (
        verified.revision !== currentNote.revision ||
        verified.snapshotHash !== currentNote.snapshotHash
      ) {
        setRecovery({ kind: 'unavailable', cause: null, choice: null, submission: null })
        return
      }
      const record = recordAtStart
      if (record === null) {
        suppressChoicePersistRef.current = false
        return
      }
      if (!stillCurrent()) return
      if (record.choice !== null) {
        suppressChoicePersistRef.current = true
        const choice = record.choice
        const noteMatches =
          choice.documentSelection.note_id === currentNote.noteId &&
          choice.documentSelection.revision === verified.revision &&
          choice.documentSelection.snapshot_hash === verified.snapshotHash
        if (!noteMatches) {
          // Note 版本已变化：原选择失效，不得静默改成当前正文/生成新 token。
          persistRecord({ choice: null })
          setRecovery({ kind: 'stale', cause: 'note', choice, submission: record.lastSubmission })
          return
        }
        if (!choiceTargetMatchesCurrent(choice, currentRef, effectiveKind, effectiveSourceId)) {
          // 目标会话身份不符（例如 source 会话选择在 global surface 恢复）：
          // 不恢复、不把目标静默换成当前会话。
          persistRecord({ choice: null })
          setRecovery({
            kind: 'stale',
            cause: 'session',
            choice,
            submission: record.lastSubmission,
          })
          return
        }
        setSelectionState(choice.documentSelection.selection)
        setHistoryModeState(choice.historyMode)
        setSessionChoiceKindState(choice.sessionChoice)
        setQueryState(choice.query)
        if (choice.sessionChoice === 'new') {
          const confirmed = record.confirmedSessionCreate
          if (confirmed !== null && confirmedTargetMatches(confirmed)) {
            setCreatedSession({
              domain: 'research',
              kind: confirmed.sessionKind,
              projectId,
              sessionId: confirmed.sessionId,
              sourceId: confirmed.sessionKind === 'source' ? confirmed.sourceId : null,
            })
          }
        }
        setRecovery({
          kind: 'unsent',
          cause: null,
          choice,
          submission: record.lastSubmission,
        })
        // 恢复完成：后续输入/选择必须能重新落盘（否则 suppress 常开，debounce
        // 与关闭 flush 全部被抑制，刷新仍丢最新输入）。
        suppressChoicePersistRef.current = false
        return
      }
      if (record.lastSubmission !== null) {
        suppressChoicePersistRef.current = true
        // 结果未知/已冻结：恢复原请求身份（重放使用原会话，不换目标）。
        const submission = record.lastSubmission
        submittedTargetRef.current = {
          domain: 'research',
          kind: submission.sessionKind,
          projectId,
          sessionId: submission.sessionId,
          sourceId: submission.sessionKind === 'source' ? submission.sourceId : null,
        }
        setRecovery({ kind: 'unknown', cause: null, choice: null, submission })
        return
      }
      // 既有记录但没有可恢复内容：允许后续选择正常落盘。
      suppressChoicePersistRef.current = false
    })()
  }, [
    cacheScope,
    currentNote,
    notePermission,
    restoreScopeKey,
    projectId,
    readCacheRecord,
    persistRecord,
    ports,
    currentRef,
    effectiveKind,
    effectiveSourceId,
    confirmedTargetMatches,
  ])

  // 作用域切换清理（身份/项目/文档变化不沿用上一状态）。
  const lastScopeKeyRef = useRef(restoreScopeKey)
  useEffect(() => {
    if (lastScopeKeyRef.current === restoreScopeKey) return
    lastScopeKeyRef.current = restoreScopeKey
    abortRef.current?.('user_cancel')
    abortRef.current = null
    setCreatedSession(null)
    setSubmission(IDLE_WRITING_SUBMISSION)
    setComposeError(null)
    setRecovery(null)
    setLastSubmittedQuery(null)
    attemptIdRef.current = null
    idempotencyKeyRef.current = null
    generationIdRef.current = null
    submittedTargetRef.current = null
    storedRequestRef.current = null
    sseRef.current = createSseState()
    restoredScopeRef.current = null
    submitInFlightRef.current = false
    createInFlightRef.current = false
    restoreRequestSeqRef.current += 1
    if (queryPersistTimerRef.current !== null) {
      clearTimeout(queryPersistTimerRef.current)
      queryPersistTimerRef.current = null
    }
  }, [restoreScopeKey])

  // 未发送选择落盘：选择/历史/会话/文档变化时立即写；query 输入做 debounce
  // （方案 §6.1.2 允许缓存 query/请求身份；不缓存历史正文/凭证/候选）。
  useEffect(() => {
    if (suppressChoicePersistRef.current) return
    if (cacheScope === null || currentNote === null) return
    const choice = buildChoice(selection, historyMode, queryRef.current)
    if (choice === null) return
    persistRecord({ choice })
  }, [cacheScope, currentNote, buildChoice, selection, historyMode, sessionChoiceKind, persistRecord])

  // query 输入 debounce 落盘（400ms；关闭/reset 时也会显式落盘一次）。
  // 抑制标记在定时器触发时判断（恢复是异步的；若在 effect 建立时就跳过，
  // 恢复完成前键入的 query 会永远不落盘）。
  useEffect(() => {
    if (cacheScope === null || currentNote === null) return
    if (queryPersistTimerRef.current !== null) {
      clearTimeout(queryPersistTimerRef.current)
    }
    queryPersistTimerRef.current = setTimeout(() => {
      queryPersistTimerRef.current = null
      if (!mountedRef.current || suppressChoicePersistRef.current) return
      const choice = buildChoice(selection, historyMode, queryRef.current)
      if (choice === null) return
      persistRecord({ choice })
    }, 400)
    return () => {
      if (queryPersistTimerRef.current !== null) {
        clearTimeout(queryPersistTimerRef.current)
        queryPersistTimerRef.current = null
      }
    }
  }, [
    cacheScope,
    currentNote,
    buildChoice,
    selection,
    historyMode,
    sessionChoiceKind,
    query,
    persistRecord,
  ])

  // ── 会话创建（不发送；失败同 id 重试） ──

  const createSession = useCallback(async (): Promise<boolean> => {
    if (createInFlightRef.current) return false
    setComposeError(null)
    if (sessionChoiceKind !== 'new') {
      setComposeError({ stage: 'session', code: 'session_required', apiError: null })
      return false
    }
    if (createdSession !== null) return true
    if (effectiveKind === 'source' && effectiveSourceId === null) {
      setComposeError({ stage: 'session', code: 'session_required', apiError: null })
      return false
    }
    // 已确认创建成功过的会话（刷新/重开对话框）：直接复用，禁止重复创建。
    const existing = readCacheRecord()
    const confirmed = existing?.confirmedSessionCreate ?? null
    if (confirmed !== null && confirmedTargetMatches(confirmed)) {
      setCreatedSession({
        domain: 'research',
        kind: confirmed.sessionKind,
        projectId,
        sessionId: confirmed.sessionId,
        sourceId: confirmed.sessionKind === 'source' ? confirmed.sourceId : null,
      })
      return true
    }
    if (attemptIdRef.current === null) attemptIdRef.current = makeAttemptId()
    const attemptId = attemptIdRef.current
    // 持久保存同一目标（kind/source 相同）的 session_id：创建结果未知时无论
    // 同一次尝试还是刷新后重试，都必须复用同一 id（服务端 200/created=false
    // 视作同一会话），禁止重复创建。
    let sessionId: string
    const pending = existing?.pendingSessionCreate ?? null
    if (
      pending !== null &&
      pending.sessionKind === effectiveKind &&
      pending.sourceId === effectiveSourceId
    ) {
      sessionId = pending.sessionId
    } else {
      sessionId = makeSessionId()
      persistRecord({
        pendingSessionCreate: {
          attemptId,
          sessionId,
          sessionKind: effectiveKind,
          sourceId: effectiveSourceId,
          createdAt: clock(),
        },
      })
    }
    createInFlightRef.current = true
    setSubmission((previous) => ({ ...previous, stage: 'preparing_session' }))
    const result = await ports.createSession({
      projectId,
      sessionId,
      kind: effectiveKind,
      sourceId: effectiveSourceId,
    })
    createInFlightRef.current = false
    if (!mountedRef.current) return false
    if (!result.ok) {
      setSubmission((previous) => ({ ...previous, stage: 'idle' }))
      const unauthorized =
        result.error.code === 'chat_owner_required' ||
        result.error.code === 'access_denied' ||
        result.error.status === 403
      setComposeError({
        stage: 'session',
        code: unauthorized ? 'session_unauthorized' : 'session_create_failed',
        apiError: result.error,
      })
      return false
    }
    // 创建成功：把 session_id 持久化为“已确认会话”，刷新后复用同一会话。
    persistRecord({
      pendingSessionCreate: null,
      confirmedSessionCreate: {
        sessionId: result.ref.sessionId,
        sessionKind: result.ref.kind,
        sourceId: result.ref.kind === 'source' ? (result.ref.sourceId ?? null) : null,
        createdAt: clock(),
      },
    })
    setSubmission((previous) => ({ ...previous, stage: 'idle' }))
    setCreatedSession(result.ref)
    if (openSession !== undefined) openSession(result.ref)
    return true
  }, [
    sessionChoiceKind,
    createdSession,
    effectiveKind,
    effectiveSourceId,
    makeAttemptId,
    makeSessionId,
    readCacheRecord,
    confirmedTargetMatches,
    persistRecord,
    clock,
    ports,
    projectId,
    openSession,
  ])

  // ── 提交 ──

  const failCompose = useCallback(
    (
      stage: WritingComposeErrorStage,
      code: WritingComposeErrorCode,
      apiError: WritingApiError | null = null,
    ): void => {
      setComposeError({ stage, code, apiError })
    },
    [],
  )

  const updateSubmission = useCallback((patch: Partial<WritingSubmissionView>): void => {
    setSubmission((previous) => ({ ...previous, ...patch }))
  }, [])

  const clearCacheAfterDone = useCallback((): void => {
    if (cacheScope === null) return
    removeWritingCacheRecord(cacheScope)
    setCacheDegraded(false)
  }, [cacheScope])

  const finishWithContext = useCallback(
    async (generationId: string | null): Promise<void> => {
      if (generationId === null) {
        submitInFlightRef.current = false
        updateSubmission({
          stage: 'done',
          context: null,
          contextError: writingApiError('unknown_error', { status: 0, retryable: false }),
        })
        return
      }
      updateSubmission({ stage: 'fetching_context' })
      const result = await ports.getWritingContext(projectId, generationId)
      if (!mountedRef.current) return
      submitInFlightRef.current = false
      if (result.ok) {
        updateSubmission({ stage: 'done', context: result.projection, contextError: null })
      } else {
        updateSubmission({ stage: 'done', context: null, contextError: result.error })
      }
      clearCacheAfterDone()
    },
    [ports, projectId, updateSubmission, clearCacheAfterDone],
  )

  const handleStreamEvent = useCallback(
    (event: ResearchSseEvent): void => {
      const next = applySseEvent(sseRef.current, event)
      sseRef.current = next
      if (!mountedRef.current) return
      if (next.accepted !== null && generationIdRef.current === null) {
        generationIdRef.current = next.accepted.generationId
      }
      const generationId = generationIdRef.current
      updateSubmission({
        stage: next.terminal === 'done' ? 'fetching_context' : 'streaming',
        answer: next.answer,
        thinking: next.thinking,
        terminal: next.terminal,
        terminalErrorCode: next.errorCode,
        generationId,
      })
      if (next.terminal === 'error') {
        submitInFlightRef.current = false
        updateSubmission({
          stage: 'error',
          error: writingApiError('generation_failed', {
            status: 0,
            retryable: false,
          }),
        })
      }
      if (next.terminal === 'done') {
        void finishWithContext(generationId)
      }
    },
    [updateSubmission, finishWithContext],
  )

  const buildRequestFor = useCallback(
    (
      target: ResearchSessionRef,
      owner: number,
      input: {
        editorRevision: number
        intentHash: string
        draftToken: string
        documentContext: WritingDocumentContext
        history: WritingHistoryMode
      },
    ): WritingSubmissionRequest | null => {
      if (modelId === null || currentNote === null) return null
      const built = buildWritingSubmissionRequest({
        projectId,
        ownerUserId: owner,
        sessionKind: target.kind,
        sourceId: target.kind === 'source' ? (target.sourceId ?? null) : null,
        sessionId: target.sessionId,
        editorRevision: input.editorRevision,
        editorIntentHash: input.intentHash,
        draftToken: input.draftToken,
        query: queryRef.current,
        modelId,
        responseLanguage: writingResponseLanguage(language),
        documentContext: input.documentContext,
        historyMode: input.history,
      })
      return built.ok ? built.value.request : null
    },
    [modelId, currentNote, projectId, language],
  )

  const launchSubmission = useCallback(
    (
      target: ResearchSessionRef,
      request: WritingSubmissionRequest,
      idempotencyKey: string,
    ): void => {
      submittedTargetRef.current = target
      storedRequestRef.current = request
      idempotencyKeyRef.current = idempotencyKey
      generationIdRef.current = null
      sseRef.current = createSseState()
      setLastSubmittedQuery(request.query)
      submitInFlightRef.current = true
      updateSubmission({ ...IDLE_WRITING_SUBMISSION, stage: 'submitting' })
      const settleError = (error: WritingApiError): void => {
        submitInFlightRef.current = false
        // 传输/HTTP 错误不代表 Generation 已失败（可能根本没开始执行）：
        // 只记录可见错误，不伪造 terminal 状态/生成失败文案。
        updateSubmission({ stage: 'error', error })
      }
      const abort = ports.submitWriting({
        projectId,
        sessionRef: target,
        request,
        idempotencyKey,
        onAcceptReceipt: (receipt) => {
          if (!mountedRef.current) return
          generationIdRef.current = receipt.generationId
          updateSubmission({ generationId: receipt.generationId, stage: 'streaming' })
        },
        onEvent: handleStreamEvent,
        onHttpError: (status, body) => {
          if (!mountedRef.current) return
          settleError(normalizeHttpError(status, body))
        },
        onNetworkError: () => {
          if (!mountedRef.current) return
          settleError(writingApiError('network_error', { status: 0, retryable: true }))
        },
        onProtocolError: () => {
          if (!mountedRef.current) return
          settleError(writingApiError('invalid_response', { status: 0, retryable: false }))
        },
        onIdleTimeout: () => {
          if (!mountedRef.current) return
          settleError(writingApiError('network_error', { status: 0, retryable: true }))
        },
        onEnd: () => {
          // EOF 但没有终态：结果是未知的（读取被中断/服务端未发 done）。
          // 不得停在 streaming；用原请求身份可重试，不自动重发。
          if (!mountedRef.current) return
          if (sseRef.current.terminal !== null) return
          settleError(
            writingApiError('network_error', {
              status: 0,
              retryable: true,
              message: 'stream ended without terminal event',
            }),
          )
        },
      })
      abortRef.current = abort
    },
    [ports, projectId, updateSubmission, handleStreamEvent],
  )

  const submit = useCallback(
    async (saveComposer: (query: string) => Promise<ComposerSaveResult>): Promise<void> => {
      // single-flight：composer ACK/传输期间的重复点击不得并发保存/提交。
      if (submitInFlightRef.current) return
      setComposeError(null)
      if (currentNote === null) {
        failCompose('validation', 'note_required')
        return
      }
      if (modelId === null || modelId.length === 0) {
        failCompose('validation', 'model_missing')
        return
      }
      if (query.trim().length === 0) {
        failCompose('validation', 'query_required')
        return
      }
      if (writingUtf8Bytes(query) > 128 * 1024) {
        failCompose('validation', 'query_too_large')
        return
      }
      const target = targetRef
      if (target === null) {
        failCompose('validation', 'session_required')
        return
      }
      if (target.kind === 'source' && (target.sourceId ?? null) === null) {
        failCompose('validation', 'session_required')
        return
      }
      const normalizedContext = normalizeWritingDocumentContext(
        toDocumentContext(currentNote, selection),
      )
      if (!normalizedContext.ok) {
        failCompose('validation', 'selection_invalid')
        return
      }
      submitInFlightRef.current = true
      // 先持久化“已确认未发送”的选择（含最新 query）；刷新后可恢复。
      const confirmationChoice = buildChoice(selection, historyMode, query)
      if (confirmationChoice !== null) persistRecord({ choice: confirmationChoice })

      setSubmission((previous) => ({ ...previous, stage: 'preparing_composer' }))
      // 契约 owner_user_id：优先 claims 数字串；否则用服务端 editor-state
      // viewer_user_id（不假设宿主 claims.sub 一定是数字）。
      let owner = ownerUserId
      if (owner === null) {
        try {
          owner = await ports.resolveOwnerUserId(projectId, target)
        } catch {
          owner = null
        }
        if (!mountedRef.current) {
          submitInFlightRef.current = false
          return
        }
      }
      if (owner === null) {
        submitInFlightRef.current = false
        setSubmission((previous) => ({ ...previous, stage: 'idle' }))
        failCompose('validation', 'owner_unknown')
        return
      }

      const saved = await saveComposer(query)
      if (!mountedRef.current) {
        submitInFlightRef.current = false
        return
      }
      if (!saved.ok) {
        submitInFlightRef.current = false
        setSubmission((previous) => ({ ...previous, stage: 'idle' }))
        failCompose(
          'composer',
          saved.code === 'conflict'
            ? 'composer_conflict'
            : saved.code === 'blocked' ||
                saved.code === 'readonly' ||
                saved.code === 'invalidated'
              ? 'composer_blocked'
              : saved.code === 'not_ready' || saved.code === 'not_loaded'
                ? 'composer_not_ready'
                : 'composer_failed',
        )
        return
      }
      const request = buildRequestFor(target, owner, {
        editorRevision: saved.revision,
        intentHash: saved.intentHash,
        draftToken: saved.draftToken,
        documentContext: normalizedContext.value,
        history: historyMode,
      })
      if (request === null) {
        submitInFlightRef.current = false
        setSubmission((previous) => ({ ...previous, stage: 'idle' }))
        failCompose('validation', 'invalid_request')
        return
      }
      persistRecord({
        choice: null,
        lastSubmission: {
          sessionId: target.sessionId,
          sessionKind: target.kind,
          sourceId: target.kind === 'source' ? (target.sourceId ?? null) : null,
          writingIntentHash: request.writing_intent_hash,
          editorRevision: request.editor_revision,
          editorIntentHash: request.editor_intent_hash,
          draftToken: request.draft_token,
          query: request.query,
          modelId,
          responseLanguage: request.response_language,
          documentContext: request.document_context,
          historyMode: request.history_mode,
          createdAt: clock(),
        },
      })
      launchSubmission(target, request, makeIdempotencyKey())
    },
    [
      currentNote,
      ownerUserId,
      modelId,
      query,
      targetRef,
      selection,
      historyMode,
      buildChoice,
      persistRecord,
      buildRequestFor,
      launchSubmission,
      failCompose,
      makeIdempotencyKey,
      clock,
      ports,
      projectId,
    ],
  )

  /**
   * 已冻结/结果未知：用**原请求身份**重放（不重新保存 composer、不生成新
   * token、不重新读取当前正文）。服务端按同 token+同 writing intent 复用原
   * input/Generation；若原请求从未到服务端且 Note 已变化，服务端返回稳定
   * 409（客户端如实展示，不静默改选）。
   */
  const retrySameSubmission = useCallback(async (): Promise<void> => {
    // 同一次提交只允许一条在途重试；重复点击不产生第二个请求/幂等键。
    if (submitInFlightRef.current) return
    setComposeError(null)
    const record = readCacheRecord()
    const cachedSubmission = record?.lastSubmission ?? null
    const cachedTarget =
      cachedSubmission !== null
        ? ({
            domain: 'research',
            kind: cachedSubmission.sessionKind,
            projectId,
            sessionId: cachedSubmission.sessionId,
            sourceId:
              cachedSubmission.sessionKind === 'source' ? cachedSubmission.sourceId : null,
          } satisfies ResearchSessionRef)
        : null
    const target = submittedTargetRef.current ?? cachedTarget
    if (cachedSubmission === null && storedRequestRef.current === null) {
      failCompose('submit', 'unknown')
      return
    }
    if (target === null) {
      failCompose('validation', 'session_required')
      return
    }
    // 原请求身份重建需要同一 owner_user_id：claims 不可解析时用服务端
    // editor-state viewer_user_id（同 submit 路径）。
    let owner = ownerUserId
    if (owner === null) {
      try {
        owner = await ports.resolveOwnerUserId(projectId, target)
      } catch {
        owner = null
      }
      if (!mountedRef.current) return
    }
    if (owner === null) {
      failCompose('validation', 'owner_unknown')
      return
    }
    let request: WritingSubmissionRequest | null = storedRequestRef.current
    if (cachedSubmission !== null) {
      // 用缓存中的原始身份重建同一请求（writing_intent_hash 独立重算并核对）。
      const rebuilt = buildWritingSubmissionRequest({
        projectId,
        ownerUserId: owner,
        sessionKind: cachedSubmission.sessionKind,
        sourceId: cachedSubmission.sourceId,
        sessionId: cachedSubmission.sessionId,
        editorRevision: cachedSubmission.editorRevision,
        editorIntentHash: cachedSubmission.editorIntentHash,
        draftToken: cachedSubmission.draftToken,
        query: cachedSubmission.query,
        modelId: cachedSubmission.modelId,
        responseLanguage: cachedSubmission.responseLanguage,
        documentContext: cachedSubmission.documentContext,
        historyMode: cachedSubmission.historyMode,
      })
      if (!rebuilt.ok || rebuilt.value.intentHash !== cachedSubmission.writingIntentHash) {
        failCompose('submit', 'invalid_request')
        return
      }
      request = rebuilt.value.request
    }
    if (request === null) {
      failCompose('submit', 'unknown')
      return
    }
    launchSubmission(target, request, idempotencyKeyRef.current ?? makeIdempotencyKey())
  }, [
    readCacheRecord,
    ownerUserId,
    projectId,
    launchSubmission,
    failCompose,
    makeIdempotencyKey,
    ports,
  ])

  const cancel = useCallback((): void => {
    abortRef.current?.('user_cancel')
    abortRef.current = null
    submitInFlightRef.current = false
    if (!mountedRef.current) return
    setSubmission((previous) => ({ ...previous, stage: 'cancelled', detached: true }))
  }, [])

  const discardRecovery = useCallback((): void => {
    suppressChoicePersistRef.current = false
    if (cacheScope !== null) removeWritingCacheRecord(cacheScope)
    setRecovery(null)
    setQueryState('')
    setHistoryModeState('none')
    setCreatedSession(null)
    attemptIdRef.current = null
    submitInFlightRef.current = false
    setLastSubmittedQuery(null)
    setSubmission(IDLE_WRITING_SUBMISSION)
    setComposeError(null)
  }, [cacheScope])

  const reset = useCallback((): void => {
    abortRef.current?.('user_cancel')
    abortRef.current = null
    submitInFlightRef.current = false
    // 关闭/重置时把当前输入（含 query）最后一次落盘，避免“只输入指令然后关闭”
    // 后刷新恢复出旧 query（review MEDIUM-2）。
    if (!suppressChoicePersistRef.current && cacheScope !== null && currentNote !== null) {
      const choice = buildChoice(selection, historyMode, queryRef.current)
      if (choice !== null) persistRecord({ choice })
    }
    setCreatedSession(null)
    setSubmission(IDLE_WRITING_SUBMISSION)
    setComposeError(null)
    setLastSubmittedQuery(null)
    attemptIdRef.current = null
    idempotencyKeyRef.current = null
    generationIdRef.current = null
    submittedTargetRef.current = null
    storedRequestRef.current = null
    sseRef.current = createSseState()
    // 新尝试：未发送选择与已确认/未确认的会话创建记录都保留在缓存中
    // （刷新后可恢复；未知创建必须用同一 session_id 重试，禁止重复创建）。
  }, [cacheScope, currentNote, buildChoice, selection, historyMode, persistRecord])

  const setSelection = useCallback((next: WritingSelection): void => {
    suppressChoicePersistRef.current = false
    setSelectionState(next)
  }, [])
  const setHistoryMode = useCallback((next: WritingHistoryMode): void => {
    suppressChoicePersistRef.current = false
    setHistoryModeState(next)
  }, [])
  const setSessionChoice = useCallback((next: 'current' | 'new'): void => {
    setSessionChoiceKindState(next)
  }, [])
  const setQuery = useCallback((next: string): void => {
    // 用户显式输入即恢复落盘（恢复期间的写保护只覆盖恢复窗口）。
    suppressChoicePersistRef.current = false
    setQueryState(next)
  }, [])

  const capacity = useMemo(
    () =>
      measureWritingCapacity({
        selectedText:
          currentNote !== null ? selectedWritingText(currentNote.content, selection) : '',
        query,
      }),
    [currentNote, selection, query],
  )

  return {
    selection,
    historyMode,
    sessionChoiceKind,
    query,
    createdSession,
    targetRef,
    submission,
    composeError,
    recovery,
    cacheDegraded,
    lastSubmittedQuery,
    capacity,
    setSelection,
    setHistoryMode,
    setSessionChoice,
    setQuery,
    createSession,
    submit,
    retrySameSubmission,
    cancel,
    discardRecovery,
    reset,
  }
}
