import { describe, expect, it, vi } from 'vitest'
import { createGatewayApp, registerProvider } from '../app/api'
import { GatewayError } from '../app/api/errors'
import { bytesToBase64, readBytes } from '../app/api/http'
import { agnes } from '../app/api/providers/agnes'
import { upstreamUrl } from '../app/api/upstream'
import type { ImageGenerationRequest } from '../app/api/types'
import type { ProviderCallContext } from '../app/api/providers/types'

registerProvider({
  id: 'mockmedialimits', name: 'Media limits fixture', defaultBaseUrl: 'https://mock.example/v1', models: [],
  images: { generations: { path: '/images/generations', maxRequestBytes: 128, maxResponseBytes: 80,
    transformRequest: () => Array.from({ length: 2 }, () => ({ path: '/images/generations', json: {} })) } },
  video: { create: { path: '/videos', maxRequestBytes: 128 } },
})

const context = {} as ProviderCallContext

describe('媒体边界和取消', () => {
  it.each(['images/generations', 'videos'])('上游正文断连返回 502，不是内部 500：%s', async (endpoint) => {
    const app = createGatewayApp({ env: {}, fetch: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('private transport failure')) },
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch })
    const res = await app.request(`/agnes/v1/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: endpoint === 'videos' ? 'agnes-video-2.5-flash' : 'agnes-image-2.5-flash', prompt: 'test' }),
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.code).toBe('upstream_error')
    expect(body.error.message).not.toContain('private transport failure')
  })

  it('multipart 嵌套结构拒绝原型键与冲突数组', async () => {
    for (const field of ['extra_body[__proto__][polluted]', 'extra_body[constructor][prototype][polluted]', 'images[999999]']) {
      const form = new FormData()
      form.set('model', 'agnes-video-2.5-flash')
      form.set('prompt', 'test')
      form.set(field, 'test')
      await expect(agnes.video!.create!.transformMultipartRequest!(form, context)).rejects.toMatchObject({ status: 400 })
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('通用 MIME 的假图片不按文件扩展名接受', async () => {
    const form = new FormData()
    form.set('model', 'agnes-image-2.5-flash')
    form.set('prompt', 'test')
    form.set('image', new Blob(['<script>evil</script>'], { type: 'application/octet-stream' }), 'image.png')
    await expect(agnes.images!.edits!.transformMultipartRequest!(form, context)).rejects.toMatchObject({ status: 400 })
  })

  it('Web Base64 编码能处理超过 spread 限制的数组', () => {
    const bytes = new Uint8Array(100_000).fill(0x61)
    expect(atob(bytesToBase64(bytes))).toBe('a'.repeat(bytes.length))
  })

  it('读取越界时取消 body 并释放锁', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(9)) },
      cancel() { cancelled = true },
    })
    await expect(readBytes(body, 8, () => new GatewayError('Too large.', { status: 413 }))).rejects.toMatchObject({ status: 413 })
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })

  it.each(['images/generations', 'videos'])('请求超过配置上限时在解析前拒绝：%s', async (endpoint) => {
    const fetchMock = vi.fn()
    const app = createGatewayApp({ fetch: fetchMock as typeof fetch, env: {} })
    const res = await app.request(`/mockmedialimits/v1/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', prompt: 'x'.repeat(129) }),
    })
    expect(res.status).toBe(413)
    expect((await res.json()).error.code).toBe('request_too_large')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('图片累计响应超过上限时整体报错并取消未消费的分支', async () => {
    let index = 0
    let cancelled = false
    const app = createGatewayApp({ env: {}, fetch: (async () => index++ === 0
      ? Response.json({ data: [{ b64_json: 'x'.repeat(100) }] })
      : new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))) as typeof fetch })
    const res = await app.request('/mockmedialimits/v1/images/generations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test', prompt: 'test' }),
    })
    expect(res.status).toBe(502)
    expect(cancelled).toBe(true)
  })

  it('单文件超过 20 MiB 在编码前拒绝', async () => {
    const form = new FormData()
    form.set('model', 'agnes-image-2.5-flash')
    form.set('prompt', 'Edit')
    form.set('image', new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png')
    await expect(agnes.images!.edits!.transformMultipartRequest!(form, context)).rejects.toMatchObject({ status: 413, code: 'file_too_large' })
  })

  it('编辑文件/JSON 引用数量超过 16 提前拒绝', async () => {
    const form = new FormData()
    form.set('model', 'agnes-image-2.5-flash')
    form.set('prompt', 'Edit')
    for (let i = 0; i < 17; i++) form.append('image', new Blob(['small'], { type: 'image/png' }), `${i}.png`)
    await expect(agnes.images!.edits!.transformMultipartRequest!(form, context)).rejects.toMatchObject({ status: 413, code: 'too_many_files' })
    expect(() => agnes.images!.edits!.transformRequest!({
      model: 'agnes-image-2.5-flash', prompt: 'Edit', images: Array(17).fill('https://example.com/image.png'),
    }, context)).toThrow(GatewayError)
  })

  it('标准编辑空/非法值不会被扩展参考图偷偷替代', () => {
    for (const image of [null, [], { file_id: 'file-test' }]) {
      expect(() => agnes.images!.edits!.transformRequest!({
        model: 'agnes-image-2.5-flash', prompt: 'Edit', image,
        extra_body: { image: ['https://example.com/fallback.png'] },
      } as ImageGenerationRequest, context)).toThrow(GatewayError)
    }
  })

  it('上游 URL 合并路径查询与 API 前缀查询，不将问号编码成 pathname', () => {
    expect(upstreamUrl('https://example.com/prefix/v1?tenant=test', {
      path: '/task?video_id=one%2Ftwo', query: { model_name: 'flash' },
    })).toBe('https://example.com/prefix/v1/task?tenant=test&video_id=one%2Ftwo&model_name=flash')
  })

  it('超时映射 504 并中断上游', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const app = createGatewayApp({ env: { UPSTREAM_TIMEOUT_MS: '1000' }, fetch: ((_input, init) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true })
      })) as typeof fetch })
      const response = app.request('/agnes/v1/videos', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'agnes-video-2.5-flash', prompt: 'test' }),
      })
      await vi.advanceTimersByTimeAsync(1001)
      const res = await response
      expect(res.status).toBe(504)
      expect((await res.json()).error.code).toBe('upstream_timeout')
      expect(signal?.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('客户端在读取图片 body 时取消，取消关联保持到响应结束', async () => {
    const abort = new AbortController()
    let upstreamSignal: AbortSignal | undefined
    const app = createGatewayApp({ env: {}, fetch: (async (_input, init) => {
      upstreamSignal = init?.signal ?? undefined
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamSignal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
          abort.abort()
        },
      }))
    }) as typeof fetch })
    const res = await app.request('/agnes/v1/images/generations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
      body: JSON.stringify({ model: 'agnes-image-2.5-flash', prompt: 'test' }),
    })
    expect(upstreamSignal?.aborted).toBe(true)
    // 请求取消不应反射底层异常详情。
    expect(res.status).toBe(499)
    await res.body?.cancel()
  })
})
