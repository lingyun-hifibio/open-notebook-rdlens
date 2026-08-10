import { describe, expect, it } from 'vitest'
import { embeddedRedirectTarget, isResearchPath } from './routes'

// UI-02 Red：嵌入式模式非 research 路由禁用矩阵（REQ-SCOPE-03/设计
// §2.2、§15.2）——嵌入式模式下浏览器只能落在 /research 工作台；全局
// Notebook、认证、设置、Podcast、Search、Sources、Transformations 等
// 上游路由一律重定向回 /research（后端 403 矩阵之外的前端导航层，
// 双重防线，禁止仅靠隐藏入口）。

describe('embedded route disable matrix', () => {
  it('isResearchPath：/research 及其子路径为 research 路径', () => {
    expect(isResearchPath('/research')).toBe(true)
    expect(isResearchPath('/research/')).toBe(true)
    expect(isResearchPath('/research/sources')).toBe(true)
  })

  it('isResearchPath：非 research 路径全部为 false', () => {
    expect(isResearchPath('/')).toBe(false)
    expect(isResearchPath('/notebooks')).toBe(false)
    expect(isResearchPath('/notebooks/abc')).toBe(false)
    expect(isResearchPath('/login')).toBe(false)
    expect(isResearchPath('/settings')).toBe(false)
    expect(isResearchPath('/sources')).toBe(false)
    expect(isResearchPath('/search')).toBe(false)
    expect(isResearchPath('/podcasts')).toBe(false)
    expect(isResearchPath('/transformations')).toBe(false)
    expect(isResearchPath('/api/config')).toBe(false)
  })

  it('禁用矩阵：非 research 路由一律重定向到 /research', () => {
    const nonResearch = [
      '/',
      '/login',
      '/notebooks',
      '/notebooks/nb_1',
      '/sources',
      '/sources/src_1',
      '/search',
      '/podcasts',
      '/transformations',
      '/advanced',
      '/settings',
      '/settings/api-keys',
      '/dev/design',
    ]
    for (const path of nonResearch) {
      expect(embeddedRedirectTarget(path)).toBe('/research')
    }
  })

  it('research 路径不做重定向（返回 null）', () => {
    expect(embeddedRedirectTarget('/research')).toBeNull()
    expect(embeddedRedirectTarget('/research/sources')).toBeNull()
  })

  it('守卫只接收 pathname（Next.js usePathname 不含 query）；/research 根路径即放行', () => {
    // 防御性记录：query 不属于 pathname 契约，守卫无需解析
    expect(embeddedRedirectTarget('/settings')).toBe('/research')
    expect(isResearchPath('/research')).toBe(true)
  })
})
