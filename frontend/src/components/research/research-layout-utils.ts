export function clampPrimaryPixels(
  containerSize: number,
  desiredSize: number,
  handleSize: number,
  minPrimary: number,
  minSecondary: number,
): number {
  const availableSize = Math.max(0, containerSize - handleSize)
  const lower = Math.min(Math.max(0, minPrimary), availableSize)
  const upper = Math.max(lower, availableSize - Math.max(0, minSecondary))
  const safeDesired = Number.isFinite(desiredSize) ? desiredSize : lower
  return Math.min(upper, Math.max(lower, safeDesired))
}

export function getPrimaryPercentBounds(
  containerSize: number,
  handleSize: number,
  minPrimary: number,
  minSecondary: number,
): { min: number; max: number } {
  const availableSize = Math.max(0, containerSize - handleSize)
  const lower = Math.min(Math.max(0, minPrimary), availableSize)
  const upper = Math.max(lower, availableSize - Math.max(0, minSecondary))

  return {
    min: pixelsToPercent(lower, availableSize),
    max: pixelsToPercent(upper, availableSize),
  }
}

export function pixelsToPercent(primarySize: number, availableSize: number): number {
  if (!Number.isFinite(primarySize) || !Number.isFinite(availableSize) || availableSize <= 0) return 0
  return (primarySize / availableSize) * 100
}

export function percentToPixels(percent: number, availableSize: number): number {
  if (!Number.isFinite(percent) || !Number.isFinite(availableSize) || availableSize <= 0) return 0
  return (percent / 100) * availableSize
}
