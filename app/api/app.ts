import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { errors, GatewayError, gatewayErrorBody } from './errors'
import { errorResponse, gatewayErrorResponse, internalErrorResponse } from './http'
import { endpointMethods, matchApiRoute, resolveBaseUrl } from './router'
import { envPrefix, getProvider } from './providers/registry'
import { buildUpstreamHeaders, DEFAULT_TIMEOUT_MS, providerEnv } from './upstream'
import { handleModels } from './handlers/models'
import { handleChat } from './handlers/chat'
import { handleImages } from './handlers/images'
import { handleVideoContent, handleVideoCreate, handleVideoTask } from './handlers/video'
import type { ApiRequestContext } from './handlers/types'

export interface GatewayOptions {
  /** 依赖注入的 fetch（测试用），默认 globalThis.fetch */
  fetch?: typeof fetch
  /** 依赖注入的环境变量（测试用），默认读取 c.env + process.env */
  env?: Record<string, string | undefined>
}

export function createGatewayApp(options: GatewayOptions = {}): Hono {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)

  const app = new Hono()

  // 独立部署时也开放任意 origin 的 CORS（HonoX 集成时由外层中间件统一处理预检）
  app.use('*', cors())

  app.all('*', async (c) => {
    const requestId = `gw-${crypto.randomUUID()}`
    let response: Response
    try {
      response = await dispatch(c, fetchImpl, options.env)
    } catch (e) {
      response = renderError(e)
    }
    return withRequestId(response, requestId)
  })

  return app
}

async function dispatch(
  c: Context,
  fetchImpl: typeof fetch,
  envOverride?: Record<string, string | undefined>,
): Promise<Response> {
  const match = matchApiRoute(c.req.url)
  if (!match) throw errors.unknownEndpoint(c.req.path)

  const provider = getProvider(match.providerId)
  if (!provider) throw errors.unknownProvider(match.providerId)

  // 方法校验（OPTIONS 预检已由 cors 中间件处理）
  const allowed = endpointMethods(match.kind)
  if (!allowed.includes(c.req.method)) {
    return errorResponse(
      gatewayErrorBody(errors.methodNotAllowed([...allowed, 'OPTIONS'])),
      405,
      { allow: [...allowed, 'OPTIONS'].join(', ') },
    )
  }

  // baseUrl 解析：/<provider>/v1 -> env/默认；/<provider>/<任意URL> -> 原样使用
  const env = envOverride ? { ...envOverride } : providerEnv(c.env)
  const envBaseUrl = env[`${envPrefix(provider.id)}_BASE_URL`]
  const resolved = resolveBaseUrl(match.prefix, {
    defaultBaseUrl: provider.defaultBaseUrl,
    versionPath: provider.versionPath,
    envBaseUrl,
  })
  if (!resolved) throw errors.invalidBaseUrl(match.prefix)

  const timeoutMs = parseTimeout(env.UPSTREAM_TIMEOUT_MS)

  // 认证：客户端 Authorization > 客户端 x-api-key > ${PROVIDER}_API_KEY_FOR_DEV
  const { headers, credential } = buildUpstreamHeaders(
    provider,
    c.req.header('authorization') ?? null,
    c.req.header('x-api-key') ?? null,
    env,
    'json',
  )

  const req: ApiRequestContext = {
    c,
    provider,
    match,
    upstream: {
      baseUrl: resolved.baseUrl,
      credential,
      env,
      fetch: fetchImpl,
      signal: c.req.raw.signal,
    },
    headers,
    timeoutMs,
    baseUrlSource: resolved.source,
  }

  switch (match.kind) {
    case 'models':
      return handleModels(req)
    case 'chat.completions':
      return handleChat(req)
    case 'images.generations':
      return handleImages(req, 'generations')
    case 'images.edits':
      return handleImages(req, 'edits')
    case 'videos.create':
      return handleVideoCreate(req)
    case 'videos.retrieve':
      return handleVideoTask(req)
    case 'videos.content':
      return handleVideoContent(req)
  }
}

/** 网关中间件：路径命中已知端点时交给网关子应用，否则放行给 HonoX 页面路由 */
export function gateway(options: GatewayOptions = {}): MiddlewareHandler {
  const api = createGatewayApp(options)
  return async (c, next) => {
    if (!matchApiRoute(c.req.url)) return next()
    return api.fetch(c.req.raw, c.env)
  }
}

function parseTimeout(raw: string | undefined): number {
  const value = Number(raw)
  if (Number.isFinite(value) && value >= 1000) return value
  return DEFAULT_TIMEOUT_MS
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers)
  headers.set('x-request-id', requestId)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function renderError(e: unknown): Response {
  if (e instanceof GatewayError) return gatewayErrorResponse(e)
  console.error('[gateway] unhandled error:', e)
  return internalErrorResponse()
}
