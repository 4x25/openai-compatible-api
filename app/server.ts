import { showRoutes } from 'hono/dev'
import { cors } from 'hono/cors'
import { createApp } from 'honox/server'
import { gateway } from './api'

const app = createApp({
  init(app) {
    // 任意 origin 的 CORS；OPTIONS 预检在这里统一短路
    app.use('*', cors())
    // 网关中间件：命中已知 API 端点时接管，否则放行给 HonoX 页面路由
    app.use('*', gateway())
  },
})

showRoutes(app)

export default app
