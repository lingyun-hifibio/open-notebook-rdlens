'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { UseSourceMediaResult } from '@/lib/hooks/use-source-media'
import { readerLocatorKey } from '@/lib/research/reader'
import type { ResearchPendingSelection } from '@/lib/research/types'
import {
  TARGET_READER_BACK_BAR_HEIGHT,
  resolveTargetReaderLayout,
} from './target-layout'
import type { TargetReaderOpenRequest } from './target-reader-state'
import { TargetReaderAside } from './TargetReaderAside'
import { TargetReaderBody } from './TargetReaderBody'

/** 标题元素 id（`aria-labelledby` 指向它，不依赖可见文案）。 */
const READER_TITLE_ID = 'rdlens-target-reader-title'
/** aside 面板 id（供折叠开关 `aria-controls` 指向）。 */
const READER_ASIDE_ID = 'rdlens-target-reader-aside-panel'

/** 可聚焦元素选择器（与既有 a11y 约定一致；不引入规格外键盘语义）。 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  )
}

export interface TargetReaderFocusProps {
  request: TargetReaderOpenRequest
  media: UseSourceMediaResult
  /** 触发本次打开的回答片段（只读对照；null = 不可用） */
  answerContext: string | null
  /** citation 入口且 return-target 可用 */
  returnAvailable: boolean
  /** 返回原回答目标不可用（position_unavailable） */
  returnUnavailableNotice: boolean
  canPinSingleSource: boolean
  onAskThisSource: () => void
  onReturnToAnswer: () => void
  /** = media.openFile（返回条与正文列共用同一动作） */
  onOpenFile: () => void
  onDiscussSelection: (pending: ResearchPendingSelection) => void
  onClose: () => void
  /** 视口宽度（TargetShell 传入；1024–1279 aside 折叠判定） */
  viewportWidth: number
  /**
   * 当前页（0-based）与切页回调。
   *
   * DESIGN 接口清单未列出这两项，但 `TargetReaderBody` 需要它们、且
   * `useSourceMedia` 的 `pageIdx` 由 shell 持有（页面图按当前页单页请求）：
   * shell 必须以受控方式传入，reader 不自持页状态（避免正文/页图错位）。
   */
  pageIdx: number | null
  onSelectPage: (pageIdx: number) => void
}

/**
 * 宽屏阅读器覆盖层（Issue #1077 W2；UI 规格 v1 §5.7；合并计划 §2.3/
 * §2.10-4/5/11）。
 *
 * - 覆盖不卸载工作台（`fixed inset-0` 对话框；关闭后 shell 恢复滚动/草稿/
 *   流式状态，不新增路由）；
 * - 返回条固定 65px：返回按钮（打开即聚焦，Esc 同义）、标题、格式感知定位，
 *   右侧「只问此来源 / 打开原文件（下载）/ 返回原回答」；
 * - 正文列 ≤830 居中、独立滚动；aside ≥1280 恒 340px，1024–1279 默认折叠、
 *   展开时正文让宽（`resolveTargetReaderLayout`），不产生整页横向滚动；
 * - 焦点限制在 dialog 内（Tab 首/末环绕），`aria-modal` + `aria-labelledby`；
 * - PDF/PPT 不内联、不 `window.open`/`target=_blank`：原件只经下载读取。
 */
export function TargetReaderFocus({
  request,
  media,
  answerContext,
  returnAvailable,
  returnUnavailableNotice,
  canPinSingleSource,
  onAskThisSource,
  onReturnToAnswer,
  onOpenFile,
  onDiscussSelection,
  onClose,
  viewportWidth,
  pageIdx,
  onSelectPage,
}: TargetReaderFocusProps) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const backRef = useRef<HTMLButtonElement | null>(null)
  // aside 展开态只属于 reader 覆盖层（不影响工作台/右栏）；切来源/新请求复位。
  const [asideExpanded, setAsideExpanded] = useState(false)

  const requestKey = [
    request.origin,
    request.sourceId,
    request.documentRef?.documentId ?? '',
    request.documentRef?.documentVersion ?? '',
    String(request.initialPageIdx ?? ''),
  ].join('|')

  useEffect(() => {
    setAsideExpanded(false)
  }, [requestKey])

  // §5.7：打开即聚焦返回按钮（卸载后由 shell 恢复焦点到触发控件）。
  useEffect(() => {
    backRef.current?.focus()
  }, [])

  // §5.7：Esc 关闭；Tab 限制在 dialog 内环绕。监听在 document 上但不捕获，
  // 已由上层（Radix 弹层）处理过的 Esc（defaultPrevented）不再重复关闭。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const root = dialogRef.current
      if (root === null) return
      const focusable = focusableWithin(root)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const inside = active !== null && root.contains(active)
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const layout = resolveTargetReaderLayout({ viewportWidth, asideExpanded })
  const sourceType = media.sourceType
  const locatorKey = readerLocatorKey(sourceType)
  const detailTitle = media.detail?.title ?? null
  const title =
    detailTitle !== null && detailTitle.trim().length > 0
      ? detailTitle
      : media.detail?.document_id ??
        request.documentRef?.documentId ??
        request.sourceId
  const locatorText =
    locatorKey === null || pageIdx === null
      ? t('research.target.reader.locatorUnavailable')
      : t(locatorKey, { page: pageIdx + 1 })
  const downloadFailed = media.file.status === 'error'
  // §2.4：仅 `file_available === true` 且详情就绪时才提供原文件下载（不伪造入口）。
  const fileAvailable =
    media.detailStatus === 'ready' && media.detail?.file_available === true
  const downloadUnavailableReason = fileAvailable
    ? null
    : t('research.target.reader.downloadUnavailable')

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={READER_TITLE_ID}
      // 标题元素总是存在，可访问名以 aria-labelledby 为准；aria-label 只作
      // 兜底（标题为空/宿主裁剪标题节点时仍有可读名称）。
      aria-label={t('research.target.reader.dialogAria')}
      data-testid="rdlens-target-reader"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden"
      style={{
        background: 'var(--rdlens-paper)',
        color: 'var(--rdlens-ink)',
      }}
    >
      <header
        className="flex shrink-0 items-center gap-3 border-b px-4"
        style={{
          height: TARGET_READER_BACK_BAR_HEIGHT,
          borderColor: 'var(--rdlens-line)',
          background: 'var(--rdlens-surface)',
        }}
      >
        <button
          ref={backRef}
          type="button"
          onClick={onClose}
          aria-label={t('research.target.reader.backAria')}
          data-testid="rdlens-target-reader-back"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium outline-none focus-visible:ring-[3px]"
          style={{ borderColor: 'var(--rdlens-line-control)', color: 'var(--rdlens-ink)' }}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('research.target.reader.back')}
        </button>

        <div className="min-w-0 flex-1">
          <h2
            id={READER_TITLE_ID}
            className="truncate text-sm font-semibold"
            data-testid="rdlens-target-reader-title"
            title={title ?? undefined}
          >
            {title}
          </h2>
          <p
            className="rdlens-mono truncate text-xs"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-reader-locator"
          >
            {locatorText}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {layout.asideCollapsible && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="rdlens-target-reader-toggle-aside"
              aria-expanded={layout.asideVisible}
              aria-controls={layout.asideVisible ? READER_ASIDE_ID : undefined}
              aria-label={t('research.target.reader.toggleAsideAria')}
              onClick={() => setAsideExpanded((previous) => !previous)}
            >
              {t('research.target.reader.toggleAside')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="rdlens-target-reader-ask-source"
            disabled={!canPinSingleSource}
            title={
              canPinSingleSource
                ? undefined
                : t('research.target.conversation.noActiveSession')
            }
            onClick={onAskThisSource}
          >
            {t('research.target.rightPane.askThisSource')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="rdlens-target-reader-download"
            disabled={downloadUnavailableReason !== null || media.file.status === 'loading'}
            title={downloadUnavailableReason ?? undefined}
            aria-describedby={
              downloadUnavailableReason === null
                ? undefined
                : 'rdlens-target-reader-download-reason'
            }
            onClick={() => {
              if (downloadUnavailableReason === null) onOpenFile()
            }}
          >
            {t('research.target.reader.download')}
          </Button>
          {returnAvailable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="rdlens-target-reader-return"
              onClick={onReturnToAnswer}
            >
              {t('research.source.returnToAnswer')}
            </Button>
          )}
        </div>
      </header>

      {downloadUnavailableReason !== null && (
        <span
          id="rdlens-target-reader-download-reason"
          className="sr-only"
        >
          {downloadUnavailableReason}
        </span>
      )}

      {(returnUnavailableNotice || downloadFailed) && (
        <div
          className="flex shrink-0 flex-col gap-1 border-b px-4 py-2"
          style={{ borderColor: 'var(--rdlens-line)' }}
        >
          {returnUnavailableNotice && (
            <p
              className="text-xs"
              role="status"
              style={{ color: 'var(--rdlens-warning)' }}
              data-testid="rdlens-target-reader-return-unavailable"
            >
              {t('research.source.returnUnavailable')}
            </p>
          )}
          {downloadFailed && (
            <p
              className="text-xs"
              role="status"
              style={{ color: 'var(--rdlens-warning)' }}
              data-testid="rdlens-target-reader-download-failed"
            >
              {t('research.target.reader.downloadFailed')}
            </p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
          <div
            className="w-full px-6 py-4"
            style={{ maxWidth: layout.bodyColumnWidth }}
            data-testid="rdlens-target-reader-body-column"
          >
            <TargetReaderBody
              request={request}
              media={media}
              pageIdx={pageIdx}
              pages={media.pages}
              onSelectPage={onSelectPage}
              onDiscussSelection={onDiscussSelection}
              onOpenFile={onOpenFile}
            />
          </div>
        </div>
        {layout.asideVisible && (
          <div
            id={READER_ASIDE_ID}
            className="shrink-0 overflow-y-auto border-l"
            style={{
              width: layout.asideWidth,
              borderColor: 'var(--rdlens-line)',
            }}
            data-testid="rdlens-target-reader-aside-panel"
          >
            <TargetReaderAside
              request={request}
              media={media}
              answerContext={answerContext}
              canPinSingleSource={canPinSingleSource}
              onAskThisSource={onAskThisSource}
              returnAvailable={returnAvailable}
              onReturnToAnswer={onReturnToAnswer}
              returnUnavailableNotice={returnUnavailableNotice}
            />
          </div>
        )}
      </div>
    </div>
  )
}
