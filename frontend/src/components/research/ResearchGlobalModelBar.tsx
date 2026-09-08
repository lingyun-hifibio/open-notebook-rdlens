'use client'

import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'

/**
 * Research 顶层全局模型控件（Issue #243 GMOD-FE-01；RWV2-UIOPT-A 收敛）。
 *
 * RWV2-UIOPT-A（fork #57）：删除 `layout` 参数，组件恒为紧凑
 * Trigger + Popover 形态。Trigger 是 Header 常驻摘要，由三部分组成：
 * 已确认模型名（无 display name 用 model ID）、显式 Local/External、
 * 当前最高优先级状态。
 *
 * 这是页面内**唯一**的 Research 模型入口（退出条件一）。行为约束：
 *
 * - Trigger 永不读取 draft：只显示 confirmed 模型；未保存的选择只在
 *   状态里提示（不变量 2）；
 * - 下拉框是 draft：只有保存成功后才成为 confirmed，生成入口不读 draft
 *   （不变量 2）；未保存时展示「尚未保存的选择」而不是静默生效；
 * - 保存只 PATCH `preferred_model_id`；Search 上下文在 Search 面板内单独
 *   保存，两者互不覆盖（不变量 8，§6.3）；
 * - 保存中禁用控件与所有新生成入口（不变量 3）；失败展示 i18n 错误；
 * - 已保存模型消失/禁用时**保留其条目**并标注不可用，绝不自动改选
 *   （不变量 7）；Trigger 显示原 ID + Unavailable，不因元数据缺失推断
 *   为 Local；
 * - 未配置模型时 Trigger 显示 Select model，不出现虚假的 Local/External；
 * - 允许显式清除；清除后生成入口被阻止并引导重新选择；
 * - Admin readonly：控件禁用（isAdminReadonly），不发 PATCH；
 * - 外部模型需确认时入口仍可点击——点击后由根级 guard 弹确认，禁用会让
 *   用户永远无法触发确认（§6.8 第 3 步）；External 标识必须直接出现在
 *   Trigger，不得只藏在 Popover/Tooltip 内。
 */
export function ResearchGlobalModelBar() {
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
    confirmedModel,
    confirmedModelIsExternal,
    confirmedModelAvailability,
    needsConsent,
    runGuarded,
    isAdminReadonly,
  } = useResearchGlobalModel()

  // 目录里已消失的已保存模型仍要以不可用条目呈现（不变量 7）
  const options = useMemo(() => {
    const available = models.map((model) => ({
      value: model.model_id,
      // RWV2-42：本地/外部身份显式可见（data_egress=true=外部模型，
      // 恒 false=本地部署内，不出域）；UI 不得暗示 embedding 离境。
      label:
        (model.display_name || model.model_id) +
        (model.data_egress === true
          ? ` (${t('research.globalModel.external')})`
          : ` (${t('research.globalModel.local')})`),
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

  // 状态优先级：Save failed → Saving → Unavailable → No model →
  // Consent required → Unsaved draft → Admin readonly（计划 §6.3）。
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

  // Trigger 摘要（永不读 draft）：
  // - 名称：confirmed display name（缺省用 model ID）；未配置 → Select model；
  // - 部署身份：confirmed 模型在目录中时显式 Local/External；消失或未配置
  //   时不标注（不得推断）；
  // - 状态：最高优先级状态（抑制规则见 triggerStatus 处注释）。
  const triggerName =
    confirmedModelAvailability === 'available' && confirmedModel
      ? confirmedModel.display_name || confirmedModel.model_id
      : confirmedModelAvailability === 'unavailable' && confirmedModelId !== null
        ? confirmedModelId
        : t('research.globalModel.placeholder')
  const triggerVisibility =
    confirmedModelAvailability === 'available' && confirmedModel
      ? confirmedModelIsExternal
        ? t('research.globalModel.external')
        : t('research.globalModel.local')
      : null
  // Trigger 状态 = 最高优先级状态，两类抑制：
  // - 「No model」提示与名称槽 Select model 重复——仅抑制该分支，其余状态
  //   （含未配置模型的首次 Save failed/Saving）仍直接上 Trigger；
  // - 目录加载中不把「暂未命中」标成 Unavailable：preferences 先于目录
  //   返回时无法区分「真消失」与「尚未到达」，等目录落地再判定。
  const triggerStatus =
    statusText === t('research.globalModel.selectModelHint')
      ? ''
      : statusText === t('research.globalModel.unavailable') && isLoadingModel
        ? ''
        : statusText

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

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="max-w-full"
          data-testid="global-model-summary-trigger"
          title={triggerName}
        >
          <span className="max-w-[10rem] truncate" data-testid="global-model-summary-name">
            {triggerName}
          </span>
          {triggerVisibility !== null && (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              data-testid="global-model-summary-visibility"
            >
              · {triggerVisibility}
            </span>
          )}
          {triggerStatus && (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              data-testid="global-model-summary-status"
            >
              · {triggerStatus}
            </span>
          )}
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
