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
 * - 组件卸载时释放状态机（不写服务端）。
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useResearchWorkspaceOptional } from '@/lib/embedded/workspace-context'
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
  const { projectId, capabilities, isAdminReadonly } = options
  const workspace = useResearchWorkspaceOptional()
  const viewerUserId = workspace?.userId ?? ''
  const authGeneration = workspace?.authGeneration ?? 0
  const identityKey = `${projectId}\u0000${viewerUserId}`

  const boundRef = useRef<BoundEditor | null>(null)
  if (boundRef.current === null || boundRef.current.key !== identityKey) {
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
  const machine = boundRef.current.machine

  // 能力/只读矩阵变化：同步进状态机（不重建，保留本地文本与 undo）。
  useEffect(() => {
    machine.updateCapabilities(capabilities)
  }, [machine, capabilities])

  // 身份/代际变化：同 viewer 的代际变化保留本地编辑；项目/viewer 变化会因
  // identityKey 变化重建状态机，此处再同步一次以覆盖渲染间竞态。
  useEffect(() => {
    machine.setIdentity({ projectId, viewerUserId, authGeneration, isAdminReadonly })
  }, [machine, projectId, viewerUserId, authGeneration, isAdminReadonly])

  const state = useSyncExternalStore(
    machine.subscribe,
    machine.getState,
    machine.getState,
  )
  const actions: NoteEditorActions = useMemo(
    () => machine.getActions(),
    [machine],
  )

  // 组件卸载：释放状态机（不写服务端；草稿已在每次编辑时持久化）。
  useEffect(() => () => machine.dispose(), [machine])

  // 离开保护：beforeunload 仅在存在未完成保存时提示；pagehide 只做同步持久化。
  useEffect(() => {
    if (typeof window === 'undefined') return
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

  return { state, actions }
}
