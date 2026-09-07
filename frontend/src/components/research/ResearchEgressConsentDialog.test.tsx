/**
 * ResearchEgressConsentDialog 组件测试（Issue #243 GMOD-FE-01，评审 Minor-7）。
 *
 * 用 global-model-stub 替身隔离 provider 逻辑（确认流程语义由
 * use-research-global-model.test.tsx 覆盖），聚焦弹窗 UI 呈现与回调：
 * - 目的地/数据类别渲染（required_scope 展示）；
 * - 确认失败错误展示（egress-consent-error，role=alert）；
 * - 取消/确认回调触发。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ResearchEgressConsentDialog } from './ResearchEgressConsentDialog'
import { resetGlobalModelStub, setGlobalModelStub } from '@/test/global-model-stub'
import type { ResearchEgressConsentResponse } from '@/lib/research/types'

vi.mock('@/lib/hooks/use-research-global-model')
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const consentResponse: ResearchEgressConsentResponse = {
  consent: null,
  required_scope: {
    policy_version: '1',
    provider_destinations: [
      { provider_id: 'ext-1', api_base_url: 'https://ext.example.com/v1' },
    ],
    data_categories: ['focused_context'],
    scope_hash: 'hash-current',
  },
}

describe('ResearchEgressConsentDialog', () => {
  beforeEach(() => {
    resetGlobalModelStub()
  })

  it('关闭时不渲染；打开时展示目的地与数据类别', () => {
    const { rerender } = render(<ResearchEgressConsentDialog />)
    expect(screen.queryByTestId('egress-consent-dialog')).toBeNull()

    setGlobalModelStub({ isConsentPromptOpen: true, consentResponse })
    rerender(<ResearchEgressConsentDialog />)

    expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy()
    expect(screen.getByTestId('egress-consent-destination').textContent).toContain(
      'ext-1',
    )
    expect(screen.getByTestId('egress-consent-categories').textContent).toContain(
      'focused_context',
    )
  })

  it('确认失败时展示错误（consentFailed + 具体信息），弹窗保持打开', () => {
    setGlobalModelStub({
      isConsentPromptOpen: true,
      consentResponse,
      consentError: 'upstream rejected',
    })
    render(<ResearchEgressConsentDialog />)

    const error = screen.getByTestId('egress-consent-error')
    expect(error.textContent).toContain('research.globalModel.consentFailed')
    expect(error.textContent).toContain('upstream rejected')
    expect(screen.getByTestId('egress-consent-dialog')).toBeTruthy()
  })

  it('取消与确认分别触发对应回调', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn(async () => undefined)
    setGlobalModelStub({
      isConsentPromptOpen: true,
      consentResponse,
      onCancelConsent: onCancel,
      onConfirmConsent: onConfirm,
    })
    render(<ResearchEgressConsentDialog />)

    fireEvent.click(screen.getByTestId('egress-consent-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('egress-consent-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('RWV2-42：Model 行展示登记快照模型（名称+provider+External）与本地性注记', () => {
    setGlobalModelStub({
      isConsentPromptOpen: true,
      consentResponse,
      pendingModelId: 'm-ext',
      models: [
        {
          model_id: 'm-ext',
          display_name: 'Ext M',
          provider_id: 'ext-1',
          data_egress: true,
        },
        { model_id: 'm-local', display_name: 'Local M', data_egress: false },
      ],
    })
    render(<ResearchEgressConsentDialog />)

    const modelRow = screen.getByTestId('egress-consent-model')
    // t() 在测试中映射为 key：断言使用 external 身份 key（非猜测语言）
    expect(modelRow.textContent).toContain('Ext M')
    expect(modelRow.textContent).toContain('ext-1')
    expect(modelRow.textContent).toContain('research.globalModel.external')
    // 本地性注记：embedding/检索不出域（RWV2-42）
    expect(screen.getByTestId('egress-consent-embedding-note').textContent).toContain(
      'research.consentEmbeddingLocal',
    )
  })

  it('RWV2-42：登记模型不在目录（unavailable）→ Model 行显示 id + unavailable 标记，不猜测身份', () => {
    setGlobalModelStub({
      isConsentPromptOpen: true,
      consentResponse,
      pendingModelId: 'm-gone',
      models: [{ model_id: 'm-local', display_name: 'Local M', data_egress: false }],
    })
    render(<ResearchEgressConsentDialog />)

    const modelRow = screen.getByTestId('egress-consent-model')
    expect(modelRow.textContent).toContain('m-gone')
    expect(modelRow.textContent).toContain('research.globalModel.unavailable')
  })

  it('RWV2-42：Scope 行仅在派发登记了摘要时显示；Model 行与本地性注记常驻（弹窗开）', () => {
    setGlobalModelStub({
      isConsentPromptOpen: true,
      consentResponse,
      pendingModelId: 'm-ext',
      models: [{ model_id: 'm-ext', display_name: 'Ext M', data_egress: true }],
    })
    const { rerender } = render(<ResearchEgressConsentDialog />)
    // 未登记摘要：无 Scope 行（防展示与派发无关范围），但有 Model 行
    expect(screen.queryByTestId('egress-consent-scope')).toBeNull()
    expect(screen.getByTestId('egress-consent-model')).toBeTruthy()

    setGlobalModelStub({ pendingScopeLabel: '2 sources · 1 note' })
    rerender(<ResearchEgressConsentDialog />)
    expect(screen.getByTestId('egress-consent-scope').textContent).toContain(
      '2 sources · 1 note',
    )
  })
})
