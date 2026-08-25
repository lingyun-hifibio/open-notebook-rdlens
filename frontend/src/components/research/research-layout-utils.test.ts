import { describe, expect, it } from 'vitest'
import { clampPrimaryPixels, getPrimaryPercentBounds, percentToPixels, pixelsToPercent } from './research-layout-utils'

describe('research layout dimensions', () => {
  it('clamps primary dimensions without violating either panel minimum', () => {
    expect(clampPrimaryPixels(800, 20, 8, 200, 300)).toBe(200)
    expect(clampPrimaryPixels(800, 900, 8, 200, 300)).toBe(492)
    expect(clampPrimaryPixels(800, 360, 8, 200, 300)).toBe(360)
  })

  it('remains recoverable for invalid and undersized containers', () => {
    expect(clampPrimaryPixels(100, Number.NaN, 8, 200, 300)).toBe(92)
    expect(clampPrimaryPixels(-1, 50, 8, 200, 300)).toBe(0)
    expect(percentToPixels(Number.NaN, 100)).toBe(0)
    expect(pixelsToPercent(10, 0)).toBe(0)
  })

  it('converts percentages against the available dimension', () => {
    expect(percentToPixels(40, 500)).toBe(200)
    expect(pixelsToPercent(200, 500)).toBe(40)
  })

  it('reports the reachable percentage range for the current container', () => {
    expect(getPrimaryPercentBounds(800, 8, 200, 300)).toEqual({
      min: 200 / 792 * 100,
      max: 492 / 792 * 100,
    })
    expect(getPrimaryPercentBounds(100, 8, 200, 300)).toEqual({ min: 100, max: 100 })
    expect(getPrimaryPercentBounds(0, 8, 200, 300)).toEqual({ min: 0, max: 0 })
  })
})
