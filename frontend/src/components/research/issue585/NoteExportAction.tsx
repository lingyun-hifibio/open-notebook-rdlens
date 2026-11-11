'use client'

/**
 * Issue #1191 PR-B（W3-G2）：单份 Markdown 导出动作（唯一入口 = 目标壳宽屏
 * 编辑器 overlay 的顶部动作区；由 PR-A 的 `TargetEditorFocus` 挂载）。
 *
 * 权威依据：
 * - issue #1191 `## 期望交付` 第 2 条（复用 #1050 后端 API；当前权限/撤权阻断）；
 * - UI 规格 v1 §5.8 UI-19「单份 Markdown 导出为目标要求」；
 * - 计划 §2.2.1 的 NORMATIVE testid 契约（P-E 的 S10 只用这三个 testid）：
 *   入口按钮 `data-testid="note-export-markdown"`、导出中状态
 *   `role="status"` + `data-testid="note-export-status"`、失败条
 *   `role="alert"` + `data-testid="note-export-error"`。
 *
 * 可见性三道闸（全部 fail-closed，全部在 `use-note-export.ts` 内）：
 * (a) `capabilities.markdownExport.available === true`；
 * (b) 当前文档为 d2-v1 且 revision/snapshot_hash 非空；
 * (c) 非 Admin 只读。任一不满足时不渲染任何控件（不显示假入口）。
 *
 * 失败只呈现映射后的稳定文案（不显示原始响应体/堆栈），且不改正文与草稿；
 * 导出进行中重复点击是 no-op（按钮禁用 + hook 单在途守卫）。
 */

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useNoteExport, type NoteExportEditorHandle } from '@/lib/research/issue585/use-note-export'
import type { NoteExportFailure } from '@/lib/research/issue585/note-export'
import type { NoteCapabilities } from '@/lib/research/issue585/types'
import {
  noteExportFailureHintKey,
  noteExportFailureLabelKey,
  noteExportFailureRequestId,
} from './note-ui-labels'

export interface NoteExportActionProps {
  /** 目标壳宽屏编辑器句柄（`NoteWorkspaceEditorHandle` 结构等价）。 */
  editor: NoteExportEditorHandle | null
  /** 服务端能力投影（`/models.capabilities`；null = 未知 → 不可用）。 */
  capabilities: NoteCapabilities | null
  /** Admin 只读会话不提供导出（fail-closed 隐藏）。 */
  isAdminReadonly?: boolean
}

/** 失败分类 → `data-error-code`（仅供样式/测试定位；不作为文案来源）。 */
function failureErrorCode(failure: NoteExportFailure): string {
  switch (failure.kind) {
    case 'api':
      return failure.code
    case 'blocked':
      return `blocked:${failure.reason}`
    case 'not_exportable':
      return failure.reason
    case 'invalid_response':
      return 'invalid_response'
    case 'download_unavailable':
      return 'download_unavailable'
  }
}

/**
 * 「导出 Markdown」动作（入口 + 导出中状态 + 行内失败条）。
 *
 * 不可用时渲染 `null`（旧未保护行、能力关闭、Admin 只读、无已保存版本）。
 */
export function NoteExportAction({
  editor,
  capabilities,
  isAdminReadonly = false,
}: NoteExportActionProps) {
  const { t } = useTranslation()
  const { state, exportMarkdown } = useNoteExport({ editor, capabilities, isAdminReadonly })

  if (!state.available) return null

  const failure = state.failure
  const failureLabelKey = failure === null ? null : noteExportFailureLabelKey(failure)
  const failureHintKey = failure === null ? null : noteExportFailureHintKey(failure)
  const failureRequestId = failure === null ? null : noteExportFailureRequestId(failure)
  const statusKey = state.isExporting
    ? 'research.notes.export.exporting'
    : state.lastFilename !== null
      ? 'research.notes.export.exported'
      : null

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void exportMarkdown()}
        disabled={state.isExporting}
        aria-busy={state.isExporting}
        aria-label={t('research.notes.export.action')}
        data-testid="note-export-markdown"
      >
        {t('research.notes.export.action')}
      </Button>
      <span
        role="status"
        aria-live="polite"
        className="text-xs text-muted-foreground"
        data-testid="note-export-status"
      >
        {statusKey !== null ? t(statusKey) : ''}
      </span>
      {failure !== null && failureLabelKey !== null && (
        <div
          role="alert"
          className="max-w-xs text-right text-xs text-destructive"
          data-testid="note-export-error"
          data-error-code={failureErrorCode(failure)}
        >
          <p>{t(failureLabelKey)}</p>
          {failureHintKey !== null && (
            <p className="text-muted-foreground">{t(failureHintKey)}</p>
          )}
          {failureRequestId !== null && (
            <p className="text-muted-foreground">
              {t('research.notes.export.requestId', { requestId: failureRequestId })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
