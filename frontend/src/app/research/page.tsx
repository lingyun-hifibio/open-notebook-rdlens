'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ResearchWorkspaceShell } from '@/lib/embedded/shell'
import { isEmbeddedMode } from '@/lib/embedded/config'
import { getResearchProjectId } from '@/lib/research/project'
import { useIsDesktop } from '@/lib/hooks/use-media-query'
import { ResearchJobsProvider } from '@/components/research/ResearchJobsProvider'
import { ResearchHeader } from '@/components/research/ResearchHeader'
import { ResearchEgressConsentDialog } from '@/components/research/ResearchEgressConsentDialog'
import { ResearchWorkbench } from '@/components/research/ResearchWorkbench'
import { ResearchWorkspace } from '@/components/research/ResearchWorkspace'
import { ResearchSourceChatPanel } from '@/components/research/ResearchSourceChatPanel'
import { ResearchLayout } from '@/components/research/ResearchLayout'
import {
  ResearchSessionSwitcher,
  RESEARCH_SESSION_SWITCHER_PLACEHOLDERS,
} from '@/components/research/ResearchSessionSwitcher'
import { type ResearchMainAction } from '@/components/research/research-main-action'
import { useTranslation } from '@/lib/hooks/use-translation'
import { translateOrFallback } from '@/lib/locales/translate-or-fallback'
import { useResearchSessionRuntimeOptional } from '@/lib/hooks/research-session-runtime'
import { useResearchSessions } from '@/lib/hooks/use-research-sessions'
import { readDisplayPointer, readPointer } from '@/lib/research/session-cache'
import type { SessionRuntimeSnapshot } from '@/lib/research/session-runtime'
import { sessionRefEquals, type ResearchSessionRef } from '@/lib/research/session-contract'

/**
 * /research：嵌入式 Research Workspace 入口路由（UI-01，设计 §4.1；RWV2-40 IA）。
 *
 * RWV2-40（Fork #44）目标 IA；RWV2-UIOPT-A（fork #57）收敛：
 * - Header：Current scope（左） | Global model | Activity | Export（右，
 *   ml-auto 聚合）；技术 Project 段删除（可读项目名称由 RDLens 父页面展示）。
 * - 左栏（ResearchWorkbench）：Materials(Sources, Notes) / Results(Insights,
 *   Transformation runs 插槽)；Tools/Research templates 跨区快捷入口删除，
 *   模板唯一正式入口是主区 Custom Analysis 动作。
 * - 主区（ResearchWorkspace）：Evidence Search / Research Chat / Compare /
 *   Mind Map（占位）/ Custom Analysis 五动作（#445）；Jobs 迁往 Header
 *   Activity 兼容壳。
 * - 组合根同时保活「全局工作区」与「单个创建过的 Source Chat」：显隐只由
 *   `sourceFocusActive` 决定（Back 仅退出 focus，Source Chat 隐藏保留；
 *   A→B 用 projectId:sourceId key 隔离）。唯一 keyed Source Chat、访问便
 *   Back/Source focus 的 highlight 时序与 Citation 跳转语义与 Issue #182
 *   保持一致组件能力。
 *
 * 状态划分（冻结）：
 * - 组合根持有 `activeMainAction`；保活 visited 集合由 ResearchWorkspace
 *   内部维护并以渲染期并集（visited∪{active}）保证首访动作同帧挂载；
 * - highlightPageIdx/highlightRequestId 线程保留（同页重复 Citation 再次聚焦）；
 * - 根级 handleEditScopeAllStates/onCitationJump 统一链。
 *
 * 第三批 PR-2（DESIGN §4.2–§4.5、§9.6）：页面级会话导航只能挂载在
 * `ResearchWorkspaceShell` 的后代——真实 `ResearchSessionRuntimeProvider`
 * 位于 Shell 内部（`src/lib/embedded/shell.tsx`），页面自身在其之上。
 * 因此导航 hooks 全部放进 `ResearchPageContent`（Shell children 内），
 * 否则 `useResearchSessionRuntimeOptional()` 恒为 null（Codex review B1）。
 */
export default function ResearchPage() {
  const router = useRouter()

  useEffect(() => {
    if (!isEmbeddedMode()) {
      router.replace('/notebooks')
    }
  }, [router])

  if (!isEmbeddedMode()) {
    return null
  }

  return (
    // Issue #243 GMOD-FE-01 §6.2：页面根 h-screen flex-col；Header shrink-0，
    // ResearchLayout min-h-0 flex-1——不产生双滚动。
    <div className="flex h-screen flex-col">
      <ResearchWorkspaceShell>
        {/* Jobs 控制器唯一实例化点：Header Activity + 主区 Chat coverage/
            Compare 共享同一 3s 轮询与 localStorage 登记 */}
        <ResearchJobsProvider>
          <ResearchPageContent />
        </ResearchJobsProvider>
      </ResearchWorkspaceShell>
    </div>
  )
}

function ResearchPageContent() {
  const { t } = useTranslation()

  // 主区当前动作（组合根受控；保活的 visited 集合由 ResearchWorkspace
  // 内部维护——渲染期并集 visited∪{active} 保证首访动作同帧挂载）
  const [activeMainAction, setActiveMainAction] =
    useState<ResearchMainAction>('evidence-search')

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  // Source 专注态与“已选中来源”分离：Back 只清 focus，不丢唯一 Source Chat。
  const [sourceFocusActive, setSourceFocusActive] = useState(false)
  const [highlightPageIdx, setHighlightPageIdx] = useState<number | null>(null)
  const [highlightRequestId, setHighlightRequestId] = useState(0)
  const [globalMaximized, setGlobalMaximized] = useState(false)
  const [scopeEditRequest, setScopeEditRequest] = useState(0)
  // RWV2-23（AC4/AC3）：Continue research 的 Chat 预填草稿 与保存后的左栏
  // pane reveal（seq 递增触发挂载/切换；与 scopeEditRequest 同一根级模式）。
  const [chatPrefill, setChatPrefill] = useState<{ text: string; seq: number } | null>(null)
  const [paneReveal, setPaneReveal] = useState<{
    pane: 'notes' | 'insights'
    artifactId: string
    seq: number
  } | null>(null)
  const isDesktop = useIsDesktop()
  const [globalCompactPanel, setGlobalCompactPanel] = useState<'primary' | 'secondary'>('secondary')
  const [sourceCompactPanel, setSourceCompactPanel] = useState<'primary' | 'secondary'>('primary')

  // ── 会话导航（PR-2；DESIGN §4.2–§4.5、§9.6） ──────────────────────────────
  // 页面级导航是 PR-2 的唯一入口（Lead 裁决 R1(a)：不改两个 Chat 面板）；
  // 三指针写入通过 PR-1 runtime/cache 完成：active(global)/active(source) 只写
  // 各自指针，display 指针只由显式导航/返回全局写入。
  const sessionRuntime = useResearchSessionRuntimeOptional()
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<SessionRuntimeSnapshot | null>(null)
  const [activeGlobalRef, setActiveGlobalRef] = useState<ResearchSessionRef | null>(null)
  const [activeSourceRef, setActiveSourceRef] = useState<ResearchSessionRef | null>(null)
  // F-M3（Lead 裁决 R3）：页面级独立 state 表达“该来源新会话”（display
  // `{surface:'source', sourceId, sessionRef:null}`）。该状态下不写 `.source`、
  // 不清 runtime active，也不把旧 `.source` 指针恢复成活动会话。
  const [sourceNewSessionFor, setSourceNewSessionFor] = useState<string | null>(null)
  const restoredIdentityRef = useRef<string | null>(null)
  // display 指针已恢复过某来源的具体会话：紧接着的“打开来源”effect 不得用
  // 旧 `.source` 指针覆盖它（display 是刷新显示权威，§4.5）。
  const restoredSourceGuardRef = useRef<string | null>(null)
  // 该来源已完成的 runtime/display 同步（避免快照变化反复写指针）。
  const syncedSourceRef = useRef<string | null>(null)
  // 显式打开来源（含 Back 后重开同一来源）的请求序号：syncedSourceRef 按
  // sourceId 短路会让“重开同一来源”不再同步 runtime/display（R3）。
  const [sourceOpenRequest, setSourceOpenRequest] = useState(0)

  useEffect(() => {
    if (!sessionRuntime) {
      setRuntimeSnapshot(null)
      return
    }
    setRuntimeSnapshot(sessionRuntime.getSnapshot())
    return sessionRuntime.subscribe(() => setRuntimeSnapshot(sessionRuntime.getSnapshot()))
  }, [sessionRuntime])

  // 项目级“历史”抽屉使用 `kind=all`（DESIGN §4.1：项目级历史聚合 global +
  // source）；代码级 `kind=global` 仅用于单 surface 列表，页面历史入口必须
  // 能列出 source 会话（Codex review B6）。
  const globalSessions = useResearchSessions({
    runtime: sessionRuntime,
    surface: 'global',
    projectHistory: true,
  })
  const sourceSessions = useResearchSessions({
    runtime: sessionRuntime,
    surface: 'source',
    sourceId: selectedSourceId,
  })

  // S1：viewer/authGeneration/project/role 变化 → 同帧隐藏并清空页面导航 state
  // （列表缓存在 use-research-sessions 内同步清空），绝不沿用上一身份标识。
  const identityKey = runtimeSnapshot
    ? `${runtimeSnapshot.role}|${runtimeSnapshot.viewerUserId ?? ''}|${runtimeSnapshot.projectId}|${runtimeSnapshot.authGeneration}`
    : null
  // 导航 state 归属的身份键：不一致的那一帧起就用派生空值渲染，effect 再清理。
  const [navScopeKey, setNavScopeKey] = useState<string | null>(identityKey)
  const navScopeMatches = navScopeKey === identityKey
  const navActiveGlobalRef = navScopeMatches ? activeGlobalRef : null
  const navActiveSourceRef = navScopeMatches ? activeSourceRef : null
  const navSourceNewSessionFor = navScopeMatches ? sourceNewSessionFor : null
  const navSelectedSourceId = navScopeMatches ? selectedSourceId : null
  const navSourceFocusActive = navScopeMatches ? sourceFocusActive : false

  useEffect(() => {
    if (navScopeMatches) return
    setActiveGlobalRef(null)
    setActiveSourceRef(null)
    setSourceNewSessionFor(null)
    setSelectedSourceId(null)
    setSourceFocusActive(false)
    restoredIdentityRef.current = null
    restoredSourceGuardRef.current = null
    syncedSourceRef.current = null
    setNavScopeKey(identityKey)
  }, [identityKey, navScopeMatches])

  // 刷新/重开恢复（§4.5）：只有拿到 cacheScope/cacheAuthority（owner + viewer
  // 已确认）后才读指针。display 有具体 ref 时是显示权威；display
  // `source + null` 是“该来源新会话”（F-M3），不得回退成 `.source` 旧指针。
  useEffect(() => {
    if (!sessionRuntime) return
    const snapshot = sessionRuntime.getSnapshot()
    if (snapshot.phase !== 'ready') return
    const scope = sessionRuntime.cacheScope()
    const authority = sessionRuntime.cacheAuthority()
    if (!scope || !authority) return
    const identity = `${snapshot.role}|${snapshot.viewerUserId ?? ''}|${snapshot.projectId}|${snapshot.authGeneration}`
    if (restoredIdentityRef.current === identity) return
    restoredIdentityRef.current = identity

    const display = readDisplayPointer(scope, authority)
    const globalPointer = readPointer(scope, authority, 'global', null)
    const displayGlobal = display?.surface === 'global' ? display.ref : undefined
    // PR-11（P0 刷新恢复）：恢复是**读 + 重建 runtime active**，不只是页面
    // state。display 优先、其次 `.global` 指针；只有该 surface 的 active 被
    // 重建后，workspace 才能建 editor/controller 继续发送，后续 navScope/清理
    // 也不会把页面 state 抹掉。source 显示时同样重建（三指针独立，§4.5）。
    const restoredGlobalRef = displayGlobal !== undefined ? displayGlobal : globalPointer?.ref ?? null
    setActiveGlobalRef(restoredGlobalRef)
    // 幂等：navScope/身份清理会让本 effect 再跑一次，bootstrap 也可能已从
    // 指针恢复同一会话；runtime 内已是同一活动会话时不再重复写指针。
    if (
      restoredGlobalRef !== null &&
      !sessionRefEquals(sessionRuntime.active('global'), restoredGlobalRef)
    ) {
      // 校验失败（项目/kind 与当前身份不符）保持既有语义：不清指针、不写
      // display，也不把 runtime active 强行改成别的会话（400/降级由后续导航
      // 与列表 404 分支处理）。
      sessionRuntime.activate('global', restoredGlobalRef)
    }

    if (display?.surface === 'source') {
      setSelectedSourceId(display.sourceId)
      setSourceFocusActive(true)
      syncedSourceRef.current = display.sourceId
      if (display.ref) {
        restoredSourceGuardRef.current = display.sourceId
        setActiveSourceRef(display.ref)
        setSourceNewSessionFor(null)
        sessionRuntime.activate('source', display.ref)
      } else {
        // 该来源新会话：不写 `.source`、不清 runtime active、不激活会话。
        setActiveSourceRef(null)
        setSourceNewSessionFor(display.sourceId)
      }
      return
    }
    setSourceNewSessionFor(null)
    if (display?.surface === 'global') setSourceFocusActive(false)
  }, [sessionRuntime, runtimeSnapshot])

  // 打开某个来源（Citation/工作台/抽屉）时同步该来源的 runtime active 与
  // display 指针（§4.5：打开来源即显示切换；先 focus 后激活）；`.source`
  // 指针存在时恢复它，否则进入“该来源新会话”状态（F-M3，不写 `.source`）。
  useEffect(() => {
    if (!sessionRuntime || !navSelectedSourceId) return
    // 只有 Source surface 真正显示时才同步该来源的 active/display。否则
    // `activate('global', …)` 触发的 runtime 通知会让本 effect 在“全局已显示”
    // 时重新恢复来源并覆盖 display（R3 回归：source→global→source）。
    if (!navSourceFocusActive) return
    // 离开该来源后遗留的 display 恢复 guard 不得跳过下一次显式打开（R3）。
    if (
      restoredSourceGuardRef.current !== null &&
      restoredSourceGuardRef.current !== navSelectedSourceId
    ) {
      restoredSourceGuardRef.current = null
    }
    if (syncedSourceRef.current === navSelectedSourceId) return
    const snapshot = sessionRuntime.getSnapshot()
    if (snapshot.phase !== 'ready') return
    if (navSourceNewSessionFor === navSelectedSourceId) {
      syncedSourceRef.current = navSelectedSourceId
      return
    }
    const scope = sessionRuntime.cacheScope()
    const authority = sessionRuntime.cacheAuthority()
    if (!scope || !authority) return
    if (restoredSourceGuardRef.current === navSelectedSourceId) {
      // display 已恢复该来源具体会话：保留 display 的显示权威。
      restoredSourceGuardRef.current = null
      syncedSourceRef.current = navSelectedSourceId
      return
    }
    const pointer = readPointer(scope, authority, 'source', navSelectedSourceId)
    syncedSourceRef.current = navSelectedSourceId
    if (pointer?.ref) {
      const accepted = sessionRuntime.activate('source', pointer.ref)
      if (accepted) {
        setActiveSourceRef(pointer.ref)
        setSourceNewSessionFor(null)
        sessionRuntime.setDisplayPointer({
          version: 1,
          surface: 'source',
          sourceId: navSelectedSourceId,
          ref: pointer.ref,
        })
      }
      return
    }
    setActiveSourceRef(null)
    setSourceNewSessionFor(navSelectedSourceId)
    sessionRuntime.setDisplayPointer({
      version: 1,
      surface: 'source',
      sourceId: navSelectedSourceId,
      ref: null,
    })
  }, [
    sessionRuntime,
    runtimeSnapshot,
    navSelectedSourceId,
    navSourceNewSessionFor,
    sourceOpenRequest,
    navSourceFocusActive,
  ])

  // 列表返回 404 `session_not_found`（§4.1 / §4.7）：清该 surface 指针并显示
  // 空态；本机草稿由 PR-3 的草稿分区各自保留，不在本 PR 注入其他会话。
  useEffect(() => {
    if (!sessionRuntime) return
    if (globalSessions.error !== 'not_found') return
    sessionRuntime.activate('global', null)
    setActiveGlobalRef(null)
    // R7：global 列表 404 只清 global active/指针；若用户正在看 source，
    // 不得把 display 改写成 global（刷新位置会被意外改变）。
    if (!(navSourceFocusActive && navSelectedSourceId !== null)) {
      sessionRuntime.setDisplayPointer({ version: 1, surface: 'global', ref: null })
    }
  }, [globalSessions.error, sessionRuntime, navSourceFocusActive, navSelectedSourceId])

  // 页面级导航（§9.6 / §4.2-1）：source 会话先进入该来源 Source focus，再
  // 激活该 surface 会话；global 会话返回全局 surface。activate 同时校验
  // project/kind/sourceId 并写 surface 独立指针；只有校验通过（S4）才写
  // display 指针。任一 surface 的切换都不动另一 surface 的活动会话。
  const openSession = useCallback(
    (ref: ResearchSessionRef) => {
      if (ref.kind === 'source') {
        if (!ref.sourceId) return
        // 先切 Source focus（页面导航顺序），再激活该 surface 会话（§4.2-1）。
        setSelectedSourceId(ref.sourceId)
        setSourceFocusActive(true)
        setSourceNewSessionFor(null)
        restoredSourceGuardRef.current = null
        syncedSourceRef.current = ref.sourceId
        if (sessionRuntime) {
          const accepted = sessionRuntime.activate('source', ref)
          if (!accepted) return
          sessionRuntime.setDisplayPointer({
            version: 1,
            surface: 'source',
            sourceId: ref.sourceId,
            ref,
          })
        }
        setActiveSourceRef(ref)
        return
      }
      setSourceFocusActive(false)
      // R3：返回全局后同一来源再次被打开时必须重新同步 runtime/display。
      syncedSourceRef.current = null
      restoredSourceGuardRef.current = null
      if (sessionRuntime) {
        const accepted = sessionRuntime.activate('global', ref)
        if (!accepted) return
        sessionRuntime.setDisplayPointer({ version: 1, surface: 'global', ref })
      }
      setActiveGlobalRef(ref)
    },
    [sessionRuntime],
  )

  // 新对话（§4.3）：显式触发、single-flight；成功后激活为当前会话；editor
  // 初始化留 PR-3（本 PR 不产生消息、不建空壳列表项）。
  const createGlobalSession = globalSessions.create
  const createSourceSession = sourceSessions.create

  const handleNewGlobalSession = useCallback(async () => {
    const created = await createGlobalSession()
    if (created) openSession(created.ref)
  }, [createGlobalSession, openSession])

  const handleNewSourceSession = useCallback(async () => {
    const created = await createSourceSession()
    if (created) openSession(created.ref)
  }, [createSourceSession, openSession])

  // Edit scope 统一链路（R8-3）：退 Source focus → 退最大化 → 回左栏编辑面 →
  // 递增聚焦请求。Header ScopeSummary / Run Template Dialog 共用本入口。
  const handleEditScopeAllStates = useCallback(() => {
    setSourceFocusActive(false)
    setGlobalMaximized(false)
    setScopeEditRequest((request) => request + 1)
  }, [])

  const activateAction = useCallback((action: ResearchMainAction) => {
    setActiveMainAction(action)
  }, [])

  // RWV2-23（AC4）：Continue research → 归一布局并切到 Chat，预填可编辑草稿
  // （不自动派发；Send 仍走既有 runGuarded + 当前 Scope 快照）。
  const openResearchChatDraft = useCallback((text: string) => {
    setSourceFocusActive(false)
    setGlobalMaximized(false)
    setActiveMainAction('research-chat')
    setChatPrefill((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  // RWV2-23（AC3）：保存成功 → 左栏 Reveal 到 Notes/Insights 并高亮目标行。
  const revealSavedArtifact = useCallback((kind: 'note' | 'insight', artifactId: string) => {
    setSourceFocusActive(false)
    setGlobalMaximized(false)
    setPaneReveal((prev) => ({
      pane: kind === 'note' ? 'notes' : 'insights',
      artifactId,
      seq: (prev?.seq ?? 0) + 1,
    }))
  }, [])

  // 选中来源（列表/跨区 Citation）→ 进入 Source focus（左栏 Back+详情，右栏
  // Source Chat）；默认重置高亮，显式 pageIdx 时递增请求序号（防泄漏+同页重跳）。
  const openSource = useCallback((sourceId: string, pageIdx?: number | null) => {
    setSelectedSourceId(sourceId)
    setSourceFocusActive(true)
    // 显式打开（含关闭后重开同一来源）：强制重新同步该来源 runtime/display（R3）。
    syncedSourceRef.current = null
    restoredSourceGuardRef.current = null
    setSourceNewSessionFor(null)
    setSourceOpenRequest((request) => request + 1)
    setSourceCompactPanel('primary')
    const nextHighlight = pageIdx ?? null
    setHighlightPageIdx(nextHighlight)
    if (nextHighlight !== null) {
      setHighlightRequestId((requestId) => requestId + 1)
    }
  }, [])

  // Back：仅退出 Source focus（Source Chat 保活隐藏，不卸载）。返回全局时
  // 只把 display 更新为 `{surface:'global', sessionRef:active('global')}`，
  // 来源指针保留、且不清 active('global')（§4.5 返回全局）。
  const exitSourceFocus = useCallback(() => {
    setSourceFocusActive(false)
    // R3：Back 会改 display；下次打开来源必须重新同步，不能沿用旧标记。
    syncedSourceRef.current = null
    restoredSourceGuardRef.current = null
    if (sessionRuntime) {
      sessionRuntime.setDisplayPointer({
        version: 1,
        surface: 'global',
        ref: navActiveGlobalRef,
      })
    }
  }, [sessionRuntime, navActiveGlobalRef])

  // Source Chat 内 Citation → 只需高亮左栏详情（不改变选中/专注状态）。
  const handleHighlightPage = useCallback((pageIdx: number) => {
    setHighlightPageIdx(pageIdx)
    setHighlightRequestId((requestId) => requestId + 1)
    setSourceCompactPanel('primary')
  }, [])

  // 跨区 Citation（Workspace/Activity/Transformation 报告）→ 选源 + 高亮。
  const handleCitationJump = useCallback(
    (sourceId: string, pageIdx: number | null) => {
      if (pageIdx === null) {
        openSource(sourceId)
        return
      }
      openSource(sourceId, pageIdx)
    },
    [openSource],
  )

  const projectId = getResearchProjectId() ?? ''
  const sourceMode = navSourceFocusActive && navSelectedSourceId !== null
  const sourceDesktop = sourceMode && isDesktop
  const compact = !isDesktop
  const focusedSourceId = sourceMode ? navSelectedSourceId : null

  return (
    <>
      <ResearchHeader
        onEditScopeAllStates={handleEditScopeAllStates}
        onCitationJump={handleCitationJump}
      />
      {/* 根级统一外发确认（§6.8 single-flight） */}
      <ResearchEgressConsentDialog />
      <div className="flex min-h-0 flex-1 flex-col">
        {/* PR-2 页面级会话导航（Lead 裁决 R1(a)：不改两个 Chat 面板）。
            global 当前会话 / 历史抽屉 / 新对话；有选中来源时并列 Source
            会话导航；无来源时明确显示“先打开来源”的可见原因（S2）。 */}
        <div
          data-testid="research-session-nav"
          data-active-global-session={navActiveGlobalRef?.sessionId ?? undefined}
          data-active-source-session={navActiveSourceRef?.sessionId ?? undefined}
          data-source-new-session={navSourceNewSessionFor ?? undefined}
          className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2"
        >
          <ResearchSessionSwitcher
            surface="global"
            currentRef={navActiveGlobalRef}
            sessions={globalSessions}
            onOpenSession={openSession}
            onNew={handleNewGlobalSession}
          />
          {navSelectedSourceId !== null ? (
            <ResearchSessionSwitcher
              surface="source"
              sourceId={navSelectedSourceId}
              currentRef={navActiveSourceRef}
              sessions={sourceSessions}
              onOpenSession={openSession}
              onNew={handleNewSourceSession}
            />
          ) : (
            <span
              data-testid="source-session-unavailable"
              className="text-xs text-muted-foreground"
            >
              {translateOrFallback(
                t,
                'research.session.sourceRequired',
                RESEARCH_SESSION_SWITCHER_PLACEHOLDERS.sourceRequired,
              )}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1" data-testid="legacy-session-content">
          <ResearchLayout
            layoutId={sourceDesktop ? 'source-desktop' : 'global'}
            axis="horizontal"
            compact={compact}
            defaultRatio={sourceDesktop ? 55 : 35}
            minPrimary={sourceDesktop ? 360 : 280}
            minSecondary={sourceDesktop ? 360 : 420}
            primaryLabel={sourceMode ? t('research.layout.sourceContent') : t('research.layout.artifacts')}
            secondaryLabel={sourceMode ? t('research.layout.sourceChat') : t('research.layout.workspace')}
            separatorLabel={sourceMode ? t('research.layout.resizeSource') : t('research.layout.resizeWorkspace')}
            expandSecondaryLabel={sourceMode ? t('research.layout.expandSourceChat') : t('research.layout.expandWorkspace')}
            restoreLabel={t('research.layout.restore')}
            compactPrimaryLabel={sourceMode ? t('research.layout.content') : t('research.layout.artifacts')}
            compactSecondaryLabel={sourceMode ? t('research.layout.chat') : t('research.layout.workspace')}
            compactPanel={sourceMode ? sourceCompactPanel : globalCompactPanel}
            onCompactPanelChange={sourceMode ? setSourceCompactPanel : setGlobalCompactPanel}
            maximized={sourceDesktop ? undefined : globalMaximized}
            onMaximizedChange={sourceDesktop ? undefined : setGlobalMaximized}
          >
            {[
              <div key="workbench" className="h-full min-h-0 overflow-hidden">
                <ResearchWorkbench
                  focusedSourceId={focusedSourceId}
                  highlightPageIdx={highlightPageIdx}
                  highlightRequestId={highlightRequestId}
                  onOpenSource={openSource}
                  onExitSourceFocus={exitSourceFocus}
                  scopeEditRequest={scopeEditRequest}
                  onRevealSavedArtifact={revealSavedArtifact}
                  onOpenResearchChatDraft={openResearchChatDraft}
                  paneReveal={paneReveal}
                />
              </div>,
              <div
                key="workspace"
                className={`h-full min-h-0 ${compact ? '' : 'border-l'}`}
              >
                {/* 全局工作区保持挂载（隐藏但保活：Chat 流/Job 轮询/四动作
                    访问状态不丢）；Source Chat 也保持挂载，显隐由
                    sourceFocusActive 决定，Back 不卸载。 */}
                <div className="h-full" hidden={sourceMode}>
                  <ResearchWorkspace
                    activeAction={activeMainAction}
                    onActiveActionChange={activateAction}
                    surfaceActive={!sourceMode}
                    onCitationJump={handleCitationJump}
                    onEditScopeAllStates={handleEditScopeAllStates}
                    onOpenResearchChatDraft={openResearchChatDraft}
                    onRevealSavedArtifact={revealSavedArtifact}
                    chatPrefill={chatPrefill}
                  />
                </div>
                {navSelectedSourceId !== null && (
                  <div
                    className="h-full"
                    data-testid="source-chat-surface"
                    hidden={!sourceMode}
                  >
                    <ResearchSourceChatPanel
                      key={`${projectId}:${navSelectedSourceId}`}
                      projectId={projectId}
                      sourceId={navSelectedSourceId}
                      onHighlightPage={handleHighlightPage}
                    />
                  </div>
                )}
              </div>,
            ]}
          </ResearchLayout>
        </div>
      </div>
    </>
  )
}
