/**
 * OpenAI compatible API 的请求 / 响应类型定义。
 *
 * 网关对外只暴露这些标准形状；供应商适配层负责把上游的真实形状
 * 转换为这里的类型，或声明“上游就是该形状”从而走默认透传。
 */

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string
  object?: string
  created?: number
  ownedBy?: string
}

export interface ModelListResponse {
  object: 'list'
  data: Array<{
    id: string
    object: 'model'
    created: number
    owned_by: string
  }>
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatMessageToolCallFunction {
  name?: string
  arguments?: string
}

export interface ChatMessageToolCall {
  id?: string
  type?: 'function'
  index?: number
  function?: ChatMessageToolCallFunction
}

export interface ChatRequestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | (string & {})
  content?: string | Array<Record<string, unknown>> | null
  name?: string
  /** 兼容扩展：assistant 历史中的推理文本及旧别名。 */
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: ChatMessageToolCall[]
  tool_call_id?: string
}

export interface ChatRequestLogitBias {
  [token: string]: number
}

/** 标准 OpenAI chat/completions 请求体 */
export interface ChatCompletionRequest {
  model: string
  messages: ChatRequestMessage[]
  frequency_penalty?: number
  logit_bias?: ChatRequestLogitBias
  logprobs?: boolean
  top_logprobs?: number
  max_tokens?: number
  max_completion_tokens?: number
  n?: number
  presence_penalty?: number
  response_format?: { type?: string; [k: string]: unknown }
  seed?: number
  stop?: string | string[]
  stream?: boolean
  stream_options?: { include_usage?: boolean; [k: string]: unknown }
  temperature?: number
  top_p?: number
  tools?: Array<Record<string, unknown>>
  tool_choice?: unknown
  user?: string
  parallel_tool_calls?: boolean
  reasoning_effort?: string
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  [k: string]: unknown
}

export interface ChatChoiceMessage {
  role: 'assistant' | (string & {})
  content: string | null
  refusal?: string | null
  reasoning_content?: string | null
  tool_calls?: ChatMessageToolCall[]
  function_call?: { name?: string; arguments?: string } | null
  [k: string]: unknown
}

export interface ChatCompletionChoice {
  index: number
  message: ChatChoiceMessage
  finish_reason: string | null
  logprobs?: unknown
}

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage: ChatUsage | null
  [k: string]: unknown
}

export interface ChatCompletionChunkChoiceDelta {
  role?: 'assistant' | (string & {})
  content?: string | null
  refusal?: string | null
  reasoning_content?: string | null
  tool_calls?: ChatMessageToolCall[]
  function_call?: { name?: string; arguments?: string } | null
}

export interface ChatCompletionChunkChoice {
  index: number
  delta: ChatCompletionChunkChoiceDelta
  finish_reason: string | null
  logprobs?: unknown
}

export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: ChatCompletionChunkChoice[]
  usage?: ChatUsage | null
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageGenerationRequest {
  model: string
  prompt: string
  n?: number
  size?: string
  quality?: string
  style?: string
  response_format?: 'url' | 'b64_json'
  user?: string
  [k: string]: unknown
}

export interface ImageData {
  url?: string
  b64_json?: string
  revised_prompt?: string
  [k: string]: unknown
}

export interface ImagesResponse {
  created: number
  data: ImageData[]
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface VideoGenerationRequest {
  model: string
  prompt?: string
  image?: string
  size?: string
  duration?: number | string
  n?: number
  [k: string]: unknown
}

export interface VideoGenerationResponse {
  id: string
  object: 'video.generation'
  created: number
  model: string
  status: 'queued' | 'in_progress' | 'succeeded' | 'failed'
  video?: { url?: string; [k: string]: unknown } | null
  data?: Array<{ url?: string; [k: string]: unknown }>
  error?: OpenAiError | null
  usage?: Record<string, unknown> | null
  [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface OpenAiError {
  message: string
  type: string
  param: string | null
  code: string | number | null
}

export interface OpenAiErrorResponse {
  error: OpenAiError
}
