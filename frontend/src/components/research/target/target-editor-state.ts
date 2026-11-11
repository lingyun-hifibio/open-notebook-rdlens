/**
 * 目标壳宽屏编辑器状态面纯逻辑（Issue #1191 W3-G1；UI 规格 v1 §5.8 UI-19）。
 *
 * 职责边界（与 W2 `target-reader-state.ts` 同构）：
 * - 只描述「编辑器 overlay 为什么打开」这一个纯状态，不依赖 React/网络；
 * - `open(noteId)` 表示目录/作答入口要求 shell 发起 `openNote`（编辑器尚未打开）；
 * - `attached` 表示编辑器已由 provider 内部路径（摘入/写作/重开来）打开，shell 只
 *   渲染 overlay，**不得**重复 openNote（否则会覆盖插入后的定位/局部状态）。
 *
 * 状态本身由 `TargetNotesWorkspaceProvider` 持有；`TargetShellBody` 只消费并渲染。
 */

/** UI-19 编辑器打开请求。 */
export type TargetEditorOpenRequest =
  | { readonly kind: 'open'; readonly noteId: string }
  | { readonly kind: 'attached' }

/** 目录/作答入口：请求 shell 打开指定 Note（provider 统一发起 openNote）。 */
export function openEditorRequest(noteId: string): TargetEditorOpenRequest {
  return { kind: 'open', noteId }
}

/** 编辑器已由 provider 内部打开：shell 只渲染 overlay，不再 openNote。 */
export function attachedEditorRequest(): TargetEditorOpenRequest {
  return { kind: 'attached' }
}

/** 请求相等语义（避免同一 noteId 重复触发 openNote）。 */
export function editorRequestEquals(
  left: TargetEditorOpenRequest | null,
  right: TargetEditorOpenRequest | null,
): boolean {
  if (left === null || right === null) return left === right
  if (left.kind !== right.kind) return false
  if (left.kind === 'attached') return true
  return left.noteId === (right as { noteId: string }).noteId
}
