'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'

/**
 * Research 根级外发确认弹窗（Issue #243 GMOD-FE-01，计划 §6.8）。
 *
 * 全 Workspace 只有这一个确认入口，由 `useResearchGlobalModel` 的
 * single-flight guard 驱动：
 *
 * - 弹窗打开时执行体尚未调用，因此取消不可能残留 turn/job/loading/
 *   idempotency 状态（不变量 9）；
 * - 确认成功后 guard 用**调用时刻捕获的模型快照**执行原操作，不重新读取
 *   后来的全局模型（不变量 4）；
 * - 后端 dispatch gate 仍是最终权威——前端判断只决定是否先展示确认。
 */
export function ResearchEgressConsentDialog() {
  const { t } = useTranslation()
  const {
    isConsentPromptOpen,
    isConsentInFlight,
    consentResponse,
    consentError,
    confirmConsent,
    cancelConsent,
  } = useResearchGlobalModel()

  return (
    <Dialog
      open={isConsentPromptOpen}
      onOpenChange={(open) => {
        // 关闭（含 Esc / 点击遮罩）等同取消：丢弃登记，不执行
        if (!open) cancelConsent()
      }}
    >
      <DialogContent data-testid="egress-consent-dialog">
        <DialogHeader>
          <DialogTitle>{t('research.consentTitle')}</DialogTitle>
          <DialogDescription>{t('research.consentIntro')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-medium">{t('research.consentDestinations')}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {(consentResponse?.required_scope.provider_destinations ?? []).map(
                (destination) => (
                  <li
                    key={destination.provider_id}
                    data-testid="egress-consent-destination"
                  >
                    {destination.provider_id} · {destination.api_base_url}
                  </li>
                ),
              )}
            </ul>
          </div>
          <div>
            <p className="font-medium">{t('research.consentCategories')}</p>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid="egress-consent-categories"
            >
              {(consentResponse?.required_scope.data_categories ?? []).join(', ')}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('research.consentPreviewNote')}
          </p>
          {consentError && (
            <p
              className="text-xs font-medium text-destructive"
              role="alert"
              data-testid="egress-consent-error"
            >
              {t('research.globalModel.consentFailed')}
              {': '}
              {consentError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={cancelConsent}
            disabled={isConsentInFlight}
            data-testid="egress-consent-cancel"
          >
            {t('research.consentCancel')}
          </Button>
          <Button
            onClick={() => void confirmConsent()}
            disabled={isConsentInFlight}
            data-testid="egress-consent-confirm"
          >
            {t('research.consentConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
