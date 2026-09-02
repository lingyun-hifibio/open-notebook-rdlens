'use client'

import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'

/**
 * Research 顶层全局模型控件（Issue #243 GMOD-FE-01，计划 §6.1/§6.2）。
 *
 * 这是页面内**唯一**的 Research 模型入口（退出条件一）。行为约束：
 *
 * - 下拉框是 draft：只有保存成功后才成为 confirmed，生成入口不读 draft
 *   （不变量 2）；未保存时展示「尚未保存的选择」而不是静默生效；
 * - 保存只 PATCH `preferred_model_id`；Search 上下文在 Search 面板内单独
 *   保存，两者互不覆盖（不变量 8，§6.3）；
 * - 保存中禁用控件与所有新生成入口（不变量 3）；失败展示 i18n 错误；
 * - 已保存模型消失/禁用时**保留其条目**并标注不可用，绝不自动改选
 *   （不变量 7）；
 * - 允许显式清除；清除后生成入口被阻止并引导重新选择；
 * - Admin readonly：控件禁用（isAdminReadonly），不发 PATCH；
 * - 外部模型需确认时入口仍可点击——点击后由根级 guard 弹确认，禁用会让
 *   用户永远无法触发确认（§6.8 第 3 步）。
 *
 * `layout="popover"` 用于窄屏：把设置收进可访问触发器的浮层，避免横向溢出。
 */
export function ResearchGlobalModelBar({
  layout = 'inline',
}: {
  layout?: 'inline' | 'popover'
}) {
  const { t } = useTranslation()
  const {
    models,
    draftModelId,
    setDraftModelId,
    confirmedModelId,
    saveModel,
    clearModel,
    isSavingModel,
    isLoadingModel,
    saveModelError,
    dismissSaveModelError,
    confirmedModelAvailability,
    needsConsent,
    runGuarded,
    isAdminReadonly,
  } = useResearchGlobalModel()

  // 目录里已消失的已保存模型仍要以不可用条目呈现（不变量 7）
  const options = useMemo(() => {
    const available = models.map((model) => ({
      value: model.model_id,
      label:
        (model.display_name || model.model_id) +
        (model.data_egress === true
          ? ` (${t('research.globalModel.external')})`
          : ''),
    }))
    if (
      confirmedModelId !== null &&
      !models.some((model) => model.model_id === confirmedModelId)
    ) {
      available.unshift({
        value: confirmedModelId,
        label: `${confirmedModelId} (${t('research.globalModel.unavailable')})`,
      })
    }
    return available
  }, [confirmedModelId, models, t])

  const dirty = draftModelId !== confirmedModelId
  const disabled = isAdminReadonly || isSavingModel || isLoadingModel

  const statusText = saveModelError
    ? t('research.globalModel.saveFailed')
    : isSavingModel
      ? t('research.globalModel.saving')
      : confirmedModelAvailability === 'unavailable'
        ? t('research.globalModel.unavailable')
        : confirmedModelId === null
          ? t('research.globalModel.selectModelHint')
          : needsConsent
            ? t('research.globalModel.consentRequired')
            : dirty
              ? t('research.globalModel.draftUnsaved')
              : isAdminReadonly
                ? t('research.globalModel.adminReadonly')
                : ''

  const controls = (
    <>
      <label className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('research.globalModel.label')}
        </span>
        <select
          className="h-8 min-w-0 max-w-[14rem] shrink rounded-md border bg-background px-2 text-xs"
          data-testid="global-model-select"
          aria-label={t('research.globalModel.label')}
          value={draftModelId ?? ''}
          disabled={disabled}
          onChange={(event) => {
            dismissSaveModelError()
            setDraftModelId(event.target.value === '' ? null : event.target.value)
          }}
        >
          {/* 无已保存偏好时保持空选：绝不自动选中第一个模型 */}
          <option value="">{t('research.globalModel.placeholder')}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {statusText && (
        <span
          className="text-xs text-muted-foreground"
          data-testid="global-model-status"
          role="status"
        >
          {statusText}
        </span>
      )}

      <div className="flex shrink-0 items-center gap-1.5">
        {needsConsent && !isAdminReadonly && (
          <Button
            size="sm"
            variant="outline"
            data-testid="global-model-consent"
            disabled={isSavingModel || isLoadingModel}
            onClick={() => void runGuarded(() => undefined)}
          >
            {t('research.consentConfirm')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          data-testid="global-model-save"
          disabled={disabled || !dirty || draftModelId === null}
          onClick={() => void saveModel()}
        >
          {isSavingModel
            ? t('research.globalModel.saving')
            : t('research.globalModel.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="global-model-clear"
          disabled={disabled || confirmedModelId === null}
          onClick={() => void clearModel()}
        >
          {t('research.globalModel.clear')}
        </Button>
      </div>
    </>
  )

  if (layout === 'popover') {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            data-testid="global-model-settings-trigger"
          >
            {t('research.globalModel.settings')}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-72 space-y-2"
          data-testid="global-model-popover"
        >
          {controls}
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
      data-testid="research-global-model-bar"
    >
      {controls}
    </div>
  )
}
