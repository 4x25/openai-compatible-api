import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createGatewayApp, gateway } from '../app/api'
import { agnes } from '../app/api/providers/agnes'
import type { ProviderCallContext } from '../app/api/providers/types'
import type { ChatCompletionChunk, ChatCompletionRequest } from '../app/api/types'
import { matchApiRoute } from '../app/api/router'

const chatModel = 'agnes-3.0-flash'
const imageModel = 'agnes-image-2.5-flash'
const videoModel = 'agnes-video-2.5-flash'
const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
const completion = {
  id: 'chatcmpl-agnes-test', object: 'chat.completion', created: 1700000000, model: chatModel,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage,
}
const toolCall = { id: 'call-test', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }
const createdVideo = {
  id: 'task-create', task_id: 'task-create', video_id: 'video-test', object: 'video', model: videoModel,
  created_at: 1700000000, progress: 0, status: 'queued', seconds: '4', size: '720P',
}

interface CapturedRequest {
  url: string
  method: string
  headers: Headers
  body: Record<string, unknown> | undefined
  signal: AbortSignal | null | undefined
  redirect: RequestRedirect | undefined
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function makeApp(
  handler: (request: CapturedRequest, index: number) => Response | Promise<Response> = () => json(completion),
  env: Record<string, string> = {},
) {
  const calls: CapturedRequest[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal, redirect: init?.redirect,
    }
    calls.push(request)
    return handler(request, calls.length - 1)
  }) as typeof fetch
  return { app: createGatewayApp({ fetch: fetchImpl, env }), calls, fetchImpl }
}

function post(body: Record<string, unknown>, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

function chat(body: Record<string, unknown> = {}, headers: Record<string, string> = {}): RequestInit {
  return post({ model: chatModel, messages: [{ role: 'user', content: 'Reply OK.' }], ...body }, headers)
}

function image(body: Record<string, unknown> = {}): RequestInit {
  return post({ model: imageModel, prompt: 'An orange square.', ...body })
}

function video(body: Record<string, unknown> = {}): RequestInit {
  return post({ model: videoModel, prompt: 'A slow camera push.', ...body })
}

function sse(deltas: Record<string, unknown>[], withDone = true): Response {
  const text = deltas.map((event) => `data: ${JSON.stringify({
    id: completion.id, created: completion.created, model: chatModel, object: 'chat.completion.chunk', ...event,
  })}\n\n`).join('') + (withDone ? 'data: [DONE]\n\n' : '')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}

function streamChunks(text: string): ChatCompletionChunk[] {
  expect(text.match(/data: \[DONE\]/g)).toHaveLength(1)
  expect(text.endsWith('data: [DONE]\n\n')).toBe(true)
  return text.split('\n\n').filter((block) => block.startsWith('data: {')).map((block) => JSON.parse(block.slice(6)))
}

describe('Agnes 注册、路由与认证', () => {
  it.each(['chat/completions', 'models', 'videos'])('原样 URL 的 /videos?tenant=... 前缀不抢占查询串后的端点：%s', async (endpoint) => {
    const { app, calls } = makeApp(() => json(endpoint === 'videos' ? createdVideo : completion))
    const request = endpoint === 'models' ? undefined : endpoint === 'videos' ? video() : chat()
    const res = await app.request(`/agnes/https://custom.example/videos?tenant=test/${endpoint}`, request)
    expect(res.status).toBe(200)
    if (endpoint === 'models') {
      expect((await res.json()).object).toBe('list')
      expect(calls).toHaveLength(0)
    } else expect(calls[0].url).toBe(`https://custom.example/videos/${endpoint}?tenant=test`)
  })

  it('默认请求的客户端查询串不会覆盖视频路由', () => {
    expect(matchApiRoute('https://example.com/agnes/v1/videos?id=/models')).toMatchObject({ kind: 'videos.create', prefix: '/v1' })
    expect(matchApiRoute('https://example.com/agnes/https%3A%2F%2Fcustom.example%2Fapi/videos?id=/models')).toMatchObject({ kind: 'videos.create' })
  })

  it.each(['models', 'videos'])('自定义 baseUrl 的 /videos 路径不遮蔽固定端点：%s', async (endpoint) => {
    const { app, calls } = makeApp(() => json(createdVideo))
    const res = await app.request(`/agnes/https://custom.example/videos/${endpoint}`, endpoint === 'videos' ? video() : undefined)
    expect(res.status).toBe(200)
    if (endpoint === 'models') {
      expect((await res.json()).object).toBe('list')
      expect(calls).toHaveLength(0)
    } else expect(calls[0].url).toBe('https://custom.example/videos/videos')
  })

  it.each([
    ['', 'models'], ['', 'videos'], ['/v1', 'models'], ['/v1', 'videos'],
  ])('默认前缀 %s 下同名的 video ID %s 仍按查询解析', async (prefix, id) => {
    const { app, calls } = makeApp(() => json({ status: 'queued' }))
    const res = await app.request(`/agnes${prefix}/videos/${id}`)
    expect(res.status).toBe(200)
    expect(new URL(calls[0].url).searchParams.get('video_id')).toBe(id)
  })

  it('列出指定的三种模型，不调用上游', async () => {
    const { app, calls } = makeApp()
    const res = await app.request('/agnes/v1/models')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([chatModel, imageModel, videoModel].map((id) => ({ id, object: 'model', created: 0, owned_by: 'agnes' })))
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['/agnes/v1/chat/completions', {}, 'https://apihub.agnes-ai.com/v1/chat/completions'],
    ['/agnes/chat/completions', { AGNES_BASE_URL: 'https://env.example' }, 'https://env.example/v1/chat/completions'],
    ['/agnes/https://custom.example/prefix/v1/chat/completions', { AGNES_BASE_URL: 'https://env.example' }, 'https://custom.example/prefix/v1/chat/completions'],
    ['/agnes/https%3A%2F%2Fcustom.example%2Fapi/chat/completions', {}, 'https://custom.example/api/chat/completions'],
  ])('baseUrl：%s', async (path, env, expected) => {
    const { app, calls } = makeApp(undefined, env)
    expect((await app.request(path, chat())).status).toBe(200)
    expect(calls[0].url).toBe(expected)
  })

  it.each([
    [{ authorization: 'Bearer test-client', 'x-api-key': 'test-api' }, 'Bearer test-client'],
    [{ 'x-api-key': 'test-api' }, 'Bearer test-api'],
    [{}, 'Bearer test-dev'],
  ])('凭证优先级：%j', async (headers, expected) => {
    const { app, calls } = makeApp(undefined, { AGNES_API_KEY_FOR_DEV: 'test-dev' })
    await app.request('/agnes/v1/chat/completions', chat({}, headers))
    expect(calls[0].headers.get('authorization')).toBe(expected)
    expect(calls[0].headers.get('x-api-key')).toBeNull()
    expect(calls[0].redirect).toBe('error')
  })

  it('按视频后缀分流，放行页面及静态资源', async () => {
    expect(matchApiRoute('/invalid')).toBeNull()
    expect(matchApiRoute('https://example.com/agnes/v1/videos')).toMatchObject({ kind: 'videos.create' })
    expect(matchApiRoute('https://example.com/agnes/v1/videos/id/content?variant=video')).toMatchObject({ kind: 'videos.content', videoId: 'id' })
    const { fetchImpl } = makeApp()
    const app = new Hono()
    app.use('*', gateway({ fetch: fetchImpl, env: {} }))
    app.all('*', (c) => c.text('page'))
    for (const path of ['/', '/app/client.ts', '/static/client.js', '/some/page']) {
      expect(await (await app.request(path)).text()).toBe('page')
    }
  })

  it.each(['/agnes/v1/videos', '/agnes/v1/videos/id', '/agnes/v1/videos/id/content'])('错误方法返回 405：%s', async (path) => {
    const { app, calls } = makeApp()
    const res = await app.request(path, { method: 'DELETE' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain(path.endsWith('/videos') ? 'POST' : 'GET')
    expect((await res.json()).error.code).toBe('method_not_allowed')
    expect(calls).toHaveLength(0)
  })
})

describe('Agnes 文本转换', () => {
  it('工具结果的标准文本数组按原顺序拼接，调用 ID 保持一致', async () => {
    const { app, calls } = makeApp()
    const res = await app.request('/agnes/v1/chat/completions', chat({ messages: [
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', tool_call_id: toolCall.id, content: [{ type: 'text', text: 'Sunny ' }, { type: 'text', text: 'in Paris.' }] },
    ] }))
    expect(res.status).toBe(200)
    expect((calls[0].body?.messages as unknown[])[1]).toEqual({ role: 'tool', tool_call_id: toolCall.id, content: 'Sunny in Paris.' })
  })

  it('工具结果数组中非文本块返回具体参数错误', async () => {
    const { app, calls } = makeApp()
    const res = await app.request('/agnes/v1/chat/completions', chat({ messages: [
      { role: 'tool', tool_call_id: toolCall.id, content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] },
    ] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.param).toBe('messages.0.content.0')
    expect(calls).toHaveLength(0)
  })

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'future-value'])('reasoning_effort=%s 映射为布尔 Thinking', async (effort) => {
    const { app, calls } = makeApp()
    await app.request('/agnes/v1/chat/completions', chat({ reasoning_effort: effort }))
    expect(calls[0].body?.chat_template_kwargs).toEqual({ enable_thinking: effort !== 'none' })
    expect(calls[0].body?.reasoning_effort).toBeUndefined()
  })

  it('未传推理强度时不注入 Thinking，并显式发送 stream:false', async () => {
    const { app, calls } = makeApp()
    await app.request('/agnes/v1/chat/completions', chat())
    expect(calls[0].body?.chat_template_kwargs).toBeUndefined()
    expect(calls[0].body?.stream).toBe(false)
  })

  it.each(['none', 'high'])('标准推理强度覆盖扩展中的冲突值，保留其他字段：%s', async (effort) => {
    const { app, calls } = makeApp()
    await app.request('/agnes/v1/chat/completions', chat({
      reasoning_effort: effort, chat_template_kwargs: { enable_thinking: effort === 'none', other: 'kept' },
    }))
    expect(calls[0].body?.chat_template_kwargs).toEqual({ enable_thinking: effort !== 'none', other: 'kept' })
  })

  it('未提供标准推理强度时保留扩展', async () => {
    const { app, calls } = makeApp()
    await app.request('/agnes/v1/chat/completions', chat({ chat_template_kwargs: { enable_thinking: false } }))
    expect(calls[0].body?.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('developer、文本和图像块归一化，移除不兼容的嵌套内容', async () => {
    const { app, calls } = makeApp()
    const res = await app.request('/agnes/v1/chat/completions', chat({ messages: [
      { role: 'developer', content: 'Rule', name: 'unused' },
      { role: 'user', metadata: 'unused', content: [
        { type: 'text', text: 'Describe', extra: 'unused' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } },
        { type: 'input_audio', input_audio: { data: 'unused', format: 'wav' } },
      ] },
    ] }))
    expect(res.status).toBe(200)
    expect(calls[0].body?.messages).toEqual([
      { role: 'system', content: 'Rule' },
      { role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] },
    ])
  })

  it('token 上限优先级与工具定义透传，忽略其他顶层参数', async () => {
    const { app, calls } = makeApp()
    const tools = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
    await app.request('/agnes/v1/chat/completions', chat({
      max_completion_tokens: 128, max_tokens: -1, temperature: 0.3, top_p: 0.9,
      tools, tool_choice: 'auto', unknown: 'drop', stop: 'drop', response_format: { type: 'json_object' },
    }))
    expect(calls[0].body).toMatchObject({ max_tokens: 128, temperature: 0.3, top_p: 0.9, tools, tool_choice: 'auto' })
    for (const key of ['max_completion_tokens', 'unknown', 'stop', 'response_format']) expect(calls[0].body?.[key]).toBeUndefined()
  })

  it.each([null, undefined])('工具续接 content=%s 归一化为 null，保留调用关联', async (content) => {
    const { app, calls } = makeApp()
    const res = await app.request('/agnes/v1/chat/completions', chat({ messages: [
      { role: 'assistant', content, tool_calls: [{ ...toolCall, index: 0, internal: 'drop' }] },
      { role: 'tool', content: 'Sunny', tool_call_id: toolCall.id, metadata: 'drop' },
    ] }))
    expect(res.status).toBe(200)
    expect(calls[0].body?.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'Sunny', tool_call_id: toolCall.id },
    ])
  })

  it.each([
    [{ messages: [] }, 'messages'],
    [{ reasoning_effort: 0 }, 'reasoning_effort'],
    [{ chat_template_kwargs: [] }, 'chat_template_kwargs'],
    [{ max_completion_tokens: 0 }, 'max_completion_tokens'],
    [{ tools: {} }, 'tools'],
    [{ tool_choice: false }, 'tool_choice'],
    [{ messages: [null] }, 'messages.0'],
    [{ messages: [{ role: 'invalid', content: 'hello' }] }, 'messages.0.role'],
    [{ messages: [{ role: 'user', content: null }] }, 'messages.0.content'],
    [{ messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] }, 'messages.0.content'],
    [{ messages: [{ role: 'tool', content: 'Sunny' }] }, 'messages.0.tool_call_id'],
    [{ messages: [{ role: 'assistant', content: null, tool_calls: [{ ...toolCall, id: '' }] }] }, 'messages.0.tool_calls.0.id'],
  ])('参数错误有具体 param：%j', async (body, param) => {
    const { app, calls } = makeApp()
    const res = await app.request('/agnes/v1/chat/completions', chat(body))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatchObject({ type: 'invalid_request_error', param })
    expect(calls).toHaveLength(0)
  })

  it('转换不修改调用方对象', async () => {
    const request = {
      model: chatModel, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: true },
      messages: [{ role: 'developer', content: [{ type: 'text', text: 'Rule' }] }],
    }
    const before = structuredClone(request)
    await agnes.chat!.transformRequest!(request as ChatCompletionRequest, {} as ProviderCallContext)
    expect(request).toEqual(before)
  })
})

describe('Agnes 流式和工具闭环', () => {
  it('取消 SSE 消费能中断仍在等待的上游流', async () => {
    let cancelled = false
    const { app } = makeApp(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          id: completion.id, choices: [{ index: 0, delta: { content: 'partial' } }],
        })}\n\n`))
      },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const res = await app.request('/agnes/v1/chat/completions', chat({ stream: true }))
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await Promise.resolve()
    expect(cancelled).toBe(true)
  })

  it('工具响应补 content:null，可直接回传作为下一轮历史', async () => {
    const { app, calls } = makeApp((_req, index) => index === 0 ? json({
      ...completion, choices: [{ index: 0, message: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
    }) : json(completion))
    const first = await (await app.request('/agnes/v1/chat/completions', chat())).json()
    expect(first.choices[0].message.content).toBeNull()
    const second = await app.request('/agnes/v1/chat/completions', chat({ messages: [
      { role: 'user', content: 'Weather?' }, first.choices[0].message,
      { role: 'tool', tool_call_id: toolCall.id, content: 'Sunny' },
    ] }))
    expect(second.status).toBe(200)
    expect((calls[1].body?.messages as unknown[])[1]).toEqual(first.choices[0].message)
  })

  it.each([true, false])('SSE 推理、工具片段与 usage=%s', async (includeUsage) => {
    const { app, calls } = makeApp(() => sse([
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Check.' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: 'weather', arguments: '{"city":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: 'tool_calls' }], usage },
    ], false))
    const chunks = streamChunks(await (await app.request('/agnes/v1/chat/completions', chat({
      reasoning_effort: 'high', stream: true, stream_options: { include_usage: includeUsage },
    }))).text())
    expect(chunks[0].choices[0].delta.reasoning_content).toBe('Check.')
    expect(chunks.filter((chunk) => chunk.usage)).toHaveLength(includeUsage ? 1 : 0)
    expect(chunks.flatMap((chunk) => chunk.choices).at(-1)?.finish_reason).toBe('tool_calls')
    expect(calls[0].body?.stream).toBe(true)
    expect(calls[0].body?.chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(calls[0].body?.stream_options).toEqual(includeUsage ? { include_usage: true } : undefined)
  })

  it('客户端非流式而上游 SSE 时聚合内容、推理和统计', async () => {
    const { app } = makeApp(() => sse([
      { choices: [{ index: 0, delta: { content: 'O', reasoning_content: 'Think.' } }] },
      { choices: [{ index: 0, delta: { content: 'K' }, finish_reason: 'stop' }], usage },
    ]))
    const body = await (await app.request('/agnes/v1/chat/completions', chat())).json()
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'OK', reasoning_content: 'Think.' })
    expect(body.usage).toEqual(usage)
  })

  it('客户端流式而上游 JSON 时合成 SSE', async () => {
    const { app } = makeApp()
    const chunks = streamChunks(await (await app.request('/agnes/v1/chat/completions', chat({ stream: true, stream_options: { include_usage: true } }))).text())
    expect(chunks.flatMap((chunk) => chunk.choices).map((choice) => choice.delta.content ?? '').join('')).toBe('OK')
    expect(chunks.at(-1)?.usage).toEqual(usage)
  })
})

describe('Agnes 图片生成和编辑', () => {
  it.each(['url', 'b64_json'])('标准输出格式优先，移动至 extra_body：%s', async (format) => {
    const { app, calls } = makeApp(() => json({ created: 1, data: [{ [format === 'url' ? 'url' : 'b64_json']: 'result' }] }))
    const res = await app.request('/agnes/v1/images/generations', image({
      response_format: format, return_base64: 'invalid-but-overridden',
      extra_body: { response_format: format === 'url' ? 'b64_json' : 'url', other: 'kept' },
      ratio: '16:9', size: '2K', quality: 'high', unknown: 'drop', image: 'drop',
    }))
    expect(res.status).toBe(200)
    expect(calls[0].body).toEqual({
      model: imageModel, prompt: 'An orange square.', size: '2K', ratio: '16:9',
      extra_body: { response_format: format, other: 'kept' },
    })
    expect(calls[0].url).toBe('https://apihub.agnes-ai.com/v1/images/generations')
  })

  it('默认尺寸、供应商扩展以及响应空值归一化', async () => {
    const { app, calls } = makeApp(() => json({ created: 1, data: [{ url: null, b64_json: 'result', revised_prompt: null }] }))
    const res = await app.request('/agnes/v1/images/generations', image({ return_base64: true }))
    expect(calls[0].body).toMatchObject({ size: '1024x1024', return_base64: true })
    expect((await res.json()).data).toEqual([{ b64_json: 'result' }])
  })

  it('n 并发扇出，响应完成乱序仍按请求顺序合并', async () => {
    let active = 0
    let maximum = 0
    const resolvers: Array<() => void> = []
    const { app, calls } = makeApp(async (_req, index) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise<void>((resolve) => {
        resolvers.push(resolve)
        if (resolvers.length === 3) for (const done of [...resolvers].reverse()) done()
      })
      active--
      return json({ created: 1, data: [{ url: `https://images.example/${index}.png` }] })
    })
    const body = await (await app.request('/agnes/v1/images/generations', image({ n: 3 }))).json()
    expect(maximum).toBe(3)
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.body?.n === undefined)).toBe(true)
    expect(body.data.map((item: { url: string }) => item.url)).toEqual([0, 1, 2].map((i) => `https://images.example/${i}.png`))
  })

  it('分支失败则整体报错，取消其他未消费响应，不重试', async () => {
    let cancelled = 0
    const { app, calls } = makeApp((_req, index) => index === 1 ? json({ detail: 'Busy' }, 429, { 'retry-after': '2' })
      : new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++ } })))
    const res = await app.request('/agnes/v1/images/generations', image({ n: 3 }))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('2')
    expect((await res.json()).data).toBeUndefined()
    expect(calls).toHaveLength(3)
    expect(cancelled).toBe(2)
  })

  it('无效图片分支取消后续未消费响应', async () => {
    let cancelled = false
    const { app } = makeApp((_req, index) => index === 0 ? new Response('not-json')
      : new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })))
    const res = await app.request('/agnes/v1/images/generations', image({ n: 2 }))
    expect(res.status).toBe(502)
    expect(cancelled).toBe(true)
  })

  it('multipart 编辑转 Data URI、忽略 mask，支持 n', async () => {
    const { app, calls } = makeApp(() => json({ data: [{ b64_json: 'result' }] }))
    const form = new FormData()
    form.set('model', imageModel)
    form.set('prompt', 'Repaint')
    form.set('n', '2')
    form.set('response_format', 'b64_json')
    form.set('return_base64', 'invalid-but-overridden')
    form.set('extra_body', JSON.stringify({ image: ['https://example.com/overridden.png'] }))
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'one.png')
    form.append('image[]', new Blob([new Uint8Array([4, 5])], { type: 'image/webp' }), 'two.webp')
    form.set('mask', new Blob(['ignored'], { type: 'image/png' }), 'mask.png')
    const res = await app.request('/agnes/v1/images/edits', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toHaveLength(2)
    expect(calls).toHaveLength(2)
    expect(calls[0].body?.extra_body).toEqual({
      image: ['data:image/png;base64,AQID', 'data:image/webp;base64,BAU='], response_format: 'b64_json',
    })
    expect(calls[0].body?.mask).toBeUndefined()
  })

  it('JSON 多图编辑优先使用标准 images，移除无 URL 的 file_id 引用', async () => {
    const { app, calls } = makeApp(() => json({ data: [{ url: 'result' }] }))
    const res = await app.request('/agnes/v1/images/edits', image({
      images: [{ image_url: { url: 'https://example.com/a.png', detail: 'high' }, file_id: 'unused' }, { file_id: 'unused' }],
      image: 'https://example.com/overridden.png', extra_body: { image: ['https://example.com/also-overridden.png'] },
    }))
    expect(res.status).toBe(200)
    expect(calls[0].body?.extra_body).toEqual({ image: ['https://example.com/a.png'] })
  })

  it('extra_body.image 可用于生成或编辑', async () => {
    for (const endpoint of ['generations', 'edits']) {
      const { app, calls } = makeApp(() => json({ data: [{ url: 'result' }] }))
      const res = await app.request(`/agnes/v1/images/${endpoint}`, image({ extra_body: { image: ['https://example.com/a.png'] } }))
      expect(res.status).toBe(200)
      expect(calls[0].body?.extra_body).toEqual({ image: ['https://example.com/a.png'] })
    }
  })

  it.each([0, -1, 11, 1.5, '2'])('拒绝非法图片 n=%s', async (n) => {
    const { app, calls } = makeApp()
    const res = await app.request('/agnes/v1/images/generations', image({ n }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.param).toBe('n')
    expect(calls).toHaveLength(0)
  })

  it('编辑缺少输入图、非法格式、非法文件在本地返回参数错误', async () => {
    const { app, calls } = makeApp()
    for (const body of [{}, { image: [] }, { image: [{ file_id: 'file-test' }] }]) {
      const res = await app.request('/agnes/v1/images/edits', image(body))
      expect(res.status).toBe(400)
      expect((await res.json()).error.param).toBe('image')
    }
    expect((await app.request('/agnes/v1/images/generations', image({ response_format: 'invalid' }))).status).toBe(400)
    const form = new FormData()
    form.set('model', imageModel)
    form.set('prompt', 'Edit')
    form.set('image', new Blob(['text'], { type: 'text/plain' }), 'not-an-image.txt')
    expect((await app.request('/agnes/v1/images/edits', { method: 'POST', body: form })).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('Agnes 视频创建', () => {
  it.each(['task-only', null, []])('非对象视频创建信封返回 502：%j', async (body) => {
    const { app } = makeApp(() => json(body))
    const res = await app.request('/agnes/v1/videos', video())
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('upstream_error')
  })

  it.each(['model', 'prompt', 'seconds', 'extra_body'])('multipart 重复标量 %s 在调用上游前拒绝', async (field) => {
    const { app, calls } = makeApp(() => json(createdVideo))
    const form = new FormData()
    form.set('model', videoModel)
    form.set('prompt', 'Animate')
    if (!form.has(field)) form.set(field, field === 'extra_body' ? '{}' : '4')
    form.append(field, field === 'model' ? chatModel : field === 'extra_body' ? '{}' : 'different')
    const res = await app.request('/agnes/v1/videos', { method: 'POST', body: form })
    expect(res.status).toBe(400)
    expect((await res.json()).error.param).toBe(field)
    expect(calls).toHaveLength(0)
  })

  it('默认映射为 4 秒、720P、9:16 的文本任务', async () => {
    const { app, calls } = makeApp(() => json(createdVideo))
    const res = await app.request('/agnes/v1/videos', video({ unknown: 'drop', height: 720 }))
    expect(res.status).toBe(200)
    expect(calls[0].body).toEqual({ model: videoModel, prompt: 'A slow camera push.', seconds: '4', size: '720P', aspect_ratio: '9:16', mode: 'text' })
    expect(calls[0].url).toBe('https://apihub.agnes-ai.com/v1/videos')
    expect(await res.json()).toMatchObject({
      id: `${videoModel}:video-test`, video_id: 'video-test', task_id: 'task-create', object: 'video',
      status: 'queued', created_at: 1700000000, completed_at: null, expires_at: null, progress: 0,
      error: null, seconds: '4', size: '720P', model: videoModel,
    })
  })

  it.each([
    ['720x1280', '9:16'], ['1280x720', '16:9'], ['1024x1792', '9:16'], ['1792x1024', '16:9'], ['720P', '1:1'],
  ])('尺寸 %s 映射为 720P 和 %s', async (size, ratio) => {
    const { app, calls } = makeApp(() => json(createdVideo))
    await app.request('/agnes/v1/videos', video({ size, seconds: 8, aspect_ratio: '1:1' }))
    expect(calls[0].body).toMatchObject({ size: '720P', seconds: '8', aspect_ratio: ratio })
  })

  it('参考图片映射 first_frame；标准引用覆盖扩展', async () => {
    const { app, calls } = makeApp(() => json(createdVideo))
    const res = await app.request('/agnes/v1/videos', video({
      input_reference: { image_url: 'https://example.com/first.png' },
      first_frame: 'https://example.com/overridden.png', image: 'https://example.com/also-overridden.png',
      last_frame: 'https://example.com/last.png', mode: 'keyframes',
    }))
    expect(res.status).toBe(200)
    expect(calls[0].body).toMatchObject({ mode: 'keyframe', first_frame: 'https://example.com/first.png', last_frame: 'https://example.com/last.png' })
    expect(calls[0].body?.input_reference).toBeUndefined()
    expect(calls[0].body?.image).toBeUndefined()
  })

  it('参考媒体从 extra_body 提升，顶层优先于扩展', async () => {
    const { app, calls } = makeApp(() => json(createdVideo))
    const res = await app.request('/agnes/v1/videos', video({
      aspect_ratio: '4:3', seed: 42,
      extra_body: { aspect_ratio: '1:1', images: ['https://example.com/image.png'], audios: ['https://example.com/audio.mp3'], unknown: 'drop' },
    }))
    expect(res.status).toBe(200)
    expect(calls[0].body).toMatchObject({
      mode: 'reference', aspect_ratio: '4:3', seed: 42, images: ['https://example.com/image.png'], audios: ['https://example.com/audio.mp3'],
    })
    expect(calls[0].body?.extra_body).toBeUndefined()
    expect(calls[0].body?.unknown).toBeUndefined()
  })

  it('multipart 文件和 SDK 括号 URL 引用都转为首帧', async () => {
    const { app, calls } = makeApp(() => json(createdVideo))
    for (const [name, reference] of [
      ['input_reference', new Blob([new Uint8Array([7, 8])], { type: 'image/png' })],
      ['input_reference[image_url]', 'https://example.com/image.png'],
    ] as const) {
      const form = new FormData()
      form.set('model', videoModel)
      form.set('prompt', 'Animate')
      form.set('seconds', '5')
      form.set('size', '1280x720')
      if (typeof reference === 'string') form.set(name, reference)
      else form.set(name, reference, 'reference.png')
      const res = await app.request('/agnes/v1/videos', { method: 'POST', body: form })
      expect(res.status).toBe(200)
    }
    expect(calls[0].body?.first_frame).toBe('data:image/png;base64,Bwg=')
    expect(calls[1].body?.first_frame).toBe('https://example.com/image.png')
    expect(calls.every((call) => call.body?.mode === 'keyframe' && call.body.seconds === '5')).toBe(true)
  })

  it.each([
    [{ seconds: 3 }, 'seconds'], [{ seconds: '13' }, 'seconds'], [{ seconds: 4.5 }, 'seconds'], [{ seconds: null }, 'seconds'],
    [{ size: '1080P' }, 'size'], [{ size: 'invalid' }, 'size'], [{ size: 'toString' }, 'size'], [{ aspect_ratio: 'auto' }, 'aspect_ratio'],
    [{ images: Array(6).fill('https://example.com/image.png') }, 'images'],
    [{ audios: Array(4).fill('https://example.com/audio.mp3') }, 'audios'],
    [{ videos: [{ url: 'https://example.com/video.mp4' }] }, 'videos'], [{ n: 2 }, 'n'],
    [{ mode: 'invalid' }, 'mode'], [{ mode: 'keyframe' }, 'mode'], [{ mode: 'reference' }, 'mode'],
    [{ mode: 'text', first_frame: 'https://example.com/image.png' }, 'mode'],
    [{ first_frame: 'https://example.com/image.png', images: ['https://example.com/image.png'] }, 'mode'],
    [{ input_reference: { file_id: 'file-test' } }, 'input_reference'],
    [{ images: [null] }, 'images.0'], [{ seed: 1.5 }, 'seed'],
  ])('视频参数错误提前拦截：%j', async (body, param) => {
    const { app, calls } = makeApp(() => json(createdVideo))
    const res = await app.request('/agnes/v1/videos', video(body))
    expect(res.status).toBe(400)
    expect((await res.json()).error.param).toBe(param)
    expect(calls).toHaveLength(0)
  })

  it('创建信封缺少 video_id 不会误用 task id', async () => {
    const { app } = makeApp(() => json({ id: 'task-only', status: 'queued' }))
    const res = await app.request('/agnes/v1/videos', video())
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('upstream_error')
  })
})

describe('Agnes 视频查询与内容下载', () => {
  it.each(['task-only', null, []])('非对象视频查询信封不能改写公开 ID：%j', async (body) => {
    const { app } = makeApp(() => json(body))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test`)
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('upstream_error')
  })

  it.each(['bytes=0-1,98-99', 'not-a-range'])('非单段 Range 返回本地参数错误：%s', async (range) => {
    const { app, calls } = makeApp()
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content`, { headers: { range } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.param).toBe('range')
    expect(calls).toHaveLength(0)
  })

  it('攻击者 HTML 媒体不会以网关同源响应返回，取消正文', async () => {
    let cancelled = false
    const { app } = makeApp((_req, index) => index === 0 ? json({ status: 'completed', url: 'https://media.example/evil.html' })
      : new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('<script>alert(1)</script>')) },
        cancel() { cancelled = true },
      }), { headers: { 'content-type': 'text/html' } }))
    const res = await app.request('/agnes/https://custom.example/v1/videos/evil/content')
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('<script>')
    expect(cancelled).toBe(true)
  })

  it('无编码的视频内容携带附件、nosniff 和 sandbox 防护', async () => {
    const { app } = makeApp((_req, index) => index === 0 ? json({ status: 'completed', url: 'https://media.example/video.mp4' })
      : new Response(new Uint8Array([1]), { headers: { 'content-type': 'video/mp4' } }))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    await res.body?.cancel()
  })

  it('自动解压的视频正文剥除压缩前长度和强验证头', async () => {
    const { app, calls } = makeApp((_req, index) => index === 0 ? json({ status: 'completed', url: 'https://media.example/video.mp4' })
      : new Response(new Uint8Array(100), { headers: { 'content-type': 'video/mp4', 'content-encoding': 'gzip',
        'content-length': '24', 'accept-ranges': 'bytes', etag: '"compressed"' } }))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content`)
    expect(res.status).toBe(200)
    expect(calls[1].headers.get('accept-encoding')).toBe('identity')
    for (const key of ['content-length', 'content-encoding', 'accept-ranges', 'etag']) expect(res.headers.get(key)).toBeNull()
    expect((await res.arrayBuffer()).byteLength).toBe(100)
  })

  it('上游忽略 identity 返回压缩 Range 时拒绝不一致的字节范围', async () => {
    const { app } = makeApp((_req, index) => index === 0 ? json({ status: 'completed', url: 'https://media.example/video.mp4' })
      : new Response(new Uint8Array(100), { status: 206, headers: { 'content-type': 'video/mp4', 'content-encoding': 'gzip', 'content-range': 'bytes 0-23/24' } }))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content`, { headers: { range: 'bytes=0-23' } })
    expect(res.status).toBe(502)
  })

  it.each([
    ['/agnes/v1/videos', {}, 'https://apihub.agnes-ai.com/agnesapi'],
    ['/agnes/v1/videos', { AGNES_BASE_URL: 'https://env.example/prefix/v1' }, 'https://env.example/prefix/agnesapi'],
    ['/agnes/https://custom.example/proxy/v1/videos', {}, 'https://custom.example/proxy/agnesapi'],
    ['/agnes/https%3A%2F%2Fcustom.example%2Fapi%3Ftenant%3Dtest/videos', {}, 'https://custom.example/api/agnesapi'],
  ])('查询根路径、模型名及公开 ID：%s', async (prefix, env, expected) => {
    const { app, calls } = makeApp(() => json({
      id: 'task-completed', status: 'completed', progress: 100, created_at: 1700000000,
      completed_at: 1700000010, seconds: '4', size: '720P', url: 'https://example.com/video.mp4',
      internal_status: 'pending', internal_progress: 0,
    }), env)
    const id = `${videoModel}:video/with space`
    const res = await app.request(`${prefix}/${encodeURIComponent(id)}`)
    expect(res.status).toBe(200)
    const upstream = new URL(calls[0].url)
    expect(upstream.origin + upstream.pathname).toBe(expected)
    expect(upstream.searchParams.get('video_id')).toBe('video/with space')
    expect(upstream.searchParams.get('model_name')).toBe(videoModel)
    if (prefix.includes('tenant')) expect(upstream.searchParams.get('tenant')).toBe('test')
    const body = await res.json()
    expect(body.id).toBe(id)
    expect(body.status).toBe('completed')
    expect(body.model).toBe(videoModel)
    expect(body.progress).toBe(100)
    expect(body.internal_status).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it('原始 video_id 查询同样带 Flash 模型名', async () => {
    const { app, calls } = makeApp(() => json({ id: 'task-result', status: 'queued' }))
    const res = await app.request('/agnes/v1/videos/raw-id')
    expect(res.status).toBe(200)
    expect(new URL(calls[0].url).searchParams.get('model_name')).toBe(videoModel)
    expect((await res.json()).id).toBe(`${videoModel}:raw-id`)
  })

  it('查询 404 不回退或重试', async () => {
    const { app, calls } = makeApp(() => json({ detail: 'Missing video' }, 404))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:missing`)
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(1)
  })

  it('失败任务归一化为标准错误元数据', async () => {
    const { app } = makeApp(() => json({ status: 'failed', error: { message: 'Invalid reference media' } }))
    const body = await (await app.request(`/agnes/v1/videos/${videoModel}:failed`)).json()
    expect(body.status).toBe('failed')
    expect(body.error).toEqual({ message: 'Invalid reference media', code: 'video_generation_failed' })
  })

  it.each(['url', 'metadata'])('下载从 %s 获取媒体并透传 Range，剥离凭证与敏感头', async (location) => {
    const bytes = new Uint8Array([10, 11, 12])
    const { app, calls } = makeApp((_request, index) => index === 0 ? json({
      status: 'completed', [location]: location === 'url' ? 'https://media.example/video.mp4' : { url: 'https://media.example/video.mp4' },
    }) : new Response(bytes, {
      status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 10-12/100', 'accept-ranges': 'bytes',
        'content-length': '3', 'set-cookie': 'private=test', 'x-private': 'private', 'cache-control': 'public' },
    }))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content?variant=video`, {
      headers: { authorization: 'Bearer test-client', range: 'bytes=10-12' },
    })
    expect(res.status).toBe(206)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect(calls[0].headers.get('authorization')).toBe('Bearer test-client')
    expect(calls[1].url).toBe('https://media.example/video.mp4')
    expect(calls[1].headers.get('authorization')).toBeNull()
    expect(calls[1].headers.get('x-api-key')).toBeNull()
    expect(calls[1].headers.get('range')).toBe('bytes=10-12')
    expect(calls[1].redirect).toBe('follow')
    expect(res.headers.get('content-range')).toBe('bytes 10-12/100')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-private')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it.each(['queued', 'in_progress', 'failed'])('未完成的任务只查元数据不下载：%s', async (status) => {
    const { app, calls } = makeApp(() => json({ status }))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content`)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe(status === 'failed' ? 'video_generation_failed' : 'video_not_ready')
    expect(calls).toHaveLength(1)
  })

  it.each([undefined, 'data:video/mp4;base64,AAAA', 'https://user:password@media.example/video.mp4'])('无效媒体 URL 不触发下载：%s', async (url) => {
    const { app, calls } = makeApp(() => json({ status: 'completed', url }))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content`)
    expect(res.status).toBe(502)
    expect(calls).toHaveLength(1)
  })

  it('媒体 416 保留 Content-Range，错误正文不反射', async () => {
    const { app } = makeApp((_req, index) => index === 0 ? json({ status: 'completed', url: 'https://media.example/video.mp4' })
      : new Response('private media error', { status: 416, headers: { 'content-range': 'bytes */100' } }))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content`)
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */100')
    expect(await res.text()).not.toContain('private media error')
  })

  it('取消媒体响应传递到上游流', async () => {
    let cancelled = false
    const { app } = makeApp((_req, index) => index === 0 ? json({ status: 'completed', url: 'https://media.example/video.mp4' })
      : new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])) },
        cancel() { cancelled = true },
      }), { headers: { 'content-type': 'video/mp4' } }))
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content`)
    const reader = res.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1]))
    await reader.cancel()
    expect(cancelled).toBe(true)
  })

  it('非视频 variant 返回明确错误', async () => {
    const { app, calls } = makeApp()
    const res = await app.request(`/agnes/v1/videos/${videoModel}:video-test/content?variant=thumbnail`)
    expect(res.status).toBe(400)
    expect((await res.json()).error.param).toBe('variant')
    expect(calls).toHaveLength(0)
  })
})

describe('Agnes 错误边界', () => {
  it.each([400, 401, 403, 429, 500])('上游状态 %s 归一化并保留重试提示', async (status) => {
    const { app, calls } = makeApp(() => json({ detail: 'Upstream error' }, status, { 'retry-after': '2', 'set-cookie': 'private=test' }))
    const res = await app.request('/agnes/v1/chat/completions', chat())
    expect(res.status).toBe(status >= 500 ? 502 : status)
    expect((await res.json()).error.message).toBe('Upstream error')
    expect(res.headers.get('retry-after')).toBe('2')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it.each(['/agnes/v1/images/edits', '/agnes/v1/videos'])('无效 multipart 在上游调用前返回 400：%s', async (path) => {
    const { app, calls } = makeApp()
    const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'multipart/form-data' }, body: 'invalid' })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
