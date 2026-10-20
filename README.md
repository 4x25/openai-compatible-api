# openai-compatible-api

对接各小众大模型网关，将其请求/响应抹平为标准 **OpenAI compatible API** 的轻量转换层。

- 基于 Hono，无任何状态存储，每次请求都是无状态函数，可部署到边缘运行时（仅使用 Web 标准 API）
- 供应商逻辑可插拔：新增供应商 = 一个 provider 文件 + 一行注册
- 网关生产环境**不内置任何密钥**：凭证完全由使用方传入，网关只做透传或针对性转换

## 快速开始

```bash
cp .env.example .env    # 填入开发用的 *_API_KEY_FOR_DEV（可选）
npm install
npm run dev             # http://localhost:5173
```

## baseUrl 与路由

以部署在 `https://example.com` 为例，使用方的 baseUrl 支持两种形式：

```
https://example.com/<provider>/v1                  ← 读取 ${PROVIDER}_BASE_URL，缺省用 provider 默认值
https://example.com/<provider>/<providerBaseUrl>   ← 任意上游 http(s) URL，原样使用（允许任意 host）
```

客户端按 OpenAI 习惯在其后拼接端点：

```bash
# 标准形式
curl https://example.com/saltyfish/v1/chat/completions ...

# 显式指定上游 baseUrl
curl https://example.com/saltyfish/https://ai.saltyfish.live/v1/chat/completions ...
```

省略版本前缀（`/<provider>/chat/completions`）同样有效；`/<provider>/v1` 中的 `v1` 只是标记，实际上游地址始终由 env/默认值决定。自定义 baseUrl 支持任意 host、端口、路径与查询参数，也支持百分号编码形式（`https%3A%2F%2F...`）。

### 端点

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/models` | GET | 模型列表（必须） |
| `/chat/completions` | POST | 文本模型（必须） |
| `/images/generations` | POST | 图像模型 |
| `/images/edits` | POST | 图像模型（multipart/form-data） |
| `/video/generations` | POST | 视频模型：创建任务 |
| `/video/generations/{task_id}` | GET | 视频模型：查询任务 |

无任务存储：`task_id` 直接使用上游返回值，查询透传给上游。

## 抹平规则

- **未知参数静默丢弃**：以 OpenAI 标准参数白名单为准，使用方传入的上游不认识的参数不报错
- **供应商级参数控制**：`unsupportedParams`（再剔除）/ `extraParams`（放行私有参数）
- **流式双向适配**：

| 客户端请求 | 上游能力 | 网关行为 |
| --- | --- | --- |
| stream | 支持流式 | 逐 chunk 归一化透传，保证 `[DONE]` 结尾 |
| stream | 仅非流式 | 截获并等待上游完整响应后，合成 SSE 返回 |
| 非流式 | 仅流式 | 消费完整 SSE，聚合为一个完整 JSON |
| 非流式 | 非流式 | 归一化为标准 JSON |

- **错误抹平**：任何上游错误（`{"error":"..."}`、`{"error":{"message":...}}`、纯文本 `error code: 502`、HTML 错误页等）统一输出 OpenAI 错误信封：

```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": null, "code": null } }
```

状态码映射：上游 4xx 保留原状态，5xx 统一为 502，超时为 504；未知供应商/端点、方法不支持（405 + `Allow`）、缺参、非法 baseUrl 等全部为 OpenAI 格式 JSON。

- **杂牌响应兜底**：上游 200 返回纯文本时包装为 `assistant` content；图片接口返回二进制时自动转 `b64_json`
- **CORS**：任意 origin 放行
- 每个响应携带 `x-request-id`

## 认证模型

网关不存储、不强制任何凭证。解析优先级：

```
客户端 Authorization  >  客户端 x-api-key  >  ${PROVIDER}_API_KEY_FOR_DEV（仅开发兜底）
```

- **默认供应商**（标准 `Authorization: Bearer`）：客户端 `Authorization` 原样透传；只传了 `x-api-key` 时转换为 `Authorization: Bearer`
- **自定义认证供应商**：按 provider 的 `auth` 配置转换，例如剥掉 `Bearer` 前缀写入 `x-api-key`
- 什么凭证都没有时不附加认证头，由上游决定 401
- `*_API_KEY_FOR_DEV` 仅用于本地开发/联调（省去每次 curl 带 key），**生产环境永远不要设置**

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `${PROVIDER}_BASE_URL` | 否 | 覆盖默认上游 baseUrl（provider id 大写、非字母数字转下划线，如 `MY_PROVIDER_BASE_URL`） |
| `${PROVIDER}_API_KEY_FOR_DEV` | 否 | 开发/联调兜底凭证，生产环境不设置 |
| `UPSTREAM_TIMEOUT_MS` | 否 | 上游超时（毫秒），默认 300000 |

开发模式由 `vite.config.ts` 自动把 `.env` 注入 `process.env`；生产 `npm start` 通过 `node --env-file-if-exists` 加载，实际部署时用平台环境变量即可。

## 架构

```
app/
  server.ts                  # HonoX 入口：CORS + gateway 中间件（非 API 路径放行给页面）
  api/
    app.ts                   # 网关子应用：路由分发、认证解析、错误边界
    router.ts                # 路径解析（provider 段 + baseUrl 前缀 + 端点后缀）
    upstream.ts              # 上游调用：fetch、超时/取消、认证头构建、错误读取
    sse.ts                   # SSE 解析 / chunk 归一化 / 聚合 / 合成
    params.ts                # 参数白名单过滤
    errors.ts                # OpenAI 错误信封 + 上游错误归一化
    http.ts                  # JSON/SSE 响应工具
    handlers/                # models / chat / images / video 端点处理
    providers/
      types.ts               # Provider / ChatAdapter / ImageAdapter / VideoAdapter 契约
      registry.ts            # 注册表（registerProvider 即插件入口）
      saltyfish.ts           # 首个供应商
```

## 新增供应商

1. 新建 `app/api/providers/<id>.ts`：

```ts
import { registerProvider } from './registry'
import type { Provider } from './types'

registerProvider({
  id: 'agnes',
  name: 'Agnes AI',
  defaultBaseUrl: 'https://apihub.agnes-ai.com/v1',
  models: [{ id: 'agnes-1', ownedBy: 'agnes' }],
  // 认证透传为默认行为；上游用 x-api-key 时：
  // auth: { header: 'x-api-key', scheme: '' },
  chat: {
    // 上游就是 OpenAI compatible 时零配置；不支持的参数：
    // unsupportedParams: ['logprobs'],
    // 私有参数放行：extraParams: ['agnes_mode'],
    // 非 OpenAI 协议时用三个 hook 适配：
    // transformRequest / transformResponse / transformStreamChunk
  },
  images: {
    generations: { path: '/images/generations' },
  },
  video: {
    create: { path: '/video/generations' },
    get: { path: '/video/generations/{task_id}' },
  },
} satisfies Provider)
```

2. 在 `app/api/providers/registry.ts` 顶部 import 该文件（或在其中调用 `registerProvider`）。

3. 可选设置 `AGNES_BASE_URL` / `AGNES_API_KEY_FOR_DEV` 环境变量。完成——`https://example.com/agnes/v1/*` 立即可用。

能力由适配器是否存在决定：不声明 `chat` 则 `/chat/completions` 返回结构化的 `unsupported_endpoint`，不会误转发。

## 开发

```bash
npm run dev         # 开发服务器
npm run build       # 构建到 dist/（Node）
npm start           # 运行构建产物
npm test            # Vitest 测试（路由/认证/参数/流式矩阵/错误抹平/图片/视频）
npm run typecheck   # tsc --noEmit
```

## 安全说明

- 网关生产环境零内置密钥；上游凭证由使用方随请求提供，发往哪个上游也由使用方选择
- `*_API_KEY_FOR_DEV` 兜底凭证会发往任意自定义 baseUrl，请仅在本机/可信环境使用
- 公网部署时建议在网关前自行加访问控制（如平台侧鉴权 / 反向代理限制），避免被第三方消耗上游配额
