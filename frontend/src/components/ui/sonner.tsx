"use client"

import { useThemeStore } from "@/lib/stores/theme-store"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  // RWV2-50：经 getEffectiveTheme 取主题真源（含嵌入式父页 override），
  // selector 返回原始 string，override 变化即触发重渲染。
  const effectiveTheme = useThemeStore((state) => state.getEffectiveTheme())

  return (
    <Sonner
      theme={effectiveTheme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--popover)",
          "--success-text": "var(--popover-foreground)",
          "--success-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
