import { describe, expect, it } from 'vitest'
import {
  currentLegacyShellRequest,
  isLegacyShellRequested,
  resolveResearchPageMode,
} from './page-mode'

// W1 #1104（UI 规格 v1 §5.10 / BEH-13）：/research 默认目标壳；
// 只有 iframe URL 显式带 `legacy=1` 才渲染旧壳。

describe('isLegacyShellRequested（legacy=1 显式开关）', () => {
  it('legacy=1 → true；其它值/缺省 → false', () => {
    expect(isLegacyShellRequested('?legacy=1')).toBe(true)
    expect(isLegacyShellRequested('legacy=1')).toBe(true)
    expect(isLegacyShellRequested('?legacy=0')).toBe(false)
    expect(isLegacyShellRequested('?legacy=true')).toBe(false)
    expect(isLegacyShellRequested('?legacy=')).toBe(false)
    expect(isLegacyShellRequested('?other=1')).toBe(false)
    expect(isLegacyShellRequested('')).toBe(false)
  })

  it('容忍与其它查询参数共存（iframe src 常用形态）', () => {
    expect(isLegacyShellRequested('?foo=bar&legacy=1')).toBe(true)
    expect(isLegacyShellRequested('?legacy=1&foo=bar')).toBe(true)
    expect(isLegacyShellRequested('?legacy=1#hash')).toBe(true)
  })

  it('重复参数取第一个值（URLSearchParams 语义），非 1 不误开', () => {
    expect(isLegacyShellRequested('?legacy=0&legacy=1')).toBe(false)
  })
})

describe('resolveResearchPageMode / currentLegacyShellRequest', () => {
  it('默认目标壳；legacy 请求 → 旧壳', () => {
    expect(resolveResearchPageMode(false)).toBe('target')
    expect(resolveResearchPageMode(true)).toBe('legacy')
  })

  it('浏览器 location 当前查询串决定模式（client-only）', () => {
    const original = window.location.search
    window.history.replaceState(null, '', '/research?legacy=1')
    expect(currentLegacyShellRequest()).toBe(true)
    window.history.replaceState(null, '', '/research')
    expect(currentLegacyShellRequest()).toBe(false)
    window.history.replaceState(null, '', `/research${original}`)
  })
})
