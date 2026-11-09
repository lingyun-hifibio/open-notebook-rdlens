'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTranslation } from '@/lib/hooks/use-translation'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchHostOptional } from '@/lib/embedded/host-context'
import { useResearchSources } from '@/lib/hooks/use-research'
import { useResearchJobsController } from '../ResearchJobsProvider'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { countActiveJobs } from '@/lib/research/jobs'
import { formatScopeLabel, useResearchScope } from '@/lib/research/scope'
import { TargetTopBar } from './TargetTopBar'
import { TargetSourcesPane } from './TargetSourcesPane'
import { TargetConversation } from './TargetConversation'
import { TargetRightPane } from './TargetRightPane'
import { TargetSecondaryView } from './TargetSecondaryView'
import { TargetTopicOverview } from './TargetTopicOverview'
import { useTargetConversation } from './use-target-conversation'
import { useResearchPurposeCapability } from './use-purpose-capability'
import {
  TARGET_MIN_VIEWPORT,
  TARGET_THREE_COLUMN_VIEWPORT,
  resolveTargetLayout,
  targetBreakpointForWidth,
} from './target-layout'
import {
  TARGET_RIGHT_PANE_TITLE_KEYS,
  type TargetCitationPreview,
  type TargetRightPaneKind,
} from './target-types'

/** 实际视口宽度（F19：中央列宽度/内边距按真实宽度推导，不止断点下限）。 */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? TARGET_MIN_VIEWPORT : window.innerWidth,
  )
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

/**
 * 目标工作台壳（W1 #1104；UI 规格 v1 §2.2/§3/§5/§7）。
 *
 * 布局：UI-02 顶栏（72px）＋ UI-04 左资料栏（282px）＋ UI-07 中央对话 ＋
 * UI-12 按需右栏（355px，默认收起）。断点：
 * - 1024–1279：右栏打开时左栏**临时收起**（状态保留），关闭后恢复左栏；
 * - ≥1280：三栏并排，左栏不收起；
 * - 中央列最小 640px；页面无横向滚动。
 *
 * 键盘：跳过链接 → 输入区；右栏打开焦点进面板标题/关闭，`Esc` 关闭并
 * 焦点返回触发控件（A11Y-02，含 citation/source 预览与 compact 左栏恢复，
 * F7）；header/aside/main 地标。
 *
 * 诚实边界（W1）：W2/W3/P6 能力（原文阅读、成果编辑、深入研究执行）不绘制
 * 假控件；空 selected 同时阻断 composer 与次级搜索/比较（BEH-03/F4）；
 * 「本次用途」（UI-11）由 #1106 PR-B 提供：能力位严格 true 时才渲染三选
 * 控件，空 selected 时另给真实的「改为探索讨论/写作」显式动作（D6）。
 * #1125（owner「选A」defect 修复）：中央对话起始位置挂载既有 #1016 主题
 * 概览入口/Dialog（UI 规格 v1 BEH-12/§5.4/D-UI-04=A）；不新增一级导航、
 * 主区动作、路由或右栏面板。
 */
export function TargetShell() {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const host = useResearchHostOptional()
  const purposeInferenceAvailable = useResearchPurposeCapability(projectId)
  const conversation = useTargetConversation({ purposeInferenceAvailable })
  const jobsController = useResearchJobsController()
  const scopeApi = useResearchScope()
  const sourcesQuery = useResearchSources(projectId)
  const { runGuarded, confirmedModelIsExternal } = useResearchGlobalModel()
  const viewportWidth = useViewportWidth()
  const isWideViewport = useMediaQuery(`(min-width: ${TARGET_THREE_COLUMN_VIEWPORT}px)`)
  // 断点判定走媒体查询（响应式/测试可注入）；中央列宽度用真实视口宽度推导
  // （F19：1440 右栏打开时中心 ≥720，不能按 1280 下限误判）。
  const breakpoint = isWideViewport
    ? 'wide'
    : targetBreakpointForWidth(viewportWidth)

  const [rightPane, setRightPane] = useState<TargetRightPaneKind | null>(null)
  const [citationPreview, setCitationPreview] = useState<TargetCitationPreview | null>(null)
  const [sourcePreviewId, setSourcePreviewId] = useState<string | null>(null)
  const [centerView, setCenterView] = useState<'conversation' | 'evidence-search' | 'compare'>(
    'conversation',
  )
  const [scopeFocusRequest, setScopeFocusRequest] = useState(0)
  const triggerRef = useRef<HTMLElement | null>(null)
  const restoreFocusPendingRef = useRef(false)
  const shellRef = useRef<HTMLDivElement | null>(null)

  const layout = resolveTargetLayout({
    breakpoint,
    rightPaneOpen: rightPane !== null,
    viewportWidth,
  })

  // —— F4/BEH-03：空 selected 同时阻断 composer 与证据搜索/比较 ——
  const scopeSnapshot = scopeApi.getSnapshot()
  const scopeBlocked =
    scopeSnapshot.mode === 'selected' &&
    scopeSnapshot.sourceIds.length === 0 &&
    scopeSnapshot.noteIds.length === 0
  const scopeBlockedText = scopeBlocked ? t('research.target.composer.scopeBlocked') : null

  // —— F7：关闭右栏后焦点回到触发控件；compact 左栏恢复可见后再执行 ——
  useEffect(() => {
    if (rightPane !== null) return
    if (!restoreFocusPendingRef.current) return
    restoreFocusPendingRef.current = false
    const trigger = triggerRef.current
    triggerRef.current = null
    if (trigger !== null && trigger.isConnected) {
      trigger.focus()
      if (typeof document !== 'undefined' && document.activeElement === trigger) return
    }
    shellRef.current
      ?.querySelector<HTMLElement>('[data-testid="chat-input"]')
      ?.focus()
  }, [rightPane])

  const closeRightPane = useCallback(() => {
    restoreFocusPendingRef.current = true
    setRightPane(null)
  }, [])

  const openPane = useCallback(
    (kind: TargetRightPaneKind, trigger: HTMLElement | null) => {
      triggerRef.current = trigger
      setRightPane(kind)
    },
    [],
  )

  // `Esc` 关闭右栏（文档级：焦点在面板任意位置都生效；不拦截弹层自身）。
  useEffect(() => {
    if (rightPane === null) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target
      // 弹层（Radix Dialog/Popover，role=dialog/listbox）自行处理 Esc，不抢。
      if (
        target instanceof Element &&
        target.closest('[role="dialog"], [role="listbox"]') !== null
      ) {
        return
      }
      event.stopPropagation()
      closeRightPane()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [rightPane, closeRightPane])

  const openCitation = useCallback(
    (preview: TargetCitationPreview, trigger: HTMLElement | null) => {
      triggerRef.current = trigger
      setCitationPreview(preview)
      setRightPane('citation')
    },
    [],
  )

  const openSourcePreview = useCallback((sourceId: string, trigger: HTMLElement | null) => {
    triggerRef.current = trigger
    setSourcePreviewId(sourceId)
    setRightPane('source')
  }, [])

  const handleOpenHistory = useCallback(
    (trigger: HTMLElement) => {
      openPane('conversations', trigger)
    },
    [openPane],
  )

  const handleCitationJump = useCallback(
    (sourceId: string, pageIdx: number | null) => {
      void pageIdx
      openSourcePreview(sourceId, null)
    },
    [openSourcePreview],
  )

  const sourcesReady = sourcesQuery.isSuccess && (sourcesQuery.data?.items.length ?? 0) > 0
  const secondaryAvailable = sourcesReady && !scopeBlocked
  const composerScopeLabel = useMemo(
    () =>
      layout.composerShowsCompactScope
        ? formatScopeLabel(scopeApi.getSnapshot(), t)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 每次渲染快照按需重取
    [layout.composerShowsCompactScope, t, scopeApi, conversation.activeRef, conversation.scopeBlockedText],
  )

  const layoutStyle = {
    borderColor: 'var(--rdlens-line)',
    backgroundColor: 'var(--rdlens-paper)',
  } as const

  const paneTitle = rightPane === null ? null : t(TARGET_RIGHT_PANE_TITLE_KEYS[rightPane])

  return (
    <div
      ref={shellRef}
      className="rdlens-target-shell flex h-full min-h-0 flex-col"
      style={layoutStyle}
      data-testid="rdlens-target-shell"
      data-breakpoint={breakpoint}
      data-center-width={layout.centerColumnWidth}
      data-right-pane-open={rightPane !== null ? 'true' : undefined}
      data-left-pane-collapsed={layout.leftPaneTemporarilyCollapsed ? 'true' : undefined}
    >
      {/* A11Y-01：跳到输入区（首个可聚焦元素，键盘用户可直接进入 composer） */}
      <a
        href="#rdlens-target-composer"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:px-3 focus:py-2 focus:text-sm"
        style={{
          backgroundColor: 'var(--rdlens-evidence)',
          color: 'var(--rdlens-on-evidence)',
        }}
        data-testid="rdlens-target-skip-link"
      >
        {t('research.target.a11y.skipToComposer')}
      </a>

      <TargetTopBar
        projectName={host?.projectName ?? null}
        activeJobCount={countActiveJobs(jobsController.jobs)}
        rightPane={rightPane}
        onOpenPane={openPane}
      />

      <div className="flex min-h-0 flex-1">
        {/* §3.3/§5.6：compact + 右栏打开 → 左栏**临时收起但保持挂载**，
            保留搜索/滚动/范围显示状态；关闭右栏立即恢复（不重挂载）。 */}
        <aside
          aria-label={t('research.target.a11y.sources')}
          aria-hidden={layout.leftPaneVisible ? undefined : true}
          className={`h-full min-h-0 w-[282px] shrink-0 flex-col border-r ${
            layout.leftPaneVisible ? 'flex' : 'hidden'
          }`}
          style={{ borderColor: 'var(--rdlens-line)', backgroundColor: 'var(--rdlens-surface-subtle)' }}
          data-testid="rdlens-target-sources-aside"
        >
          <TargetSourcesPane
            onOpenSource={openSourcePreview}
            scopeFocusRequest={scopeFocusRequest}
            purposeInferenceAvailable={conversation.purposeInferenceAvailable}
            onSetWorkPurpose={conversation.setWorkPurpose}
          />
        </aside>

        <main
          id="rdlens-target-main"
          aria-label={t('research.target.a11y.main')}
          className="flex min-h-0 min-w-[640px] flex-1 flex-col"
          style={{ backgroundColor: 'var(--rdlens-paper)' }}
          data-testid="rdlens-target-main"
        >
          {/* 对话保持挂载：切到次级视图不丢流式/草稿 */}
          <div
            className="flex min-h-0 flex-1 flex-col"
            hidden={centerView !== 'conversation'}
            data-testid="rdlens-target-conversation-slot"
          >
            <TargetConversation
              conversation={conversation}
              onOpenHistory={handleOpenHistory}
              onNewConversation={() => void conversation.newSession()}
              onOpenCitation={openCitation}
              rightPane={rightPane}
              onOpenRightPane={openPane}
              onOpenSearch={() => setCenterView('evidence-search')}
              onOpenCompare={() => setCenterView('compare')}
              searchAvailable={secondaryAvailable}
              compareAvailable={secondaryAvailable}
              secondaryBlockedReason={scopeBlockedText}
              compactScopeChip={composerScopeLabel}
              onCompactScopeChipActivate={() => {
                closeRightPane()
                setScopeFocusRequest((request) => request + 1)
              }}
              // #1125：中央对话起始位置的既有 #1016 概览入口/Dialog。仅在
              // 对话中心视图注入（次级视图不渲染，DOM 不残留 hidden 入口）；
              // 引用跳转复用 shell 既有右栏来源预览；继续讨论写当前会话既有
              // 草稿（无活动会话 → `editorHandle=null`，动作 fail-closed 隐藏）。
              overviewSlot={
                centerView === 'conversation' ? (
                  <TargetTopicOverview
                    projectId={projectId}
                    onCitationJump={handleCitationJump}
                    editorHandle={conversation.sessionWired ? conversation.editor : null}
                    canExecute={conversation.canExecute}
                    blockedHint={conversation.blockedHint}
                    isAdminReadonly={isAdminReadonly}
                    confirmedModelIsExternal={confirmedModelIsExternal === true}
                  />
                ) : undefined
              }
            />
          </div>

          {centerView !== 'conversation' && (
            <TargetSecondaryView
              view={centerView}
              onBack={() => setCenterView('conversation')}
              onCitationJump={handleCitationJump}
              scopeBlockedText={scopeBlockedText}
              compare={{
                isCreating: jobsController.isCreating,
                error: jobsController.error,
                errorCode: jobsController.errorCode ?? null,
                onCreate: async (documentIds, groupSize) => {
                  const scopeLabel = formatScopeLabel(
                    {
                      mode: 'selected',
                      sourceIds: [...documentIds],
                      noteIds: [],
                      singleSourceId: null,
                    },
                    t,
                  )
                  const sent = await runGuarded(
                    (modelId) => {
                      jobsController.createCompare(documentIds, modelId, groupSize)
                      return true
                    },
                    { scopeLabel },
                  )
                  return sent === true
                },
                modelBlocked: !conversation.canExecute,
                blockedHint: conversation.blockedHint,
              }}
            />
          )}
        </main>

        {layout.rightPaneVisible && rightPane !== null && (
          <TargetRightPane
            kind={rightPane}
            onClose={closeRightPane}
            citationPreview={citationPreview}
            sourceId={sourcePreviewId}
            sessions={conversation.sessions}
            activeRef={conversation.activeRef}
            onOpenSession={conversation.openSession}
            onNewSession={() => void conversation.newSession()}
            canPinSingleSource={conversation.canPinSingleSource}
            onAskThisSource={(sourceId) => {
              if (conversation.pinSingleSource(sourceId)) closeRightPane()
            }}
            jobs={jobsController.jobs}
          />
        )}
      </div>

      {/* 面板打开/关闭播报（不打断焦点；标题随面板切换） */}
      <p role="status" aria-live="polite" className="sr-only" data-testid="rdlens-target-pane-live">
        {paneTitle === null ? '' : t('research.target.rightPane.openedLive', { title: paneTitle })}
      </p>
    </div>
  )
}
