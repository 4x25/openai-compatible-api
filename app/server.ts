import { showRoutes } from 'hono/dev'
import { cors } from 'hono/cors'
import { createApp } from 'honox/server'
import { gateway, isPassthroughRequest } from './api'

const app = createApp({
  init(app) {
    // 任意 origin 的 CORS；透传调试路径的 OPTIONS 不短路，交给网关原样转发
    const corsMiddleware = cors()
    app.use('*', async (c, next) => {
      if (c.req.method === 'OPTIONS' && isPassthroughRequest(c.req.url)) return next()
      return corsMiddleware(c, next)
    })
    // 网关中间件：命中已知 API 端点时接管，否则放行给 HonoX 页面路由
    app.use('*', gateway())
  },
})

showRoutes(app)

export default app
