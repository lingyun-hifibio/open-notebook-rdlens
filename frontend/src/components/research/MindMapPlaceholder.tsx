'use client'

import { useTranslation } from '@/lib/hooks/use-translation'

/**
 * #445：Mind Map 一级动作占位面板（coming soon）。
 *
 * 仅渲染约定的占位文案（标题 + 说明），不实现 Mind Map 的生成、编辑、
 * 持久化、引用或导出能力；完整实现由后续独立 Issue 承接，本组件即其
 * 接入点。选中态/焦点态/键盘可访问性由主区 Radix Tabs 统一提供。
 */
export function MindMapPlaceholder() {
  const { t } = useTranslation()
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
      data-testid="mind-map-placeholder"
    >
      <h2 className="text-lg font-medium text-foreground">{t('research.mindMap.title')}</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {t('research.mindMap.description')}
      </p>
    </div>
  )
}
