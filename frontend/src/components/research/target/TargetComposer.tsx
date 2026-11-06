'use client'

import { useState } from 'react'
import { ArrowRight, GitCompareArrows, Search, Telescope } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchScope } from '@/lib/research/scope'
import {
  ResearchDraftComposer,
  deriveResearchDraftGate,
  researchDraftGateReasonKey,
} from '../ResearchDraftComposer'
import type { ResearchDraftGate } from '@/lib/research/types'
import type { UseResearchEditorResult } from '@/lib/hooks/use-research-editor'

/**
 * 目标壳 composer（W1 #1104；UI 规格 v1 §5.5 UI-10/UI-11，§3.4）。
 *
 * - 复用 `ResearchDraftComposer`（加性 props：`mod-enter` 提交、52/170px、
 *   footerSlot、describedById），既有旧壳默认行为不变；
 * - 最小 52px、最大 170px；空输入不可提交、提交中禁用重复；
 * - 上下文 chip：单篇限定（BEH-02，可清除）与选段 chip（复用既有 shape）可见
 *   可移除；
 * - 次级操作行：证据搜索 / 比较资料 → 打开既有面板作为中央次级视图；
 *   深入研究在 P6 前**明确不可用**（不建假任务）；
 * - 「本次用途」（UI-11）在 #1106 提供真实语义前**不造假控件**，登记为欠项；
 * - 空 selected 阻断（BEH-03）：显示原因与改选路径，不静默扩大范围。
 */

export function TargetComposer({
  sessionWired,
  editor,
  editorSnapshot,
  submissionReady,
  isStreaming,
  canExecute,
  blockedHint,
  scopeBlockedText,
  onSend,
  onOpenSearch,
  onOpenCompare,
  searchAvailable,
  compareAvailable,
  compactScopeChip,
  onCompactScopeChipActivate,
  selectionChip = null,
  focusRequestToken,
}: {
  sessionWired: boolean
  editor: UseResearchEditorResult
  editorSnapshot: UseResearchEditorResult['snapshot']
  submissionReady: boolean | undefined
  isStreaming: boolean
  canExecute: boolean
  blockedHint: string
  scopeBlockedText: string | null
  onSend: (text: string) => Promise<boolean>
  onOpenSearch: () => void
  onOpenCompare: () => void
  searchAvailable: boolean
  compareAvailable: boolean
  /** §3.3 compact + 右栏打开时的当前范围紧凑标签 */
  compactScopeChip: string | null
  onCompactScopeChipActivate: () => void
  selectionChip?: {
    readonly label: string
    readonly title?: string
    readonly onRemove: () => void
    readonly disabled?: boolean
  } | null
  focusRequestToken?: number
}) {
  const { t } = useTranslation()
  const { isAdminReadonly } = useResearchWorkspace()
  const { mode, singlePin, clearSingle } = useResearchScope()
  // legacy（未装配会话）路径没有 editor 快照：本地草稿由 composer 内部维护，
  // 父层镜像一份用于发送（不改变既有输入行为）。
  const [localDraft, setLocalDraft] = useState('')

  const draftText = sessionWired ? editorSnapshot?.draftText ?? '' : localDraft
  const conversationSnapshot = {
    isBusy: isStreaming,
    isStreaming,
    activeTurnId: null,
    phase: isStreaming ? ('streaming' as const) : ('idle' as const),
  }

  const gate: ResearchDraftGate = sessionWired
    ? deriveResearchDraftGate({
        editorSnapshot,
        conversationSnapshot,
        submissionReady,
        kind: 'global',
      })
    : {
        allowed:
          localDraft.trim().length > 0 &&
          !isStreaming &&
          canExecute &&
          !isAdminReadonly &&
          scopeBlockedText === null,
        reason: null,
      }

  // 阻断原因优先级：范围阻断（BEH-03）> 模型不可用 > 会话状态 > 空输入。
  const gateReasonText =
    scopeBlockedText !== null
      ? scopeBlockedText
      : gate.allowed
        ? null
        : !canExecute && blockedHint.length > 0
          ? blockedHint
          : isAdminReadonly
            ? t('research.workbench.adminWriteDenied')
            : isStreaming
              ? t('research.errors.generationInProgress')
              : sessionWired && gate.reason !== null
                ? t(researchDraftGateReasonKey(gate.reason))
                : draftText.trim().length === 0
                  ? t('research.target.composer.emptyDisabled')
                  : null

  const singleChip =
    mode === 'single' && singlePin !== null
      ? {
          label: t('research.target.composer.singleChip', { name: singlePin.sourceId }),
          onRemove: clearSingle,
        }
      : null
  const chip = selectionChip ?? singleChip

  const handleSend = (): void => {
    if (!gate.allowed) return
    void onSend(draftText)
  }

  const secondary = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="sr-only">{t('research.target.secondary.label')}</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 gap-1 px-2 text-xs"
        disabled={!searchAvailable}
        onClick={onOpenSearch}
        data-testid="rdlens-target-secondary-search"
      >
        <Search aria-hidden="true" className="h-3.5 w-3.5" />
        {t('research.target.secondary.search')}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 gap-1 px-2 text-xs"
        disabled={!compareAvailable}
        onClick={onOpenCompare}
        data-testid="rdlens-target-secondary-compare"
      >
        <GitCompareArrows aria-hidden="true" className="h-3.5 w-3.5" />
        {t('research.target.secondary.compare')}
      </Button>
      {/* P6 前深入研究没有真实执行：只显示不可用原因，不建假任务、不弹确认。 */}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 gap-1 px-2 text-xs"
        disabled
        aria-describedby="rdlens-target-deep-research-reason"
        data-testid="rdlens-target-secondary-deep-research"
      >
        <Telescope aria-hidden="true" className="h-3.5 w-3.5" />
        {t('research.target.secondary.deepResearch')}
      </Button>
      <p
        id="rdlens-target-deep-research-reason"
        className="basis-full text-xs"
        style={{ color: 'var(--rdlens-ink-muted)' }}
        data-testid="rdlens-target-deep-research-reason"
      >
        {t('research.target.secondary.deepResearchUnavailable')}
      </p>
    </div>
  )

  return (
    <div
      id="rdlens-target-composer"
      className="shrink-0"
      // A11Y-01：跳过链接指向输入区；tabIndex=-1 让片段导航真正把焦点落到
      // composer 容器（随后 Tab 进 textarea），而不只是滚动。
      tabIndex={-1}
      data-testid="rdlens-target-composer"
    >
      {compactScopeChip !== null && (
        <div className="px-1 pb-1">
          {/* §3.3：compact + 右栏打开 → composer 显示范围紧凑标签，点击关闭右栏
              并聚焦左栏范围控件（不在此提供第二套范围控件）。 */}
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-1 rounded-[4px] px-2 py-1 text-xs"
            style={{
              backgroundColor: 'var(--rdlens-cite-field)',
              color: 'var(--rdlens-ink)',
            }}
            aria-label={t('research.target.composer.scopeChipAria', { label: compactScopeChip })}
            onClick={onCompactScopeChipActivate}
            data-testid="rdlens-target-compact-scope-chip"
          >
            <span className="min-w-0 truncate">{compactScopeChip}</span>
            <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0" />
          </button>
        </div>
      )}
      <ResearchDraftComposer
        editorSnapshot={sessionWired ? editorSnapshot : null}
        conversationSnapshot={conversationSnapshot}
        gate={gate}
        gateReasonText={gateReasonText}
        onDraftChange={(text) => {
          if (sessionWired) {
            editor.setDraftText(text)
          } else {
            setLocalDraft(text)
          }
        }}
        onSend={handleSend}
        onRetrySave={() => {
          if (sessionWired) void editor.retrySave()
        }}
        selectionChip={chip}
        localDraftMode={!sessionWired}
        submitShortcut="mod-enter"
        minHeightPx={52}
        maxHeightPx={170}
        describedById="rdlens-target-composer-shortcut"
        footerSlot={secondary}
        focusRequestToken={focusRequestToken}
      />
      <p
        id="rdlens-target-composer-shortcut"
        className="px-4 pb-2 text-[11px]"
        style={{ color: 'var(--rdlens-ink-muted)' }}
      >
        {t('research.target.composer.shortcutHint')}
      </p>
    </div>
  )
}
