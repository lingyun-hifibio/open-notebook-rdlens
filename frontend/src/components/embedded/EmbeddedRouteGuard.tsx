'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { isEmbeddedMode } from '@/lib/embedded/config'
import { embeddedRedirectTarget } from '@/lib/embedded/routes'

/**
 * 嵌入式模式非 research 路由禁用矩阵守卫（UI-02，REQ-SCOPE-03，设计
 * §2.2/§15.2）：挂载后若处于嵌入式模式且当前路径不在 /research 工作台，
 * 立即重定向回 /research。渲染 null，不产生 UI。
 *
 * 放置在 dashboard 布局与 login 页，覆盖全部上游路由（Notebook/设置/
 * Search/Podcast/Sources/Transformations/认证）。
 */
export function EmbeddedRouteGuard(): null {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (isEmbeddedMode()) {
      const target = embeddedRedirectTarget(pathname)
      if (target !== null) {
        router.replace(target)
      }
    }
  }, [pathname, router])

  return null
}
