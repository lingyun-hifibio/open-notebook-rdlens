/**
 * /research 页面模式判定（W1 #1104，UI 规格 §5.10 / BEH-13）。
 *
 * 目标壳为默认入口；旧壳只在宿主经 iframe URL 显式带 `legacy=1` 时渲染
 * （D-UI-05：过渡期旧壳仅作回归/回退，不新增能力）。本模块为纯函数，
 * 不触碰 window/DOM，便于单测。
 *
 * URL 读取是 **client-only**：真实宿主以 iframe src 查询参数下发；服务端
 * 首屏不参与该判定（shell 在认证前只渲染加载态，不产生水合差异）。
 */

export const LEGACY_SHELL_PARAM = 'legacy'

export type ResearchPageMode = 'target' | 'legacy'

/** 只接受 `legacy=1`（`0`/空/缺省一律目标壳）；容忍 `?legacy=1&other`。 */
export function isLegacyShellRequested(search: string): boolean {
  if (typeof search !== 'string' || search.length === 0) return false
  try {
    // 防御：调用方误传完整 URL 片段时去掉 hash（location.search 本身不含）。
    const query = search.split('#')[0]
    return new URLSearchParams(query).get(LEGACY_SHELL_PARAM) === '1'
  } catch {
    return false
  }
}

/** 浏览器当前 location 的查询串（SSR/非浏览器环境返回空串 = 目标壳）。 */
export function currentLegacyShellRequest(): boolean {
  if (typeof window === 'undefined') return false
  return isLegacyShellRequested(window.location.search)
}

/** 页面模式：legacy=1 → 旧壳；否则目标壳（默认）。 */
export function resolveResearchPageMode(legacyRequested: boolean): ResearchPageMode {
  return legacyRequested ? 'legacy' : 'target'
}
