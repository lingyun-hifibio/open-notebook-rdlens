/**
 * 本地文本撤销栈单测（Issue #1046 PR4 / D2-B2，方案 §4.1〔R32〕）。
 *
 * 覆盖：按操作边界分组、时间窗口合并、显式 breakGroup、撤销顺序与深度上限、
 * 自动保存（外部调用）不清空 undo 的语义由状态机测试覆盖。
 */

import { describe, expect, it } from 'vitest'
import { NOTE_UNDO_MAX_ENTRIES, NoteUndoStack } from './note-undo'

function stack(options: { now?: () => number; groupMs?: number; maxEntries?: number } = {}) {
  return new NoteUndoStack(options)
}

describe('NoteUndoStack', () => {
  it('records the pre-edit snapshot once per input group', () => {
    let now = 1000
    const undo = stack({ now: () => now })
    undo.observe({ title: 't', content: '' })
    now += 100
    undo.observe({ title: 't', content: 'a' })
    now += 100
    undo.observe({ title: 't', content: 'ab' })
    expect(undo.size()).toBe(1)
    expect(undo.canUndo()).toBe(true)
    expect(undo.undo()).toEqual({ title: 't', content: '' })
    expect(undo.canUndo()).toBe(false)
  })

  it('starts a new group after an idle gap', () => {
    let now = 1000
    const undo = stack({ now: () => now, groupMs: 200 })
    undo.observe({ title: 't', content: '' })
    now += 50
    undo.observe({ title: 't', content: 'a' })
    now += 500
    undo.observe({ title: 't', content: 'ab' })
    expect(undo.size()).toBe(2)
    // 同组输入（a → ab）是一个撤销单元：撤销回到组开始前的 'ab' 之后的状态。
    expect(undo.undo()).toEqual({ title: 't', content: 'ab' })
    expect(undo.undo()).toEqual({ title: 't', content: '' })
  })

  it('breakGroup forces a new undo unit (IME end / paste / blur)', () => {
    const undo = stack()
    undo.observe({ title: 't', content: '' })
    undo.breakGroup()
    undo.observe({ title: 't', content: 'a' })
    expect(undo.size()).toBe(2)
    // 显式边界后两次输入不再合并：先回到 'a'，再回到 ''。
    expect(undo.undo()).toEqual({ title: 't', content: 'a' })
    expect(undo.undo()).toEqual({ title: 't', content: '' })
  })

  it('caps history depth (drops oldest)', () => {
    let now = 0
    const undo = stack({ now: () => now, groupMs: 0, maxEntries: 3 })
    for (let index = 0; index < 6; index += 1) {
      undo.observe({ title: 't', content: `v${index}` })
      now += 10
    }
    expect(undo.size()).toBe(3)
    expect(undo.undo()).toEqual({ title: 't', content: 'v5' })
    expect(undo.undo()).toEqual({ title: 't', content: 'v4' })
    expect(undo.undo()).toEqual({ title: 't', content: 'v3' })
    expect(undo.canUndo()).toBe(false)
  })

  it('undo resets grouping so subsequent input forms a fresh unit', () => {
    const undo = stack()
    undo.observe({ title: 't', content: '' })
    undo.observe({ title: 't', content: 'a' })
    undo.observe({ title: 't', content: 'ab' })
    expect(undo.undo()).toEqual({ title: 't', content: '' })
    // 撤销后的下一次输入必须开新组（不能继续并入已撤销组）。
    undo.observe({ title: 't', content: 'a' })
    expect(undo.size()).toBe(1)
    expect(undo.undo()).toEqual({ title: 't', content: 'a' })
  })

  it('clear empties history (document switch / load latest / discard)', () => {
    const undo = stack()
    undo.observe({ title: 't', content: 'a' })
    undo.clear()
    expect(undo.canUndo()).toBe(false)
    expect(undo.undo()).toBeNull()
  })

  it('exports the bounded default depth constant', () => {
    expect(NOTE_UNDO_MAX_ENTRIES).toBeGreaterThan(0)
  })
})
