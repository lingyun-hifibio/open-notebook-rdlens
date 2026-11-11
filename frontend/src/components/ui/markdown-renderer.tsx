'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

import { useThemeStore } from '@/lib/stores/theme-store'
import { oneDark as darkTheme } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { oneLight as lightTheme } from 'react-syntax-highlighter/dist/esm/styles/prism'
// PrismLight with an explicit language set instead of the full Prism build:
// bundling every refractor grammar costs ~600KB of client JS. Unregistered
// languages fall back to unhighlighted text.
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import r from 'react-syntax-highlighter/dist/esm/languages/prism/r'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'

import type {ExtraProps} from 'react-markdown'
import type {ComponentProps, ElementType} from 'react'
import {useMemo} from 'react'

const LANGUAGES = {
  bash, c, cpp, csharp, css, diff, docker, go, java, javascript, json, jsx,
  kotlin, markdown, markup, php, python, r, ruby, rust, sql, swift, tsx,
  typescript, yaml,
}
for (const [name, language] of Object.entries(LANGUAGES)) {
  SyntaxHighlighter.registerLanguage(name, language)
}

type Components = {
  [Key in Extract<ElementType, string>]?: ElementType<ComponentProps<Key> & ExtraProps>
}

const EMPTY_COMPONENTS: Components = {}

/**
 * Markdown 渲染器。
 *
 * 调用方约定（#1202）：传入的 `components` 覆盖项及其中的自定义组件函数必须
 * 在重渲染之间保持**引用稳定**——用模块级常量，或用 `useMemo` 缓存映射与
 * 组件函数（依赖只放真正会改变渲染结果的值）。每次 render 新建内联覆盖项会
 * 让 `mergedComponents` 变化，React 会把同名元素当成新组件类型卸载重建；
 * 与 #1192 同类，包含链接等自定义元素的文本选区会因此被折叠。
 */
export function MarkdownRenderer({ children, components: extraComponents = EMPTY_COMPONENTS }: { children: React.ReactNode , components?: Components }) {

  const { getEffectiveTheme } = useThemeStore()
  const isDark = getEffectiveTheme() === 'dark'

  // #1192（W3-G12）：内置 component 映射必须在重渲染之间保持**函数身份稳定**。
  // 若每次 render 都新建内联 component 函数，React 会把同名元素当成新类型而
  // 卸载后重建（`<p>` 等正文节点被替换）；浏览器会因此折叠此时已存在的文本
  // 选区，`selectionchange` 再让来源选段的「讨论选段/摘入文档」浮层消失 ——
  // 表现为「选中文本后入口不出现」。折叠/主题切换时重建是有意行为。
  const components = useMemo<Components>(() => ({
    p: ({ children }) => <p className="mb-4">{children}</p>,
    h1: ({ children }) => <h1 className="mb-4 mt-6">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-3 mt-5">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-3 mt-4">{children}</h3>,
    h4: ({ children }) => <h4 className="mb-2 mt-4">{children}</h4>,
    h5: ({ children }) => <h5 className="mb-2 mt-3">{children}</h5>,
    h6: ({ children }) => <h6 className="mb-2 mt-3">{children}</h6>,
    li: ({ children }) => <li className="mb-1">{children}</li>,
    ul: ({ children }) => <ul className="mb-4 space-y-1">{children}</ul>,
    ol: ({ children }) => <ol className="mb-4 space-y-1">{children}</ol>,
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto">
        <table className="min-w-full border-collapse border border-border">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="border-b border-border">{children}</tr>,
    th: ({ children }) => <th className="border border-border px-3 py-2 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="border border-border px-3 py-2">{children}</td>,
    code: ({ children, className }) => {
      const match = /language-(\w+)/.exec(className || '')
      const isBlock = match || String(children).includes('\n')
      return isBlock ? (
        <SyntaxHighlighter
          language={match ? match[1] : 'text'}
          style={isDark ? darkTheme : lightTheme}
          PreTag="div"
          className="text-sm border border-border"
        >
          {String(children)}
        </SyntaxHighlighter>
      ) : (
        <code className="bg-border rounded px-1 py-0.5">{children}</code>
      )
    },
  }), [isDark])

  // 合并调用方覆盖项：保持默认映射的稳定身份。调用方自身也必须传入稳定引用
  // （见组件 docstring 的调用方约定），否则 `<a>` 等自定义元素仍会被重建。
  const mergedComponents = useMemo<Components>(
    () => ({...components, ...extraComponents}),
    [components, extraComponents],
  )

  return (
    <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none break-words prose-headings:font-semibold prose-a:text-primary prose-a:break-all prose-code:before:content-none prose-code:after:content-none prose-pre:p-0 prose-pre:bg-transparent prose-p:mb-4 prose-p:leading-7 prose-li:mb-2">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={mergedComponents}
        >
          {String(children)}
        </ReactMarkdown>
      </div>
  )
}
