'use client'

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react'

/**
 * Issue #601 PR5（C1/D-04/D-10/D-21）：C-05 三档范围模型。
 *
 * - `all`：服务端解析当前有权且可读的最新可用版本（覆盖分页外资料）；
 * - `selected`：显式 ID 集合（Note-only = 空 source_ids + 非空 note_ids）；
 * - `single`：临时单篇限定——**随会话存在**（D-04），取消/改选/会话切换清除，
 *   绝不带入新对话。持久化只在确认 `boundSessionId` 后写回，无 session 身份
 *   的持久化限定按不可归属丢弃（`single_unbound_discarded`）。
 *
 * 迁移（D-21）：旧值 `entire_project` 读作 `all`；**所有持久副本**（本键、
 * 恢复 turn 的快照、同意登记）统一经 `normalizePersistedScope` 归一——
 * 旧字面量只允许出现在该函数内。
 */

export type ResearchScopeMode = 'all' | 'selected' | 'single'

/** 旧持久化字面量（仅迁移读取用；静态守卫钉住不得扩散） */
const LEGACY_ENTIRE_PROJECT = 'entire_project' as const

export interface ResearchScopeState {
  readonly mode: ResearchScopeMode
  readonly sourceIds: readonly string[]
  readonly noteIds: readonly string[]
}

/** 临时单篇限定（不进入基础范围的持久化 shape） */
export interface ResearchSinglePin {
  /** 绑定的会话（null = 待绑定；本会话内后续查询生效） */
  boundSessionId: string | null
  sourceId: string
  /** 限定生效前的基础范围（取消后恢复） */
  baseMode: Exclude<ResearchScopeMode, 'single'>
}

export interface ResearchScopeSnapshot {
  readonly mode: ResearchScopeMode
  readonly sourceIds: readonly string[]
  readonly noteIds: readonly string[]
  readonly singleSourceId: string | null
}

export interface ResearchScopeReconciliation {
  sourceIds: string[]
  noteIds: string[]
}

/**
 * RWV2-11（K11）+ PR5：Scope 摘要格式化（i18n key 驱动）。
 * `single` 显示被限定来源名（解析失败由调用方传 ID，不冒充名称）。
 */
export function formatScopeLabel(
  snapshot: ResearchScopeSnapshot,
  t: (key: string, opts?: Record<string, unknown>) => string,
  singleSourceName?: string | null,
): string {
  if (snapshot.mode === 'single' && snapshot.singleSourceId !== null) {
    return t('research.scopeSummary.singleSource', {
      name: singleSourceName ?? snapshot.singleSourceId,
    })
  }
  if (snapshot.mode === 'all') {
    return t('research.scopeSummary.entireProject')
  }
  const parts: string[] = []
  if (snapshot.sourceIds.length > 0) {
    parts.push(
      snapshot.sourceIds.length === 1
        ? t('research.scopeSummary.sourceOne')
        : t('research.scopeSummary.sourceMany', { count: snapshot.sourceIds.length }),
    )
  }
  if (snapshot.noteIds.length > 0) {
    parts.push(
      snapshot.noteIds.length === 1
        ? t('research.scopeSummary.noteOne')
        : t('research.scopeSummary.noteMany', { count: snapshot.noteIds.length }),
    )
  }
  // Reconciliation can intentionally leave selected empty so execution stays
  // blocked instead of silently expanding to the entire project.
  return parts.join(' · ') || t('research.layout.scope.selected')
}

export type ResearchScopeValidation =
  | { valid: true }
  | { valid: false; reason: 'empty_selected_scope' }

interface PersistedResearchScope {
  version: 1
  mode: ResearchScopeMode
  sourceIds: string[]
  noteIds: string[]
}

interface PersistedSinglePin {
  version: 1
  sessionId: string
  sourceId: string
  baseMode: Exclude<ResearchScopeMode, 'single'>
}

const STORAGE_PREFIX = 'rdlens.research.scope.v1'
const SINGLE_STORAGE_PREFIX = 'rdlens.research.scope.single.v1'
const ALL_SCOPE: ResearchScopeState = { mode: 'all', sourceIds: [], noteIds: [] }

function uniqueStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    return null
  }
  return [...new Set(value)]
}

/**
 * D-21：**唯一**的持久范围归一函数。旧 `entire_project` → `all`；
 * 不可识别值返回 null（调用方丢弃，不落 selected 语义）。
 * 静态守卫钉住：旧字面量不得在归一函数之外出现。
 */
export function normalizePersistedScope(value: unknown): ResearchScopeState | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1) return null
  const sourceIds = uniqueStrings(record.sourceIds)
  const noteIds = uniqueStrings(record.noteIds)
  if (sourceIds === null || noteIds === null) return null
  const rawMode = record.mode
  if (rawMode === 'all' || rawMode === LEGACY_ENTIRE_PROJECT) {
    return sourceIds.length + noteIds.length === 0
      ? { mode: 'all', sourceIds: [], noteIds: [] }
      : null
  }
  if (rawMode === 'selected') return { mode: 'selected', sourceIds, noteIds }
  return null
}

export function scopeStorageKey(userId: string, projectId: string): string {
  return `${STORAGE_PREFIX}/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}`
}

function singleStorageKey(userId: string, projectId: string): string {
  return `${SINGLE_STORAGE_PREFIX}/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}`
}

export function validateResearchScope(scope: ResearchScopeState): ResearchScopeValidation {
  if (scope.mode === 'selected' && scope.sourceIds.length + scope.noteIds.length === 0) {
    return { valid: false, reason: 'empty_selected_scope' }
  }
  return { valid: true }
}

function restoreScope(userId: string, projectId: string): ResearchScopeState {
  if (typeof window === 'undefined') return ALL_SCOPE
  const storageKey = scopeStorageKey(userId, projectId)
  const discard = () => {
    try {
      window.localStorage.removeItem(storageKey)
    } catch {
      // Storage may be unavailable; the in-memory fallback remains safe.
    }
    return ALL_SCOPE
  }
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw === null) return ALL_SCOPE
    const parsed: unknown = JSON.parse(raw)
    // 空对象 `{}`（旧版"显式 all"写法）也归一为 all
    if (typeof parsed === 'object' && parsed !== null
      && !('mode' in (parsed as Record<string, unknown>))) {
      return ALL_SCOPE
    }
    const normalized = normalizePersistedScope(parsed)
    if (normalized === null) return discard()
    return normalized
  } catch {
    return discard()
  }
}

function restoreSinglePin(userId: string, projectId: string): ResearchSinglePin | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(singleStorageKey(userId, projectId))
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.version !== 1) return null
    // D-04：无 session 身份的持久化限定不可归属 → 丢弃（不静默扩大）
    if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
      window.localStorage.removeItem(singleStorageKey(userId, projectId))
      return null
    }
    if (typeof record.sourceId !== 'string' || record.sourceId.length === 0) return null
    if (record.baseMode !== 'all' && record.baseMode !== 'selected') return null
    return {
      boundSessionId: record.sessionId,
      sourceId: record.sourceId,
      baseMode: record.baseMode,
    }
  } catch {
    return null
  }
}

function persistScope(userId: string, projectId: string, scope: ResearchScopeState): void {
  if (typeof window === 'undefined') return
  const value: PersistedResearchScope = {
    version: 1,
    mode: scope.mode === 'single' ? 'all' : scope.mode,
    sourceIds: [...scope.sourceIds],
    noteIds: [...scope.noteIds],
  }
  try {
    window.localStorage.setItem(scopeStorageKey(userId, projectId), JSON.stringify(value))
  } catch {
    // Browser storage is optional; a failed write must not block research UI.
  }
}

function persistSinglePin(userId: string, projectId: string, pin: ResearchSinglePin | null): void {
  if (typeof window === 'undefined') return
  try {
    if (pin === null || pin.boundSessionId === null) {
      // 未绑定 session 的限定不落盘（刷新后不可归属即丢弃）
      window.localStorage.removeItem(singleStorageKey(userId, projectId))
      return
    }
    const value: PersistedSinglePin = {
      version: 1, sessionId: pin.boundSessionId, sourceId: pin.sourceId, baseMode: pin.baseMode,
    }
    window.localStorage.setItem(singleStorageKey(userId, projectId), JSON.stringify(value))
  } catch {
    // Optional storage
  }
}

interface ResearchScopeValue {
  /** 生效范围（single 限定存在时为 'single'，否则为基础范围） */
  mode: ResearchScopeMode
  selectedSourceIds: string[]
  selectedNoteIds: string[]
  /** 当前生效的临时单篇（null = 无限定） */
  singlePin: ResearchSinglePin | null
  setMode: (mode: Exclude<ResearchScopeMode, 'single'>) => void
  toggleSource: (sourceId: string) => void
  toggleNote: (noteId: string) => void
  /** 「只问此来源」（D-04）：绑定当前会话；sessionId 未知时先入待绑态 */
  setSingle: (sourceId: string, sessionId: string | null) => void
  /** 用户取消限定 → 恢复基础范围 */
  clearSingle: () => void
  /** 会话身份确认（首响应捕获 / 恢复）时调用：绑定待绑限定或清除异会话限定 */
  bindSession: (sessionId: string) => void
  reconcileSelection: (
    selectableSourceIds?: readonly string[],
    validNoteIds?: readonly string[],
  ) => ResearchScopeReconciliation
  removeNote: (noteId: string) => boolean
  validate: (scope?: ResearchScopeState) => ResearchScopeValidation
  getSnapshot: () => ResearchScopeSnapshot
}

const ResearchScopeContext = createContext<ResearchScopeValue | null>(null)

export function ResearchScopeProvider({
  userId,
  projectId,
  children,
}: {
  userId: string
  projectId: string
  children: React.ReactNode
}): React.ReactNode {
  // The identity key lives at the Provider boundary so any future caller gets
  // the same no-leak remount behavior as the authenticated shell.
  return (
    <ResearchScopeProviderForIdentity
      key={scopeStorageKey(userId, projectId)}
      userId={userId}
      projectId={projectId}
    >
      {children}
    </ResearchScopeProviderForIdentity>
  )
}

function ResearchScopeProviderForIdentity({
  userId,
  projectId,
  children,
}: {
  userId: string
  projectId: string
  children: React.ReactNode
}): React.ReactNode {
  const [scope, setScopeState] = useState<ResearchScopeState>(() => restoreScope(userId, projectId))
  const [singlePin, setSinglePinState] = useState<ResearchSinglePin | null>(
    () => restoreSinglePin(userId, projectId),
  )
  const scopeRef = useRef(scope)
  const singlePinRef = useRef(singlePin)

  const updateScope = useCallback((next: ResearchScopeState) => {
    scopeRef.current = next
    setScopeState(next)
    persistScope(userId, projectId, next)
  }, [projectId, userId])

  const updateSinglePin = useCallback((next: ResearchSinglePin | null) => {
    singlePinRef.current = next
    setSinglePinState(next)
    persistSinglePin(userId, projectId, next)
  }, [projectId, userId])

  const setMode = useCallback((mode: Exclude<ResearchScopeMode, 'single'>) => {
    // 切模式 = 显式范围操作：清除临时限定（D-04）
    updateSinglePin(null)
    if (mode === 'all') {
      updateScope(ALL_SCOPE)
      return
    }
    // Selected cannot be entered without an explicit item selection.
    if (scopeRef.current.sourceIds.length + scopeRef.current.noteIds.length > 0) {
      updateScope({ ...scopeRef.current, mode })
    }
  }, [updateScope, updateSinglePin])

  const toggle = useCallback((kind: 'sourceIds' | 'noteIds', id: string) => {
    // 勾选/取消是显式范围操作：清除临时限定（D-10/D-04）
    updateSinglePin(null)
    const current = scopeRef.current
    const ids = current[kind]
    const hasId = ids.includes(id)
    const nextIds = hasId ? ids.filter((item) => item !== id) : [...ids, id]
    const next: ResearchScopeState = {
      mode: hasId && current.mode === 'selected' && current.sourceIds.length + current.noteIds.length === 1
        ? current.mode
        : 'selected',
      sourceIds: kind === 'sourceIds' ? nextIds : current.sourceIds,
      noteIds: kind === 'noteIds' ? nextIds : current.noteIds,
    }
    // The selector disables the final checkbox; keep the provider defensive for keyboard/script calls.
    if (!validateResearchScope(next).valid) return
    updateScope(next)
  }, [updateScope, updateSinglePin])

  const toggleSource = useCallback((sourceId: string) => toggle('sourceIds', sourceId), [toggle])
  const toggleNote = useCallback((noteId: string) => toggle('noteIds', noteId), [toggle])

  const setSingle = useCallback((sourceId: string, sessionId: string | null) => {
    const current = scopeRef.current
    const baseMode: Exclude<ResearchScopeMode, 'single'> = current.mode === 'single'
      ? 'all'
      : current.mode
    updateSinglePin({ boundSessionId: sessionId, sourceId, baseMode })
  }, [updateSinglePin])

  const clearSingle = useCallback(() => {
    updateSinglePin(null)
  }, [updateSinglePin])

  const bindSession = useCallback((sessionId: string) => {
    const pin = singlePinRef.current
    if (pin === null) return
    if (pin.boundSessionId === null) {
      // 待绑限定 → 绑定到本会话
      updateSinglePin({ ...pin, boundSessionId: sessionId })
      return
    }
    if (pin.boundSessionId !== sessionId) {
      // R1-H5：会话切换 → 限定不带入新会话（D-04 硬约束），并**恢复基础
      // 范围**（新对话默认 all；不残留 selected 快照冒充继承）。
      updateSinglePin(null)
      const current = scopeRef.current
      if (current.mode !== pin.baseMode) {
        updateScope(pin.baseMode === 'all'
          ? ALL_SCOPE
          : { mode: 'selected', sourceIds: current.sourceIds, noteIds: current.noteIds })
      }
    }
  }, [updateSinglePin, updateScope])

  const reconcileSelection = useCallback((
    selectableSourceIds?: readonly string[],
    validNoteIds?: readonly string[],
  ): ResearchScopeReconciliation => {
    const current = scopeRef.current
    if (current.mode !== 'selected') return { sourceIds: [], noteIds: [] }

    const selectableSources = selectableSourceIds === undefined
      ? null
      : new Set(selectableSourceIds)
    const validNotes = validNoteIds === undefined ? null : new Set(validNoteIds)
    const sourceIds = selectableSources === null
      ? current.sourceIds
      : current.sourceIds.filter((id) => selectableSources.has(id))
    const noteIds = validNotes === null
      ? current.noteIds
      : current.noteIds.filter((id) => validNotes.has(id))
    const removed = {
      sourceIds: selectableSources === null
        ? []
        : current.sourceIds.filter((id) => !selectableSources.has(id)),
      noteIds: validNotes === null
        ? []
        : current.noteIds.filter((id) => !validNotes.has(id)),
    }
    if (removed.sourceIds.length + removed.noteIds.length > 0) {
      // An empty selected scope is intentionally retained: it is invalid and
      // must block execution instead of silently broadening to Entire project.
      updateScope({ mode: 'selected', sourceIds, noteIds })
    }
    return removed
  }, [updateScope])
  const removeNote = useCallback((noteId: string): boolean => {
    const current = scopeRef.current
    if (!current.noteIds.includes(noteId)) return false
    updateScope({
      mode: current.mode,
      sourceIds: current.sourceIds,
      noteIds: current.noteIds.filter((id) => id !== noteId),
    })
    return true
  }, [updateScope])
  const validate = useCallback((candidate?: ResearchScopeState) => validateResearchScope(candidate ?? scopeRef.current), [])
  const getSnapshot = useCallback((): ResearchScopeSnapshot => {
    const current = scopeRef.current
    const pin = singlePinRef.current
    // R1-H5：pin 生效门控——**已绑定会话**（boundSessionId 非空）才对派发
    // 生效；恢复的 pin 在 bindSession 核验会话身份前按基础范围派发
    //（避免"pin 属于会话 A、实际会话 B"的首请求错误携带限定）。
    const single = pin !== null && pin.boundSessionId !== null
    return Object.freeze({
      mode: single ? 'single' : current.mode,
      sourceIds: Object.freeze([...current.sourceIds]),
      noteIds: Object.freeze([...current.noteIds]),
      singleSourceId: single ? pin.sourceId : null,
    })
  }, [])

  const effectiveMode: ResearchScopeMode = (singlePin !== null && singlePin.boundSessionId !== null) ? 'single' : scope.mode

  return (
    <ResearchScopeContext.Provider
      value={{
        mode: effectiveMode,
        selectedSourceIds: [...scope.sourceIds],
        selectedNoteIds: [...scope.noteIds],
        singlePin,
        setMode,
        toggleSource,
        toggleNote,
        setSingle,
        clearSingle,
        bindSession,
        reconcileSelection,
        removeNote,
        validate,
        getSnapshot,
      }}
    >
      {children}
    </ResearchScopeContext.Provider>
  )
}

export function useResearchScope(): ResearchScopeValue {
  const value = useContext(ResearchScopeContext)
  if (value === null) {
    throw new Error('research scope context is not available')
  }
  return value
}
