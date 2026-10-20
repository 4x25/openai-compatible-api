# openai-compatible-api

将小众大模型网关抹平为 OpenAI compatible API 的 Hono 转换层。HonoX 落地页 + 无状态 API 网关。

## 命令

```bash
npm run dev         # Vite dev server（默认 5173/5174）
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npx vitest run -t "关键词"   # 只跑匹配的用例
npm run build       # 先 client 构建，再 SSR 构建（顺序固定，两阶段缺一不可）
npm start           # cd dist && node --env-file-if-exists=../.env index.js
```

改动后的验证顺序：`typecheck` → `test` → `build`。测试不需要网络/真实上游（fetch 全 mock）；真实上游 E2E 需 `.env` 里的 `SALTYFISH_API_KEY_FOR_DEV`。

## 架构要点

- 两条线：`app/routes/`+`app/islands/` 是 HonoX 落地页；`app/api/` 是网关后端。`app/server.ts` 通过 `createApp({ init })` 把 `cors()` + `gateway()` 中间件注册在 HonoX 路由**之前**。
- 网关不注册任何路由。`gateway()` 用 `matchApiRoute()`（`app/api/router.ts`）按**端点后缀**判断是否接管请求，非 API 路径调用 `next()` 放行给 HonoX 页面。不要改用 `/:provider/*` catch-all 路由——会截走 `/app/client.ts`、`/static/*` 并破坏落地页。
- 新增端点：必须在 `router.ts` 的 `ENDPOINTS` 表里加后缀正则，然后接 `app.ts` 的 dispatch。
- baseUrl 双形式：`/<provider>/v1/...`（读 env/默认值）与 `/<provider>/<任意上游URL>/...`（原样使用）。自定义 baseUrl 不自动补 `/v1`；versionPath 自动补全只作用于 env/默认 baseUrl。
- 流式抹平矩阵在 `app/api/sse.ts`：透传/聚合/合成三路径，`[DONE]` 由网关兜底补齐。

## 供应商插件

- 新增供应商 = `app/api/providers/` 下一个文件 + 在 `registry.ts` 注册（`registerProvider`）。能力由 `chat`/`images`/`video` 适配器是否存在决定，未声明的能力返回结构化 `unsupported_endpoint` 而非误转发。
- 认证模型：客户端 `Authorization` > `x-api-key` > `${PROVIDER}_API_KEY_FOR_DEV`（仅开发兜底）。网关生产环境零内置密钥；任何真实 key 只能进 `.env`（已 gitignore），绝不进代码/文档/测试。

## 约束与坑

- `app/api/` 只允许 Web 标准 API（fetch/URL/ReadableStream/FormData 等），不得引用 `process`/`Buffer` 等_NODE 专属能力——需要保持边缘可移植。读环境变量走 `upstream.ts` 的 `providerEnv()`。
- env 加载：dev 由 `vite.config.ts` 把 `.env` 注入 `process.env`；prod 由 `npm start` 的 `--env-file-if-exists` 加载（注意路径相对 `dist/`，是 `../.env`）。
- tsconfig 的 `lib` 含 `DOM.Iterable`（`FormData.entries` 需要）；`moduleResolution: Bundler`，import 不写扩展名。
- saltyfish 上游会返回字符画等"乱回文字"内容，属正常行为，不要在网关层"修复"内容；其错误格式（`{"error":"..."}` 字符串、纯文本 `error code: 502`）由 `errors.ts` 归一化，新增错误形状在那里扩展。
- `tests/gateway.test.ts` 在模块顶层用 `registerProvider` 注册 mock 供应商，registry 是全局可变单例——新增测试文件时避免 id 冲突。
- 前端用 daisyUI 5 + Tailwind 4（Vite 插件），落地页当前**故意保持不动**。
- `CLAUDE.md` 是用户文件，不要修改（它引用本文件）。
