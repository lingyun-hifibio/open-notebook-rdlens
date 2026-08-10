import { redirect } from 'next/navigation'
import { isEmbeddedMode } from '@/lib/embedded/config'

export default function HomePage() {
  // 嵌入式模式（NEXT_PUBLIC_RD_EMBEDDED_MODE）下入口为 Research
  // Workspace Shell；默认保持上游行为（跳转 Notebook 列表）。
  redirect(isEmbeddedMode() ? '/research' : '/notebooks')
}
