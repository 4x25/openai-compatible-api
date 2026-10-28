import type {
  ChatCompletionRequest,
  ImageGenerationRequest,
  ImagesResponse,
  ModelInfo,
  VideoCreateRequest,
  VideoResponse,
} from '../types'

// ---------------------------------------------------------------------------
// 调用上下文
// ---------------------------------------------------------------------------

/** 发往上游的请求描述 */
export interface UpstreamRequest {
  /** 相对于 baseUrl 的路径，以 / 开头 */
  path: string
  /** 覆盖请求的 API 前缀（例如供应商的版本外轮询端点）。 */
  baseUrl?: string
  /** 合并到 baseUrl 的查询参数，避免作为 pathname 编码。 */
  query?: Record<string, string>
  method?: string
  headers?: HeadersInit
  /** JSON 请求体（与 formData 二选一） */
  json?: unknown
  /** multipart 请求体（与 json 二选一） */
  formData?: FormData
}

/** 供应商调用上下文：由网关构造 */
export interface ProviderCallContext {
  /** 本次请求实际使用的上游 baseUrl（无尾斜杠，可能是 env / 默认值 / 使用方自定义） */
  baseUrl: string
  /** 使用方凭证（已剥掉 scheme）；未传时为 null */
  credential: string | null
  /** 解析后的环境变量（含 dev key 等） */
  env: Record<string, string | undefined>
  /** 原始 fetch（边缘运行时兼容） */
  fetch: typeof fetch
  /** 请求取消信号 */
  signal: AbortSignal
}

// ---------------------------------------------------------------------------
// Chat 适配器
// ---------------------------------------------------------------------------

export interface ChatAdapter {
  /** 上游端点路径，默认 '/chat/completions' */
  path?: string
  /** 上游是否支持流式响应，默认 true */
  supportsStreaming?: boolean
  /** 上游是否支持非流式响应，默认 true */
  supportsNonStreaming?: boolean
  /** 上游不支持的参数（会被静默丢弃） */
  unsupportedParams?: string[]
  /** 允许透传给上游的供应商私有参数（网关白名单之外的） */
  extraParams?: string[]
  /** 转换标准请求 -> 上游请求体；默认透传（深拷贝后的过滤结果） */
  transformRequest?: (req: ChatCompletionRequest, ctx: ProviderCallContext) => Promise<unknown> | unknown
  /** 转换上游非流式响应 -> 标准响应；默认透传 */
  transformResponse?: (res: unknown, ctx: ProviderCallContext) => Promise<unknown> | unknown
  /** 转换上游流式 chunk -> 标准 chunk；默认透传 */
  transformStreamChunk?: (chunk: unknown, ctx: ProviderCallContext) => Promise<unknown> | unknown
}

// ---------------------------------------------------------------------------
// Image / Video 适配器
// ---------------------------------------------------------------------------

export interface ImageAdapter {
  /** 上游端点路径 */
  path: string
  unsupportedParams?: string[]
  extraParams?: string[]
  maxRequestBytes?: number
  /**
   * 转换标准请求 -> 上游请求。
   * 默认：json = 过滤后的标准请求体。
   */
  transformRequest?: (req: ImageGenerationRequest, ctx: ProviderCallContext) => Promise<UpstreamRequest | UpstreamRequest[]> | UpstreamRequest | UpstreamRequest[]
  /** 解析并过滤原始 multipart；未声明时保持默认白名单和文件透传行为。 */
  transformMultipartRequest?: (form: FormData, ctx: ProviderCallContext) => Promise<UpstreamRequest | UpstreamRequest[]> | UpstreamRequest | UpstreamRequest[]
  /** 所有图片分支响应的累计字节上限。 */
  maxResponseBytes?: number
  /** 转换上游响应 -> 标准响应 */
  transformResponse?: (res: unknown, ctx: ProviderCallContext) => Promise<ImagesResponse> | ImagesResponse
}

export interface VideoResponseContext {
  requestModel?: string
  videoId?: string
}

export interface VideoAdapter {
  /** 上游端点路径；查询适配器可用 {video_id} 占位符。 */
  path: string
  unsupportedParams?: string[]
  extraParams?: string[]
  maxRequestBytes?: number
  transformRequest?: (req: VideoCreateRequest, ctx: ProviderCallContext) => Promise<UpstreamRequest> | UpstreamRequest
  transformMultipartRequest?: (form: FormData, ctx: ProviderCallContext) => Promise<UpstreamRequest> | UpstreamRequest
  transformTaskRequest?: (videoId: string, ctx: ProviderCallContext) => Promise<UpstreamRequest> | UpstreamRequest
  transformResponse?: (res: unknown, ctx: ProviderCallContext, info: VideoResponseContext) => Promise<unknown> | unknown
}

export interface VideoContentAdapter {
  /** 从查询结果中获取媒体地址；默认使用顶层 url。 */
  resolveUrl?: (video: VideoResponse) => string | undefined
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProviderAuth {
  /** 上游期望的认证头，默认 'authorization' */
  header?: string
  /** 上游期望的 scheme，默认 'Bearer'；'' 表示凭证原样写入 */
  scheme?: string
  /** 附加上游请求头，例如 anthropic-version */
  extraHeaders?: Record<string, string>
}

export interface Provider {
  /** 供应商 id，用作路由第一段（小写） */
  id: string
  name: string
  /** 默认上游 baseUrl */
  defaultBaseUrl: string
  /**
   * 使用 /<provider>/v1 形式时，若 env baseUrl 未带路径则自动补全的版本前缀。
   * 默认 '/v1'。显式 baseUrl 永远原样使用。
   */
  versionPath?: string
  /** 模型列表：静态数组或从上游拉取 */
  models: ModelInfo[] | ((ctx: ProviderCallContext) => Promise<ModelInfo[]>)
  /**
   * 认证转换配置；缺省为标准 Authorization: Bearer 透传。
   * 'none' 表示上游无需鉴权：网关剥离客户端凭证，也不读取 dev key，
   * 避免把使用方发给本网关的 key 转发给第三方上游。
   */
  auth?: ProviderAuth | 'none'
  /** 附加到所有上游请求的头 */
  headers?: Record<string, string>
  chat?: ChatAdapter
  images?: {
    generations?: ImageAdapter
    edits?: ImageAdapter
  }
  video?: {
    create?: VideoAdapter
    get?: VideoAdapter
    content?: VideoContentAdapter
  }
}
