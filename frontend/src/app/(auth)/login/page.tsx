import { LoginForm } from '@/components/auth/LoginForm'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { EmbeddedRouteGuard } from '@/components/embedded/EmbeddedRouteGuard'

export default function LoginPage() {
  return (
    <ErrorBoundary>
      {/* UI-02 禁用矩阵（REQ-SCOPE-03）：嵌入式模式不渲染上游登录页，
          重定向回 /research 工作台 */}
      <EmbeddedRouteGuard />
      <LoginForm />
    </ErrorBoundary>
  )
}