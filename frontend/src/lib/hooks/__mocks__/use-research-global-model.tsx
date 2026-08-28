/**
 * `use-research-global-model` 的自动 mock 入口（Vitest `__mocks__` 约定）：
 * 用例里 `vi.mock('@/lib/hooks/use-research-global-model')` 即命中本文件。
 *
 * 实现与可覆盖状态放在 `src/test/global-model-stub.tsx`，用例从那里
 * 导入 `setGlobalModelStub/resetGlobalModelStub`（类型可见、不依赖
 * `__mocks__` 路径）。
 */
export {
  GLOBAL_MODEL_STUB_ID,
  ResearchGlobalModelProvider,
  resetGlobalModelStub,
  setGlobalModelStub,
  useResearchGlobalModel,
} from '@/test/global-model-stub'
