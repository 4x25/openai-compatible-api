import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createGatewayApp, gateway, registerProvider } from '../app/api'
import type { Provider } from '../app/api'

// ---------------------------------------------------------------------------
// 测试用供应商
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<Provider> & { id: string }): Provider {
  return {
    name: overrides.id,
    defaultBaseUrl: 'https://mock.test/v1',
    models: [
      { id: 'mock-a', ownedBy: 'mock' },
      { id: 'mock-b', ownedBy: 'mock' },
    ],
    chat: {},
    images: {
      generations: { path: '/images/generations' },
      edits: { path: '/images/edits' },
    },
    video: {
      create: { path: '/video/generations' },
      get: { path: '/video/generations/{task_id}' },
    },
    ...overrides,
  }
}

registerProvider(makeProvider({ id: 'mock' }))
// 仅流式
registerProvider(makeProvider({ id: 'mockns', chat: { supportsNonStreaming: false } }))
// 仅非流式
registerProvider(makeProvider({ id: 'mockso', chat: { supportsStreaming: false } }))
// 认证转换：x-api-key 裸写入
registerProvider(makeProvider({ id: 'mockkey', auth: { header: 'x-api-key', scheme: '' } }))
// 参数抹平
registerProvider(
  makeProvider({
    id: 'mockparams',
    chat: { unsupportedParams: ['temperature'], extraParams: ['vendor_field'] },
  }),
)
// 无路径默认 baseUrl（自动补 /v1）
registerProvider(makeProvider({ id: 'mockpathless', defaultBaseUrl: 'https://pathless.example' }))
// env baseUrl 指定的供应商
registerProvider(makeProvider({ id: 'mockenv', defaultBaseUrl: 'https://default.example/v1' }))
// 无图片/视频能力
registerProvider(makeProvider({ id: 'mocktext', images: undefined, video: undefined }))

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

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1700000000,
  model: 'mock-a',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hello', reasoning_content: 'thinking...' },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
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

const defaultChatSse = () =>
  sseOf([
    JSON.stringify({ id: 'chatcmpl-1', created: 1700000000, model: 'mock-a', choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    JSON.stringify({ id: 'chatcmpl-1', created: 1700000000, model: 'mock-a', choices: [{ index: 0, delta: { content: 'he' } }] }),
    JSON.stringify({ id: 'chatcmpl-1', created: 1700000000, model: 'mock-a', choices: [{ index: 0, delta: { content: 'llo' } }] }),
    JSON.stringify({ id: 'chatcmpl-1', created: 1700000000, model: 'mock-a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    JSON.stringify({ id: 'chatcmpl-1', created: 1700000000, model: 'mock-a', choices: [], usage: completion.usage }),
    '[DONE]',
  ])

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeApp(handler: (req: CapturedRequest) => Response | Promise<Response>, env?: Record<string, string>) {
  const { impl, calls } = makeFetch(handler)
  const app = createGatewayApp({ fetch: impl, env })
  return { app, calls }
}

// ---------------------------------------------------------------------------
// 路由与错误抹平
// ---------------------------------------------------------------------------

describe('路由与错误抹平', () => {
  it('GET /:provider/v1/models 返回标准模型列表（无需上游）', async () => {
    const { app, calls } = makeApp(() => jsonRes({}))
    const res = await app.request('/mock/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.object).toBe('list')
    expect(body.data).toHaveLength(2)
    expect(body.data[0]).toEqual({ id: 'mock-a', object: 'model', created: 0, owned_by: 'mock' })
    expect(calls).toHaveLength(0)
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('saltyfish 暴露且仅暴露 3 个指定模型', async () => {
    const { app } = makeApp(() => jsonRes({}))
    const res = await app.request('/saltyfish/v1/models')
    const body = await res.json()
    expect(body.data.map((m: { id: string }) => m.id).sort()).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'gpt-6-astra',
    ])
  })

  it('未知供应商返回 OpenAI 错误信封', async () => {
    const { app } = makeApp(() => jsonRes({}))
    const res = await app.request('/nope/v1/models')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.code).toBe('unknown_provider')
  })

  it('gateway() 中间件放行非 API 路径给页面路由', async () => {
    const { impl } = makeFetch(() => jsonRes({}))
    const app = new Hono()
    app.use('*', gateway({ fetch: impl }))
    app.all('*', (c) => c.text('page'))
    const page = await app.request('/some/page')
    expect(await page.text()).toBe('page')
    const api = await app.request('/mock/v1/models')
    const body = await api.json()
    expect(body.object).toBe('list')
  })

  it('方法不允许返回 405 与 Allow 头', async () => {
    const { app, calls } = makeApp(() => jsonRes({}))
    const res = await app.request('/mock/v1/chat/completions', { method: 'DELETE' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('POST')
    const body = await res.json()
    expect(body.error.code).toBe('method_not_allowed')
    expect(calls).toHaveLength(0)
  })

  it('缺少必填参数返回 400', async () => {
    const { app, calls } = makeApp(() => jsonRes({}))
    const res = await app.request('/mock/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error.param).toBe('model')
    expect(calls).toHaveLength(0)
  })

  it('CORS：任意 origin 放行', async () => {
    const { app } = makeApp(() => jsonRes({}))
    const res = await app.request('/mock/v1/models', {
      headers: { origin: 'https://any.example' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const preflight = await app.request('/mock/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://any.example',
        'access-control-request-headers': 'authorization, content-type',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
  })
})

// ---------------------------------------------------------------------------
// baseUrl 解析
// ---------------------------------------------------------------------------

describe('baseUrl 解析', () => {
  const chatReq = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-a', messages: [{ role: 'user', content: 'hi' }] }),
  }

  it('/:provider/v1 使用默认 baseUrl', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/v1/chat/completions', chatReq)
    expect(calls[0].url).toBe('https://mock.test/v1/chat/completions')
  })

  it('/:provider/<任意上游URL> 原样使用，允许任意 host', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/https://other.example:8443/api/v2/chat/completions', chatReq)
    expect(calls[0].url).toBe('https://other.example:8443/api/v2/chat/completions')
  })

  it('多层路径的上游 baseUrl（如 /a/b/v4）逐段保留', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/https://upstream.com/a/b/v4/chat/completions', chatReq)
    expect(calls[0].url).toBe('https://upstream.com/a/b/v4/chat/completions')
    // 尾部斜杠也归一化
    await app.request('/mock/https://upstream.com/a/b/v4//chat/completions', chatReq)
    expect(calls[1].url).toBe('https://upstream.com/a/b/v4/chat/completions')
  })

  it('自定义 baseUrl 支持百分号编码形式', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/https%3A%2F%2Fother.example%2Fapi/chat/completions', chatReq)
    expect(calls[0].url).toBe('https://other.example/api/chat/completions')
  })

  it('自定义 baseUrl 保留查询参数', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/https://other.example/api?api-version=1/chat/completions', chatReq)
    expect(calls[0].url).toBe('https://other.example/api/chat/completions?api-version=1')
  })

  it('非法前缀返回 400 invalid_base_url', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    const res = await app.request('/mock/not-a-url/chat/completions', chatReq)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_base_url')
    const res2 = await app.request('/mock/ftp://x/chat/completions', chatReq)
    expect(res2.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('env ${PROVIDER}_BASE_URL 覆盖默认值', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion), { MOCKENV_BASE_URL: 'https://env.example/v9' })
    await app.request('/mockenv/v1/chat/completions', chatReq)
    expect(calls[0].url).toBe('https://env.example/v9/chat/completions')
  })

  it('默认 baseUrl 无路径时自动补 versionPath', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mockpathless/v1/chat/completions', chatReq)
    expect(calls[0].url).toBe('https://pathless.example/v1/chat/completions')
  })

  it('无版本前缀（/:provider/chat/completions）同样走默认 baseUrl', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/chat/completions', chatReq)
    expect(calls[0].url).toBe('https://mock.test/v1/chat/completions')
  })
})

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

describe('认证透传与转换', () => {
  const chatReq = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-client' },
    body: JSON.stringify({ model: 'mock-a', messages: [{ role: 'user', content: 'hi' }] }),
  }

  it('默认供应商原样透传 Authorization', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/v1/chat/completions', chatReq)
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-client')
  })

  it('客户端 x-api-key 转换为 Authorization: Bearer', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-key-header' },
      body: JSON.stringify({ model: 'mock-a', messages: [] }),
    })
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-key-header')
  })

  it('自定义认证头供应商：剥掉 Bearer 写入 x-api-key', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mockkey/v1/chat/completions', chatReq)
    expect(calls[0].headers.get('x-api-key')).toBe('sk-client')
    expect(calls[0].headers.get('authorization')).toBeNull()
  })

  it('dev key 兜底：无客户端凭证时使用 ${PROVIDER}_API_KEY_FOR_DEV', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion), { MOCK_API_KEY_FOR_DEV: 'sk-dev' })
    await app.request('/mock/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-a', messages: [] }),
    })
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-dev')
  })

  it('客户端凭证优先于 dev key', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion), { MOCK_API_KEY_FOR_DEV: 'sk-dev' })
    await app.request('/mock/v1/chat/completions', chatReq)
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-client')
  })

  it('无任何凭证时不带认证头，上游 401 被抹平', async () => {
    const { app, calls } = makeFetchHandler()
    await app.request('/mock/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-a', messages: [] }),
    })
    expect(calls[0].headers.get('authorization')).toBeNull()
  })
})

function makeFetchHandler() {
  const { impl, calls } = makeFetch(() => jsonRes({ error: 'Invalid API key' }, 401))
  const app = createGatewayApp({ fetch: impl })
  return { app, calls }
}

// ---------------------------------------------------------------------------
// 参数抹平
// ---------------------------------------------------------------------------

describe('参数抹平', () => {
  it('未知参数静默丢弃，已知参数透传', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mock/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-a',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        top_k: 2,
        some_unknown_param: { a: 1 },
      }),
    })
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.model).toBe('mock-a')
    expect(sent.temperature).toBe(0.5)
    expect(sent.top_k).toBeUndefined()
    expect(sent.some_unknown_param).toBeUndefined()
  })

  it('unsupportedParams 剔除、extraParams 放行', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    await app.request('/mockparams/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-a',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.9,
        vendor_field: 'yes',
      }),
    })
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.temperature).toBeUndefined()
    expect(sent.vendor_field).toBe('yes')
  })
})

// ---------------------------------------------------------------------------
// 流式转换矩阵
// ---------------------------------------------------------------------------

describe('流式转换矩阵', () => {
  const streamReq = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-a',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  }
  const plainReq = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-a', messages: [{ role: 'user', content: 'hi' }] }),
  }

  it('客户端流式 + 上游流式：透传并保证 [DONE]', async () => {
    const { app, calls } = makeApp(() => defaultChatSse())
    const res = await app.request('/mock/v1/chat/completions', streamReq)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.stream).toBe(true)
    expect(sent.stream_options).toEqual({ include_usage: true })
  })

  it('客户端流式 + 上游仅非流式：网关合成 SSE（截获等待后返回）', async () => {
    const { app, calls } = makeApp(() => jsonRes(completion))
    const res = await app.request('/mockso/v1/chat/completions', streamReq)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"delta":{"role":"assistant"}')
    expect(text).toContain('"content":"hello"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('"usage"')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.stream).toBeUndefined()
    expect(sent.stream_options).toBeUndefined()
  })

  it('客户端非流式 + 上游仅流式：网关聚合为完整 JSON', async () => {
    const { app, calls } = makeApp(() => defaultChatSse())
    const res = await app.request('/mockns/v1/chat/completions', plainReq)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].message.content).toBe('hello')
    expect(body.choices[0].message.reasoning_content).toBeUndefined()
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBe(3)
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.stream).toBe(true)
  })

  it('流式聚合保留 reasoning_content 与 tool_calls', async () => {
    const sse = sseOf([
      JSON.stringify({ id: 'c1', created: 1, model: 'mock-a', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }] }),
      JSON.stringify({ id: 'c1', created: 1, model: 'mock-a', choices: [{ index: 0, delta: { reasoning_content: 'ing', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"' } }] } }] }),
      JSON.stringify({ id: 'c1', created: 1, model: 'mock-a', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'x":1}' } }] } }] }),
      JSON.stringify({ id: 'c1', created: 1, model: 'mock-a', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ])
    const { app } = makeApp(() => sse)
    const res = await app.request('/mockns/v1/chat/completions', plainReq)
    const body = await res.json()
    expect(body.choices[0].message.reasoning_content).toBe('thinking')
    expect(body.choices[0].message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
    ])
    expect(body.choices[0].finish_reason).toBe('tool_calls')
  })

  it('上游流式中途断开：合成 [DONE] 保证客户端不挂死', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'),
        )
      },
      pull(controller) {
        controller.error(new Error('upstream broke'))
      },
    })
    const { app } = makeApp(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }))
    const res = await app.request('/mock/v1/chat/completions', streamReq)
    const text = await res.text()
    expect(text).toContain('"content":"hi"')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 上游错误抹平
// ---------------------------------------------------------------------------

describe('上游错误抹平', () => {
  const chatReq = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-a', messages: [{ role: 'user', content: 'hi' }] }),
  }

  it('{"error":"Invalid API key"} 401 -> OpenAI 错误信封', async () => {
    const { app } = makeApp(() => jsonRes({ error: 'Invalid API key' }, 401))
    const res = await app.request('/mock/v1/chat/completions', chatReq)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.message).toBe('Invalid API key')
    expect(body.error.type).toBe('authentication_error')
    expect(body.error.param).toBeNull()
  })

  it('纯文本 502（saltyfish 风格）-> 502 OpenAI 错误', async () => {
    const { app } = makeApp(() => new Response('error code: 502', { status: 502, headers: { 'content-type': 'text/plain' } }))
    const res = await app.request('/mock/v1/chat/completions', chatReq)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.message).toContain('error code: 502')
    expect(body.error.type).toBe('api_error')
  })

  it('{"error":{"message":...}} OpenAI 风格透传 message', async () => {
    const { app } = makeApp(() =>
      jsonRes({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'billing_hard_limit_reached' } }, 429),
    )
    const res = await app.request('/mock/v1/chat/completions', chatReq)
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error.message).toBe('You exceeded your current quota')
    expect(body.error.type).toBe('insufficient_quota')
    expect(body.error.code).toBe('billing_hard_limit_reached')
  })

  it('上游 200 返回非 JSON 内容 -> 包装为 assistant content', async () => {
    const { app } = makeApp(() => new Response('plain text reply', { headers: { 'content-type': 'text/plain' } }))
    const res = await app.request('/mock/v1/chat/completions', chatReq)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('plain text reply')
    expect(body.object).toBe('chat.completion')
  })
})

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

describe('图片端点', () => {
  it('generations：JSON 请求过滤 + 响应透传归一化', async () => {
    const { app, calls } = makeApp(() => jsonRes({ created: 1, data: [{ url: 'https://img.example/1.png' }] }))
    const res = await app.request('/mock/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-a', prompt: 'a cat', foo: 'x', n: 1 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].url).toBe('https://img.example/1.png')
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.prompt).toBe('a cat')
    expect(sent.foo).toBeUndefined()
    expect(calls[0].url).toBe('https://mock.test/v1/images/generations')
  })

  it('上游返回二进制图片时包装为 b64_json', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const { app } = makeApp(() => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    const res = await app.request('/mock/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-a', prompt: 'a cat' }),
    })
    const body = await res.json()
    expect(body.data[0].b64_json).toBe(btoa('\x01\x02\x03\x04'))
  })

  it('edits：multipart 字段过滤，文件透传', async () => {
    const { app, calls } = makeApp(() => jsonRes({ data: [{ url: 'https://img.example/out.png' }] }))
    const form = new FormData()
    form.append('model', 'mock-a')
    form.append('prompt', 'make it red')
    form.append('evil_field', 'drop me')
    form.append('image', new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), 'in.png')
    const res = await app.request('/mock/v1/images/edits', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const upstreamForm = calls[0].body as FormData
    expect(upstreamForm).toBeInstanceOf(FormData)
    expect(upstreamForm.get('model')).toBe('mock-a')
    expect(upstreamForm.get('prompt')).toBe('make it red')
    expect(upstreamForm.get('evil_field')).toBeNull()
    expect((upstreamForm.get('image') as File).name).toBe('in.png')
    const body = await res.json()
    expect(body.data[0].url).toBe('https://img.example/out.png')
  })

  it('供应商无图片能力时返回 unsupported_endpoint', async () => {
    const { app, calls } = makeApp(() => jsonRes({}))
    const res = await app.request('/saltyfish/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', prompt: 'y' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('unsupported_endpoint')
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 视频
// ---------------------------------------------------------------------------

describe('视频端点', () => {
  it('POST /video/generations 创建任务并归一化状态', async () => {
    const { app, calls } = makeApp(() => jsonRes({ id: 'task_1', status: 'processing' }))
    const res = await app.request('/mock/v1/video/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-a', prompt: 'a sunset', foo: 'x' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('task_1')
    expect(body.object).toBe('video.generation')
    expect(body.status).toBe('in_progress')
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.foo).toBeUndefined()
  })

  it('GET /video/generations/{task_id} 查询任务，路径占位符替换', async () => {
    const { app, calls } = makeApp(() => jsonRes({ id: 'task_1', status: 'succeeded', url: 'https://v.example/1.mp4' }))
    const res = await app.request('/mock/v1/video/generations/task_1')
    expect(res.status).toBe(200)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://mock.test/v1/video/generations/task_1')
    const body = await res.json()
    expect(body.status).toBe('succeeded')
    expect(body.video.url).toBe('https://v.example/1.mp4')
  })

  it('供应商无视频能力时返回 unsupported_endpoint', async () => {
    const { app, calls } = makeApp(() => jsonRes({}))
    const res = await app.request('/mocktext/v1/video/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-a', prompt: 'x' }),
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('unsupported_endpoint')
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// inceptionlabs-playground（真实供应商：/playground 端点、无需鉴权、stream 默认流式的怪癖）
// ---------------------------------------------------------------------------

describe('inceptionlabs-playground', () => {
  const ilpCompletion = {
    id: 'chatcmpl-41ea0baa-5f9c-4ad2-87b7-572c5212b9c9',
    object: 'chat.completion',
    created: 1792495964,
    model: 'mercury-2',
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
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: { reasoning_tokens: 20 },
    },
    warning: null,
    reasoning_summary: null,
  }

  it('/models 返回静态声明的 3 个 mercury 模型（上游无 /models 端点）', async () => {
    const { app, calls } = makeApp(() => jsonRes({}))
    const res = await app.request('/inceptionlabs-playground/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(['mercury-2', 'mercury-2.5', 'mercury-3'])
    expect(calls).toHaveLength(0)
  })

  it('chat 走 /playground 端点，非流式显式 stream:false（上游省略 stream 会默认流式）', async () => {
    const { app, calls } = makeApp(() => jsonRes(ilpCompletion))
    const res = await app.request('/inceptionlabs-playground/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mercury-2',
        messages: [{ role: 'user', content: 'Say exactly: hello' }],
        max_tokens: 64,
        reasoning_effort: 'low',
        temperature: 0.7,
      }),
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://web-api-proxy.inceptionlabs.ai/v1/playground')
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.stream).toBe(false)
    expect(sent.reasoning_effort).toBe('low')
    expect(sent.model).toBe('mercury-2')
    // 出参归一化：剥掉上游的 tool_call_id / warning 等额外字段
    const body = await res.json()
    expect(body.choices[0].message.content).toBe('hello')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBe(28)
    expect(body.warning).toBeUndefined()
    expect(body.choices[0].message.tool_call_id).toBeUndefined()
  })

  it('chat 流式：stream:true 透传 + [DONE] 兜底', async () => {
    const sse = sseOf([
      JSON.stringify({
        id: 'chatcmpl-6162',
        object: 'chat.completion.chunk',
        created: 1792495976,
        model: 'mercury-2',
        choices: [{ index: 0, delta: { content: 'ok', role: 'assistant', tool_calls: null }, finish_reason: 'stop' }],
        reasoning_summary: null,
      }),
      JSON.stringify({
        id: 'chatcmpl-6162',
        object: 'chat.completion.chunk',
        created: 1792495976,
        model: 'mercury-2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }),
      '[DONE]',
    ])
    const { app, calls } = makeApp(() => sse)
    const res = await app.request('/inceptionlabs-playground/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mercury-3',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        reasoning_effort: 'instant',
      }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"content":"ok"')
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.stream).toBe(true)
    expect(sent.reasoning_effort).toBe('instant')
  })

  it('无需鉴权：客户端 Authorization 不转发给上游（防 key 泄露）', async () => {
    const { app, calls } = makeApp(() => jsonRes(ilpCompletion), {
      INCEPTIONLABS_PLAYGROUND_API_KEY_FOR_DEV: 'sk-dev-leak-check',
    })
    await app.request('/inceptionlabs-playground/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-gateway-secret' },
      body: JSON.stringify({ model: 'mercury-2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(calls[0].headers.get('authorization')).toBeNull()
    expect(calls[0].headers.get('x-api-key')).toBeNull()
  })

  it('FastAPI 嵌套 JSON 字符串错误（非法 model 400）被提取为可读 message', async () => {
    const fastapiDetail = JSON.stringify({
      error: {
        message: [
          { type: 'value_error', loc: ['body', 'model'], msg: 'Value error, Model must be one of the following: mercury, mercury-2, mercury-2.5, mercury-3' },
        ],
      },
    })
    const { app } = makeApp(() => jsonRes({ detail: fastapiDetail }, 400))
    const res = await app.request('/inceptionlabs-playground/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain('Model must be one of the following')
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('FastAPI 数组校验错误（422 detail:[...]）逐项提取', async () => {
    const { app } = makeApp(() =>
      jsonRes({ detail: [{ type: 'missing', loc: ['body', 'messages'], msg: 'Field required' }] }, 422),
    )
    const res = await app.request('/inceptionlabs-playground/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mercury-2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.message).toBe('Field required')
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('流式请求的 stream_options.include_usage 不受 unsupportedParams 丢弃影响', async () => {
    const { app, calls } = makeApp(() => defaultChatSse())
    const res = await app.request('/inceptionlabs-playground/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mercury-2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
    expect(res.status).toBe(200)
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.stream).toBe(true)
    expect(sent.stream_options).toEqual({ include_usage: true })
    // unsupportedParams 的丢弃只作用于客户端原样字段，不影响网关重新添加的字段
    expect(sent.temperature).toBeUndefined()
    expect(sent.user).toBeUndefined()
  })

  it('流式请求：客户端原样传入的 unsupportedParams 字段确实被丢弃', async () => {
    const { app, calls } = makeApp(() => defaultChatSse())
    await app.request('/inceptionlabs-playground/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mercury-2',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        temperature: 0.9,
        user: 'someone',
        tools: [],
      }),
    })
    const sent = JSON.parse(String(calls[0].body))
    expect(sent.temperature).toBeUndefined()
    expect(sent.user).toBeUndefined()
    expect(sent.tools).toBeUndefined()
    expect(sent.model).toBe('mercury-2')
  })

  it('单元素数组错误不把 FastAPI type 泄漏为 OpenAI error.type', async () => {
    const { app } = makeApp(() => jsonRes([{ type: 'missing', msg: 'Field required' }], 400))
    const res = await app.request('/inceptionlabs-playground/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mercury-2', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toBe('Field required')
    expect(body.error.type).toBe('invalid_request_error')
  })
})
