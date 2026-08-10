/**
 * 嵌入式模式非 research 路由禁用矩阵（UI-02，REQ-SCOPE-03，设计 §2.2、
 * §15.2）。
 *
 * 后端 SPK-03 的 `EmbeddedScopeMiddleware` 已对非研究 API 一律 403；
 * 本模块是前端导航层的第二道防线：嵌入式模式下浏览器只允许落在
 * `/research` 工作台，其余上游路由（全局 Notebook、认证、设置、
 * Podcast、Search、Sources、Transformations…）由布局守卫重定向回
 * `/research`。纯函数，可直接单元测试。
 */

/** 仅 `/research` 及其子路径属于嵌入式工作台。 */
export function isResearchPath(pathname: string): boolean {
  return pathname === '/research' || pathname.startsWith('/research/')
}

/**
 * 嵌入式禁用矩阵：非 research 路径返回重定向目标 `/research`；
 * research 路径返回 null（不重定向）。
 */
export function embeddedRedirectTarget(pathname: string): string | null {
  return isResearchPath(pathname) ? null : '/research'
}
