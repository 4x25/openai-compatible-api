import { describe, expect, it } from 'vitest'
import { createGatewayApp } from '../app/api'
import { ifm } from '../app/api/providers/ifm'
import type { ProviderCallContext } from '../app/api/providers/types'
import type { ChatCompletionChunk, ChatCompletionRequest } from '../app/api/types'

const model = 'IFM/K2-Horizon-375B-A23B'
const jaisModel = 'IFM/Jais-3-MoVA-36B-A4B'
const usage = {
  prompt_tokens: 15,
  completion_tokens: 10,
  total_tokens: 25,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 7 },
}
const meta = { id: 'chatcmpl-ifm-test', created: 1700000000, model }
const completion = {
  ...meta,
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK', reasoning: 'Check.' }, finish_reason: 'stop' }],
  usage,
}
const toolCall = {
  id: 'call-ifm-test',
  type: 'function' as const,
  function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' },
}

interface CapturedRequest {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function makeApp(
  handler: (req: CapturedRequest) => Response | Promise<Response> = () => jsonRes(completion),
  env: Record<string, string> = {},
) {
  const calls: CapturedRequest[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    }
    calls.push(req)
    return handler(req)
  }) as typeof fetch
  return { app: createGatewayApp({ fetch: fetchImpl, env }), calls }
}

function chatReq(body: Record<string, unknown> = {}, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply OK.' }], ...body }),
  }
}

function chunk(delta: Record<string, unknown>, finishReason?: string, chunkUsage?: unknown) {
  return {
    ...meta,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...(chunkUsage !== undefined ? { usage: chunkUsage } : {}),
  }
}

function sseRes(events: unknown[], done = true): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    + (done ? 'data: [DONE]\n\n' : '')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

function parseStream(text: string): ChatCompletionChunk[] {
  expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  expect(text.match(/data: \[DONE\]/g)).toHaveLength(1)
  return text.split('\n\n')
    .filter((event) => event.startsWith('data: {'))
    .map((event) => JSON.parse(event.slice(6)) as ChatCompletionChunk)
}

describe('IFM 注册与认证', () => {
  it('静态模型列表只包含两种聊天模型，不调用上游', async () => {
    const { app, calls } = makeApp()
    const res = await app.request('/ifm/v1/models')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([
      { id: model, object: 'model', created: 0, owned_by: 'MBZUAI' },
      { id: jaisModel, object: 'model', created: 0, owned_by: 'MBZUAI' },
    ])
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['/ifm/v1/chat/completions', {}, 'https://api.ifm.ai/v1/chat/completions'],
    ['/ifm/chat/completions', { IFM_BASE_URL: 'https://env.example' }, 'https://env.example/v1/chat/completions'],
    ['/ifm/https://custom.example/api/chat/completions', { IFM_BASE_URL: 'https://env.example' }, 'https://custom.example/api/chat/completions'],
  ])('解析 baseUrl：%s', async (path, env, url) => {
    const { app, calls } = makeApp(undefined, env)
    expect((await app.request(path, chatReq())).status).toBe(200)
    expect(calls[0].url).toBe(url)
  })

  it.each([
    [{ authorization: 'Bearer test-client', 'x-api-key': 'test-api-key' }, 'Bearer test-client'],
    [{ 'x-api-key': 'test-api-key' }, 'Bearer test-api-key'],
    [{}, 'Bearer test-dev-key'],
  ])('凭证优先级：%j', async (headers, expected) => {
    const { app, calls } = makeApp(undefined, { IFM_API_KEY_FOR_DEV: 'test-dev-key' })
    await app.request('/ifm/v1/chat/completions', chatReq({}, headers))
    expect(calls[0].headers.get('authorization')).toBe(expected)
    expect(calls[0].headers.get('x-api-key')).toBeNull()
  })

  it.each(['/ifm/v1/images/generations', '/ifm/v1/videos'])('能力未声明时返回 unsupported_endpoint：%s', async (path) => {
    const { app, calls } = makeApp()
    const res = await app.request(path, chatReq())
    expect((await res.json()).error.code).toBe('unsupported_endpoint')
    expect(calls).toHaveLength(0)
  })
})

describe('IFM 请求转换', () => {
  it('按原顺序映射 developer，拼接纯文本块并保留 name', async () => {
    const { app, calls } = makeApp()
    const res = await app.request('/ifm/v1/chat/completions', chatReq({
      messages: [
        { role: 'developer', name: 'rules', content: [{ type: 'text', text: 'Rule ' }, { type: 'text', text: 'A\n' }] },
        { role: 'system', content: 'Rule B' },
        { role: 'user', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] },
      ],
    }))
    expect(res.status).toBe(200)
    expect(calls[0].body.messages).toEqual([
      { role: 'system', name: 'rules', content: 'Rule A\n' },
      { role: 'system', content: 'Rule B' },
      { role: 'user', content: 'hello' },
    ])
  })

  it.each([
    [{}, ''],
    [{ reasoning_content: '' }, ''],
    [{ reasoning: 'legacy trace' }, 'legacy trace'],
    [{ reasoning_content: 'canonical', reasoning: 'legacy' }, 'canonical'],
    [{ reasoning_content: '', reasoning: 'legacy' }, ''],
    [{ reasoning_content: null, reasoning: 'legacy' }, 'legacy'],
    [{ reasoning_content: null, reasoning: null }, ''],
  ])('assistant 推理字段优先级与空值：%j', async (fields, expected) => {
    const { app, calls } = makeApp()
    const res = await app.request('/ifm/v1/chat/completions', chatReq({
      messages: [{ role: 'assistant', content: 'OK', ...fields }, { role: 'user', content: 'Continue.' }],
    }))
    expect(res.status).toBe(200)
    expect(calls[0].body.messages).toEqual([
      { role: 'assistant', content: 'OK', reasoning_content: expected, reasoning: expected },
      { role: 'user', content: 'Continue.' },
    ])
  })

  it.each([null, undefined])('工具历史 content=%s 转为空字符串，保留调用关联和 arguments', async (content) => {
    const { app, calls } = makeApp()
    await app.request('/ifm/v1/chat/completions', chatReq({
      messages: [
        { role: 'assistant', content, tool_calls: [toolCall], reasoning_content: 'Need weather.' },
        { role: 'tool', tool_call_id: toolCall.id, content: [{ type: 'text', text: '{"sunny":true}' }] },
      ],
    }))
    expect(calls[0].body.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [toolCall], reasoning_content: 'Need weather.', reasoning: 'Need weather.' },
      { role: 'tool', tool_call_id: toolCall.id, content: '{"sunny":true}' },
    ])
  })

  it.each([
    [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }, 'messages.0.content.1'],
    [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'placeholder', format: 'wav' } }] }, 'messages.0.content.0'],
    [{ role: 'user', content: [{ type: 'text', text: 1 }] }, 'messages.0.content.0.text'],
    [{ role: 'user', content: null }, 'messages.0.content'],
    [{ role: 'assistant' }, 'messages.0.content'],
    [{ role: 'invalid', content: 'hello' }, 'messages.0.role'],
    [{ role: { toString: 'user' }, content: 'hello' }, 'messages.0.role'],
    [null, 'messages.0'],
  ])('非法消息返回具体 param：%j', async (message, param) => {
    const { app, calls } = makeApp()
    const res = await app.request('/ifm/v1/chat/completions', chatReq({ messages: [message] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_parameter', param })
    expect(calls).toHaveLength(0)
  })

  it('保留标准采样、推理、结构化输出及工具参数，过滤未知参数', async () => {
    const params = {
      temperature: 0.3,
      top_p: 0.9,
      stop: ['end'],
      seed: 42,
      reasoning_effort: 'low',
      max_completion_tokens: 128,
      logprobs: true,
      top_logprobs: 2,
      tools: [{ type: 'function', function: { name: 'lookup_weather', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
      parallel_tool_calls: false,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema: { type: 'object' } } },
      n: 1,
    }
    const { app, calls } = makeApp()
    await app.request('/ifm/v1/chat/completions', chatReq({ ...params, unknown: true }))
    expect(calls[0].body).toMatchObject(params)
    expect(calls[0].body.unknown).toBeUndefined()
    expect(calls[0].body.chat_template_kwargs).toBeUndefined()
    expect(calls[0].body.tool_call_format).toBeUndefined()
    expect(calls[0].body.stream).toBeUndefined()
  })

  it.each([2, 0, -1, '1'])('拒绝 n=%s，避免静默降级或拆分付费请求', async (n) => {
    const { app, calls } = makeApp()
    const res = await app.request('/ifm/v1/chat/completions', chatReq({ n }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.param).toBe('n')
    expect(calls).toHaveLength(0)
  })

  it('转换不修改调用方的消息、content 数组或工具对象', async () => {
    const req: ChatCompletionRequest = {
      model,
      messages: [
        { role: 'developer', content: [{ type: 'text', text: 'Rule' }] },
        { role: 'assistant', content: null, reasoning: 'trace', tool_calls: [toolCall] },
      ],
    }
    const original = structuredClone(req)
    await ifm.chat!.transformRequest!(req, {} as ProviderCallContext)
    expect(req).toEqual(original)
  })
})

describe('IFM 响应与多轮兼容', () => {
  it.each([
    [{ reasoning: 'legacy' }, 'legacy'],
    [{ reasoning_content: 'canonical', reasoning: 'legacy' }, 'canonical'],
    [{ reasoning_content: '', reasoning: 'legacy' }, ''],
    [{ reasoning: '' }, ''],
    [{ reasoning_content: null, reasoning: 'legacy' }, 'legacy'],
  ])('非流式推理别名归一化：%j', async (fields, expected) => {
    const upstream = {
      ...completion,
      time_info: { total_time: 1 },
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK', ...fields }, finish_reason: 'stop' }],
    }
    const original = structuredClone(upstream)
    const { app } = makeApp(() => jsonRes(upstream))
    const body = await (await app.request('/ifm/v1/chat/completions', chatReq())).json()
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'OK', reasoning_content: expected })
    expect(body.usage).toEqual(usage)
    expect(body.time_info).toBeUndefined()
    await ifm.chat!.transformResponse!(upstream, {} as ProviderCallContext)
    expect(upstream).toEqual(original)
  })

  it('工具响应补 content:null，保留 finish_reason 与工具结构', async () => {
    const { app } = makeApp(() => jsonRes({
      ...completion,
      choices: [{ index: 0, message: { role: 'assistant', reasoning: '', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
    }))
    const body = await (await app.request('/ifm/v1/chat/completions', chatReq())).json()
    expect(body.choices[0]).toEqual({
      index: 0,
      message: { role: 'assistant', content: null, reasoning_content: '', tool_calls: [toolCall] },
      finish_reason: 'tool_calls',
    })
  })

  it('规范化的 assistant 可直接回传，工具多轮保持调用关联', async () => {
    const { app, calls } = makeApp((req) => calls.length === 1 ? jsonRes({
      ...completion,
      choices: [{ index: 0, message: { role: 'assistant', reasoning: 'Need weather.', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
    }) : jsonRes(completion))
    const first = await (await app.request('/ifm/v1/chat/completions', chatReq())).json()
    const second = await app.request('/ifm/v1/chat/completions', chatReq({
      messages: [
        { role: 'user', content: 'Paris weather?' },
        first.choices[0].message,
        { role: 'tool', tool_call_id: toolCall.id, content: '{"sunny":true}' },
      ],
    }))
    expect(second.status).toBe(200)
    expect(calls[1].body.messages).toEqual([
      { role: 'user', content: 'Paris weather?' },
      { role: 'assistant', content: '', reasoning_content: 'Need weather.', reasoning: 'Need weather.', tool_calls: [toolCall] },
      { role: 'tool', tool_call_id: toolCall.id, content: '{"sunny":true}' },
    ])
  })

  it('低推理强度保留用户值和上游混合文本，不进行分隔符删除', async () => {
    const content = 'Thinking text\n</ifm|think>\nOK'
    const { app, calls } = makeApp(() => jsonRes({
      ...completion,
      choices: [{ index: 0, message: { role: 'assistant', content, reasoning: '' }, finish_reason: 'stop' }],
    }))
    const body = await (await app.request('/ifm/v1/chat/completions', chatReq({ reasoning_effort: 'low' }))).json()
    expect(calls[0].body.reasoning_effort).toBe('low')
    expect(body.choices[0].message.content).toBe(content)
  })
})

describe('IFM 流式与转换矩阵', () => {
  it('K2 流中推理不重复累计，拆分结束 chunk 的 usage', async () => {
    const { app, calls } = makeApp(() => sseRes([
      chunk({ role: 'assistant' }),
      chunk({ reasoning: 'Check ' }),
      chunk({ reasoning_content: 'done.', reasoning: 'done.' }),
      chunk({ content: 'OK' }, 'stop', usage),
    ]))
    const events = parseStream(await (await app.request('/ifm/v1/chat/completions', chatReq({
      stream: true, stream_options: { include_usage: true },
    }))).text())
    expect(events.slice(0, -1).every((event) => event.usage === null)).toBe(true)
    expect(events.flatMap((event) => event.choices).map((choice) => choice.delta.reasoning_content ?? '').join('')).toBe('Check done.')
    expect(events.at(-2)?.choices[0]).toMatchObject({ delta: { content: 'OK' }, finish_reason: 'stop' })
    expect(events.at(-1)).toEqual({ ...meta, object: 'chat.completion.chunk', choices: [], usage })
    expect(calls[0].body.stream_options).toEqual({ include_usage: true })
    expect(JSON.stringify(events)).not.toContain('"reasoning":')
  })

  it.each([undefined, { include_usage: false }])('未请求 usage 时丢弃上游统计，保留内容和结束原因：%j', async (streamOptions) => {
    const { app, calls } = makeApp(() => sseRes([
      chunk({ content: 'OK' }, 'stop', usage),
      { ...meta, choices: [], usage },
    ]))
    const events = parseStream(await (await app.request('/ifm/v1/chat/completions', chatReq({
      stream: true, stream_options: streamOptions,
    }))).text())
    expect(events).toHaveLength(1)
    expect(events[0].choices[0]).toMatchObject({ delta: { content: 'OK' }, finish_reason: 'stop' })
    expect(events.every((event) => !('usage' in event))).toBe(true)
    expect(calls[0].body.stream_options).toBeUndefined()
  })

  it('Jais 独立 usage chunk 不重复发送，以最后一份上游统计为准', async () => {
    const finalUsage = { ...usage, prompt_tokens: 16, total_tokens: 26 }
    const { app } = makeApp(() => sseRes([
      { ...chunk({ role: 'assistant', reasoning: '' }), model: jaisModel },
      { ...chunk({ content: 'OK' }, 'stop'), model: jaisModel },
      { ...meta, model: jaisModel, choices: [], usage },
      { ...meta, model: jaisModel, choices: [], usage: finalUsage },
    ]))
    const events = parseStream(await (await app.request('/ifm/v1/chat/completions', chatReq({
      model: jaisModel, stream: true, stream_options: { include_usage: true },
    }))).text())
    expect(events.filter((event) => event.usage)).toHaveLength(1)
    expect(events[0].choices[0].delta.reasoning_content).toBe('')
    expect(events.at(-1)).toEqual({ ...meta, model: jaisModel, object: 'chat.completion.chunk', choices: [], usage: finalUsage })
  })

  it('上游没有 usage 时不编造统计，缺少 DONE 时只补一次', async () => {
    const { app } = makeApp(() => sseRes([chunk({ content: 'OK' }, 'stop')], false))
    const events = parseStream(await (await app.request('/ifm/v1/chat/completions', chatReq({
      stream: true, stream_options: { include_usage: true },
    }))).text())
    expect(events).toHaveLength(1)
    expect(events[0].usage).toBeNull()
  })

  it('流式工具参数片段原样透传，保留 index 和 finish_reason', async () => {
    const fragments = [
      { index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: '{"city":' } },
      { index: 0, function: { arguments: '"Paris"}' } },
    ]
    const { app } = makeApp(() => sseRes([
      chunk({ tool_calls: [fragments[0]] }),
      chunk({ tool_calls: [fragments[1]] }),
      chunk({}, 'tool_calls', usage),
    ]))
    const events = parseStream(await (await app.request('/ifm/v1/chat/completions', chatReq({ stream: true }))).text())
    expect(events.flatMap((event) => event.choices.flatMap((choice) => choice.delta.tool_calls ?? []))).toEqual(fragments)
    expect(events.at(-1)?.choices[0].finish_reason).toBe('tool_calls')
  })

  it('客户端非流式而上游返回 SSE 时，聚合推理、工具参数和 usage', async () => {
    const { app } = makeApp(() => sseRes([
      chunk({ reasoning: 'Need ' }),
      chunk({ reasoning_content: 'weather.', reasoning: 'weather.', tool_calls: [{ index: 0, id: toolCall.id, function: { name: 'lookup_weather', arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      chunk({}, 'tool_calls', usage),
    ]))
    const body = await (await app.request('/ifm/v1/chat/completions', chatReq())).json()
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: null, reasoning_content: 'Need weather.', tool_calls: [toolCall] })
    expect(body.usage).toEqual(usage)
  })

  it('SSE 聚合保留明确的空推理字段', async () => {
    const { app } = makeApp(() => sseRes([chunk({ reasoning: '', content: 'OK' }, 'stop')]))
    const body = await (await app.request('/ifm/v1/chat/completions', chatReq())).json()
    expect(body.choices[0].message.reasoning_content).toBe('')
  })

  it.each([true, false])('客户端流式而上游返回 JSON 时，合成 SSE 并遵守 usage=%s', async (includeUsage) => {
    const { app } = makeApp(() => jsonRes({
      ...completion,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK', reasoning: '' }, finish_reason: 'stop' }],
    }))
    const events = parseStream(await (await app.request('/ifm/v1/chat/completions', chatReq({
      stream: true, stream_options: { include_usage: includeUsage },
    }))).text())
    expect(events.flatMap((event) => event.choices).some((choice) => choice.delta.reasoning_content === '')).toBe(true)
    expect(events.filter((event) => event.usage)).toHaveLength(includeUsage ? 1 : 0)
    if (!includeUsage) expect(events.every((event) => !('usage' in event))).toBe(true)
  })

  it('上游中断不输出累计 usage 或伪造 finish_reason', async () => {
    const encoder = new TextEncoder()
    const { app } = makeApp(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: 'partial' }, undefined, usage))}\n\n`))
      },
      pull(controller) {
        controller.error(new Error('upstream interrupted'))
      },
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const events = parseStream(await (await app.request('/ifm/v1/chat/completions', chatReq({
      stream: true, stream_options: { include_usage: true },
    }))).text())
    expect(events).toHaveLength(1)
    expect(events[0].choices[0].finish_reason).toBeNull()
    expect(events[0].usage).toBeNull()
  })

  it('上游无 finish_reason 即结束时不把已有统计当作成功完成', async () => {
    const { app } = makeApp(() => sseRes([chunk({ content: 'partial' }, undefined, usage)]))
    const events = parseStream(await (await app.request('/ifm/v1/chat/completions', chatReq({
      stream: true, stream_options: { include_usage: true },
    }))).text())
    expect(events).toHaveLength(1)
    expect(events[0].usage).toBeNull()
    expect(events[0].choices[0].finish_reason).toBeNull()
  })

  it('并发流隔离推理和统计', async () => {
    const { app } = makeApp(async (req) => {
      const label = String(req.body.model)
      await Promise.resolve()
      return sseRes([
        { ...chunk({ reasoning: label, content: label }, 'stop', { ...usage, prompt_tokens: label === model ? 1 : 2 }), id: label, model: label },
      ])
    })
    const texts = await Promise.all([model, jaisModel].map(async (requestModel) => {
      const res = await app.request('/ifm/v1/chat/completions', chatReq({
        model: requestModel, stream: true, stream_options: { include_usage: true },
      }))
      return parseStream(await res.text())
    }))
    for (const [index, events] of texts.entries()) {
      const expectedModel = index === 0 ? model : jaisModel
      expect(events[0].choices[0].delta).toEqual({ content: expectedModel, reasoning_content: expectedModel })
      expect(events.at(-1)?.usage?.prompt_tokens).toBe(index + 1)
      expect(events.every((event) => event.model === expectedModel && event.id === expectedModel)).toBe(true)
    }
  })
})

describe('IFM 错误归一化', () => {
  it('detail + error 优先提取 error 并剥离 retryable', async () => {
    const { app } = makeApp(() => jsonRes({
      detail: 'Generic guidance',
      error: { message: 'Bad temperature.', type: 'invalid_request_error', param: 'temperature', code: 'invalid_parameter', retryable: false },
    }, 400))
    const res = await app.request('/ifm/v1/chat/completions', chatReq())
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: { message: 'Bad temperature.', type: 'invalid_request_error', param: 'temperature', code: 'invalid_parameter' } })
  })

  it('429 保留 Retry-After，仅转发安全响应头，不自动重试', async () => {
    const { app, calls } = makeApp(() => jsonRes({
      error: { message: 'Rate limited.', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' },
    }, 429, { 'retry-after': '1', 'set-cookie': 'private=placeholder', 'ifm-user-id': 'private-user', 'ifm-token-id': 'private-token' }))
    const res = await app.request('/ifm/v1/chat/completions', chatReq())
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('ifm-user-id')).toBeNull()
    expect(res.headers.get('ifm-token-id')).toBeNull()
    expect((await res.json()).error.type).toBe('rate_limit_error')
    expect(calls).toHaveLength(1)
  })

  it('保留 HTTP-date 格式 Retry-After，5xx 仍按既有规则映射 502', async () => {
    const retryAfter = 'Wed, 21 Oct 2026 07:28:00 GMT'
    const { app } = makeApp(() => jsonRes({ error: { message: 'Overloaded.' } }, 503, { 'retry-after': retryAfter }))
    const res = await app.request('/ifm/v1/chat/completions', chatReq())
    expect(res.status).toBe(502)
    expect(res.headers.get('retry-after')).toBe(retryAfter)
  })
})
