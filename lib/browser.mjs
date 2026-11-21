/**
 * 可见浏览器登录。
 *
 * 这里不用无头浏览器：用户要自己看见登录页、输账号密码/过验证码。
 * 每个平台用独立的 persistent profile，Cookie 会留在 profile 里；
 * 登录成功后由宿主把 Cookie 取出来验证，再存进 DSH credentials。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const LOGIN_URLS = {
  epic: 'https://www.epicgames.com/account/personal',
  gog: 'https://www.gog.com/',
  steam: 'https://store.steampowered.com/login/',
}

// Cookie 只取“这个平台真正会收到”的那一份。Steam 尤其重要：
// 浏览器里同时存在 store / community / help 的 sessionid、steamLoginSecure，
// 全量拼进一个 Cookie 头会出现同名重复，Steam 会直接返回 HTTP 400。
// 第一个 URL 是主域；后面的只用来补主域没拿到的 Cookie 名。
const COOKIE_URLS = {
  // Epic 的网页登录态把 EPIC_SSO / EPIC_BEARER_TOKEN 放在 .unrealengine.com，
  // 只查 epicgames.com 会拿不到这两个关键 Cookie，登录会一直“检测不到”。
  epic: [
    'https://www.epicgames.com/',
    'https://www.epicgames.com/id/',
    'https://store.epicgames.com/',
    // EPIC_SESSION_AP 的 path 是 /id；EPIC_AUTH_* 在 accounts.epicgames.com。
    'https://www.unrealengine.com/id/',
    'https://www.accounts.epicgames.com/',
  ],
  gog: ['https://www.gog.com/'],
  steam: ['https://store.steampowered.com/', 'https://steamcommunity.com/'],
}

const BROWSER_CANDIDATES = [
  {
    id: 'chrome',
    label: 'Chrome',
    paths: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ],
  },
  {
    id: 'edge',
    label: 'Edge',
    paths: [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
    ],
  },
]

/** 列出本机装了哪些浏览器；不启动任何东西。 */
export function detectBrowsers() {
  return BROWSER_CANDIDATES.map((browser) => {
    const executablePath = browser.paths.find((file) => file && existsSync(file)) || ''
    return {
      id: browser.id,
      label: browser.label,
      available: Boolean(executablePath),
      executablePath,
    }
  })
}

/** preferred: auto / chrome / edge。auto 先找 Chrome，再找 Edge。 */
export function resolveBrowser(preferred = 'auto') {
  const all = detectBrowsers()
  if (preferred === 'chrome' || preferred === 'edge') {
    return all.find((browser) => browser.id === preferred && browser.available) || null
  }
  return all.find((browser) => browser.id === 'chrome' && browser.available)
    || all.find((browser) => browser.available)
    || null
}

/** 只把非空 Cookie 拼成请求头；浏览器里 HttpOnly 的 Cookie 也会在这里出现。 */
export function serializeCookies(cookies) {
  if (!Array.isArray(cookies)) return ''
  const byName = new Map()
  for (const cookie of cookies) {
    if (!cookie || !cookie.name || typeof cookie.value !== 'string') continue
    if (/[\r\n]/.test(cookie.value)) continue
    byName.set(cookie.name, cookie)
  }
  return [...byName.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

/**
 * 取某个平台会实际发送的 Cookie，并按名字去重。
 * Playwright 的 context.cookies(url) 会带上该 URL 的 domain cookie，
 * 不会把 community/help 等兄弟域名的同名 Cookie 混进来。
 */
export async function readPlatformCookies(context, platform) {
  if (!context?.cookies) return []
  const urls = COOKIE_URLS[platform] || []
  const queries = urls.length ? urls : [null]
  const byName = new Map()

  for (const url of queries) {
    let cookies = []
    try {
      cookies = url ? await context.cookies(url) : await context.cookies()
    } catch {
      continue
    }
    // 同一 URL 下，同名不同 path 时更具体的 path 优先。
    const local = new Map()
    for (const cookie of Array.isArray(cookies) ? cookies : []) {
      if (!cookie || !cookie.name || typeof cookie.value !== 'string') continue
      if (/[\r\n]/.test(cookie.value)) continue
      const previous = local.get(cookie.name)
      if (!previous || (cookie.path?.length || 0) >= (previous.path?.length || 0)) {
        local.set(cookie.name, cookie)
      }
    }
    // 主域已有的名字不再被兄弟域覆盖，避免同名 Cookie 冲突。
    for (const [name, cookie] of local) {
      if (!byName.has(name)) byName.set(name, cookie)
    }
  }

  return [...byName.values()]
}

/**
 * 先看“登录后才会出现”的 Cookie 名，避免每 2 秒都拿空 Cookie 去打平台接口。
 * 真正是否登录成功仍然要再用 validate* 验证一次。
 */
export function hasLoginCookies(platform, cookies) {
  const names = new Set((Array.isArray(cookies) ? cookies : []).map((cookie) => cookie?.name).filter(Boolean))
  if (platform === 'epic') {
    return [...names].some((name) => /^EPIC_(BEARER_TOKEN|SESSION|SSO|COOKIE|AUTH_)/i.test(name))
  }
  if (platform === 'gog') {
    return names.has('gog_session') || names.has('galaxy_session') || names.has('gog_us')
  }
  if (platform === 'steam') {
    return names.has('steamLoginSecure') && names.has('sessionid')
  }
  return names.size > 0
}

/** 启动一个看得见的浏览器窗口，并打开对应平台的登录页。 */
export async function launchVisibleLogin({ platform, browser, profileDir }) {
  if (!browser?.executablePath) throw new Error('没有找到可用的 Chrome/Edge')
  if (!LOGIN_URLS[platform]) throw new Error(`未知平台：${platform}`)

  mkdirSync(profileDir, { recursive: true })
  const { chromium } = await import('playwright-core')
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: browser.executablePath,
    viewport: null,
    locale: 'zh-CN',
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  })

  const page = context.pages()[0] || (await context.newPage())
  await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  await page.bringToFront().catch(() => {})
  return { context, page }
}

export async function closeBrowserContext(context) {
  try {
    await context?.close()
  } catch {
    // 用户可能已经手动关掉了
  }
}