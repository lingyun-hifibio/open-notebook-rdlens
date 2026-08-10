'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useTranslation } from '@/lib/hooks/use-translation'

/**
 * Admin 只读横幅（UI-02，设计 §4.4 权限矩阵，REQ-AUTH-04）。
 *
 * Admin（admin_readonly 角色）在工作台顶部看到只读提示：研究产物不可
 * 创建/编辑/运行，查看与导出可用。角色来自 Token claims（服务端签发），
 * 仅决定 UI 呈现——后端 403 仍是权威。
 */
export function AdminReadOnlyBanner() {
  const { t } = useTranslation()
  return (
    <Alert variant="default" data-testid="admin-readonly-banner">
      <AlertTitle>{t('research.workbench.adminBanner')}</AlertTitle>
      <AlertDescription>{t('research.workbench.adminBannerDesc')}</AlertDescription>
    </Alert>
  )
}
