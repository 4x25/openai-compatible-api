import { GatewayError } from '../errors'
import { isRecord } from '../http'
import type { ChatCompletionRequest } from '../types'
import type { Provider, ProviderCallContext } from './types'

const API_BASE = 'https://api.inceptionlabs.ai/v1'
const PLAYGROUND_BASE = 'https://web-api-proxy.inceptionlabs.ai/v1'
const PLAYGROUND_KEY = 'playground'

/**
 * inception — Inception Labs Mercury 系列（dLLM）。
 *
 * 一个 provider 按凭证选择两条上游：
 *  - 普通 API Key：https://api.inceptionlabs.ai/v1（OpenAI 兼容，Bearer 透传）
 *  - 凭证写作 `playground`（大小写、首尾空白不敏感）：Inception 官方 Playground
 *    代理 https://web-api-proxy.inceptionlabs.ai/v1/playground（无需鉴权）
 *
 * 两条上游共同的推理强度适配：
 *  - 省略 reasoning_effort 或写作 "none" -> "instant"（Mercury 的最低延迟档）
 *  - 其余取值原样透传
 *
 * Playground 只接受 model / messages / max_tokens / stream / reasoning_effort：
 *  - max_completion_tokens 转成 max_tokens；
 *  - 其他参数（temperature、tools、stream_options 等）静默丢弃；
 *  - 省略 stream 时上游默认返回 SSE，因此始终显式发送 stream 布尔值；
 *  - 工具声明或工具历史在本地返回结构化 400，避免把请求发给不支持工具的上游；
 *  - 上游响应里的 tool_call_id、warning、reasoning_summary 等额外字段由网关归一化层剥掉。
 */
export const inception: Provider = {
  id: 'inception',
  name: 'Inception Labs',
  defaultBaseUrl: API_BASE,
  versionPath: '/v1',
  models: [
    { id: 'mercury-3', ownedBy: 'inceptionlabs' },
    { id: 'mercury-2.5', ownedBy: 'inceptionlabs' },
    { id: 'mercury-2', ownedBy: 'inceptionlabs' },
  ],
  chat: {
    path: '/chat/completions',
    supportsStreaming: true,
    supportsNonStreaming: true,
    // 旧版 function 字段：保留到 transformRequest，Playground 模式据此在本地拒绝工具请求
    extraParams: ['functions', 'function_call'],
    resolveUpstream: (_req, ctx) => (isPlayground(ctx)
      ? {
          baseUrl: PLAYGROUND_BASE,
          path: '/playground',
          // 上游无需鉴权：绝不把客户端发给本网关的 key 转发给 Playground
          removeHeaders: ['authorization', 'x-api-key', 'api-key'],
        }
      : undefined),
    transformRequest: (req, ctx) => (isPlayground(ctx) ? playgroundRequest(req) : apiRequest(req)),
    transformResponse: (res, ctx) => (isPlayground(ctx) ? normalizePlaygroundCompletion(res) : res),
    transformStreamChunk: (chunk, ctx) => (isPlayground(ctx) ? normalizePlaygroundChunk(chunk) : chunk),
  },
}

function isPlayground(ctx: ProviderCallContext): boolean {
  return ctx.credential?.trim().toLowerCase() === PLAYGROUND_KEY
}

/** 省略 effort 时取 instant；兼容名 none 映射到 Inception 的 instant。 */
function upstreamEffort(value: unknown): unknown {
  if (value === undefined) return 'instant'
  return typeof value === 'string' && value.trim().toLowerCase() === 'none' ? 'instant' : value
}

function apiRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const out = { ...(body as unknown as Record<string, unknown>) }
  const effort = upstreamEffort(out.reasoning_effort)
  if (effort !== out.reasoning_effort) out.reasoning_effort = effort
  return out
}

function playgroundRequest(body: ChatCompletionRequest): Record<string, unknown> {
  const raw = body as unknown as Record<string, unknown>
  const tool = toolParameter(raw)
  if (tool) throw toolError(tool)

  const out: Record<string, unknown> = {}
  if (typeof raw.model === 'string') out.model = raw.model
  if (Array.isArray(raw.messages)) out.messages = raw.messages

  const max = finiteNumber(raw.max_tokens) ?? finiteNumber(raw.max_completion_tokens)
  if (max !== undefined && max > 0) out.max_tokens = max

  const effort = upstreamEffort(raw.reasoning_effort)
  if (typeof effort === 'string' && effort.trim()) out.reasoning_effort = effort.trim()

  out.stream = raw.stream === true
  return out
}

const toolContentTypes = new Set(['tool_use', 'tool_result', 'server_tool_use'])
const implicitToolChoices = new Set(['auto', 'none'])

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function choiceIndex(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function hasFields(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0
}

function choosesTool(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized !== '' && !implicitToolChoices.has(normalized)
  }
  if (!hasFields(value)) return false
  const type = (value as Record<string, unknown>).type
  return typeof type !== 'string' || !implicitToolChoices.has(type.trim().toLowerCase())
}

/** 工具声明或工具历史仍需要 API Key 上游；只检查结构字段，不误判普通文本。 */
function toolParameter(body: Record<string, unknown>): string | null {
  if (hasItems(body.tools)) return 'tools'
  if (hasItems(body.functions)) return 'functions'
  if (choosesTool(body.tool_choice)) return 'tool_choice'
  if (choosesTool(body.function_call)) return 'function_call'
  if (Array.isArray(body.messages) && body.messages.some((message) => {
    if (!isRecord(message)) return false
    if (message.role === 'tool' || message.role === 'function') return true
    if (hasItems(message.tool_calls) || hasFields(message.function_call)) return true
    return Array.isArray(message.content) && message.content.some(
      (part) => isRecord(part) && typeof part.type === 'string' && toolContentTypes.has(part.type),
    )
  })) return 'messages'
  return null
}

function toolError(param: string): GatewayError {
  const message = param === 'messages'
    ? 'Unknown item type: tool call or tool result in Inception Playground messages. Use an Inception API key for tool requests.'
    : `Unknown parameter: '${param}' for Inception Playground. Use an Inception API key for tool requests.`
  return new GatewayError(message, {
    status: 400,
    type: 'invalid_request_error',
    code: param === 'messages' ? 'unknown_item_type' : 'unknown_parameter',
    param,
  })
}

// ---------------------------------------------------------------------------
// Playground 响应归一化：去掉上游额外的 tool_call_id / warning / reasoning_summary
// ---------------------------------------------------------------------------

function normalizePlaygroundMessage(value: unknown): Record<string, unknown> {
  const message = isRecord(value) ? value : {}
  const out: Record<string, unknown> = {
    role: typeof message.role === 'string' ? message.role : 'assistant',
    content: typeof message.content === 'string' ? message.content : null,
  }
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    out.reasoning_content = message.reasoning_content
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    out.tool_calls = message.tool_calls
  }
  if (hasFields(message.function_call)) out.function_call = message.function_call
  if (typeof message.refusal === 'string' && message.refusal) out.refusal = message.refusal
  return out
}

function normalizePlaygroundCompletion(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) return raw
  return {
    ...raw,
    choices: raw.choices.map((choice, index) => {
      if (!isRecord(choice)) return choice
      return {
        ...choice,
        index: choiceIndex(choice.index, index),
        message: normalizePlaygroundMessage(choice.message),
        finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
      }
    }),
  }
}

function normalizePlaygroundChunk(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) return raw
  return {
    ...raw,
    choices: raw.choices.map((choice, index) => {
      if (!isRecord(choice)) return choice
      const delta = isRecord(choice.delta) ? choice.delta : {}
      const out: Record<string, unknown> = {}
      if (typeof delta.role === 'string') out.role = delta.role
      if (typeof delta.content === 'string') out.content = delta.content
      else if (delta.content === null) out.content = null
      if (typeof delta.reasoning_content === 'string') out.reasoning_content = delta.reasoning_content
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) out.tool_calls = delta.tool_calls
      if (hasFields(delta.function_call)) out.function_call = delta.function_call
      if (typeof delta.refusal === 'string') out.refusal = delta.refusal
      return {
        ...choice,
        index: choiceIndex(choice.index, index),
        delta: out,
        finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      }
    }),
  }
}
