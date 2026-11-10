'use client'

/**
 * Issue #1047 PR5（D2-B3）：页面级组合根向既有 hook 暴露的编辑会话槽位。
 *
 * 为什么需要：来源正文阅读/选段与 Notes 面板在旧壳是两个互斥 pane；若编辑器
 * 状态机仍由 NotesPanel 持有，切到 Sources/来源专注时 NotesPanel 卸载 →
 * machine/undo 丢失，引用核查往返无法“保持同一草稿实例”。本槽位让
 * `NoteWorkspaceProvider`（页面级、跨 pane 常驻）持有唯一的编辑器 machine 与
 * 能力投影，`useNoteEditor`/`useNoteCapabilities` 在 Provider 内直接消费，
 * 不在面板本地重复创建；不在 Provider 内（单测/旧宿主）时保持 PR4 行为。
 *
 * 身份重建纪律：槽位不缓存跨身份机器；provider 内 `useNoteEditor` 仍按
 * project/viewer 身份键重建并在身份变化时 dispose 旧 machine（PR4 行为）。
 */

import { createContext, useContext } from 'react'
import type {
  NoteCapabilities,
  NoteCapabilitiesResult,
  NoteEditorActions,
  NoteEditorState,
} from './types'

export interface NoteEditorSlotValue {
  readonly state: NoteEditorState
  readonly actions: NoteEditorActions
  readonly capabilities: NoteCapabilities | null
  readonly capabilitiesResult: NoteCapabilitiesResult | null
}

const NoteEditorSlotContext = createContext<NoteEditorSlotValue | null>(null)

export const NoteEditorSlotProvider = NoteEditorSlotContext.Provider

/** Provider 内的编辑会话槽位；无 Provider 返回 null（旧行为）。 */
export function useNoteEditorSlot(): NoteEditorSlotValue | null {
  return useContext(NoteEditorSlotContext)
}
