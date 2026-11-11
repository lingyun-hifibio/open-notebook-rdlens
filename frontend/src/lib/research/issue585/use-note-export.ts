'use client'

/**
 * Issue #1191 PR-B（W3-G2）：单份 Markdown 导出 hook。
 *
 * 职责边界：
 * - 本 hook 只做 React 侧编排：可见性闸、flush-first、幂等键生命周期、
 *   失败/成功状态；纯逻辑（请求体/响应校验/文件名/下载触发/错误归一）在
 *   `./note-export.ts`，网络传输在 `./note-client.ts`。
 * - 不写任何新的前端持久化状态：幂等键只在组件生命周期内（`useRef` 内的
 *   Map）复用；不碰编辑正文、本地草稿缓存与撤销栈。
 *
 * 关键纪律（计划 §2.5-10..12、§2.2.2）：
 * - 先 `actions.flushBeforeLeave()`；返回非 null 的阻塞原因时中止导出并按
 *   既有 leave 文案如实提示——绝不导出旧版本、绝不把阻断当成功；
 * - flush 之后**重新渲染后**再读 `state.note.revision/snapshot_hash` 构造
 *   签名（同签名重试/再次点击复用同一幂等键；版本签名变化才换键）；
 * - 单在途：导出进行中重复调用是 no-op。
 *
 * 时序说明（flush → 读新 revision）：flush 内部保存成功后状态机 emit 新
 * revision；本 hook 在 flush 完成后不直接用旧 props，而是置一个「flush 完成
 * 意图」并在下一轮提交后的 effect 里构造签名——此时组件 props 已是保存后的
 * `state.note`，不会把旧 revision 发出去。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { downloadNoteExportFile, requestNoteExportD2 } from './note-client'
import {
  createNoteExportKeyStore,
  exportableNoteSnapshot,
  runNoteExport,
  type NoteExportDownloader,
  type NoteExportFailure,
  type NoteExportKeyStore,
  type NoteExportSignature,
  type NoteExportTransport,
} from './note-export'
import type { NoteCapabilities, NoteEditorActions, NoteEditorState } from './types'

/** 编辑器句柄（结构等价于 `NoteWorkspaceEditorHandle`；不依赖组件层）。 */
export interface NoteExportEditorHandle {
  readonly state: NoteEditorState
  readonly actions: NoteEditorActions
}

export interface UseNoteExportOptions {
  editor: NoteExportEditorHandle | null
  capabilities: NoteCapabilities | null
  /** Admin 只读会话不提供导出（fail-closed 隐藏入口）。 */
  isAdminReadonly?: boolean
  /** 下载触发注入（测试/SSR 环境）；默认 blob + `<a download>`。 */
  download?: NoteExportDownloader
}

/** 用户视角的导出状态（`available` 为三道闸的合成结果）。 */
export interface NoteExportState {
  available: boolean
  isExporting: boolean
  /** 最近一次成功导出的文件名（失败/新尝试时清空，不显示“已导出”）。 */
  lastFilename: string | null
  failure: NoteExportFailure | null
}

export interface UseNoteExportResult {
  state: NoteExportState
  exportMarkdown: () => Promise<void>
}

interface InternalState {
  isExporting: boolean
  lastFilename: string | null
  failure: NoteExportFailure | null
}

/** flush 完成后待提交的导出意图（下一轮提交后再读已保存版本）。 */
interface ExportIntent {
  token: number
  /** flush 开始前的文档 identity（用于确认没有切到别的文档）。 */
  noteIdAtFlush: string
}

const INITIAL_INTERNAL: InternalState = {
  isExporting: false,
  lastFilename: null,
  failure: null,
}

function currentTitle(editor: NoteExportEditorHandle | null): string | null {
  if (!editor) return null
  if (typeof editor.state.title === 'string' && editor.state.title.length > 0) {
    return editor.state.title
  }
  return editor.state.note?.title ?? null
}

export function useNoteExport(options: UseNoteExportOptions): UseNoteExportResult {
  const { editor, capabilities, isAdminReadonly = false, download } = options

  // 幂等键缓存只随组件实例存活（不落盘、不跨文档复用）。
  const keyStoreRef = useRef<NoteExportKeyStore | null>(null)
  if (keyStoreRef.current === null) keyStoreRef.current = createNoteExportKeyStore()
  const keyStore = keyStoreRef.current

  const [internal, setInternal] = useState<InternalState>(INITIAL_INTERNAL)
  const [intent, setIntent] = useState<ExportIntent | null>(null)
  const exportingRef = useRef(false)
  const intentSeqRef = useRef(0)

  // 每次渲染刷新「最新 props」：click 入口（flush 前）与在途标记读取用。
  const latestRef = useRef(options)
  latestRef.current = options

  const available = useMemo(() => {
    if (!editor) return false
    if (isAdminReadonly) return false
    if (capabilities?.markdownExport.available !== true) return false
    return exportableNoteSnapshot(editor.state.note) !== null
  }, [editor, capabilities, isAdminReadonly])

  const noteId = editor?.state.note?.note_id ?? null
  // 换文档/关闭编辑器：清掉上一份文档的失败与“已导出”提示。
  useEffect(() => {
    setInternal((previous) =>
      previous.failure === null && previous.lastFilename === null
        ? previous
        : { ...previous, failure: null, lastFilename: null },
    )
  }, [noteId])

  /**
   * 提交一轮导出（在 flush 完成后的下一轮提交里执行）：此处 `editor.state`
   * 已是 flush 保存后的投影，签名不会带旧 revision。
   */
  const runExport = useCallback(
    async (pending: ExportIntent): Promise<void> => {
      const editorNow = editor
      const snapshot = exportableNoteSnapshot(editorNow?.state.note ?? null)
      if (
        !editorNow ||
        !snapshot ||
        isAdminReadonly ||
        capabilities?.markdownExport.available !== true
      ) {
        setInternal({
          isExporting: false,
          lastFilename: null,
          failure: {
            kind: 'not_exportable',
            reason: 'note_snapshot_unavailable',
          },
        })
        exportingRef.current = false
        return
      }
      if (snapshot.noteId !== pending.noteIdAtFlush) {
        setInternal({
          isExporting: false,
          lastFilename: null,
          failure: { kind: 'not_exportable', reason: 'note_not_found' },
        })
        exportingRef.current = false
        return
      }

      const signature: NoteExportSignature = {
        projectId: snapshot.projectId,
        noteId: snapshot.noteId,
        revision: snapshot.revision,
        snapshotHash: snapshot.snapshotHash,
        format: 'markdown',
      }
      const client: NoteExportTransport = {
        requestExport: ({ projectId, noteId: requestNoteId, body, idempotencyKey }) =>
          requestNoteExportD2(projectId, requestNoteId, body, idempotencyKey),
        fetchExportFile: (downloadUrl) => downloadNoteExportFile(downloadUrl),
      }

      try {
        const outcome = await runNoteExport({
          signature,
          title: currentTitle(editorNow),
          keyStore,
          client,
          download,
        })
        // 导出期间切到别的文档：丢弃该结果（不把上一份文档的导出状态显示在
        // 当前文档上），但仍正确结束在途标记。
        const finalNoteId = latestRef.current.editor?.state.note?.note_id ?? null
        if (finalNoteId !== signature.noteId) {
          setInternal((previous) => ({ ...previous, isExporting: false }))
          return
        }
        if (outcome.ok) {
          setInternal({ isExporting: false, lastFilename: outcome.filename, failure: null })
        } else {
          setInternal({ isExporting: false, lastFilename: null, failure: outcome.failure })
        }
      } catch {
        // 兜底：任何未预期异常都按「结果未知」呈现，不冒充成功。
        setInternal({
          isExporting: false,
          lastFilename: null,
          failure: {
            kind: 'api',
            code: 'unknown_error',
            status: 0,
            requestId: null,
            retryable: true,
          },
        })
      } finally {
        exportingRef.current = false
      }
    },
    [editor, capabilities, isAdminReadonly, download, keyStore],
  )

  // flush 完成后的下一轮提交再发请求（吃保存后的 revision/snapshot_hash）。
  useEffect(() => {
    if (intent === null) return
    setIntent(null)
    void runExport(intent)
  }, [intent, runExport])

  const exportMarkdown = useCallback(async (): Promise<void> => {
    if (exportingRef.current) return
    const before = latestRef.current
    const beforeEditor = before.editor
    const beforeSnapshot = exportableNoteSnapshot(beforeEditor?.state.note ?? null)
    if (
      !beforeEditor ||
      !beforeSnapshot ||
      before.isAdminReadonly === true ||
      before.capabilities?.markdownExport.available !== true
    ) {
      return
    }

    // 单在途守卫必须先于 flush（重复点击不再触发第二次保存）。
    exportingRef.current = true
    setInternal({ isExporting: true, lastFilename: null, failure: null })

    try {
      // 1) flush-first：先保存；非 null = 被离开保护阻断，诚实中止。
      const blocked = await beforeEditor.actions.flushBeforeLeave()
      if (blocked !== null) {
        setInternal({
          isExporting: false,
          lastFilename: null,
          failure: { kind: 'blocked', reason: blocked },
        })
        exportingRef.current = false
        return
      }
      // 2) 交给下一轮提交后的 effect：此时 props 已是保存后的 note 投影。
      intentSeqRef.current += 1
      setIntent({ token: intentSeqRef.current, noteIdAtFlush: beforeSnapshot.noteId })
    } catch {
      setInternal({
        isExporting: false,
        lastFilename: null,
        failure: {
          kind: 'api',
          code: 'unknown_error',
          status: 0,
          requestId: null,
          retryable: true,
        },
      })
      exportingRef.current = false
    }
  }, [])

  const state = useMemo<NoteExportState>(
    () => ({
      available,
      isExporting: internal.isExporting,
      lastFilename: internal.lastFilename,
      failure: internal.failure,
    }),
    [available, internal],
  )

  return { state, exportMarkdown }
}
