import { describe, expect, it } from 'vitest'
import {
  attachedEditorRequest,
  editorRequestEquals,
  openEditorRequest,
  type TargetEditorOpenRequest,
} from './target-editor-state'

// UI-19（计划 §2.1.3）：编辑器打开请求的纯状态面。
// - `open(noteId)`：目录/作答入口要求 shell 发起 openNote；
// - `attached`：编辑器已由摘入/写作等 provider 内部路径打开，shell 只渲染 overlay，
//   不得重复 openNote（避免外层 openNote 覆盖插入后的定位/局部状态）。
describe('target-editor-state（UI-19）', () => {
  it('open(noteId) 构造 open 请求并保留 noteId', () => {
    const request = openEditorRequest('note_1')
    expect(request).toEqual({ kind: 'open', noteId: 'note_1' })
    expect(request.kind).toBe('open')
  })

  it('attached 构造 attached 请求（无 noteId，不触发 openNote）', () => {
    const request = attachedEditorRequest()
    expect(request).toEqual({ kind: 'attached' })
    expect(request.kind).toBe('attached')
  })

  it('同一 noteId 的 open 请求相等；不同 noteId / open 与 attached 不相等', () => {
    expect(editorRequestEquals(openEditorRequest('n1'), openEditorRequest('n1'))).toBe(true)
    expect(editorRequestEquals(openEditorRequest('n1'), openEditorRequest('n2'))).toBe(false)
    expect(editorRequestEquals(openEditorRequest('n1'), attachedEditorRequest())).toBe(false)
    expect(editorRequestEquals(attachedEditorRequest(), attachedEditorRequest())).toBe(true)
    expect(editorRequestEquals(null, null)).toBe(true)
    expect(editorRequestEquals(null, openEditorRequest('n1'))).toBe(false)
  })

  it('请求类型面：两种 kind 的判别字段稳定（供 seam 消费）', () => {
    const requests: TargetEditorOpenRequest[] = [openEditorRequest('n1'), attachedEditorRequest()]
    expect(requests.map((request) => request.kind)).toEqual(['open', 'attached'])
  })
})
