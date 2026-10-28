import OpenAI, { toFile } from 'openai'
import { describe, expect, it } from 'vitest'
import { createGatewayApp } from '../app/api'
import type { VideoCreateParams } from 'openai/resources/videos'

// 合成的一像素 PNG，仅用于验证官方 SDK 未指定 MIME 的上传路径。
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9sAAAAASUVORK5CYII='), (character) => character.charCodeAt(0))

function sdkApp() {
  const bodies: Record<string, unknown>[] = []
  const app = createGatewayApp({ env: {}, fetch: (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ video_id: 'sdk-extra', status: 'queued', data: [{ url: 'https://example.com/image.png' }],
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    })
  }) as typeof fetch })
  const sdkFetch = Object.assign((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === 'data:,') return new Response('')
    return app.fetch(input instanceof Request && !init ? input : new Request(input, init))
  }) as typeof fetch, { Response })
  return { bodies, client: new OpenAI({ apiKey: 'sdk-test-key', baseURL: 'https://gateway.example/agnes/v1', fetch: sdkFetch, maxRetries: 0 }) }
}

describe('官方 OpenAI SDK 协议兼容', () => {
  it('官方 SDK 可使用文本块数组作为工具结果', async () => {
    const { client, bodies } = sdkApp()
    await client.chat.completions.create({ model: 'agnes-3.0-flash', messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-sdk', type: 'function', function: { name: 'weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-sdk', content: [{ type: 'text', text: 'Sunny' }] },
    ] })
    expect((bodies[0].messages as unknown[])[1]).toEqual({ role: 'tool', tool_call_id: 'call-sdk', content: 'Sunny' })
  })

  it.each(['nested', 'top-level'])('官方 SDK 参考媒体括号数组保留素材和模式：%s', async (location) => {
    const { client, bodies } = sdkApp()
    const media = { mode: 'reference', images: ['https://example.com/one.png', 'https://example.com/two.png'],
      audios: ['https://example.com/audio.mp3'], seed: 42, aspect_ratio: '4:3' }
    const request = { model: 'agnes-video-2.5-flash', prompt: 'Reference test',
      ...(location === 'nested' ? { extra_body: media } : media) }
    await client.videos.create(request as VideoCreateParams)
    expect(bodies[0]).toMatchObject(media)
    expect(bodies[0].extra_body).toBeUndefined()
  })

  it('官方 SDK 未指定 MIME 的图片编辑和视频上传识别真实 PNG 类型', async () => {
    const { client, bodies } = sdkApp()
    const file = await toFile(png, 'image.png')
    await client.images.edit({ model: 'agnes-image-2.5-flash', prompt: 'Edit', image: file })
    await client.videos.create({ model: 'agnes-video-2.5-flash', prompt: 'Animate', input_reference: file })
    const uri = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`
    expect((bodies[0].extra_body as Record<string, unknown>).image).toEqual([uri])
    expect(bodies[1].first_frame).toBe(uri)
  })

  it('官方 SDK 图片编辑中的嵌套 extra_body 格式保留且标准字段优先', async () => {
    const { client, bodies } = sdkApp()
    const file = await toFile(png, 'image.png')
    await client.images.edit({ model: 'agnes-image-2.5-flash', prompt: 'Edit', image: file, response_format: 'url',
      extra_body: { response_format: 'b64_json', image: ['https://example.com/overridden.png'], extra: 'kept' },
    } as Parameters<typeof client.images.edit>[0])
    expect(bodies[0].extra_body).toMatchObject({ response_format: 'url', extra: 'kept' })
    expect((bodies[0].extra_body as Record<string, unknown[]>).image).toHaveLength(1)
    expect(String((bodies[0].extra_body as Record<string, unknown[]>).image[0])).toContain('data:image/png;base64,')
  })

  it('官方 SDK reference 中超过数量限制仍在本地拒绝', async () => {
    const { client, bodies } = sdkApp()
    await expect(client.videos.create({ model: 'agnes-video-2.5-flash', prompt: 'Reference test',
      extra_body: { mode: 'reference', images: Array(6).fill('https://example.com/image.png') },
    } as VideoCreateParams)).rejects.toMatchObject({ status: 400 })
    expect(bodies).toHaveLength(0)
  })

  it('官方 SDK 对象数组视频参考仍触发 Flash 参数校验', async () => {
    const { client, bodies } = sdkApp()
    await expect(client.videos.create({ model: 'agnes-video-2.5-flash', prompt: 'Reference test',
      extra_body: { mode: 'reference', videos: [{ url: 'https://example.com/ref.mp4', start_seconds: 0, require_audio: false }] },
    } as VideoCreateParams)).rejects.toMatchObject({ status: 400 })
    expect(bodies).toHaveLength(0)
  })

  it('Agnes 文本、批量图片、图片编辑、视频创建/查询/下载均可使用', async () => {
    const bodies: Record<string, unknown>[] = []
    let mediaAuth: string | null = 'not-called'
    let imageIndex = 0
    const upstreamFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (url.hostname === 'media.example') {
        mediaAuth = headers.get('authorization')
        return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'content-type': 'video/mp4' } })
      }
      expect(headers.get('authorization')).toBe('Bearer sdk-test-key')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      if (body) bodies.push(body)
      if (url.pathname.endsWith('/chat/completions')) return Response.json({
        id: 'chatcmpl-sdk', object: 'chat.completion', created: 1, model: 'agnes-3.0-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
      if (url.pathname.endsWith('/images/generations')) return Response.json({ created: 1, data: [{ url: `https://images.example/${imageIndex++}.png` }] })
      if (url.pathname.endsWith('/videos') && init?.method === 'POST') return Response.json({
        id: 'task-sdk', task_id: 'task-sdk', video_id: 'video-sdk', model: 'agnes-video-2.5-flash',
        object: 'video', status: 'queued', progress: 0, created_at: 1, seconds: '4', size: '720P',
      })
      if (url.pathname.endsWith('/agnesapi')) {
        expect(url.searchParams.get('video_id')).toBe('video-sdk')
        expect(url.searchParams.get('model_name')).toBe('agnes-video-2.5-flash')
        // 实际查询信封可能省略 model 与 video_id，只保留 task id。
        return Response.json({
          id: 'task-sdk', object: 'video', status: 'completed', progress: 100, created_at: 1,
          completed_at: 2, seconds: '4', size: '720P', url: 'https://media.example/video.mp4', error: null,
        })
      }
      throw new Error(`Unexpected mock upstream path: ${url.pathname}`)
    }) as typeof fetch
    const app = createGatewayApp({ fetch: upstreamFetch, env: {} })
    // SDK 经过自己的 JSON/multipart 序列化；不启服务，全部通过 app.fetch 注入。
    const sdkFetch = Object.assign((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'data:,') return new Response('')
      const request = input instanceof Request && !init ? input : new Request(input, init)
      return app.fetch(request)
    }) as typeof fetch, { Response })
    const client = new OpenAI({ apiKey: 'sdk-test-key', baseURL: 'https://gateway.example/agnes/v1', fetch: sdkFetch, maxRetries: 0 })
    const chat = await client.chat.completions.create({
      model: 'agnes-3.0-flash', reasoning_effort: 'none', messages: [{ role: 'user', content: 'Reply OK.' }],
    })
    expect(chat.choices[0].message.content).toBe('OK')
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false })

    const images = await client.images.generate({ model: 'agnes-image-2.5-flash', prompt: 'An orange square.', n: 2, size: '1024x1024' })
    expect(images.data).toHaveLength(2)
    const file = await toFile(new Uint8Array([1, 2, 3]), 'image.png', { type: 'image/png' })
    const edited = await client.images.edit({ model: 'agnes-image-2.5-flash', image: [file, file], prompt: 'Repaint.', response_format: 'url' })
    expect(edited.data?.[0].url).toContain('images.example')
    const editBody = bodies.find((body) => body.prompt === 'Repaint.')
    expect(editBody?.extra_body).toEqual({ image: ['data:image/png;base64,AQID', 'data:image/png;base64,AQID'], response_format: 'url' })

    const created = await client.videos.create({
      model: 'agnes-video-2.5-flash', prompt: 'Animate.', seconds: '4', size: '1280x720', input_reference: file,
    })
    expect(created.id).toBe('agnes-video-2.5-flash:video-sdk')
    expect(created.object).toBe('video')
    expect(bodies.find((body) => body.model === 'agnes-video-2.5-flash')).toMatchObject({
      first_frame: 'data:image/png;base64,AQID', mode: 'keyframe', seconds: '4', size: '720P', aspect_ratio: '16:9',
    })
    const retrieved = await client.videos.retrieve(created.id)
    expect(retrieved.id).toBe(created.id)
    expect(retrieved.status).toBe('completed')
    expect(retrieved.model).toBe('agnes-video-2.5-flash')
    const content = await client.videos.downloadContent(created.id)
    expect([...new Uint8Array(await content.arrayBuffer())]).toEqual([0, 1, 2, 3])
    expect(mediaAuth).toBeNull()
  })
})
