import { signRequestHuawei } from './sign.js'
import type { CodeArtsCredential } from './types.js'

/**
 * opengw 网关配置端点 — 返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export const OPENGW_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/**
 * snap-access 统计端点 — 返回常规模型列表（GLM-5.2 等，model_metrics 字段）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export const SNAP_STATISTICS_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin'

/** 远端动态模型列表缓存文件名（~/.cache/deveco/codearts_models.json）。 */
const CODEARTS_MODELS_CACHE_FILENAME = 'codearts_models.json'

/** 动态模型拉取超时（ms）。 */
const FETCH_TIMEOUT_MS = 10_000

/** 定时刷新远端模型列表的间隔（2 小时）。 */
export const MODEL_REFRESH_INTERVAL_MS = 2 * 3_600_000

export interface RemoteModel {
  id: string
  name: string
}

/** 模块级内存缓存：远端拉取或磁盘加载后填充；availableCodeArtsModels 优先读取。 */
let memoryCache: RemoteModel[] | undefined

/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 远端 gateway/config 返回带日期后缀的 model_id（-0731 = 7月31日版本），
 * 但 chat 端点只认不带后缀的 id（InferHub.002002009.404 "model is not registered"）。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) {
      return id.slice(0, -5)
    }
  }
  return id
}

function parseModelInfo(m: Record<string, unknown>, seen: Set<string>): RemoteModel | undefined {
  const rawId = m['model_id']
  if (typeof rawId !== 'string' || rawId.length === 0) return undefined
  const id = normalizeModelId(rawId)
  const rawName = m['model_name']
  const name = typeof rawName === 'string' && rawName.length > 0 ? normalizeModelId(rawName) : id
  if (seen.has(id)) return undefined
  seen.add(id)
  return { id, name }
}

/** 从 JSON 响应中沿路径指针取数组。 */
function extractJsonArray(text: string, path: string[]): unknown[] | undefined {
  try {
    let value: unknown = JSON.parse(text)
    for (const key of path) {
      if (typeof value !== 'object' || value === null) return undefined
      value = (value as Record<string, unknown>)[key]
    }
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 签名 GET 请求远端端点并读取文本；网络失败或非 200 时返回 undefined
 * （不阻断调用方）。
 */
async function fetchSignedGet(
  fetcher: typeof fetch,
  url: string,
  ak: string,
  sk: string,
  st: string,
): Promise<string | undefined> {
  const signed = await signRequestHuawei(ak, sk, st, 'GET', url, new Uint8Array())
  const headers = new Headers()
  signed.forEach((v, k) => {
    if (k !== 'host') headers.set(k, v)
  })
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}

/**
 * 从两个远端端点拉取模型列表并合并去重：
 * 1. opengw gateway/config → result.models（benefit 模型）
 * 2. snap-access statistics/plugin → model_metrics（常规模型）
 * 失败或空凭据时返回空数组（不阻断）。
 */
export async function fetchCodeArtsRemoteModels(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = fetch,
): Promise<RemoteModel[]> {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk) return []

  const models: RemoteModel[] = []
  const seen = new Set<string>()

  // 1. opengw gateway/config — benefit 模型（glm-5.3-flash 等）
  const gatewayText = await fetchSignedGet(fetcher, OPENGW_GATEWAY_CONFIG_URL, ak, sk, st)
  if (gatewayText !== undefined) {
    const arr = extractJsonArray(gatewayText, ['result', 'models'])
    if (arr !== undefined) {
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const mi = parseModelInfo(item as Record<string, unknown>, seen)
          if (mi) models.push(mi)
        }
      }
    }
  }

  // 2. snap-access statistics/plugin — 常规模型（GLM-5.2 等）
  const snapText = await fetchSignedGet(fetcher, SNAP_STATISTICS_URL, ak, sk, st)
  if (snapText !== undefined) {
    const arr = extractJsonArray(snapText, ['model_metrics'])
    if (arr !== undefined) {
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const mi = parseModelInfo(item as Record<string, unknown>, seen)
          if (mi) models.push(mi)
        }
      }
    }
  }

  return models
}

/** 动态模型列表缓存路径：~/.cache/deveco/codearts_models.json。 */
function modelsCachePath(): string | undefined {
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) return undefined
  return `${home}/.cache/deveco/${CODEARTS_MODELS_CACHE_FILENAME}`
}

/** 保存动态模型列表到缓存文件（原子写入 tmp+rename）。 */
export function saveModelsCache(models: RemoteModel[]): void {
  const path = modelsCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    import('node:fs').then((fs) => {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = path + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(models), 'utf-8')
      fs.renameSync(tmp, path)
    }).catch(() => {})
  } catch {
    // 写入失败静默忽略
  }
}

/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export function loadModelsCache(): RemoteModel[] | undefined {
  const path = modelsCachePath()
  if (!path) return undefined
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    if (!fs.existsSync(path)) return undefined
    const text = fs.readFileSync(path, 'utf-8')
    const models: RemoteModel[] = JSON.parse(text)
    return Array.isArray(models) && models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export function availableCodeArtsModels(): RemoteModel[] | undefined {
  if (memoryCache !== undefined) return memoryCache
  const disk = loadModelsCache()
  if (disk !== undefined) {
    memoryCache = disk
    return disk
  }
  return undefined
}

/** 设置内存缓存（由 service 拉取成功后调用）。 */
export function setMemoryCache(models: RemoteModel[] | undefined): void {
  memoryCache = models
}
