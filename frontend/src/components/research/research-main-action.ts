/**
 * RWV2-40（Fork #44）：主工作区（Main workspace）动作标识。
 *
 * 目标 IA 将主区固定为五个研究动作：Evidence Search / Research Chat /
 * Compare / Mind Map / Custom Analysis。Jobs 不再是主区动作（迁往 Header
 * 的 Activity 兼容壳）。各动作面板经组合根（ResearchPageContent）控制
 * active 动作与 visited 集合，以实现"首次访问后保活"（keep-alive）语义。
 *
 * #445：新增 `mind-map` 占位动作（Mind Map is coming soon，无业务逻辑），
 * 排在 Compare 与 Custom Analysis 之间；`run-template` 保留为内部动作
 * 标识（路由/状态/数据/执行逻辑不变），用户可见文案更名为 Custom
 * Analysis。
 */
export type ResearchMainAction =
  | 'evidence-search'
  | 'research-chat'
  | 'compare'
  | 'mind-map'
  | 'run-template'

export const RESEARCH_MAIN_ACTIONS: readonly ResearchMainAction[] = [
  'evidence-search',
  'research-chat',
  'compare',
  'mind-map',
  'run-template',
]
