'use client'

/**
 * Issue #1135：启用受保护编辑 hook（实现 `./note-enable.ts` 的冻结签名）。
 *
 * 仿 `./use-note-editor.ts`：
 * - `useSyncExternalStore` 订阅纯逻辑状态机（React 只读渲染）；
 * - 按 projectId + 身份（viewer/authGeneration）+ 只读角色重建状态机：项目/
 *   身份真正替换时旧状态机 dispose，旧回调自然作废（对话框状态一并复位）；
 * - capabilities 变化只同步进状态机（不重建），能力恢复后守卫自然放行；
 * - 组件卸载 / StrictMode effect 双调用的 cleanup **不永久 dispose**——本状态机
 *   无定时器/网络订阅，重挂载后同一 machine 必须继续可用（与 PR4 编辑器一致）。
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useResearchWorkspaceOptional } from '@/lib/embedded/workspace-context'
import {
  createNoteEnableMachine,
  type NoteEnableActions,
  type NoteEnableMachine,
  type NoteEnableState,
} from './note-enable'
import type { NoteCapabilities } from './types'

export interface UseNoteEnableOptions {
  projectId: string
  capabilities: NoteCapabilities | null
  isAdminReadonly: boolean
}

interface BoundEnable {
  readonly key: string
  readonly machine: NoteEnableMachine
}

export function useNoteEnable(options: UseNoteEnableOptions): {
  state: NoteEnableState
  actions: NoteEnableActions
} {
  const { projectId, capabilities, isAdminReadonly } = options
  const workspace = useResearchWorkspaceOptional()
  const viewerUserId = workspace?.userId ?? ''
  const authGeneration = workspace?.authGeneration ?? 0
  const identityKey = `${projectId}\u0000${viewerUserId}\u0000${authGeneration}\u0000${
    isAdminReadonly ? '1' : '0'
  }`

  const boundRef = useRef<BoundEnable | null>(null)
  if (boundRef.current === null || boundRef.current.key !== identityKey) {
    boundRef.current?.machine.dispose()
    boundRef.current = {
      key: identityKey,
      machine: createNoteEnableMachine({
        projectId,
        isAdminReadonly,
        capabilities,
      }),
    }
  }
  const machine = boundRef.current.machine

  // 能力投影变化：同步进状态机（不重建；守卫在 requestEnable 时读取最新值）。
  useEffect(() => {
    machine.updateCapabilities(capabilities)
  }, [machine, capabilities])

  const state = useSyncExternalStore(machine.subscribe, machine.getState, machine.getState)
  const actions = useMemo(() => machine.getActions(), [machine])

  return { state, actions }
}
