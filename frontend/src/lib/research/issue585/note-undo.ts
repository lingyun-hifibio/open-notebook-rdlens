/**
 * Issue #1046 PR4（D2-B2）：当前会话本地文本撤销栈。
 *
 * 权威依据：方案 v4 §4.1〔R32〕：
 * - 普通输入按编辑器操作边界分组（一次连续输入 = 一个撤销单元）；
 * - 自动保存不清空 undo 历史（服务端 ACK/GET 都不得清空）；
 * - 撤销只恢复本地正文，随后以**当前** serverRevision 走同一自动保存流程；
 * - 不跨刷新恢复 undo 栈，不实现历史版本恢复。
 *
 * 本模块是纯内存结构（无 React/网络/存储依赖），由 note-editor-machine 组装。
 */

/** 连续输入的合并窗口：窗口内的高频变更合并成一个撤销单元。 */
export const NOTE_UNDO_GROUP_MS = 750

/** 撤销栈深度上限（避免长时间编辑占用无界内存）。 */
export const NOTE_UNDO_MAX_ENTRIES = 100

/** 撤销时恢复的编辑器选区（UTF-16；加性 PR5/B3：片段插入/引用返回）。 */
export interface NoteUndoSelection {
  start: number
  end: number
}

export interface NoteUndoSnapshot {
  title: string
  content: string
  /** 可选：撤销后要恢复的选区（缺省保持当前光标，不伪造位置）。 */
  selection?: NoteUndoSelection
}

export interface NoteUndoStackOptions {
  readonly now?: () => number
  readonly groupMs?: number
  readonly maxEntries?: number
}

/**
 * 撤销栈：保存“每个操作组开始时”的快照。
 *
 * 典型调用：编辑器在应用一次变更前调用 `observe(变更前快照)`；同一操作组内
 * 的后续变更不再入栈。显式边界（IME 结束、粘贴/片段插入、失焦、保存等待后
 * 的下一组输入）可 `breakGroup()` 强制开新组。
 */
export class NoteUndoStack {
  private readonly entries: NoteUndoSnapshot[] = []
  private readonly now: () => number
  private readonly groupMs: number
  private readonly maxEntries: number
  private groupOpen = false
  private lastObserveAt = 0

  constructor(options: NoteUndoStackOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.groupMs = options.groupMs ?? NOTE_UNDO_GROUP_MS
    this.maxEntries = Math.max(1, options.maxEntries ?? NOTE_UNDO_MAX_ENTRIES)
  }

  canUndo(): boolean {
    return this.entries.length > 0
  }

  size(): number {
    return this.entries.length
  }

  /** 当前操作组开始时保存的快照（测试/诊断用）。 */
  peek(): NoteUndoSnapshot | null {
    return this.entries.length === 0 ? null : this.entries[this.entries.length - 1]
  }

  /** 强制下一个变更开启新操作组（IME 结束/粘贴/失焦/保存后边界）。 */
  breakGroup(): void {
    this.groupOpen = false
  }

  /**
   * 记录一次即将发生的本地变更：`previous` 是变更前的快照。
   * 同组内不重复入栈（保留组首快照），跨组窗口或显式边界后入栈。
   */
  observe(previous: NoteUndoSnapshot, options: { breakGroup?: boolean } = {}): void {
    if (options.breakGroup) this.groupOpen = false
    const now = this.now()
    const sameGroup =
      this.groupOpen && this.groupMs > 0 && now - this.lastObserveAt <= this.groupMs
    this.lastObserveAt = now
    if (sameGroup) return
    this.groupOpen = true
    this.entries.push({
      title: previous.title,
      content: previous.content,
      ...(previous.selection === undefined ? {} : { selection: previous.selection }),
    })
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries)
    }
  }

  /** 弹出最近一个撤销单元；返回 null 表示没有可撤销内容。 */
  undo(): NoteUndoSnapshot | null {
    const snapshot = this.entries.pop()
    if (snapshot === undefined) return null
    // 撤销后下一次输入必须开启新组，避免与已撤销组继续合并。
    this.groupOpen = false
    return snapshot
  }

  /** 清空（切文档/加载最新版/放弃本地编辑）。自动保存 ACK 不得调用本方法。 */
  clear(): void {
    this.entries.length = 0
    this.groupOpen = false
    this.lastObserveAt = 0
  }
}
