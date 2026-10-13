/**
 * Issue #601 PR5（D-19/T37）：模式改名静态零残留守卫。
 *
 * `entire_project` 旧字面量在 `src/`（除 scope.tsx 的迁移归一函数与测试）
 * 中出现 **0** 次——漏改一处比较会静默落进 `selected` 分支（不报错、不崩、
 * 只显示错/门禁错），编译器对字符串比较不报错，必须靠本守卫。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

/** 允许出现旧字面量的文件（迁移归一 + 本守卫自身） */
const ALLOWED_FILES = [
  // rel(f) 产出相对 src/ 的路径（walk 根 = src/）
  'lib/research/scope.tsx',
  'lib/research/c05-static-guards.test.ts',
  // 投影校验用例：旧字面量作为**非法 mode 值**参与回归（解析必须拒绝）
  'lib/research/c05-scope-projection.test.ts',
]

describe('D-19/T37：entire_project 静态零残留', () => {
  it('src/ 下（迁移点除外）不得出现 entire_project', () => {
    // vitest 下 __dirname 即本文件目录（src/lib/research）；src/ 为其上两级
    const srcDir = join(__dirname, '..', '..')
    const rel = (f: string) => f.replace(`${srcDir}/`, '')
    const files = walk(srcDir).filter(f => !ALLOWED_FILES.includes(rel(f)))
    const offenders: Array<{ file: string; line: number; text: string }> = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, idx) => {
        if (line.includes('entire_project')) {
          offenders.push({ file: file.replace(`${srcDir}/`, ''), line: idx + 1, text: line.trim().slice(0, 80) })
        }
      })
    }
    expect(offenders, `旧字面量残留：\n${offenders.map(o => `${o.file}:${o.line}: ${o.text}`).join('\n')}`).toEqual([])
  })

  it('scope.tsx 中旧字面量仅出现在迁移归一函数（normalizePersistedScope）', () => {
    const content = readFileSync(join(__dirname, 'scope.tsx'), 'utf8')
    const lines = content.split('\n')
    const hits = lines
      .map((line, idx) => ({ line: idx + 1, text: line }))
      .filter(({ text }) => text.includes('entire_project'))
    // 常量定义 + docstring 提及 + normalizePersistedScope 内 1 处比较
    expect(hits.length).toBeLessThanOrEqual(4)
    for (const hit of hits) {
      const isMigrationCode = hit.text.includes('LEGACY_ENTIRE_PROJECT')
      const isDocstring = hit.text.trim().startsWith('*') || hit.text.trim().startsWith('//')
      expect(
        isMigrationCode || isDocstring,
        `非迁移位置的旧字面量：${hit.line}: ${hit.text}`,
      ).toBe(true)
    }
  })
})
