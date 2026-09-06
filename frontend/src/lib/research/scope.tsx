'use client'

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react'

export type ResearchScopeMode = 'entire_project' | 'selected'

export interface ResearchScopeState {
  readonly mode: ResearchScopeMode
  readonly sourceIds: readonly string[]
  readonly noteIds: readonly string[]
}

export type ResearchScopeSnapshot = ResearchScopeState

export interface ResearchScopeReconciliation {
  sourceIds: string[]
  noteIds: string[]
}

/**
 * RWV2-11（K11）：把冻结快照格式化为用户可见的英文 Scope 摘要（i18n key
 * 驱动，不硬编码）。用途：consent 弹窗派发摘要、Chat turn 徽标、面板提示。
 * 语义与 payload 一致：entire_project → "Entire project"；selected →
 * "N sources · M notes"（任一为零则省略）。
 */
export function formatScopeLabel(
  snapshot: ResearchScopeSnapshot,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (snapshot.mode === 'entire_project') {
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

const STORAGE_PREFIX = 'rdlens.research.scope.v1'
const ENTIRE_PROJECT_SCOPE: ResearchScopeState = {
  mode: 'entire_project',
  sourceIds: [],
  noteIds: [],
}

function uniqueStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    return null
  }
  return [...new Set(value)]
}

function isPersistedScope(value: unknown): value is PersistedResearchScope {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.version === 1 && (record.mode === 'entire_project' || record.mode === 'selected')
}

export function scopeStorageKey(userId: string, projectId: string): string {
  return `${STORAGE_PREFIX}/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}`
}

export function validateResearchScope(scope: ResearchScopeState): ResearchScopeValidation {
  if (scope.mode === 'selected' && scope.sourceIds.length + scope.noteIds.length === 0) {
    return { valid: false, reason: 'empty_selected_scope' }
  }
  return { valid: true }
}

function restoreScope(userId: string, projectId: string): ResearchScopeState {
  if (typeof window === 'undefined') return ENTIRE_PROJECT_SCOPE
  const storageKey = scopeStorageKey(userId, projectId)
  const discard = () => {
    try {
      window.localStorage.removeItem(storageKey)
    } catch {
      // Storage may be unavailable; the in-memory fallback remains safe.
    }
    return ENTIRE_PROJECT_SCOPE
  }
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw === null) return ENTIRE_PROJECT_SCOPE
    const parsed: unknown = JSON.parse(raw)
    if (!isPersistedScope(parsed)) return discard()
    const sourceIds = uniqueStrings(parsed.sourceIds)
    const noteIds = uniqueStrings(parsed.noteIds)
    if (sourceIds === null || noteIds === null) return discard()
    if (parsed.mode === 'entire_project') {
      return sourceIds.length + noteIds.length === 0 ? ENTIRE_PROJECT_SCOPE : discard()
    }
    return { mode: 'selected', sourceIds, noteIds }
  } catch {
    return discard()
  }
}

function persistScope(userId: string, projectId: string, scope: ResearchScopeState): void {
  if (typeof window === 'undefined') return
  const value: PersistedResearchScope = {
    version: 1,
    mode: scope.mode,
    sourceIds: [...scope.sourceIds],
    noteIds: [...scope.noteIds],
  }
  try {
    window.localStorage.setItem(scopeStorageKey(userId, projectId), JSON.stringify(value))
  } catch {
    // Browser storage is optional; a failed write must not block research UI.
  }
}

interface ResearchScopeValue {
  mode: ResearchScopeMode
  selectedSourceIds: string[]
  selectedNoteIds: string[]
  setMode: (mode: ResearchScopeMode) => void
  toggleSource: (sourceId: string) => void
  toggleNote: (noteId: string) => void
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
  const scopeRef = useRef(scope)

  const updateScope = useCallback((next: ResearchScopeState) => {
    scopeRef.current = next
    setScopeState(next)
    persistScope(userId, projectId, next)
  }, [projectId, userId])

  const setMode = useCallback((mode: ResearchScopeMode) => {
    if (mode === 'entire_project') {
      updateScope(ENTIRE_PROJECT_SCOPE)
      return
    }
    // Selected cannot be entered without an explicit item selection.
    if (scopeRef.current.sourceIds.length + scopeRef.current.noteIds.length > 0) {
      updateScope({ ...scopeRef.current, mode })
    }
  }, [updateScope])

  const toggle = useCallback((kind: 'sourceIds' | 'noteIds', id: string) => {
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
  }, [updateScope])

  const toggleSource = useCallback((sourceId: string) => toggle('sourceIds', sourceId), [toggle])
  const toggleNote = useCallback((noteId: string) => toggle('noteIds', noteId), [toggle])
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
    return Object.freeze({
      mode: current.mode,
      sourceIds: Object.freeze([...current.sourceIds]),
      noteIds: Object.freeze([...current.noteIds]),
    })
  }, [])

  return (
    <ResearchScopeContext.Provider
      value={{
        mode: scope.mode,
        selectedSourceIds: [...scope.sourceIds],
        selectedNoteIds: [...scope.noteIds],
        setMode,
        toggleSource,
        toggleNote,
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
