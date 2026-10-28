import type {
  ChatChoiceMessage,
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
  ChatCompletionResponse,
  ChatMessageToolCall,
  ChatUsage,
} from './types'

const encoder = new TextEncoder()

export function sseData(payload: string | unknown): Uint8Array {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return encoder.encode(`data: ${data}\n\n`)
}

export function sseDone(): Uint8Array {
  return encoder.encode('data: [DONE]\n\n')
}

// ---------------------------------------------------------------------------
// 上游 SSE 解析
// ---------------------------------------------------------------------------

/** 从 SSE 流中逐个产出解析后的 JSON chunk（自动跳过 [DONE] 与非 JSON 行） */
export async function* parseSseJson(res: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ended = false
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })

  const emitBlock = (block: string): Record<string, unknown> | null => {
    const lines = block.split(/\r?\n/)
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith(':')) continue // 注释/心跳
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length === 0) return null
    const data = dataLines.join('\n')
    if (data === '[DONE]') return { __done: true }
    try {
      const parsed: unknown = JSON.parse(data)
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>
      }
      return null
    } catch {
      return null // 非法 JSON 静默跳过
    }
  }

  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) {
        ended = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let match: RegExpMatchArray | null
      // eslint-disable-next-line no-cond-assign
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice((match.index ?? 0) + match[0].length)
        const parsed = emitBlock(block)
        if (parsed === null) continue
        if (parsed.__done === true) return
        yield parsed
      }
    }
    const tail = emitBlock(buffer)
    if (tail !== null && tail.__done !== true) yield tail
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (!ended) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// chunk 归一化
// ---------------------------------------------------------------------------

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function normalizeChunk(
  chunk: Record<string, unknown>,
  requestModel: string,
  id: string,
  created: number,
): ChatCompletionChunk {
  const normalized: ChatCompletionChunk = {
    id: asString(chunk.id, id),
    object: 'chat.completion.chunk',
    created: asNumber(chunk.created, created),
    model: asString(chunk.model, requestModel),
    choices: [],
  }

  const rawChoices = Array.isArray(chunk.choices) ? chunk.choices : []
  normalized.choices = rawChoices
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((choice, i): ChatCompletionChunkChoice => {
      const delta = (typeof choice.delta === 'object' && choice.delta !== null
        ? choice.delta
        : {}) as Record<string, unknown>
      const deltaOut: ChatCompletionChunk['choices'][number]['delta'] = {}
      if (typeof delta.role === 'string') deltaOut.role = delta.role as 'assistant'
      if (typeof delta.content === 'string') deltaOut.content = delta.content
      else if (delta.content === null) deltaOut.content = null
      if (typeof delta.reasoning_content === 'string') deltaOut.reasoning_content = delta.reasoning_content
      if (Array.isArray(delta.tool_calls)) deltaOut.tool_calls = delta.tool_calls as ChatMessageToolCall[]
      if (typeof delta.function_call === 'object' && delta.function_call !== null) {
        deltaOut.function_call = delta.function_call as { name?: string; arguments?: string }
      }
      if (typeof delta.refusal === 'string') deltaOut.refusal = delta.refusal
      return {
        index: asNumber(choice.index, i),
        delta: deltaOut,
        finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        logprobs: choice.logprobs === undefined ? undefined : choice.logprobs,
      }
    })

  if (typeof chunk.usage === 'object' && chunk.usage !== null) {
    normalized.usage = chunk.usage as ChatUsage
  }
  return normalized
}

// ---------------------------------------------------------------------------
// chunk 聚合（上游流式 -> 客户端非流式）
// ---------------------------------------------------------------------------

interface ChoiceAccumulator {
  index: number
  role: string
  content: string | null
  reasoning: string
  hasReasoning: boolean
  toolCalls: Map<number, { id: string; type: string; name: string; arguments: string }>
  finishReason: string | null
  logprobs: unknown
}

export function aggregateChunks(
  chunks: Record<string, unknown>[],
  requestModel: string,
): ChatCompletionResponse {
  let id = ''
  let created = Math.floor(Date.now() / 1000)
  let model = requestModel
  let usage: ChatUsage | null = null
  const choices = new Map<number, ChoiceAccumulator>()

  for (const chunk of chunks) {
    if (typeof chunk.id === 'string' && chunk.id) id = chunk.id
    if (typeof chunk.created === 'number' && chunk.created) created = chunk.created
    if (typeof chunk.model === 'string' && chunk.model) model = chunk.model
    if (typeof chunk.usage === 'object' && chunk.usage !== null) {
      usage = chunk.usage as ChatUsage
    }
    const rawChoices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const raw of rawChoices) {
      if (typeof raw !== 'object' || raw === null) continue
      const choice = raw as Record<string, unknown>
      const index = asNumber(choice.index, 0)
      let acc = choices.get(index)
      if (!acc) {
        acc = {
          index,
          role: 'assistant',
          content: null,
          reasoning: '',
          hasReasoning: false,
          toolCalls: new Map(),
          finishReason: null,
          logprobs: undefined,
        }
        choices.set(index, acc)
      }
      const delta = (typeof choice.delta === 'object' && choice.delta !== null
        ? choice.delta
        : {}) as Record<string, unknown>
      if (typeof delta.role === 'string' && delta.role) acc.role = delta.role
      if (typeof delta.content === 'string') {
        acc.content = (acc.content ?? '') + delta.content
      }
      if (typeof delta.reasoning_content === 'string') {
        acc.reasoning += delta.reasoning_content
        acc.hasReasoning = true
      }
      if (Array.isArray(delta.tool_calls)) {
        mergeToolCalls(acc, delta.tool_calls)
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        acc.finishReason = choice.finish_reason
      }
      if (choice.logprobs !== undefined && choice.logprobs !== null) {
        acc.logprobs = choice.logprobs
      }
    }
  }

  const sorted = [...choices.values()].sort((a, b) => a.index - b.index)
  const finalChoices = sorted.map((acc) => {
    const message: ChatChoiceMessage = {
      role: acc.role as 'assistant',
      content: acc.content,
    }
    if (acc.hasReasoning) message.reasoning_content = acc.reasoning
    if (acc.toolCalls.size > 0) {
      message.tool_calls = [...acc.toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([i, tc]) => ({
          id: tc.id || `call_${i}`,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))
    }
    if (acc.toolCalls.size > 0 && acc.finishReason === null) acc.finishReason = 'tool_calls'
    if (acc.finishReason === null) acc.finishReason = 'stop'
    return {
      index: acc.index,
      message,
      finish_reason: acc.finishReason,
      logprobs: acc.logprobs,
    }
  })

  return {
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created,
    model,
    choices: finalChoices,
    usage,
  }
}

function mergeToolCalls(acc: ChoiceAccumulator, toolCalls: unknown[]): void {
  for (const raw of toolCalls) {
    if (typeof raw !== 'object' || raw === null) continue
    const tc = raw as Record<string, unknown>
    const index = asNumber(tc.index, acc.toolCalls.size)
    let slot = acc.toolCalls.get(index)
    if (!slot) {
      slot = { id: '', type: 'function', name: '', arguments: '' }
      acc.toolCalls.set(index, slot)
    }
    if (typeof tc.id === 'string' && tc.id) slot.id = tc.id
    if (typeof tc.type === 'string' && tc.type) slot.type = tc.type
    const fn = (typeof tc.function === 'object' && tc.function !== null
      ? tc.function
      : {}) as Record<string, unknown>
    if (typeof fn.name === 'string') slot.name += fn.name
    if (typeof fn.arguments === 'string') slot.arguments += fn.arguments
  }
}

// ---------------------------------------------------------------------------
// 响应合成（上游非流式 -> 客户端流式）
// ---------------------------------------------------------------------------

export function* streamFromCompletion(
  completion: ChatCompletionResponse,
  opts: { includeUsage: boolean } = { includeUsage: false },
): Generator<Uint8Array> {
  const { id, created, model, usage, choices } = completion
  const base = { id, created, model }

  const makeChunk = (
    choices: Array<Partial<ChatCompletionChunkChoice> & { index: number }>,
    chunkUsage?: ChatUsage | null,
  ): ChatCompletionChunk => ({
    ...base,
    object: 'chat.completion.chunk',
    choices: choices.map((c) => ({
      index: c.index,
      delta: c.delta ?? {},
      finish_reason: c.finish_reason ?? null,
      logprobs: undefined,
    })),
    ...(opts.includeUsage ? { usage: chunkUsage ?? null } : {}),
  })

  for (const choice of choices) {
    const index = choice.index
    const message = choice.message

    // role chunk
    yield sseData(makeChunk([{ index, delta: { role: message.role ?? 'assistant' } }]))

    // reasoning chunk
    const reasoning = message.reasoning_content
    if (typeof reasoning === 'string') {
      yield sseData(makeChunk([{ index, delta: { reasoning_content: reasoning } }]))
    }

    // content chunks（按 32 个码点切一刀，模拟流式节奏）
    const content = typeof message.content === 'string' ? message.content : ''
    if (content) {
      const cps = Array.from(content)
      const size = 32
      for (let i = 0; i < cps.length; i += size) {
        yield sseData(makeChunk([{ index, delta: { content: cps.slice(i, i + size).join('') } }]))
      }
    }

    // tool_calls chunk
    if (message.tool_calls && message.tool_calls.length > 0) {
      yield sseData(makeChunk([{ index, delta: { tool_calls: message.tool_calls } }]))
    }

    // finish chunk
    yield sseData(makeChunk([{ index, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }]))
  }

  // usage chunk（仅当客户端通过 stream_options.include_usage 请求时输出）
  if (usage && opts.includeUsage) {
    yield sseData(makeChunk([], usage))
  }

  yield sseDone()
}

// ---------------------------------------------------------------------------
// 上游流式透传（客户端流式）
// ---------------------------------------------------------------------------

export interface StreamTransformOptions {
  requestModel: string
  id: string
  created: number
  includeUsage?: boolean
  transformChunk?: (chunk: Record<string, unknown>) => Promise<unknown> | unknown
  signal?: AbortSignal
}

export function transformUpstreamSse(res: Response, options: StreamTransformOptions): ReadableStream<Uint8Array> {
  const cancellation = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let usageChunk: ChatCompletionChunk | undefined
      let completed = false
      const activeChoices = new Set<number>()
      const finishedChoices = new Set<number>()
      try {
        for await (const raw of parseSseJson(res, signal)) {
          if (signal.aborted) break
          const transformed = options.transformChunk ? await options.transformChunk(raw) : raw
          if (transformed === null || transformed === undefined) continue
          if (typeof transformed !== 'object') continue
          const chunk = normalizeChunk(
            transformed as Record<string, unknown>,
            options.requestModel,
            options.id,
            options.created,
          )
          for (const choice of chunk.choices) {
            activeChoices.add(choice.index)
            if (choice.finish_reason !== null) finishedChoices.add(choice.index)
          }
          // 后端可能把统计放在内容/结束 chunk，或单独放在 choices:[] 中。
          if (chunk.usage) usageChunk = { ...chunk, choices: [] }
          delete chunk.usage
          if (options.includeUsage) chunk.usage = null
          if (chunk.choices.length > 0) controller.enqueue(sseData(chunk))
        }
        completed = !signal.aborted && activeChoices.size > 0
          && [...activeChoices].every((index) => finishedChoices.has(index))
      } catch {
        // 上游中断：静默结束并补 [DONE]，保证客户端不挂死
      }
      try {
        if (completed && options.includeUsage && usageChunk) {
          controller.enqueue(sseData(usageChunk))
        }
        controller.enqueue(sseDone())
        controller.close()
      } catch {
        // controller 已关闭
      }
    },
    cancel(reason) {
      cancellation.abort(reason)
    },
  })
}

// ---------------------------------------------------------------------------
// 非流式响应归一化
// ---------------------------------------------------------------------------

export function normalizeCompletion(body: unknown, requestModel: string): ChatCompletionResponse | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>

  const rawChoices = Array.isArray(raw.choices) ? raw.choices : []
  const choices = rawChoices
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((choice, i) => {
      const message = (typeof choice.message === 'object' && choice.message !== null
        ? choice.message
        : {}) as Record<string, unknown>
      const normalizedMessage: ChatChoiceMessage = {
        role: asString(message.role, 'assistant') as 'assistant',
        content: typeof message.content === 'string' ? message.content : message.content === null ? null : '',
      }
      if (typeof message.reasoning_content === 'string') {
        normalizedMessage.reasoning_content = message.reasoning_content
      }
      if (Array.isArray(message.tool_calls)) {
        normalizedMessage.tool_calls = message.tool_calls as ChatMessageToolCall[]
      }
      if (typeof message.function_call === 'object' && message.function_call !== null) {
        normalizedMessage.function_call = message.function_call as { name?: string; arguments?: string }
      }
      if (typeof message.refusal === 'string' && message.refusal) {
        normalizedMessage.refusal = message.refusal
      }
      if (message.annotations !== undefined) {
        normalizedMessage.annotations = message.annotations
      }
      return {
        index: asNumber(choice.index, i),
        message: normalizedMessage,
        finish_reason:
          typeof choice.finish_reason === 'string'
            ? choice.finish_reason
            : choice.finish_reason === null
              ? null
              : 'stop',
        logprobs: choice.logprobs === undefined ? undefined : choice.logprobs,
      }
    })

  if (choices.length === 0 && typeof raw.content !== 'string') return null

  const finalChoices = choices.length
    ? choices
    : [
        {
          index: 0,
          message: { role: 'assistant' as const, content: asString(raw.content) },
          finish_reason: 'stop' as const,
          logprobs: undefined,
        },
      ]

  return {
    id: asString(raw.id, `chatcmpl-${crypto.randomUUID()}`),
    object: 'chat.completion',
    created: asNumber(raw.created, Math.floor(Date.now() / 1000)),
    model: asString(raw.model, requestModel),
    choices: finalChoices,
    usage: (typeof raw.usage === 'object' && raw.usage !== null
      ? (raw.usage as ChatUsage)
      : null),
  }
}
