import { describe, expect, it } from 'vitest'
import { createGatewayApp } from '../app/api'

// ---------------------------------------------------------------------------
// mock fetch
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string
  method: string
  headers: Headers
  body?: BodyInit | null | undefined
}

function makeFetch(handler: (req: CapturedRequest) => Response | Promise<Response>) {
  const calls: CapturedRequest[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured: CapturedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    }
    calls.push(captured)
    return handler(captured)
  }) as typeof fetch
  return { impl, calls }
}

function makeApp(handler: (req: CapturedRequest) => Response | Promise<Response>, env?: Record<string, string>) {
  const { impl, calls } = makeFetch(handler)
  const app = createGatewayApp({ fetch: impl, env })
  return { app, calls }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseOf(events: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

const completion = {
  id: 'chatcmpl-inception',
  object: 'chat.completion',
  created: 1792495964,
  model: 'mercury-3',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hello', tool_calls: [], tool_call_id: null },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 6,
    completion_tokens: 22,
    total_tokens: 28,
    completion_tokens_details: { reasoning_tokens: 20 },
  },
  warning: null,
  reasoning_summary: null,
}

const messages = [{ role: 'user', content: 'Say exactly: hello' }]
const functionTool = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }

function chatBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ model: 'mercury-3', messages, ...extra })
}

// ---------------------------------------------------------------------------
// 模型列表
// ---------------------------------------------------------------------------

describe('inception', () => {
  it('/models 返回静态模型列表，不访问上游', async () => {
    const { app, calls } = makeApp(() => jsonRes({}))
    const res = await app.request('/inception/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(['mercury-3', 'mercury-2.5', 'mercury-2'])
    expect(calls).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // API Key：官方 OpenAI 兼容接口
  // -------------------------------------------------------------------------

  it('普通 API Key 走官方 API，透传凭证与标准参数，省略 effort 时补 instant', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    const res = await app.request('/inception/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-real' },
      body: chatBody({
        temperature: 0.2,
        max_completion_tokens: 128,
        tools: [functionTool],
      }),
    })

    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://api.inceptionlabs.ai/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-real')
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.reasoning_effort).toBe('instant')
    expect(sent.temperature).toBe(0.2)
    expect(sent.max_completion_tokens).toBe(128)
    expect(sent.tools).toEqual([functionTool])
  })

  it('普通 API Key 在显式 none 时映射为 instant，其余档位原样保留', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    for (const [asked, sentEffort] of [[' none ', 'instant'], ['low', 'low'], ['high', 'high']]) {
      await app.request('/inception/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-real' },
        body: chatBody({ reasoning_effort: asked }),
      })
      const sent = JSON.parse(String(calls.at(-1)!.body))
      expect(sent.reasoning_effort).toBe(sentEffort)
    }
  })

  it('使用 x-api-key 时转换为 Bearer，并保留自定义 baseUrl 行为', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/inception/https://proxy.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-header' },
      body: chatBody(),
    })
    expect(calls[0].url).toBe('https://proxy.example/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-header')
  })

  // -------------------------------------------------------------------------
  // Playground：凭证为 "playground"
  // -------------------------------------------------------------------------

  it('playground 凭证切换到无鉴权 Playground 端点并只发送支持的参数', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion), {
      INCEPTION_API_KEY_FOR_DEV: 'sk-dev-must-not-be-used',
    })
    const res = await app.request('/inception/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer playground' },
      body: chatBody({
        max_completion_tokens: 64,
        reasoning_effort: 'none',
        temperature: 0.7,
        stop: ['x'],
        stream_options: { include_usage: true },
      }),
    })

    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://web-api-proxy.inceptionlabs.ai/v1/playground')
    expect(calls[0].headers.get('authorization')).toBeNull()
    expect(calls[0].headers.get('x-api-key')).toBeNull()
    expect(JSON.parse(String(calls[0].body))).toEqual({
      model: 'mercury-3',
      messages,
      max_tokens: 64,
      reasoning_effort: 'instant',
      stream: false,
    })
  })

  it('playground 凭证大小写与首尾空白不敏感，也可通过 x-api-key 传入', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    const res = await app.request('/inception/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': '  PlayGround  ' },
      body: chatBody({ stream: true }),
    })

    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://web-api-proxy.inceptionlabs.ai/v1/playground')
    expect(calls[0].headers.get('authorization')).toBeNull()
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.stream).toBe(true)
    expect(sent.reasoning_effort).toBe('instant')
  })

  it('playground 允许空工具声明，但不把工具字段发往上游', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    const res = await app.request('/inception/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer playground' },
      body: chatBody({ tools: [], functions: [], tool_choice: 'auto', function_call: 'none' }),
    })

    expect(res.status).toBe(200)
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.tools).toBeUndefined()
    expect(sent.functions).toBeUndefined()
    expect(sent.tool_choice).toBeUndefined()
    expect(sent.function_call).toBeUndefined()
  })

  const blockedTools: Array<[string, Record<string, unknown>, string]> = [
    ['工具声明', { tools: [functionTool] }, 'tools'],
    ['旧版 functions 声明', { functions: [functionTool.function] }, 'functions'],
    ['强制工具选择', { tool_choice: 'required' }, 'tool_choice'],
    ['旧版 function_call', { function_call: { name: 'get_weather' } }, 'function_call'],
    [
      '工具调用历史',
      { messages: [...messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }] },
      'messages',
    ],
    ['工具结果历史', { messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'Sunny' }] }, 'messages'],
    [
      '工具内容块',
      { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} }] }] },
      'messages',
    ],
  ]

  for (const [name, extra, param] of blockedTools) {
    it(`playground 在本地拒绝${name}，不访问上游`, async () => {
      const { app, calls } = makeApp(() => jsonRes(completion))
      const res = await app.request('/inception/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer playground' },
        body: chatBody(extra),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.type).toBe('invalid_request_error')
      expect(body.error.param).toBe(param)
      expect(body.error.code).toBe(param === 'messages' ? 'unknown_item_type' : 'unknown_parameter')
      expect(body.error.message).toContain('Use an Inception API key')
      expect(calls).toHaveLength(0)
    })
  }

  it('playground 流式响应归一化：去掉空 tool_calls 与上游额外字段，并补 [DONE]', async () => {
    const sse = sseOf([
      JSON.stringify({
        id: 'chatcmpl-6162',
        object: 'chat.completion.chunk',
        created: 1792495976,
        model: 'mercury-3',
        choices: [{ index: 0, delta: { content: 'ok', role: 'assistant', tool_calls: null }, finish_reason: 'stop' }],
        reasoning_summary: null,
      }),
      JSON.stringify({
        id: 'chatcmpl-6162',
        object: 'chat.completion.chunk',
        created: 1792495976,
        model: 'mercury-3',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      '[DONE]',
    ])
    const { app, calls } = makeApp(() => sse)
    const res = await app.request('/inception/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer playground' },
      body: chatBody({ stream: true }),
    })

    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"content":"ok"')
    expect(text).not.toContain('tool_calls')
    expect(text).not.toContain('reasoning_summary')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.stream).toBe(true)
    expect(sent.reasoning_effort).toBe('instant')
    expect(sent.stream_options).toBeUndefined()
  })

  it('playground 非流式响应剥掉 tool_call_id、空 tool_calls 与额外字段', async () => {
    const { app } = makeApp(() => jsonRes(completion))
    const res = await app.request('/inception/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer playground' },
      body: chatBody(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'hello' })
    expect(body.warning).toBeUndefined()
    expect(body.reasoning_summary).toBeUndefined()
  })

  it('playground 的 FastAPI 嵌套错误被提取为可读 message', async () => {
    const detail = JSON.stringify({
      error: {
        message: [{ type: 'value_error', msg: 'Model must be one of the following: mercury-3' }],
      },
    })
    const { app } = makeApp(() => jsonRes({ detail }, 400))
    const res = await app.request('/inception/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer playground' },
      body: chatBody({ model: 'not-a-model' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain('Model must be one of the following')
    expect(body.error.type).toBe('invalid_request_error')
  })
})
