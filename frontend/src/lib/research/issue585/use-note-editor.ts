'use client'

/**
 * Issue #1046 PR4（D2-B2）：单文档编辑器 hook（实现 types.ts 冻结签名）。
 *
 * 权威依据：方案 v4 §4.1/§4.4；`./types.ts` 的 `UseNoteEditorResult`；
 * Lead D4/D5。
 *
 * 职责：
 * - 从工作台上下文取 viewer/authGeneration（身份变化时重建状态机，旧回调
 *   自然作废；同 viewer 的代际变化由状态机保留本地编辑并把在途写转为未知）；
 * - capabilities/isAdminReadonly 变化同步进状态机（能力恢复可解除阻断态，
 *   能力丢失停止自动保存但保留本地草稿）；
 * - 注册 `beforeunload`（仅未完成保存时提示）与 `pagehide`（同步持久化草稿）；
 * - 组件卸载/StrictMode 双调用 cleanup 只做非永久 stop（不销毁可重挂载状态机）。
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useResearchWorkspaceOptional } from '@/lib/embedded/workspace-context'
import { useNoteEditorSlot } from './note-workspace-slot'
import {
  createNoteEditorMachine,
  isUnfinishedSaveStatus,
  type NoteEditorMachine,
} from './note-editor-machine'
import type { NoteCapabilities, NoteEditorActions, NoteEditorState } from './types'

export interface UseNoteEditorOptions {
  projectId: string
  capabilities: NoteCapabilities | null
  isAdminReadonly: boolean
}

interface BoundEditor {
  readonly key: string
  readonly machine: NoteEditorMachine
}

export function useNoteEditor(options: UseNoteEditorOptions): {
  state: NoteEditorState
  actions: NoteEditorActions
} {
  // PR5/B3：页面级 Provider 持有唯一编辑会话时消费同一个 machine（跨 pane 保留
  // 草稿与内存 undo）。全部 hook 保持无条件调用：槽位存在时只是不创建本地
  // machine，避免条件调用 hook；Provider 是否存在在组件树内是稳定的。
  const slot = useNoteEditorSlot()
  const { projectId, capabilities, isAdminReadonly } = options
  const workspace = useResearchWorkspaceOptional()
  const viewerUserId = workspace?.userId ?? ''
  const authGeneration = workspace?.authGeneration ?? 0
  const identityKey = `${projectId}\u0000${viewerUserId}`

  const boundRef = useRef<BoundEditor | null>(null)
  if (slot === null && (boundRef.current === null || boundRef.current.key !== identityKey)) {
    boundRef.current?.machine.dispose()
    boundRef.current = {
      key: identityKey,
      machine: createNoteEditorMachine({
        projectId,
        viewerUserId,
        isAdminReadonly,
        authGeneration,
        capabilities,
      }),
    }
  }
  const machine = boundRef.current?.machine ?? null

  // 能力/只读矩阵变化：同步进状态机（不重建，保留本地文本与 undo）。
  useEffect(() => {
    machine?.updateCapabilities(capabilities)
  }, [machine, capabilities])

  // 身份/代际变化：同 viewer 的代际变化保留本地编辑；项目/viewer 变化会因
  // identityKey 变化重建状态机，此处再同步一次以覆盖渲染间竞态。
  useEffect(() => {
    machine?.setIdentity({ projectId, viewerUserId, authGeneration, isAdminReadonly })
  }, [machine, projectId, viewerUserId, authGeneration, isAdminReadonly])

  const subscribe = useMemo(
    () => (slot === null && machine !== null ? machine.subscribe : () => () => {}),
    [machine, slot],
  )
  const getSnapshot = useMemo(
    () => (slot === null && machine !== null ? machine.getState : () => slotStateFallback(slot)),
    [machine, slot],
  )
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const actions: NoteEditorActions = useMemo(() => {
    if (slot !== null) return slot.actions
    if (machine === null) throw new Error('note editor machine is not available')
    return machine.getActions()
  }, [machine, slot])

  // 组件卸载 / React StrictMode effect 双调用（setup→cleanup→setup）的 cleanup：
  // 只做非永久停止（清 debounce + 同步落本地草稿），**绝不永久 dispose**——同一
  // machine 在 StrictMode remount 后必须继续 open/create/save（#1046 视觉阻塞根因：
  // 曾在此处 dispose，StrictMode cleanup 把 machine 永久销毁导致所有动作静默 no-op）。
  // 永久销毁只发生在身份/项目真正替换时（见上方渲染分支）。
  useEffect(
    () => () => {
      machine?.persistLocalDraft()
      machine?.stop()
    },
    [machine],
  )

  // 离开保护：beforeunload 仅在存在未完成保存时提示；pagehide 只做同步持久化。
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (machine === null) return
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      const current = machine.getState()
      const unfinished =
        current.pendingMutationId !== null ||
        isUnfinishedSaveStatus(current.saveStatus)
      if (!unfinished) return
      event.preventDefault()
      event.returnValue = ''
    }
    const onPageHide = (): void => {
      machine.persistLocalDraft()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [machine])

  if (slot !== null) return { state: slot.state, actions: slot.actions }
  return { state, actions }
}

/** 槽位存在时 useSyncExternalStore 的占位快照（真实状态直接来自槽位）。 */
function slotStateFallback(slot: ReturnType<typeof useNoteEditorSlot>): NoteEditorState {
  if (slot !== null) return slot.state
  throw new Error('note editor slot is not available')
}
