'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { cacheStatusLabelKey, formatCachedAt } from './note-ui-labels'

export interface NoteDraftRecoveryBannerProps {
  /** 本次打开是否来自本地草稿恢复（方案 §4.2）。 */
  restoredFromCache: boolean
  /** 草稿缓存可用性；memory_only/unavailable 必须显式提示恢复能力下降。 */
  cacheStatus: 'ok' | 'memory_only' | 'unavailable'
  /** 缓存时间（ISO）；非法/缺失时不展示时间，不伪造“刚保存”。 */
  savedAt?: string | null
  onDismiss?: () => void
  className?: string
}

/**
 * 本地草稿恢复横幅（方案 §4.2/§4.4）。
 *
 * - 恢复成功：明确告知正文来自本地未保存草稿，提示保存前先复核；
 * - 缓存降级（quota/SecurityError）：明确“本地恢复不可用”，草稿只在内存；
 * - 两者都不是时返回 null，避免噪声。
 *
 * 只展示状态，不改变保存状态；缓存正文永远不是授权凭据。
 */
export function NoteDraftRecoveryBanner({
  restoredFromCache,
  cacheStatus,
  savedAt = null,
  onDismiss,
  className,
}: NoteDraftRecoveryBannerProps) {
  const { t } = useTranslation()
  const degradedKey = cacheStatusLabelKey(cacheStatus)
  const cachedAt = formatCachedAt(savedAt)

  if (!restoredFromCache && degradedKey === null) {
    return null
  }

  return (
    <div className={`space-y-2 ${className ?? ''}`} data-testid="note-draft-recovery-banner">
      {restoredFromCache && (
        <Alert variant="default" data-testid="note-draft-restored">
          <AlertTitle>{t('research.notes.editor.recovery.title')}</AlertTitle>
          <AlertDescription>
            <p>{t('research.notes.editor.recovery.description')}</p>
            {cachedAt !== null && (
              <p className="text-xs text-muted-foreground" data-testid="note-draft-cached-at">
                {t('research.notes.editor.recovery.savedAt', { time: cachedAt })}
              </p>
            )}
            {onDismiss && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onDismiss}
                data-testid="note-draft-recovery-accept"
              >
                {t('research.notes.editor.recovery.dismiss')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {degradedKey !== null && (
        <Alert variant="destructive" data-testid="note-cache-degraded" data-cache-status={cacheStatus}>
          <AlertDescription>{t(degradedKey)}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
