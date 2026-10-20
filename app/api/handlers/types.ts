import type { Provider, ProviderCallContext } from '../providers/types'
import type { GatewayRouteMatch } from '../router'
import type { Context } from 'hono'

/** 分发给各端点 handler 的请求上下文 */
export interface ApiRequestContext {
  c: Context
  provider: Provider
  match: GatewayRouteMatch
  /** 供应商调用上下文（baseUrl 已解析） */
  upstream: ProviderCallContext
  /** 已构建的上游基础请求头（含认证） */
  headers: Headers
  /** 上游超时（毫秒） */
  timeoutMs: number
  /** 客户端原始请求的 baseUrl 前缀（调试用） */
  baseUrlSource: 'default' | 'env' | 'custom'
}
