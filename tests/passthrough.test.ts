import { describe, expect, it } from 'vitest'
import { createGatewayApp } from '../app/api'

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

function makeApp(
  handler: (req: CapturedRequest) => Response | Promise<Response> = () => new Response('ok'),
  env: Record<string, string> = {},
) {
  const { impl, calls } = makeFetch(handler)
  const app = createGatewayApp({ fetch: impl, env })
  return { app, calls }
}

async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  return new Response(body as BodyInit | null).text()
}

describe('完全透传供应商 "_"', () => {
  it('任意路径、方法、查询与请求体都原样转发', async () => {
    const { app, calls } = makeApp(() => new Response('ok'))
    const res = await app.request('/_/https://upstream.example/custom/path?a=1&a=2', {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: 'Bearer raw-key',
        'x-custom': 'yes',
      },
      body: 'raw-bytes',
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://upstream.example/custom/path?a=1&a=2')
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].headers.get('authorization')).toBe('Bearer raw-key')
    expect(calls[0].headers.get('x-custom')).toBe('yes')
    expect(await bodyText(calls[0].body)).toBe('raw-bytes')
  })

  it('不做认证转换：x-api-key 不会变成 Authorization', async () => {
    const { app, calls } = makeApp()
    await app.request('/_/https://upstream.example/v1/models', {
      headers: { 'x-api-key': 'sk-raw' },
    })
    expect(calls[0].headers.get('x-api-key')).toBe('sk-raw')
    expect(calls[0].headers.get('authorization')).toBeNull()
  })

  it('上游状态码、响应头与正文原样返回（不套错误信封）', async () => {
    const { app } = makeApp(() => new Response('teapot body', {
      status: 418,
      headers: { 'content-type': 'text/plain', 'x-upstream': 'teapot' },
    }))
    const res = await app.request('/_/https://upstream.example/teapot', { method: 'DELETE' })

    expect(res.status).toBe(418)
    expect(res.headers.get('content-type')).toBe('text/plain')
    expect(res.headers.get('x-upstream')).toBe('teapot')
    expect(await res.text()).toBe('teapot body')
  })

  it('SSE 原样返回，不补齐 [DONE] 也不改 chunk', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
    const { app } = makeApp(() => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
    const res = await app.request('/_/https://upstream.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [], stream: true }),
    })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe(sse)
  })

  it('相对路径使用 __BASE_URL，且 /v1 仅作版本标记', async () => {
    const { app, calls } = makeApp(() => new Response('ok'), { __BASE_URL: 'https://env.example/v9' })
    await app.request('/_/v1/chat/completions?trace=1', { method: 'POST', body: '{}' })
    await app.request('/_/chat/completions', { method: 'POST', body: '{}' })

    expect(calls[0].url).toBe('https://env.example/v9/chat/completions?trace=1')
    expect(calls[1].url).toBe('https://env.example/v9/chat/completions')
  })

  it('相对路径保留 __BASE_URL 自带的查询串', async () => {
    const { app, calls } = makeApp(() => new Response('ok'), {
      __BASE_URL: 'https://env.example/v1?api-version=2',
    })
    await app.request('/_/chat/completions?x=1', { method: 'POST', body: '{}' })
    expect(calls[0].url).toBe('https://env.example/v1/chat/completions?api-version=2&x=1')
  })

  it('"/_" 转发到 baseUrl 根路径', async () => {
    const { app, calls } = makeApp(() => new Response('ok'), { __BASE_URL: 'https://env.example/v1' })
    await app.request('/_?probe=1')
    expect(calls[0].url).toBe('https://env.example/v1/?probe=1')
  })

  it('无 __BASE_URL 时使用默认上游，并保留任意路径', async () => {
    const { app, calls } = makeApp()
    await app.request('/_/v10/custom', { method: 'POST', body: '{}' })
    expect(calls[0].url).toBe('https://api.openai.com/v1/v10/custom')
  })

  it('支持百分号编码的绝对 URL 与额外查询参数', async () => {
    const { app, calls } = makeApp()
    await app.request('/_/https%3A%2F%2Fencoded.example%2Fv1%2Fmodels%3Fa%3D1?b=2')
    expect(calls[0].url).toBe('https://encoded.example/v1/models?a=1&b=2')
  })

  it('绝对 URL 的 %2F / %3F 与尾斜杠不被改写', async () => {
    const { app, calls } = makeApp()
    await app.request('/_/https://u.example/a%2Fb%3Fc/')
    expect(calls[0].url).toBe('https://u.example/a%2Fb%3Fc/')
  })

  it('整体编码的 URL 只解码一次，路径内编码与尾斜杠保留', async () => {
    const { app, calls } = makeApp()
    await app.request('/_/https%3A%2F%2Fu.example%2Fa%252Fb%2F')
    expect(calls[0].url).toBe('https://u.example/a%2Fb/')
  })

  it('查询串末尾的 "/" 不被截断', async () => {
    const { app, calls } = makeApp()
    await app.request('/_/https%3A%2F%2Fu.example%2Fp%3Fnext%3D%2F')
    expect(calls[0].url).toBe('https://u.example/p?next=/')
  })

  it('__BASE_URL 查询值末尾的 "/" 不被截断', async () => {
    const { app, calls } = makeApp(() => new Response('ok'), {
      __BASE_URL: 'https://env.example/v1?target=foo/',
    })
    await app.request('/_/chat/completions', { method: 'POST', body: '{}' })
    expect(calls[0].url).toBe('https://env.example/v1/chat/completions?target=foo/')
  })

  it('拒绝 userinfo 与非 http(s) 绝对目标', async () => {
    const { app, calls } = makeApp()
    const userinfo = await app.request('/_/https://user:pass@u.example/x')
    expect(userinfo.status).toBe(400)
    expect((await userinfo.json()).error.code).toBe('invalid_base_url')

    const ftp = await app.request('/_/ftp://u.example/x')
    expect(ftp.status).toBe(400)
    expect((await ftp.json()).error.code).toBe('invalid_base_url')
    expect(calls).toHaveLength(0)
  })

  it('scheme-like 目标按 URL 解析，不被静默当成相对路径', async () => {
    const { app, calls } = makeApp()
    await app.request('/_/https:/u.example/x')
    await app.request('/_/https:u.example/x')
    await app.request('/_/http:/u.example/y')

    expect(calls[0].url).toBe('https://u.example/x')
    expect(calls[1].url).toBe('https://u.example/x')
    expect(calls[2].url).toBe('http://u.example/y')
  })

  it('无法解析的编码 scheme-like 目标返回 400，不改发默认上游', async () => {
    const { app, calls } = makeApp()
    const res = await app.request('/_/https%3A%2F%2Fu.example%2F%zz')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('invalid_base_url')
    expect(calls).toHaveLength(0)
  })

  it('畸形 Connection token 不会导致 500', async () => {
    const { app } = makeApp(() => new Response('ok', {
      headers: { connection: 'keep-alive, bad token' },
    }))
    const res = await app.request('/_/https://u.example/x', {
      headers: { connection: 'keep-alive, bad token' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('普通透传响应仍带网关 CORS 头', async () => {
    const { app } = makeApp()
    const res = await app.request('/_/https://u.example/x', {
      headers: { origin: 'https://app.example' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('OPTIONS 也原样转发，不被 CORS 预检短路', async () => {
    const { app, calls } = makeApp(() => new Response(null, { status: 204 }))
    const res = await app.request('/_/https://u.example/x', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(204)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('OPTIONS')
  })

  it('保留上游 x-request-id', async () => {
    const { app } = makeApp(() => new Response('ok', { headers: { 'x-request-id': 'upstream-id' } }))
    const res = await app.request('/_/https://u.example/x')
    expect(res.headers.get('x-request-id')).toBe('upstream-id')
  })

  it('请求与响应都剔除逐跳头及 Connection 列举字段', async () => {
    const { app, calls } = makeApp(() => new Response('ok', {
      headers: {
        connection: 'keep-alive, x-upstream-hop',
        'x-upstream-hop': 'drop',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
      },
    }))
    const res = await app.request('/_/https://u.example/x', {
      headers: { connection: 'x-secret-hop', 'x-secret-hop': 'drop', 'x-keep': 'yes' },
    })

    expect(calls[0].headers.get('connection')).toBeNull()
    expect(calls[0].headers.get('x-secret-hop')).toBeNull()
    expect(calls[0].headers.get('x-keep')).toBe('yes')
    expect(calls[0].headers.get('accept-encoding')).toBe('identity')

    expect(res.headers.get('connection')).toBeNull()
    expect(res.headers.get('x-upstream-hop')).toBeNull()
    expect(res.headers.get('keep-alive')).toBeNull()
    expect(res.headers.get('transfer-encoding')).toBeNull()
  })

  it('content-encoding: identity 时保留 content-length', async () => {
    const { app } = makeApp(() => new Response('plain', {
      headers: { 'content-encoding': 'identity', 'content-length': '5' },
    }))
    const res = await app.request('/_/https://upstream.example/plain')
    expect(res.headers.get('content-encoding')).toBe('identity')
    expect(res.headers.get('content-length')).toBe('5')
    expect(await res.text()).toBe('plain')
  })

  it('fetch 已解压时移除失效的 content-encoding / content-length', async () => {
    const { app } = makeApp(() => new Response('decoded', {
      headers: { 'content-encoding': 'gzip', 'content-length': '7' },
    }))
    const res = await app.request('/_/https://upstream.example/compressed')
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    expect(await res.text()).toBe('decoded')
  })
})
