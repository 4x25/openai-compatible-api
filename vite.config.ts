import build from '@hono/vite-build/node'
import adapter from '@hono/vite-dev-server/node'
import tailwindcss from '@tailwindcss/vite'
import honox from 'honox/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // 将 .env 中的变量注入 process.env，供 dev server 内运行的网关后端读取
  // （Vite 只把 VITE_ 前缀变量暴露给客户端，其余变量不会进入客户端构建产物）
  const fileEnv = loadEnv(mode, process.cwd(), '')
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value
  }

  return {
    plugins: [
      honox({
        devServer: { adapter },
        client: { input: ['/app/client.ts', '/app/style.css'] }
      }),
      tailwindcss(),
      build()
    ],
  }
})
