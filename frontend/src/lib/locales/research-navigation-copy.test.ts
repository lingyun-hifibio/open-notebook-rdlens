import { describe, expect, it } from 'vitest'
import { enUS } from './en-US'
import { zhCN } from './zh-CN'
import { resources } from './index'

// #445：Research Workspace 一级导航文案契约——
// - `Run Template` 全量更名为 `Custom Analysis`（仅文案；内部动作标识
//   `run-template` 与路由/状态/执行逻辑不变）；
// - 新增 `Mind Map` 一级占位入口（约定英文文案为产品冻结文案）。
// 键完整性由 Locale Parity（index.test.ts）与 TranslationShape（tsc）保证，
// 本文件只锚定用户可见文案本身。
const RESEARCH_SECTION = 'research'

const localizedResearch = (translation: unknown): Record<string, unknown> => {
  const section = (translation as Record<string, unknown>)[RESEARCH_SECTION]
  return section as Record<string, unknown>
}

describe('#445 导航文案契约', () => {
  it('en-US：runTemplate 文案为 Custom Analysis，mindMap 为 Mind Map', () => {
    const research = localizedResearch(enUS)
    expect(research.mainActions).toMatchObject({
      runTemplate: 'Custom Analysis',
      mindMap: 'Mind Map',
    })
  })

  it('en-US：Mind Map 占位文案与 Issue #445 约定逐字一致', () => {
    const research = localizedResearch(enUS)
    expect(research.mindMap).toEqual({
      title: 'Mind Map is coming soon',
      description:
        'Visualize concepts, evidence, and relationships across your research materials.',
    })
  })

  it('zh-CN：Custom Analysis / Mind Map 已本地化', () => {
    const research = localizedResearch(zhCN)
    expect(research.mainActions).toMatchObject({
      runTemplate: '自定义分析',
      mindMap: '思维导图',
    })
  })

  it('全部 locale 的 research 段不再出现 "Run Template"（AC：一级导航不再显示）', () => {
    for (const [code, resource] of Object.entries(resources)) {
      const research = localizedResearch(resource.translation)
      expect(JSON.stringify(research), `locale ${code}`).not.toContain('Run Template')
    }
  })
})
