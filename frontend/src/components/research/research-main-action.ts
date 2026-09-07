/**
 * RWV2-40（Fork #44）：主工作区（Main workspace）动作标识。
 *
 * 目标 IA 将主区固定为四个研究动作：Evidence Search / Research Chat /
 * Compare / Run Template。Jobs 不再是主区动作（迁往 Header 的 Activity
 * 兼容壳）。各动作面板经组合根（ResearchPageContent）控制 active 动作与
 * visited 集合，以实现"首次访问后保活"（keep-alive）语义。
 */
export type ResearchMainAction =
  | 'evidence-search'
  | 'research-chat'
  | 'compare'
  | 'run-template'

export const RESEARCH_MAIN_ACTIONS: readonly ResearchMainAction[] = [
  'evidence-search',
  'research-chat',
  'compare',
  'run-template',
]
