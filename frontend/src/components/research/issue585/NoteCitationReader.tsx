'use client'

/**
 * Issue #1047 PR5（D2-B3）：正文引用 → 独立阅读上下文（overlay）。
 *
 * 方案 §5.2：点击引用进入侧栏/覆盖层阅读具体 source/version/location；返回时
 * 由组合根按 `{noteId, localSeq, selection, scrollTop}` 恢复原文档。本组件只负责
 * 读取与展示，明确区分：
 * - ok：版本/摘要/位置均校验通过（可高亮；
 * - old_version：来源已在引用版本之后前进（note 不保留旧正文，不把旧 offset
 *   套到新正文）；
 * - position_unavailable / content_mismatch：锚点失效，保留来源关系、不伪造位置；
 * - restricted / unavailable：来源撤权或不存在（不泄露存在性）；
 * - unresolved：binding 自身标为未定位，仅展示来源记录 + 提示。
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import {
  getResearchChatSession,
  getSourceChatSession,
  listInsights,
} from '@/lib/research/api'
import {
  citationContentHashMatches,
  excerptContentHash,
  joinSourceSnapshotText,
  parseNoteSourceVersion,
  readChatMessageCitationLocator,
  readLegacyInsightCitationLocator,
  readNoteCitationLocator,
  readSourceCitationLocator,
  splitTextForHighlight,
  type SourceCitationReadingLocator,
} from '@/lib/research/issue585/excerpt'
import {
  getNoteD2,
  normalizeNoteApiError,
} from '@/lib/research/issue585/note-client'
import type {
  NoteCitationReaderRequest,
  ResearchNoteD2,
} from '@/lib/research/issue585/types'
import type { ResearchInsight } from '@/lib/types/research'
import { SourceDetailPanel } from '../SourceDetailPanel'
import { noteErrorLabelKey } from './note-ui-labels'

export interface NoteCitationReaderProps {
  request: NoteCitationReaderRequest | null
  onClose: () => void
}

type ReaderState =
  | 'loading'
  | 'ok'
  | 'source_reading'
  | 'old_version'
  | 'position_unavailable'
  | 'content_mismatch'
  | 'restricted'
  | 'unavailable'
  | 'unresolved'

interface ReaderData {
  readonly state: ReaderState
  readonly title: string
  readonly content: string | null
  readonly highlight: { start: number; end: number } | null
  readonly versionLabel: string | null
  readonly errorCode: string | null
}

function initialData(): ReaderData {
  return {
    state: 'loading',
    title: '',
    content: null,
    highlight: null,
    versionLabel: null,
    errorCode: null,
  }
}

const STATE_LABEL_KEYS: Record<ReaderState, string> = {
  loading: 'common.loading',
  ok: 'research.notes.citation.state.ok',
  source_reading: 'research.notes.citation.state.sourceReading',
  old_version: 'research.notes.citation.state.oldVersion',
  position_unavailable: 'research.notes.citation.state.positionUnavailable',
  content_mismatch: 'research.notes.citation.state.contentMismatch',
  restricted: 'research.notes.citation.state.restricted',
  unavailable: 'research.notes.citation.state.unavailable',
  unresolved: 'research.notes.citation.state.unresolved',
}

export function NoteCitationReader({ request, onClose }: NoteCitationReaderProps) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const [data, setData] = useState<ReaderData>(initialData)

  const binding = request?.binding ?? null

  useEffect(() => {
    if (request === null || binding === null) return
    let cancelled = false
    setData(initialData())
    const load = async (): Promise<void> => {
      try {
        const next = await resolveReaderData(projectId, request)
        if (!cancelled) setData(next)
      } catch (error) {
        if (cancelled) return
        const apiError = normalizeNoteApiError(error)
        const restricted = apiError.code === 'note_access_restricted'
        setData({
          state: restricted ? 'restricted' : 'unavailable',
          title: '',
          content: null,
          highlight: null,
          versionLabel: null,
          errorCode: apiError.code,
        })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [binding, projectId, request])

  const sourceLocator = useMemo<SourceCitationReadingLocator | null>(() => {
    if (binding === null || binding.source_kind !== 'source' || binding.unresolved) return null
    const locator = readSourceCitationLocator(binding)
    if (locator === null) return null
    if (locator.start_utf16 === null || locator.end_utf16 === null) return null
    return {
      document_version: locator.document_version,
      content_hash: locator.content_hash,
      start_utf16: locator.start_utf16,
      end_utf16: locator.end_utf16,
    }
  }, [binding])

  if (request === null || binding === null) return null

  const sourceCitationLocator: SourceCitationReadingLocator | null =
    binding.source_kind === 'source' ? sourceLocator : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 p-2 sm:p-6"
      data-testid="note-citation-reader"
      role="dialog"
      aria-modal="true"
      aria-label={t('research.notes.citation.title')}
    >
      <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t('research.notes.citation.title')}</h3>
            <p className="truncate text-xs text-muted-foreground" data-testid="citation-reader-binding">
              {t('research.notes.citation.binding', {
                kind: binding.source_kind,
                id: binding.source_id,
              })}
              {data.versionLabel !== null ? ` · ${data.versionLabel}` : ''}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onClose} data-testid="citation-reader-back">
            {t('research.notes.citation.back')}
          </Button>
        </div>

        <div className="border-b px-3 py-1.5 text-xs" role="status">
          <span data-testid="citation-reader-state" data-state={data.state}>
            {t(STATE_LABEL_KEYS[data.state])}
          </span>
          {data.errorCode !== null && data.state !== 'ok' && (
            <span className="ml-2 text-muted-foreground">
              {t(noteErrorLabelKey(data.errorCode))}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {data.state === 'loading' && (
            <p className="text-sm text-muted-foreground" data-testid="citation-reader-loading">
              {t('common.loading')}
            </p>
          )}

          {binding.source_kind === 'source' && data.state !== 'loading' && (
            <SourceDetailPanel
              sourceId={binding.source_id}
              citationLocator={sourceCitationLocator}
              citationVersionLabel={binding.source_version}
            />
          )}

          {binding.source_kind !== 'source' && data.content !== null && (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">{data.title || binding.source_id}</h4>
              {data.highlight !== null && (
                <blockquote
                  className="rounded border-l-4 border-primary bg-muted/40 p-2 text-sm"
                  data-testid="citation-reader-quote"
                >
                  {data.content.slice(data.highlight.start, data.highlight.end)}
                </blockquote>
              )}
              <div data-testid="citation-reader-content">
                <MarkdownRenderer>{data.content}</MarkdownRenderer>
              </div>
            </div>
          )}

          {binding.source_kind !== 'source' && data.content === null && data.state !== 'loading' && (
            <p className="text-sm text-muted-foreground" data-testid="citation-reader-empty">
              {t(STATE_LABEL_KEYS[data.state])}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 按 binding 类型读取来源记录并校验版本/摘要/位置（纯读取，无写操作）。
 */
export async function resolveReaderData(
  projectId: string,
  request: NoteCitationReaderRequest,
): Promise<ReaderData> {
  const binding = request.binding
  if (binding.unresolved) {
    const base = await readAvailableRecord(projectId, binding)
    return {
      ...base,
      state: 'unresolved',
      highlight: null,
    }
  }
  switch (binding.source_kind) {
    case 'note':
      return readNoteBinding(projectId, binding)
    case 'chat_message':
      return readChatMessageBinding(projectId, binding)
    case 'legacy_insight':
      return readLegacyInsightBinding(projectId, binding)
    case 'source':
    default:
      // 来源正文由 SourceDetailPanel 自身读取/校验；这里**不**声称“已校验”，
      // 明确区分“正在读来源记录”（版本/摘要/位置状态由面板给出）。
      return {
        state: 'source_reading',
        title: '',
        content: null,
        highlight: null,
        versionLabel: binding.source_version,
        errorCode: null,
      }
  }
}

type BindingLike = NoteCitationReaderRequest['binding']

async function readAvailableRecord(
  projectId: string,
  binding: BindingLike,
): Promise<ReaderData> {
  if (binding.source_kind === 'note') {
    try {
      const note = await getNoteD2(projectId, binding.source_id)
      return {
        state: 'ok',
        title: note.title,
        content: note.content,
        highlight: null,
        versionLabel: binding.source_version,
        errorCode: null,
      }
    } catch {
      /* fall through */
    }
  }
  return {
    state: 'position_unavailable',
    title: '',
    content: null,
    highlight: null,
    versionLabel: binding.source_version,
    errorCode: null,
  }
}

function noteVersionLabel(note: ResearchNoteD2): string | null {
  if (note.revision === null || note.snapshot_hash === null) return null
  return `${note.revision}:${note.snapshot_hash}`
}

async function readNoteBinding(projectId: string, binding: BindingLike): Promise<ReaderData> {
  const note = await getNoteD2(projectId, binding.source_id)
  const currentVersion = noteVersionLabel(note)
  const expected = parseNoteSourceVersion(binding.source_version)
  const locator = readNoteCitationLocator(binding)
  const base: ReaderData = {
    state: 'ok',
    title: note.title,
    content: note.content,
    highlight: null,
    versionLabel: currentVersion,
    errorCode: null,
  }
  if (expected === null || currentVersion === null) {
    return { ...base, state: 'position_unavailable' }
  }
  if (expected.revision !== note.revision || expected.snapshotHash !== note.snapshot_hash) {
    // note 旧版正文不保留：不把旧 offset 套到新正文，显式 old_version。
    return { ...base, state: 'old_version', highlight: null }
  }
  if (locator === null || locator.start_utf16 === null || locator.end_utf16 === null) {
    return base
  }
  const slice = splitTextForHighlight(note.content, locator.start_utf16, locator.end_utf16)
  if (slice === null) return { ...base, state: 'position_unavailable' }
  if (locator.content_hash !== null && !citationContentHashMatches(note.content, locator.content_hash)) {
    return { ...base, state: 'content_mismatch', highlight: null }
  }
  return { ...base, highlight: { start: locator.start_utf16, end: locator.end_utf16 } }
}

/** 长会话引用读取：尾部窗口 + 游标翻页，直到命中或耗尽（单页 50，上限 2000 条）。 */
const CHAT_MESSAGE_PAGE_LIMIT = 50
const CHAT_MESSAGE_MAX_PAGES = 40

async function findChatMessage(
  projectId: string,
  locator: NonNullable<ReturnType<typeof readChatMessageCitationLocator>>,
): Promise<{ message_id: string; role: 'user' | 'assistant'; content: string } | undefined> {
  if (locator.session_id === null || locator.message_id === null) return undefined
  let cursor: string | undefined
  for (let page = 0; page < CHAT_MESSAGE_MAX_PAGES; page += 1) {
    const params = {
      limit: CHAT_MESSAGE_PAGE_LIMIT,
      order: 'desc' as const,
      ...(cursor !== undefined ? { cursor } : {}),
    }
    const detail =
      locator.surface === 'source'
        ? locator.source_id !== null
          ? await getSourceChatSession(projectId, locator.source_id, locator.session_id, params)
          : null
        : await getResearchChatSession(projectId, locator.session_id, params)
    if (detail === null) return undefined
    const found = detail.messages.find((item) => item.message_id === locator.message_id)
    if (found !== undefined) return found
    cursor = detail.next_cursor ?? undefined
    if (cursor === undefined) break
  }
  return undefined
}

async function readChatMessageBinding(
  projectId: string,
  binding: BindingLike,
): Promise<ReaderData> {
  const locator = readChatMessageCitationLocator(binding)
  if (
    locator === null ||
    locator.surface === null ||
    locator.session_id === null ||
    locator.message_id === null
  ) {
    return {
      state: 'position_unavailable',
      title: '',
      content: null,
      highlight: null,
      versionLabel: null,
      errorCode: null,
    }
  }
  // issue #1047 review H-1：会话详情默认 order=asc/limit=50 只返回最旧 50 条，
  // 回答（assistant）通常在会话尾部 → 长会话必然找不到。这里从**最新尾部窗口**
  // 开始（order=desc），未命中再用 next_cursor 向更早消息翻页，直到命中或耗尽；
  // 命中后的正文/定位仍按消息自身内容渲染（与顺序无关）。
  const message = await findChatMessage(projectId, locator)
  if (message === undefined) {
    return {
      state: 'unavailable',
      title: '',
      content: null,
      highlight: null,
      versionLabel: null,
      errorCode: null,
    }
  }
  const hashOk = citationContentHashMatches(message.content, locator.content_hash)
  const base = {
    title: message.role === 'assistant' ? 'Assistant message' : 'User message',
    content: message.content,
    versionLabel: null,
    errorCode: null,
  }
  if (!hashOk) return { ...base, state: 'content_mismatch', highlight: null }
  if (locator.start_utf16 === null || locator.end_utf16 === null) {
    return { ...base, state: 'ok', highlight: null }
  }
  if (splitTextForHighlight(message.content, locator.start_utf16, locator.end_utf16) === null) {
    return { ...base, state: 'position_unavailable', highlight: null }
  }
  return {
    ...base,
    state: 'ok',
    highlight: { start: locator.start_utf16, end: locator.end_utf16 },
  }
}

async function readLegacyInsightBinding(
  projectId: string,
  binding: BindingLike,
): Promise<ReaderData> {
  const locator = readLegacyInsightCitationLocator(binding)
  const insightId = locator?.insight_id ?? binding.source_id
  let cursor: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const result = await listInsights(projectId, {
      limit: 100,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    const found: ResearchInsight | undefined = result.items.find(
      (item) => item.insight_id === insightId,
    )
    if (found !== undefined) {
      const base = {
        title: found.title,
        content: found.content,
        versionLabel: null,
        errorCode: null,
      }
      if (!citationContentHashMatches(found.content, locator?.content_hash ?? null)) {
        return { ...base, state: 'content_mismatch', highlight: null }
      }
      const start = locator?.start_utf16 ?? null
      const end = locator?.end_utf16 ?? null
      if (start === null || end === null) {
        return { ...base, state: 'ok', highlight: null }
      }
      if (splitTextForHighlight(found.content, start, end) === null) {
        return { ...base, state: 'position_unavailable', highlight: null }
      }
      return { ...base, state: 'ok', highlight: { start, end } }
    }
    cursor = result.next_cursor ?? undefined
    if (cursor === undefined) break
  }
  return {
    state: 'unavailable',
    title: '',
    content: null,
    highlight: null,
    versionLabel: null,
    errorCode: null,
  }
}

/**
 * 来源 binding 的阅读定位（joined-text 偏移 → chunk/page）。
 * 导出供 SourceDetailPanel / 单测复用。
 */
export function sourceReadingLocatorForBinding(
  binding: BindingLike,
): SourceCitationReadingLocator | null {
  if (binding.source_kind !== 'source' || binding.unresolved) return null
  const locator = readSourceCitationLocator(binding)
  if (locator === null || locator.start_utf16 === null || locator.end_utf16 === null) {
    return null
  }
  return {
    document_version: locator.document_version,
    content_hash: locator.content_hash,
    start_utf16: locator.start_utf16,
    end_utf16: locator.end_utf16,
  }
}

/** 供测试/证据断言：来源快照摘要与 locator.content_hash 的一致性。 */
export function sourceSnapshotMatchesLocator(
  chunks: Parameters<typeof joinSourceSnapshotText>[0],
  expected: string | null,
): boolean {
  return citationContentHashMatches(joinSourceSnapshotText(chunks), expected)
}

/** 供测试：来源快照的 sha256（joined 文本，host 同口径）。 */
export function sourceSnapshotHash(
  chunks: Parameters<typeof joinSourceSnapshotText>[0],
): string {
  return excerptContentHash(joinSourceSnapshotText(chunks))
}
