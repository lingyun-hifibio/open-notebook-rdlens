/**
 * NoteCitationReader（Issue #1047 PR5 / D2-B3）读取与状态测试。
 *
 * 覆盖：note 引用的版本/摘要/位置校验（ok / old_version / content_mismatch /
 * position_unavailable）、chat_message 的 session/message 定位、legacy_insight
 * 的目录回查、unresolved binding 不伪造位置，以及 403/404 的明确状态。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getResearchChatSession,
  getSourceChatSession,
  listInsights,
} from '@/lib/research/api'
import { getNoteD2 } from '@/lib/research/issue585/note-client'
import type { NoteCitationBinding, NoteCitationReaderRequest } from '@/lib/research/issue585/types'
import { resolveReaderData } from './NoteCitationReader'

vi.mock('@/lib/embedded/workspace-context', () => ({
  useResearchWorkspace: () => ({ projectId: 'p1', isAdminReadonly: false }),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/research/api', () => ({
  getResearchChatSession: vi.fn(),
  getSourceChatSession: vi.fn(),
  listInsights: vi.fn(),
}))

vi.mock('@/lib/research/issue585/note-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/research/issue585/note-client')>()
  return { ...original, getNoteD2: vi.fn() }
})

vi.mock('../SourceDetailPanel', () => ({
  SourceDetailPanel: () => 'source-detail-stub',
}))

const mockedGetNote = vi.mocked(getNoteD2)
const mockedGetChat = vi.mocked(getResearchChatSession)
const mockedGetSourceChat = vi.mocked(getSourceChatSession)
const mockedListInsights = vi.mocked(listInsights)

const HASH = 'a'.repeat(64)

function request(binding: Partial<NoteCitationBinding>): NoteCitationReaderRequest {
  return {
    binding: {
      binding_id: 'cb_1',
      source_kind: 'note',
      source_id: 'n_src',
      source_version: `2:${HASH}`,
      locator: null,
      unresolved: false,
      ...binding,
    },
    noteId: 'n_current',
    localSeq: 4,
    baseRevision: 2,
    selection: { start: 1, end: 3 },
    scrollTop: 12,
  }
}

function note(overrides: Record<string, unknown> = {}) {
  return {
    note_id: 'n_src',
    project_id: 'p1',
    title: '来源笔记',
    content: '一二三四五',
    note_type: 'human' as const,
    created_at: null,
    updated_at: null,
    revision: 2,
    snapshot_hash: HASH,
    edit_schema: 'd2-v1',
    access_state: 'visible' as const,
    ...overrides,
  }
}

function apiError(code: string, status: number) {
  return {
    response: {
      status,
      data: { detail: { code, message: '', retryable: false } },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveReaderData', () => {
  it('returns content + highlight for a matching note revision and locator', async () => {
    mockedGetNote.mockResolvedValueOnce(
      note({ locator: undefined, content: '一二三四五' }) as never,
    )
    const data = await resolveReaderData(
      'p1',
      request({
        locator: {
          start_utf16: 1,
          end_utf16: 3,
          content_hash: 'c'.repeat(64),
        },
      }),
    )
    expect(data.state).toBe('content_mismatch')
    mockedGetNote.mockResolvedValueOnce(note() as never)
    const ok = await resolveReaderData(
      'p1',
      request({ locator: { start_utf16: 1, end_utf16: 3, content_hash: null } }),
    )
    expect(ok).toMatchObject({
      state: 'ok',
      title: '来源笔记',
      content: '一二三四五',
      highlight: { start: 1, end: 3 },
    })
  })

  it('reports old_version instead of applying old offsets to newer content', async () => {
    mockedGetNote.mockResolvedValueOnce(
      note({ revision: 3, snapshot_hash: 'd'.repeat(64) }) as never,
    )
    const data = await resolveReaderData('p1', request({}))
    expect(data.state).toBe('old_version')
    expect(data.highlight).toBeNull()
  })

  it('reports position_unavailable for out-of-bounds locator offsets', async () => {
    mockedGetNote.mockResolvedValueOnce(note() as never)
    const data = await resolveReaderData(
      'p1',
      request({ locator: { start_utf16: 0, end_utf16: 99, content_hash: null } }),
    )
    expect(data.state).toBe('position_unavailable')
  })

  it('maps restricted / missing notes to explicit states', async () => {
    mockedGetNote.mockRejectedValueOnce(apiError('note_access_restricted', 403))
    await expect(resolveReaderData('p1', request({}))).rejects.toMatchObject({
      response: { status: 403 },
    })
    mockedGetNote.mockRejectedValueOnce(apiError('fragment_source_not_found', 404))
    await expect(resolveReaderData('p1', request({}))).rejects.toMatchObject({
      response: { status: 404 },
    })
  })

  it('reads a chat message from its session detail and verifies the content hash', async () => {
    mockedGetChat.mockResolvedValueOnce({
      session: { session_id: 's1', title: null },
      messages: [{ message_id: 'm1', role: 'assistant', content: '回答正文' }],
      cards: [],
      next_cursor: null,
    } as never)
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'chat_message',
        source_id: 'm1',
        source_version: null,
        locator: {
          surface: 'global',
          session_id: 's1',
          message_id: 'm1',
          content_hash: 'c'.repeat(64),
        },
      }),
    )
    expect(data.state).toBe('content_mismatch')
    expect(data.content).toBe('回答正文')
    mockedGetChat.mockResolvedValueOnce({
      session: { session_id: 's1', title: null },
      messages: [{ message_id: 'm1', role: 'assistant', content: '回答正文' }],
      cards: [],
      next_cursor: null,
    } as never)
    const ok = await resolveReaderData(
      'p1',
      request({
        source_kind: 'chat_message',
        source_id: 'm1',
        source_version: null,
        locator: { surface: 'global', session_id: 's1', message_id: 'm1' },
      }),
    )
    expect(ok.state).toBe('ok')
  })

  it('reads a long session from the newest window first (order=desc, limit=50)', async () => {
    const tailMessage = {
      message_id: 'm_tail',
      role: 'assistant',
      content: '尾部回答正文',
    }
    const messages = Array.from({ length: 50 }, (_, index) =>
      index === 49
        ? tailMessage
        : { message_id: `m${index}`, role: 'user' as const, content: `消息 ${index}` },
    )
    mockedGetChat.mockResolvedValueOnce({
      session: { session_id: 's1', title: null },
      messages,
      cards: [],
      next_cursor: null,
    } as never)
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'chat_message',
        source_id: 'm_tail',
        source_version: null,
        locator: { surface: 'global', session_id: 's1', message_id: 'm_tail' },
      }),
    )
    expect(data.state).toBe('ok')
    expect(data.content).toBe('尾部回答正文')
    expect(mockedGetChat).toHaveBeenCalledWith('p1', 's1', {
      limit: 50,
      order: 'desc',
    })
  })

  it('pages backwards with next_cursor until a tail answer is found', async () => {
    const fullPage = (start: number) =>
      Array.from({ length: 50 }, (_, index) => ({
        message_id: `m${start + index}`,
        role: 'user' as const,
        content: `消息 ${start + index}`,
      }))
    mockedGetChat
      .mockResolvedValueOnce({
        session: { session_id: 's1', title: null },
        messages: fullPage(100),
        cards: [],
        next_cursor: 'cursor_older_1',
      } as never)
      .mockResolvedValueOnce({
        session: { session_id: 's1', title: null },
        messages: [
          { message_id: 'm_answer', role: 'assistant', content: '第二页尾部回答' },
          ...fullPage(50).slice(0, 49),
        ],
        cards: [],
        next_cursor: null,
      } as never)
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'chat_message',
        source_id: 'm_answer',
        source_version: null,
        locator: { surface: 'global', session_id: 's1', message_id: 'm_answer' },
      }),
    )
    expect(data.state).toBe('ok')
    expect(data.content).toBe('第二页尾部回答')
    expect(mockedGetChat).toHaveBeenCalledTimes(2)
    expect(mockedGetChat).toHaveBeenLastCalledWith('p1', 's1', {
      limit: 50,
      order: 'desc',
      cursor: 'cursor_older_1',
    })
  })

  it('pages source chat sessions backwards too and reports unavailable after exhausting', async () => {
    mockedGetSourceChat
      .mockResolvedValueOnce({
        session: { session_id: 'ss1', title: null },
        messages: [{ message_id: 's_old', role: 'user', content: '旧消息' }],
        cards: [],
        next_cursor: 'source_cursor_1',
      } as never)
      .mockResolvedValueOnce({
        session: { session_id: 'ss1', title: null },
        messages: [{ message_id: 's_tail', role: 'assistant', content: '来源尾部回答' }],
        cards: [],
        next_cursor: null,
      } as never)
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'chat_message',
        source_id: 's_tail',
        source_version: null,
        locator: {
          surface: 'source',
          session_id: 'ss1',
          source_id: 'src1',
          message_id: 's_tail',
        },
      }),
    )
    expect(data.state).toBe('ok')
    expect(data.content).toBe('来源尾部回答')
    expect(mockedGetSourceChat).toHaveBeenCalledWith('p1', 'src1', 'ss1', {
      limit: 50,
      order: 'desc',
    })
  })

  it('fails position_unavailable for a chat message binding without locator', async () => {
    const data = await resolveReaderData(
      'p1',
      request({ source_kind: 'chat_message', source_id: 'm1', source_version: null }),
    )
    expect(data.state).toBe('position_unavailable')
    expect(mockedGetChat).not.toHaveBeenCalled()
  })

  it('reports unavailable when no page contains the referenced message', async () => {
    mockedGetChat.mockResolvedValueOnce({
      session: { session_id: 's1', title: null },
      messages: [{ message_id: 'm1', role: 'user', content: '消息' }],
      cards: [],
      next_cursor: null,
    } as never)
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'chat_message',
        source_id: 'm_missing',
        source_version: null,
        locator: { surface: 'global', session_id: 's1', message_id: 'm_missing' },
      }),
    )
    expect(data.state).toBe('unavailable')
  })

  it('pages through legacy insights beyond the first 100 items', async () => {
    mockedListInsights
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, index) => ({
          insight_id: `i${index}`,
          title: 't',
          content: 'c',
        })),
        next_cursor: 'insight_cursor_1',
      } as never)
      .mockResolvedValueOnce({
        items: [{ insight_id: 'i_tail', title: '尾部洞察', content: '尾部洞察正文' }],
        next_cursor: null,
      } as never)
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'legacy_insight',
        source_id: 'i_tail',
        source_version: null,
        locator: { insight_id: 'i_tail' },
      }),
    )
    expect(data).toMatchObject({ state: 'ok', title: '尾部洞察', content: '尾部洞察正文' })
    expect(mockedListInsights).toHaveBeenCalledTimes(2)
  })

  it('finds a legacy insight in the project catalog and verifies its hash', async () => {
    mockedListInsights.mockResolvedValueOnce({
      items: [{ insight_id: 'i1', title: '洞察', content: '洞察正文' }],
      next_cursor: null,
    } as never)
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'legacy_insight',
        source_id: 'i1',
        source_version: null,
        locator: { insight_id: 'i1' },
      }),
    )
    expect(data).toMatchObject({ state: 'ok', title: '洞察', content: '洞察正文' })
  })

  it('reports unavailable when the legacy insight is gone', async () => {
    mockedListInsights.mockResolvedValueOnce({ items: [], next_cursor: null } as never)
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'legacy_insight',
        source_id: 'i_missing',
        source_version: null,
      }),
    )
    expect(data.state).toBe('unavailable')
  })

  it('keeps the source relation but never fabricates a position for unresolved bindings', async () => {
    const data = await resolveReaderData('p1', request({ unresolved: true }))
    expect(data.state).toBe('unresolved')
    expect(data.highlight).toBeNull()
  })

  it('exposes source metadata without treating locator as authorization', async () => {
    const data = await resolveReaderData(
      'p1',
      request({
        source_kind: 'source',
        source_id: 'src_1',
        source_version: 'docv_1',
        locator: null,
      }),
    )
    expect(data.state).toBe('source_reading')
    expect(data.versionLabel).toBe('docv_1')
  })
})
