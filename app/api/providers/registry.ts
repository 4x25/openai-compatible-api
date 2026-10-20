import type { Provider } from './types'
import type { ModelInfo } from '../types'
import { saltyfish } from './saltyfish'
import { inceptionlabsPlayground } from './inceptionlabs-playground'

/** 已注册供应商（按 id 小写索引） */
const registry = new Map<string, Provider>()

function register(provider: Provider): void {
  registry.set(provider.id.toLowerCase(), provider)
}

register(saltyfish)
register(inceptionlabsPlayground)

/** 注册供应商（插件入口）：新增供应商 = 新建 provider 文件 + 调用本函数 */
export function registerProvider(provider: Provider): void {
  registry.set(provider.id.toLowerCase(), provider)
}

export function getProvider(id: string): Provider | undefined {
  return registry.get(id.toLowerCase())
}

export function listProviders(): Provider[] {
  return [...registry.values()]
}

/** provider id -> 环境变量前缀：非字母数字转下划线，全大写 */
export function envPrefix(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

export type { Provider, ModelInfo }
