/**
 * 插件自己的“家”和配置持久化。
 *
 * 所有可写数据都放在 `$DSH_HOME/free-games-claimer/`，绝不写进插件包目录：
 * 插件安装后可能位于只读目录，升级也会覆盖包内文件。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const PLATFORMS = ['epic', 'gog', 'steam']
export const PLATFORM_LABELS = { epic: 'Epic Games', gog: 'GOG', steam: 'Steam' }

export const BROWSER_CHOICES = ['auto', 'chrome', 'edge']

const DEFAULT_CONFIG = {
  /** 定时检查总开关 */
  enabled: true,
  /** 两轮检查之间的间隔，默认 1440 分钟 = 每天一轮 */
  intervalMinutes: 1440,
  /** 发现免费游戏后是否自动领取 */
  autoClaim: true,
  /** 可见登录用哪个浏览器：auto = 优先 Chrome，没有再找 Edge */
  browser: 'auto',
  /** 平台开关：关掉的平台每日不检查 */
  platforms: { epic: true, gog: true, steam: true },
}

const MAX_INTERVAL = 7 * 24 * 60
const MIN_INTERVAL = 15

function clampInterval(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.intervalMinutes
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(n)))
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

export function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const platforms = raw.platforms && typeof raw.platforms === 'object' ? raw.platforms : {}
  return {
    enabled: bool(raw.enabled, DEFAULT_CONFIG.enabled),
    intervalMinutes: clampInterval(raw.intervalMinutes ?? DEFAULT_CONFIG.intervalMinutes),
    autoClaim: bool(raw.autoClaim, DEFAULT_CONFIG.autoClaim),
    browser: BROWSER_CHOICES.includes(raw.browser) ? raw.browser : DEFAULT_CONFIG.browser,
    platforms: {
      epic: bool(platforms.epic, true),
      gog: bool(platforms.gog, true),
      steam: bool(platforms.steam, true),
    },
  }
}

export function defaultStore() {
  return {
    config: normalizeConfig(DEFAULT_CONFIG),
    runtime: {
      lastCheckAt: null,
      lastFinishedAt: null,
      lastRun: null,
      history: [],
    },
  }
}

/**
 * `ctx.get('dshHomePath')` 在 DSH 里是**函数**：`dshHomePath(...segments)`。
 * 把它当字符串用过会得到函数源码拼路径，进而 mkdir ENOENT、整个插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('free-games-claimer')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'free-games-claimer')
    }
  } catch {
    // 拿不到就走下面的兜底
  }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'free-games-claimer')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 兼容 Windows 上带 UTF-8 BOM 的 JSON（PowerShell 写文件很容易带）。 */
export function readJson(file, fallback) {
  try {
    const raw = readFileSync(file, 'utf8')
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function loadStore(dir) {
  const base = defaultStore()
  const saved = readJson(join(dir, 'state.json'), null)
  if (!saved || typeof saved !== 'object') return base
  const config = normalizeConfig(saved.config)
  const runtime = saved.runtime && typeof saved.runtime === 'object' ? saved.runtime : {}
  return {
    config,
    runtime: {
      lastCheckAt: numberOrNull(runtime.lastCheckAt),
      lastFinishedAt: numberOrNull(runtime.lastFinishedAt),
      lastRun: runtime.lastRun && typeof runtime.lastRun === 'object' ? runtime.lastRun : null,
      history: Array.isArray(runtime.history) ? runtime.history.slice(0, 30) : [],
    },
  }
}

export function saveStore(dir, store) {
  writeJson(join(dir, 'state.json'), store)
}

function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 只保留 Cookie 的字段名，绝不把值写进日志、状态或界面。 */
export function cookieKeys(cookie) {
  return String(cookie || '')
    .split(';')
    .map((part) => part.trim().split('=')[0]?.trim())
    .filter(Boolean)
}

export function normalizeCookie(input) {
  let s = String(input ?? '').trim()
  if (!s) throw new Error('Cookie 不能为空')
  s = s.replace(/^cookie\s*:/i, '').trim()
  s = s.replace(/[\r\n]+/g, ' ').trim()
  if (!s.includes('=')) throw new Error('Cookie 格式不对：需要 name=value; name2=value2')
  if (s.length > 20000) throw new Error('Cookie 太长（超过 20KB），请只粘贴需要的字段')
  return s
}

export function maskCookie(cookie) {
  const keys = cookieKeys(cookie)
  if (!keys.length) return ''
  return keys.map((key) => `${key}=***`).join('; ')
}

export function nextCheckAt(config, runtime) {
  if (!config.enabled) return null
  if (!runtime.lastCheckAt) return Date.now()
  return runtime.lastCheckAt + config.intervalMinutes * 60_000
}

export function isDue(config, runtime, now = Date.now()) {
  if (!config.enabled) return false
  if (!runtime.lastCheckAt) return true
  return now >= runtime.lastCheckAt + config.intervalMinutes * 60_000
}

export function intervalText(minutes) {
  const n = Number(minutes) || 0
  if (n % 1440 === 0) return `每 ${n / 1440} 天`
  if (n % 60 === 0) return `每 ${n / 60} 小时`
  return `每 ${n} 分钟`
}