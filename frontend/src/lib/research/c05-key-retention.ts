/**
 * Issue #601 PR5（D-02）：键龄工具——从 `ai-insight-risk.ts` 抽取共享，
 * **不新增第二套 24h/时间源机制**。单调时钟（`performance.now`）优先，
 * 避免同文档内受墙钟漂移影响。
 */

export function monotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function keyAgeMs(startedAt: number, now: number): number {
  return Math.max(0, now - startedAt)
}

export const SHARED_KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function isKeyAgeWithinWindow(startedAt: number | null, now: number): boolean {
  if (startedAt === null) return true
  return keyAgeMs(startedAt, now) <= SHARED_KEY_MAX_AGE_MS
}
