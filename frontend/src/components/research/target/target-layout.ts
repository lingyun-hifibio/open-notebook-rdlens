/**
 * 目标工作台布局纯函数（W1 #1104；UI 规格 v1 §3 尺寸/断点/布局）。
 *
 * 断点判定与布局推导全部是纯函数：不读 window/媒体查询，便于单测与
 * 验收时按视口宽度断言。组件层用 `useMediaQuery('(min-width: 1280px)')`
 * 判定断点后调用 `resolveTargetLayout`。
 *
 * 规格依据：
 * - §3.1：<1024 不设计；1024–1279 两栏＋右栏打开时**替换左栏**；
 *   ≥1280 三栏；≥1600 固定侧栏、正文列限宽居中。
 * - §3.3：中央列宽 = 视口宽 − 左栏（若显示）− 右栏（若打开）；中央列最小
 *   可读宽度 640px；三栏阈值 = 282 + 640 + 355 = 1277 → 1280。
 */

/** §3.2 左资料栏宽度（UI-04，固定）。 */
export const TARGET_LEFT_PANE_WIDTH = 282
/** §3.2 右栏宽度（UI-12，固定）。 */
export const TARGET_RIGHT_PANE_WIDTH = 355
/** §3.3 中央列最小可读宽度。 */
export const TARGET_CENTER_MIN_WIDTH = 640
/** §3.1/§3.3 三栏断点：282 + 640 + 355 = 1277，向上取 1280。 */
export const TARGET_THREE_COLUMN_VIEWPORT = 1280
/** §3.1 目标壳最低设计宽度（<1024 不设计）。 */
export const TARGET_MIN_VIEWPORT = 1024

/** 断点：compact = 1024–1279（右栏打开时左栏临时收起）；wide = ≥1280（三栏）。 */
export type TargetBreakpoint = 'compact' | 'wide'

export interface TargetLayoutInput {
  breakpoint: TargetBreakpoint
  /** 右栏是否打开（UI-12 一次一项；默认收起） */
  rightPaneOpen: boolean
  /**
   * 实际视口宽度（CSS px）。缺省时按断点最小视口（1024 / 1280）推导，
   * 供纯函数测试与 SSR 首帧使用；组件传入真实 `window.innerWidth` 以在
   * 1440 等宽视口得到正确的中央列宽度（F19）。
   */
  viewportWidth?: number
}

export interface TargetLayout {
  breakpoint: TargetBreakpoint
  /** 左资料栏是否显示（compact + 右栏打开 → 临时收起，状态保留） */
  leftPaneVisible: boolean
  /** 左栏是否因右栏打开被临时收起（关闭右栏后恢复，§5.6） */
  leftPaneTemporarilyCollapsed: boolean
  /** 右栏是否显示 */
  rightPaneVisible: boolean
  /** 由规格推导的中央列可用宽度（含中央列最小宽兜底） */
  centerColumnWidth: number
  /** 中央列是否达到最小可读宽度（未达时不做三栏/不裁切正文） */
  centerColumnMinMet: boolean
  /**
   * §3.3：compact 且右栏打开时，composer 显示当前范围紧凑标签
   * （点击关闭右栏并聚焦左栏）。
   */
  composerShowsCompactScope: boolean
}

/** 视口宽度 → 断点；<1280 一律 compact（<1024 不在本轮设计范围）。 */
export function targetBreakpointForWidth(viewportWidth: number): TargetBreakpoint {
  return viewportWidth >= TARGET_THREE_COLUMN_VIEWPORT ? 'wide' : 'compact'
}

/**
 * 布局推导。
 *
 * - compact + 右栏打开：左栏收起（不占宽度），右栏 355，中央自适应；
 * - compact + 右栏关闭 / wide 任意：左栏显示（wide 右栏打开时三栏并排）。
 */
export function resolveTargetLayout(input: TargetLayoutInput): TargetLayout {
  const { breakpoint, rightPaneOpen } = input
  const leftPaneTemporarilyCollapsed = breakpoint === 'compact' && rightPaneOpen
  const leftPaneVisible = !leftPaneTemporarilyCollapsed
  const rightPaneVisible = rightPaneOpen
  const viewport =
    input.viewportWidth !== undefined && Number.isFinite(input.viewportWidth) && input.viewportWidth > 0
      ? input.viewportWidth
      : breakpoint === 'wide'
        ? TARGET_THREE_COLUMN_VIEWPORT
        : TARGET_MIN_VIEWPORT
  const available =
    viewport -
    (leftPaneVisible ? TARGET_LEFT_PANE_WIDTH : 0) -
    (rightPaneVisible ? TARGET_RIGHT_PANE_WIDTH : 0)
  const centerColumnWidth = Math.max(available, TARGET_CENTER_MIN_WIDTH)
  return {
    breakpoint,
    leftPaneVisible,
    leftPaneTemporarilyCollapsed,
    rightPaneVisible,
    centerColumnWidth,
    centerColumnMinMet: available >= TARGET_CENTER_MIN_WIDTH,
    composerShowsCompactScope: breakpoint === 'compact' && rightPaneOpen,
  }
}

// ---------------------------------------------------------------------------
// W2 #1077：宽屏阅读器（focus view）尺寸/断点（UI 规格 v1 §3.2/§5.7；
// 合并计划 issue1077 §2.3/§2.10-4）。
//
// 与 shell 布局一致：判定全部是纯函数（组件传入真实 viewport 宽度），
// 保证 1440 正文 830 + aside 340、1024 aside 默认折叠且正文占满可用宽度，
// 任何视口都不产生整页横向滚动（正文列 + aside 列 ≤ 视口宽度）。
// ---------------------------------------------------------------------------

/** §5.7 返回条高度（固定 65px）。 */
export const TARGET_READER_BACK_BAR_HEIGHT = 65
/** §5.7 正文列最大宽度（居中）。 */
export const TARGET_READER_BODY_MAX_WIDTH = 830
/** §5.7 aside 宽度区间下限（300–380px）。 */
export const TARGET_READER_ASIDE_MIN_WIDTH = 300
/** §5.7 aside 宽度区间上限。 */
export const TARGET_READER_ASIDE_MAX_WIDTH = 380
/** §5.7 aside 固定宽度（≥1280 视口恒显示 340px）。 */
export const TARGET_READER_ASIDE_WIDTH = 340
/** §5.7 aside 折叠断点：<1280 默认折叠为可展开开关。 */
export const TARGET_READER_ASIDE_BREAKPOINT = 1280

export interface TargetReaderLayoutInput {
  /** 实际视口宽度（CSS px）；非法/缺失按 1024 处理。 */
  viewportWidth: number
  /** 用户是否展开 aside（仅 <1280 有意义；≥1280 恒显示）。 */
  asideExpanded: boolean
}

export interface TargetReaderLayout {
  /** <1280 → true（aside 可折叠，默认收起） */
  asideCollapsible: boolean
  /** aside 是否显示：≥1280 恒 true；<1280 由展开态决定 */
  asideVisible: boolean
  /** aside 宽度（固定 340，落在 300–380 区间内） */
  asideWidth: number
  /** 正文列最大宽度（830） */
  bodyMaxWidth: number
  /**
   * 正文列可用宽度 = min(830, 视口 − aside（若显示）)。
   *
   * 展开 aside 时正文**让宽**（不覆盖正文、不横向滚动）。
   */
  bodyColumnWidth: number
}

/** 视口宽度归一：非法/缺失（NaN/Infinity/≤0）按 1024 处理。 */
function normalizeReaderViewport(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return TARGET_MIN_VIEWPORT
  }
  return viewportWidth
}

/**
 * §5.7 宽屏阅读器布局推导。
 *
 * - `asideCollapsible`：视口 <1280 时 aside 默认折叠（可展开）；
 * - `asideVisible`：≥1280 恒显示；<1280 只在展开时显示；
 * - `bodyColumnWidth`：aside 可见时正文让出 340px，上限 830；
 *   两者之和恒 ≤ 视口宽度（不产生整页横向滚动）。
 */
export function resolveTargetReaderLayout(
  input: TargetReaderLayoutInput,
): TargetReaderLayout {
  const viewportWidth = normalizeReaderViewport(input.viewportWidth)
  const asideCollapsible = viewportWidth < TARGET_READER_ASIDE_BREAKPOINT
  const asideVisible = !asideCollapsible || input.asideExpanded === true
  const asideWidth = TARGET_READER_ASIDE_WIDTH
  const bodyMaxWidth = TARGET_READER_BODY_MAX_WIDTH
  const available = viewportWidth - (asideVisible ? asideWidth : 0)
  return {
    asideCollapsible,
    asideVisible,
    asideWidth,
    bodyMaxWidth,
    bodyColumnWidth: Math.min(bodyMaxWidth, Math.max(available, 0)),
  }
}

// ---------------------------------------------------------------------------
// W3 #1191：目标壳宽屏 Markdown 编辑器（focus view）尺寸/断点（UI 规格 v1
// §3.2/§5.8 UI-19；实施计划 §2.1.3）。
//
// 与 W2 阅读器同一模式：判定全部是纯函数（组件传入真实 viewport 宽度），
// 保证 1440 正文 970 + aside 330 = 1300 居中；1024–1279 aside 默认折叠、
// 展开时正文让宽；任何视口都不产生整页横向滚动（正文列 + aside ≤ 视口宽度）。
// ---------------------------------------------------------------------------

/** UI-19 正文列最大宽度（§3.2；居中）。 */
export const TARGET_EDITOR_BODY_MAX_WIDTH = 970
/** UI-19 aside 固定宽度（§3.2）。 */
export const TARGET_EDITOR_ASIDE_WIDTH = 330
/** UI-19 返回条高度（沿用 UI-18 阅读器 65px 先例；UI-19 未单独规定）。 */
export const TARGET_EDITOR_BACK_BAR_HEIGHT = 65
/** UI-19 aside 折叠断点：<1280 默认折叠为可展开开关。 */
export const TARGET_EDITOR_ASIDE_BREAKPOINT = 1280

export interface TargetEditorLayoutInput {
  /** 实际视口宽度（CSS px）；非法/缺失按 1024 处理。 */
  viewportWidth: number
  /** 用户是否展开 aside（仅 <1280 有意义；≥1280 恒显示）。 */
  asideExpanded: boolean
}

export interface TargetEditorLayout {
  /** <1280 → true（aside 可折叠，默认收起） */
  asideCollapsible: boolean
  /** aside 是否显示：≥1280 恒 true；<1280 由展开态决定 */
  asideVisible: boolean
  /** aside 宽度（固定 330） */
  asideWidth: number
  /** 正文列最大宽度（970） */
  bodyMaxWidth: number
  /**
   * 正文列可用宽度 = min(970, 视口 − aside（若显示）)。
   *
   * 展开 aside 时正文**让宽**（不覆盖正文、不横向滚动）。
   */
  bodyColumnWidth: number
}

/** 视口宽度归一：非法/缺失（NaN/Infinity/≤0）按 1024 处理。 */
function normalizeEditorViewport(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return TARGET_MIN_VIEWPORT
  }
  return viewportWidth
}

/**
 * UI-19 编辑器 overlay 布局推导。
 *
 * - `asideCollapsible`：视口 <1280 时 aside 默认折叠（可展开）；
 * - `asideVisible`：≥1280 恒显示；<1280 只在展开时显示；
 * - `bodyColumnWidth`：aside 可见时正文让出 330px，上限 970；
 *   两者之和恒 ≤ 视口宽度（不产生整页横向滚动）。
 */
export function resolveTargetEditorLayout(
  input: TargetEditorLayoutInput,
): TargetEditorLayout {
  const viewportWidth = normalizeEditorViewport(input.viewportWidth)
  const asideCollapsible = viewportWidth < TARGET_EDITOR_ASIDE_BREAKPOINT
  const asideVisible = !asideCollapsible || input.asideExpanded === true
  const asideWidth = TARGET_EDITOR_ASIDE_WIDTH
  const bodyMaxWidth = TARGET_EDITOR_BODY_MAX_WIDTH
  const available = viewportWidth - (asideVisible ? asideWidth : 0)
  return {
    asideCollapsible,
    asideVisible,
    asideWidth,
    bodyMaxWidth,
    bodyColumnWidth: Math.min(bodyMaxWidth, Math.max(available, 0)),
  }
}
