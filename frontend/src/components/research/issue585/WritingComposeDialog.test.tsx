/**
 * Issue #1048 PR7：写作入口对话框测试。
 *
 * 用真实 `useWritingCompose` + 注入 mock 的传输层与编辑器控制器，覆盖：
 * 能力/Admin 门控；全文/选区与 history 显式确认；当前/新建会话（创建不自动
 * 发送）；composer ACK 后 11 键请求；422 容量可见；SSE→实际输入回看
 * （writing_checks 缺失提示）；手工摘入复用 #1047 路径；结果未知原身份重试。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { WritingLaunchProvider } from '@/lib/research/issue585/writing-launch'
import {
  resetGlobalModelStub,
  setGlobalModelStub,
  GLOBAL_MODEL_STUB_ID,
} from '@/test/global-model-stub'
import type { WritingContextProjection } from '@/lib/research/issue585/writing-types'
import {
  clearWritingCacheMemoryFallback,
  readOrCreateWritingCacheTabId,
  readWritingCacheRecord,
  resetWritingCacheTabId,
} from '@/lib/research/issue585/writing-cache'
import { WritingComposeDialog } from './WritingComposeDialog'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
    language: 'zh-CN',
  }),
}))

vi.mock('@/lib/hooks/use-research-global-model')

const clientMocks = vi.hoisted(() => ({
  createWritingSession: vi.fn(),
  submitWritingSubmission: vi.fn(),
  getWritingContext: vi.fn(),
  locateWritingResultMessage: vi.fn(),
}))

vi.mock('@/lib/research/issue585/writing-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/research/issue585/writing-client')>()
  return {
    ...actual,
    createWritingSession: clientMocks.createWritingSession,
    submitWritingSubmission: clientMocks.submitWritingSubmission,
    getWritingContext: clientMocks.getWritingContext,
    locateWritingResultMessage: clientMocks.locateWritingResultMessage,
  }
})

const editorMock = vi.hoisted(() => {
  const state = { text: '', revision: 77, intentHash: 'b'.repeat(64), draftToken: 'draft_saved' }
  const controller = {
    setDraftText: vi.fn((text: string) => {
      state.text = text
    }),
    flush: vi.fn(async () => 'saved'),
    getSnapshot: vi.fn(() => ({
      revision: state.revision,
      intentHash: state.intentHash,
      draftToken: state.draftToken,
      draftText: state.text,
      dirty: false,
    })),
    canSubmit: vi.fn(() => ({ allowed: true, reason: null })),
  }
  return { state, controller }
})

vi.mock('@/lib/hooks/use-research-editor', () => ({
  useResearchEditor: (options: { enabled?: boolean }) => ({
    snapshot: null,
    controller: options.enabled === false ? null : editorMock.controller,
    transportWired: true,
    setDraftText: vi.fn(),
    setScope: vi.fn(),
    setChatAnchor: vi.fn(),
    setReaderAnchor: vi.fn(),
    flush: vi.fn(async () => 'saved'),
    hold: vi.fn(),
    release: vi.fn(),
    retrySave: vi.fn(),
    adoptServerVersion: vi.fn(),
    saveLocalOverServer: vi.fn(),
    clearAfterSubmission: vi.fn(),
    markTokenConsumed: vi.fn(),
    canSubmit: vi.fn(() => ({ allowed: true, reason: null })),
    restoreDraft: vi.fn(),
    refreshDraftCandidates: vi.fn(),
    releaseDocument: vi.fn(),
  }),
}))

const noteWorkspaceMock = vi.hoisted(() => ({
  value: null as null | {
    insertionAvailable: boolean
    openExcerptInsert: ReturnType<typeof vi.fn>
  },
}))

vi.mock('./NoteWorkspaceProvider', () => ({
  useNoteWorkspaceOptional: () => noteWorkspaceMock.value,
}))

import type { ResearchSessionRef } from '@/lib/research/session-contract'

const CURRENT_REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: 'p_demo',
  sessionId: 'sess_current',
  sourceId: null,
}

const NOTE = {
  noteId: 'note_abc',
  title: '研究笔记',
  revision: 4,
  snapshotHash: 'a'.repeat(64),
  content: 'abcdef',
  accessState: 'visible' as const,
}

const PROJECTION: WritingContextProjection = {
  generation_id: 'gen_1',
  input_id: 'inp_' + 'd'.repeat(64),
  input_schema_version: 4,
  input_hash: 'e'.repeat(64),
  document_context: {
    note_id: 'note_abc',
    revision: 4,
    snapshot_hash: 'a'.repeat(64),
    selection_kind: 'range',
    start_utf16: 1,
    end_utf16: 3,
    selected_text: 'bc',
    selected_text_hash: 'f'.repeat(64),
  },
  history: { mode: 'none', adopted: [], excluded: [] },
  integrity: {
    document_context_hash: '2'.repeat(64),
    history_hash: '3'.repeat(64),
    envelope_hash: '4'.repeat(64),
  },
  capacity: { input_utf8_bytes: 10, envelope_utf8_bytes: 20, limit_utf8_bytes: 1048576 },
  writing_checks: {
    version: 1,
    missing_binding_ids: ['bind_missing_1'],
    unavailable_reason: null,
  },
  access_state: 'visible',
}

type SubmitInput = Parameters<
  typeof import('@/lib/research/issue585/writing-client').submitWritingSubmission
>[0]

function wrapper(children: React.ReactNode, launch = true): React.ReactElement {
  const content = launch ? (
    <WritingLaunchProvider
      value={{
        currentRef: CURRENT_REF,
        sourceId: null,
        openSession: () => true,
      }}
    >
      {children}
    </WritingLaunchProvider>
  ) : (
    children
  )
  return (
    <ResearchWorkspaceProvider projectId="p_demo" role="owner" userId="42">
      {content}
    </ResearchWorkspaceProvider>
  )
}

function renderDialog(overrides: Partial<Parameters<typeof WritingComposeDialog>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    note: NOTE,
    initialSelection: { kind: 'range' as const, start_utf16: 1, end_utf16: 3 },
    writingAvailable: true,
    ...overrides,
  }
  return render(<WritingComposeDialog {...props} />, { wrapper: ({ children }) => wrapper(children) })
}

function lastSubmitInput(): SubmitInput {
  const calls = clientMocks.submitWritingSubmission.mock.calls
  return calls[calls.length - 1][0] as SubmitInput
}

beforeEach(() => {
  clearWritingCacheMemoryFallback()
  resetWritingCacheTabId()
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetGlobalModelStub()
  setGlobalModelStub({ confirmedModelId: GLOBAL_MODEL_STUB_ID })
  vi.clearAllMocks()
  editorMock.state.text = ''
  noteWorkspaceMock.value = { insertionAvailable: true, openExcerptInsert: vi.fn() }
  clientMocks.createWritingSession.mockImplementation(
    async (input: { sessionId: string; kind: 'global' | 'source'; projectId: string; sourceId: string | null }) => ({
      ok: true,
      ref: {
        domain: 'research',
        kind: input.kind,
        projectId: input.projectId,
        sessionId: input.sessionId,
        sourceId: input.sourceId ?? null,
      },
      created: true,
    }),
  )
  clientMocks.locateWritingResultMessage.mockResolvedValue({
    ok: true,
    messageId: 'msg_result',
    content: '改写结果',
    userMessageId: 'msg_user',
  })
  clientMocks.getWritingContext.mockResolvedValue({ ok: true, projection: PROJECTION })
})

describe('能力与权限门控（fail-closed）', () => {
  it('writing_local 不可用时入口整体不渲染', () => {
    renderDialog({ writingAvailable: false })
    expect(screen.queryByTestId('writing-compose-dialog')).not.toBeInTheDocument()
  })

  it('Admin 只读不渲染入口', () => {
    render(
      <WritingComposeDialog
        open
        onClose={vi.fn()}
        note={NOTE}
        initialSelection={{ kind: 'full' }}
        writingAvailable
        isAdminReadonly
      />,
      {
        wrapper: ({ children }) => (
          <ResearchWorkspaceProvider projectId="p_demo" role="admin_readonly" userId="7">
            <WritingLaunchProvider
              value={{ currentRef: null, sourceId: null, openSession: () => true }}
            >
              {children}
            </WritingLaunchProvider>
          </ResearchWorkspaceProvider>
        ),
      },
    )
    expect(screen.queryByTestId('writing-compose-dialog')).not.toBeInTheDocument()
  })
})

describe('输入选择确认与容量说明', () => {
  it('默认 history=none、入口选区；容量值可见', () => {
    renderDialog()
    expect(screen.getByTestId('writing-history-none')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('writing-scope-range')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('writing-capacity')).toHaveTextContent(
      'research.notes.writing.capacity.value',
    )
    expect(screen.getByTestId('writing-scope-note')).toHaveTextContent('note_abc')
  })

  it('可显式切到全文，也可切换 history=current', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('writing-scope-full'))
    expect(screen.getByTestId('writing-scope-full')).toHaveAttribute('data-state', 'checked')
    fireEvent.click(screen.getByTestId('writing-history-current'))
    expect(screen.getByTestId('writing-history-current')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByText('research.notes.writing.history.currentHint')).toBeInTheDocument()
  })

  it('初始为全文时选区选项不可用（不静默改选）', () => {
    renderDialog({ initialSelection: { kind: 'full' } })
    expect(screen.getByTestId('writing-scope-range')).toBeDisabled()
    expect(
      screen.getByText('research.notes.writing.scope.rangeUnavailable'),
    ).toBeInTheDocument()
  })
})

describe('会话：当前/新建（创建不自动发送）', () => {
  it('默认当前会话；新建会话需显式创建，创建不触发提交', async () => {
    renderDialog()
    expect(screen.getByTestId('writing-session-current')).toHaveAttribute('data-state', 'checked')
    fireEvent.click(screen.getByTestId('writing-session-new'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-create-session'))
      await Promise.resolve()
    })
    await waitFor(() => expect(clientMocks.createWritingSession).toHaveBeenCalledTimes(1))
    expect(clientMocks.submitWritingSubmission).not.toHaveBeenCalled()
    expect(screen.getByTestId('writing-created-session')).toHaveTextContent(
      'research.notes.writing.session.created',
    )
  })

  it('未创建新会话时发送按钮不可用', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('writing-session-new'))
    fireEvent.change(screen.getByTestId('writing-query'), { target: { value: '改写' } })
    expect(screen.getByTestId('writing-send')).toBeDisabled()
  })
})

describe('发送：composer ACK 后 11 键请求', () => {
  it('保存 composer 后提交；请求使用已保存 composer 身份与确认的选区/history', async () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('writing-query'), { target: { value: '请改写选段' } })
    fireEvent.click(screen.getByTestId('writing-history-current'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-send'))
      await Promise.resolve()
    })
    await waitFor(() => expect(clientMocks.submitWritingSubmission).toHaveBeenCalledTimes(1))
    expect(editorMock.controller.setDraftText).toHaveBeenCalledWith('请改写选段')
    expect(editorMock.controller.flush).toHaveBeenCalledWith('submit')
    const input = lastSubmitInput()
    expect(input.request.editor_revision).toBe(77)
    expect(input.request.draft_token).toBe('draft_saved')
    expect(input.request.editor_intent_hash).toBe('b'.repeat(64))
    expect(input.request.history_mode).toBe('current')
    expect(input.request.document_context).toEqual({
      note_id: 'note_abc',
      revision: 4,
      snapshot_hash: 'a'.repeat(64),
      selection: { kind: 'range', start_utf16: 1, end_utf16: 3 },
    })
    expect(input.sessionRef.sessionId).toBe('sess_current')
  })

  it('422 context_limit_exceeded 显示可见说明，不改选全文/不截断输入', async () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('writing-query'), { target: { value: '超限指令' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-send'))
      await Promise.resolve()
    })
    await waitFor(() => expect(clientMocks.submitWritingSubmission).toHaveBeenCalledTimes(1))
    const input = lastSubmitInput()
    act(() => {
      input.onHttpError?.(422, {
        detail: { code: 'context_limit_exceeded', retryable: false },
      })
    })
    await waitFor(() => expect(screen.getByTestId('writing-submit-error')).toBeInTheDocument())
    expect(screen.getByTestId('writing-submit-error')).toHaveTextContent(
      'research.notes.writing.errors.contextLimitExceeded',
    )
    expect(screen.getByTestId('writing-scope-range')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('writing-query')).toHaveValue('超限指令')
  })
})

describe('结果与实际输入回看 + 手工摘入', () => {
  it('SSE done 后展示 writing_checks 缺失提示，并复用摘入确认层', async () => {
    const onClose = vi.fn()
    renderDialog({ onClose })
    fireEvent.change(screen.getByTestId('writing-query'), { target: { value: '改写' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-send'))
      await Promise.resolve()
    })
    await waitFor(() => expect(clientMocks.submitWritingSubmission).toHaveBeenCalledTimes(1))
    const input = lastSubmitInput()
    act(() => {
      input.onAcceptReceipt?.({
        generationId: 'gen_1',
        idempotencyKey: 'w1_key',
        editorRevision: 77,
        sessionRef: CURRENT_REF,
      })
      input.onEvent({ event_id: 1, type: 'answer', delta: '改写结果' })
      input.onEvent({ event_id: 2, type: 'done', completion_status: 'completed' })
    })
    await waitFor(() =>
      expect(screen.getByTestId('writing-context-panel')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('writing-checks-missing')).toHaveTextContent(
      'research.notes.writing.checks.missing',
    )
    expect(screen.getByTestId('writing-result-answer')).toHaveTextContent('改写结果')

    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-insert-excerpt'))
      await Promise.resolve()
    })
    await waitFor(() => expect(noteWorkspaceMock.value?.openExcerptInsert).toHaveBeenCalled())
    // MEDIUM-7：按 generation_id 定位耐久消息，不按正文/序号猜。
    expect(clientMocks.locateWritingResultMessage).toHaveBeenCalledWith(
      'p_demo',
      expect.objectContaining({
        domain: 'research',
        kind: 'global',
        projectId: 'p_demo',
        sessionId: 'sess_current',
        sourceId: null,
      }),
      'gen_1',
      '改写结果',
    )
    expect(noteWorkspaceMock.value?.openExcerptInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'chat_message',
        sourceId: 'msg_result',
        text: '改写结果',
      }),
    )
    // #1190（W3-G14）：确认层与写作对话框同为 z-50，写作对话框的 portal 在 DOM 之后，
    // 不先关闭写作对话框，确认层会被盖住（用户看到静默 no-op）。
    expect(onClose).toHaveBeenCalledTimes(1)
    // 审查 L-3：交接顺序必须是“先关闭写作对话框，再打开确认层”。
    const onCloseOrder = onClose.mock.invocationCallOrder[0]
    const openOrder = noteWorkspaceMock.value?.openExcerptInsert.mock.invocationCallOrder[0]
    expect(openOrder).toBeDefined()
    expect(onCloseOrder).toBeLessThan(openOrder as number)
  })

  it('目标会话缺失时显式报错，不静默 no-op（#1190 / W3-G14）', async () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('writing-query'), { target: { value: '改写' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-send'))
      await Promise.resolve()
    })
    await waitFor(() => expect(clientMocks.submitWritingSubmission).toHaveBeenCalledTimes(1))
    const input = lastSubmitInput()
    act(() => {
      input.onAcceptReceipt?.({
        generationId: 'gen_1',
        idempotencyKey: 'w1_key',
        editorRevision: 77,
        sessionRef: CURRENT_REF,
      })
      input.onEvent({ event_id: 1, type: 'answer', delta: '改写结果' })
      input.onEvent({ event_id: 2, type: 'done', completion_status: 'completed' })
    })
    await waitFor(() =>
      expect(screen.getByTestId('writing-result-answer')).toHaveTextContent('改写结果'),
    )
    // 结果产生后把目标会话切到尚未创建的新会话 → targetRef=null（原实现静默 return）。
    fireEvent.click(screen.getByTestId('writing-session-new'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-insert-excerpt'))
      await Promise.resolve()
    })
    // 目标会话缺失 → 对应原因（不是“无法定位结果消息”的通用文案）。
    expect(screen.getByTestId('writing-insert-error')).toHaveTextContent(
      'research.notes.writing.composeErrors.sessionRequired',
    )
    expect(noteWorkspaceMock.value?.openExcerptInsert).not.toHaveBeenCalled()
  })

  it('定位结果返回前关闭对话框 → 不打开确认层、不二次 onClose（#1190 审查 M-1）', async () => {
    const onClose = vi.fn()
    let resolveLocate: (value: unknown) => void = () => {}
    clientMocks.locateWritingResultMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLocate = resolve
        }),
    )
    const view = renderDialog({ onClose })
    fireEvent.change(screen.getByTestId('writing-query'), { target: { value: '改写' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-send'))
      await Promise.resolve()
    })
    await waitFor(() => expect(clientMocks.submitWritingSubmission).toHaveBeenCalledTimes(1))
    const input = lastSubmitInput()
    act(() => {
      input.onAcceptReceipt?.({
        generationId: 'gen_1',
        idempotencyKey: 'w1_key',
        editorRevision: 77,
        sessionRef: CURRENT_REF,
      })
      input.onEvent({ event_id: 1, type: 'answer', delta: '改写结果' })
      input.onEvent({ event_id: 2, type: 'done', completion_status: 'completed' })
    })
    await waitFor(() =>
      expect(screen.getByTestId('writing-result-answer')).toHaveTextContent('改写结果'),
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-insert-excerpt'))
      await Promise.resolve()
    })
    expect(clientMocks.locateWritingResultMessage).toHaveBeenCalledTimes(1)
    // 生产形态（NoteWorkspaceProvider）是条件挂载：关闭 = 卸载（`open` 恒 true，
    // 父级不会用 `open=false` 重渲染）。因此这里必须用 unmount 模拟真实关闭。
    view.unmount()
    await act(async () => {
      resolveLocate({ ok: true, messageId: 'msg_result', content: '改写结果', userMessageId: 'msg_user' })
      await Promise.resolve()
    })
    expect(noteWorkspaceMock.value?.openExcerptInsert).not.toHaveBeenCalled()
    // 关闭动作由用户/父级触发；交接路径不得再调用一次 onClose。
    expect(onClose).not.toHaveBeenCalled()
  })

  it('结果未知（网络错误）→ 用原请求身份重试，不重新保存 composer', async () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('writing-query'), { target: { value: '改写' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-send'))
      await Promise.resolve()
    })
    await waitFor(() => expect(clientMocks.submitWritingSubmission).toHaveBeenCalledTimes(1))
    const first = lastSubmitInput()
    act(() => first.onNetworkError?.(new Error('offline')))
    await waitFor(() => expect(screen.getByTestId('writing-submit-error')).toBeInTheDocument())
    // 已提交未结算：发送被禁用，只能走「原身份重试」（MEDIUM-4）。
    expect(screen.getByTestId('writing-send')).toBeDisabled()
    editorMock.controller.flush.mockClear()
    await act(async () => {
      fireEvent.click(screen.getByTestId('writing-retry-same'))
      await Promise.resolve()
    })
    await waitFor(() => expect(clientMocks.submitWritingSubmission).toHaveBeenCalledTimes(2))
    const second = lastSubmitInput()
    expect(second.request).toEqual(first.request)
    expect(editorMock.controller.flush).not.toHaveBeenCalled()
  })
})


describe('关闭路径（review round-2 MEDIUM-2）', () => {
  it('输入后 400ms 内关闭：关闭即把最新 query 落盘（不丢指令）', async () => {
    const onClose = vi.fn()
    renderDialog({ onClose })
    fireEvent.change(screen.getByTestId('writing-query'), {
      target: { value: '关闭前的最新指令' },
    })
    // 不等待 debounce；立即点关闭。
    fireEvent.click(screen.getByTestId('writing-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    const record = readWritingCacheRecord(
      {
        ownerId: '42',
        projectId: 'p_demo',
        noteId: 'note_abc',
        tabId: readOrCreateWritingCacheTabId(),
      },
      {
        authority: {
          authenticatedOwnerId: '42',
          currentProjectId: 'p_demo',
          authGeneration: 0,
          currentAuthGeneration: 0,
          notePermission: 'visible',
        },
      },
    )
    expect(record?.choice?.query).toBe('关闭前的最新指令')
  })
})
