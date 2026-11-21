/**
 * Epic Games Store 的限时免费发现与领取。
 *
 * 发现走公开的 freeGamesPromotions 接口，稳定、不需要登录。
 * 领取没有可以只靠网页 Cookie 调用的干净接口：
 *   - quickPurchase 要 OAuth Bearer + accountId；
 *   - 网页 GraphQL 被 Cloudflare 挡。
 * 因此领取用 Playwright 驱动本机 Edge，走一遍“Get → 结账 → Place Order”，
 * 失败就保留链接并标记为需要手动，不伪装成功。
 */
import { AuthError, request, shortError } from './http.mjs'

const FREE_GAMES_URL =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions' +
  '?locale=en-US&country=US&allowCountries=US'

const ACCOUNT_URL = 'https://www.epicgames.com/id/api/account'

function cleanPageSlug(value) {
  let text = String(value || '').trim()
  if (!text) return ''
  if (/^https?:/i.test(text)) {
    try {
      text = new URL(text).pathname
    } catch {
      // 保持原样，下面按路径处理
    }
  }
  text = text.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/\/home$/i, '')
  return text.split('/').filter(Boolean).pop() || ''
}

/**
 * Epic 的 urlSlug 有时是 32 位 offer id（例如 2fd257a6...），不是商店页地址。
 * 真正的 page slug 在 offerMappings[].pageSlug / catalogNs.mappings[].pageSlug；
 * 优先取能读的 slug，最后才退回 urlSlug/productSlug。
 */
export function epicPageSlug(element) {
  if (!element || typeof element !== 'object') return ''
  const candidates = []
  for (const mapping of Array.isArray(element.offerMappings) ? element.offerMappings : []) {
    candidates.push(mapping?.pageSlug)
  }
  for (const mapping of Array.isArray(element.catalogNs?.mappings) ? element.catalogNs.mappings : []) {
    candidates.push(mapping?.pageSlug)
  }
  candidates.push(element.urlSlug, element.productSlug)

  const slugs = candidates.map(cleanPageSlug).filter(Boolean)
  return (
    slugs.find((slug) => /[a-z]/i.test(slug) && !/^[0-9a-f]{32}$/i.test(slug)) ||
    slugs[0] ||
    ''
  )
}

export async function validateEpic(cookie) {
  const res = await request(ACCOUNT_URL, {
    cookie,
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
  })
  if (res.status === 401) throw new AuthError('Epic Cookie 已失效，请重新登录')
  if (res.status === 403) {
    throw new Error('Epic 的登录校验被 Cloudflare 拦截了，请稍后再试')
  }
  if (res.status !== 200 || !res.json) {
    throw new Error(`Epic 登录状态检查失败（HTTP ${res.status}）`)
  }
  return {
    account: String(res.json.displayName || res.json.email || res.json.accountId || '').trim() || 'Epic 账号',
    detail: '已登录',
  }
}

/**
 * 返回当前正在免费、且不是“即将开始”的条目。
 * @returns {Promise<Array<{id:string,title:string,description:string,url:string,
 *   offerId:string,namespace:string,image:string}>>}
 */
export async function discoverEpic() {
  const res = await request(FREE_GAMES_URL, {
    headers: { accept: 'application/json' },
    timeout: 40_000,
  })
  if (res.status !== 200 || !res.json) {
    throw new Error(`Epic 免费列表获取失败（HTTP ${res.status}）`)
  }
  const elements = res.json?.data?.Catalog?.searchStore?.elements
  if (!Array.isArray(elements)) throw new Error('Epic 返回的数据结构变了（找不到 searchStore.elements）')

  const now = Date.now()
  const out = []
  const seen = new Set()
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue
    const offerId = String(el.id || '')
    if (!offerId || seen.has(offerId)) continue

    const groups = [
      ...(Array.isArray(el.promotions?.promotionalOffers) ? el.promotions.promotionalOffers : []),
      ...(Array.isArray(el.promotions?.upcomingPromotionalOffers) ? el.promotions.upcomingPromotionalOffers : []),
    ]
    const current = groups.some((group) => {
      const offers = Array.isArray(group?.promotionalOffers) ? group.promotionalOffers : []
      return offers.some((offer) => {
        const percent = offer?.discountSetting?.discountPercentage
        return Number(percent) === 0 && inWindow(offer?.startDate, offer?.endDate, now)
      })
    })
    if (!current) continue

    const slug = epicPageSlug(el)
    if (!slug) continue
    const image = pickImage(el.keyImages)
    out.push({
      id: offerId,
      title: String(el.title || 'Epic 免费游戏'),
      description: String(el.description || '').replace(/<[^>]+>/g, ' ').trim(),
      url: `https://store.epicgames.com/p/${slug}`,
      offerId,
      namespace: String(el.namespace || ''),
      image,
    })
    seen.add(offerId)
  }
  return out
}

function inWindow(start, end, now) {
  const s = Date.parse(start)
  const e = Date.parse(end)
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false
  return s <= now && now < e
}

function pickImage(images) {
  if (!Array.isArray(images)) return ''
  const wanted = ['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail', 'CoverArt']
  for (const type of wanted) {
    const hit = images.find((img) => img?.type === type && img?.url)
    if (hit) return String(hit.url)
  }
  return String(images.find((img) => img?.url)?.url || '')
}

/**
 * 用本机 Edge 无头模式尝试领取。返回 status:
 *   claimed / already / manual / failed
 */
export async function claimEpicWithBrowser(cookie, game, log = () => {}, userAgent = '', profileDir = '') {
  let browser
  let context
  try {
    const { chromium } = await import('playwright-core')
    const executablePath = await findBrowserExecutable()
    if (!executablePath) {
      return {
        status: 'manual',
        message: '没找到可用的 Edge/Chrome，请手动打开链接领取',
        url: game.url,
      }
    }

    const ua =
      userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0'
    const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check']

    if (profileDir) {
      // 直接复用登录时的持久化 profile：Cookie 各自待在正确的域/path 里，
      // 也带着 cf_clearance，比把 Cookie 全塞到 .epicgames.com 可靠。
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath,
        headless: true,
        viewport: null,
        locale: 'en-US',
        timezoneId: 'Asia/Shanghai',
        userAgent: ua,
        args: launchArgs,
      })
    } else {
      browser = await chromium.launch({ executablePath, headless: true, args: launchArgs })
      context = await browser.newContext({
        locale: 'en-US',
        timezoneId: 'Asia/Shanghai',
        userAgent: ua,
      })
      await context.addCookies(epicCookies(cookie))
    }

    const page = context.pages()[0] || (await context.newPage())
    await page.goto(game.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(1200)

    if (/\/login|id\.epicgames\.com\/login/i.test(page.url())) {
      throw new AuthError('Epic Cookie 已失效，请重新登录')
    }

    await dismissCookieBanner(page)
    const bodyText = await safeText(page)
    if (/In Library|已在库中|已拥有/i.test(bodyText)) {
      return { status: 'already', message: 'Epic 账号里已经有这个游戏了' }
    }

    const clicked = await clickFirst(page, [
      /^Get$/i,
      /^获取$/,
      /^立即获取$/,
      /^免費取得$/i,
      /^取得$/,
      /^Add to Library$/i,
    ])
    if (!clicked) {
      return {
        status: 'manual',
        message: '没找到“Get”按钮，可能活动已结束或页面结构变了',
        url: game.url,
      }
    }

    await page.waitForTimeout(2500)
    let text = await safeText(page)
    if (isSuccessText(text)) return { status: 'claimed', message: '已成功加入 Epic 库' }

    // 有的账号会进入结账确认页：继续点“下订单/Place Order”。
    for (let step = 0; step < 4; step++) {
      const before = page.url()
      const advanced = await clickFirst(page, [
        /^Place Order$/i,
        /^下订单$/,
        /^完成订单$/,
        /^Confirm$/i,
        /^确认$/,
        /^Continue$/i,
        /^继续$/,
        /^Checkout$/i,
        /^结账$/,
      ])
      if (!advanced) break
      await page.waitForTimeout(2200)
      text = await safeText(page)
      if (isSuccessText(text)) return { status: 'claimed', message: '已成功加入 Epic 库' }
      if (page.url() === before && step > 1) break
    }

    return {
      status: 'manual',
      message: '已尝试自动领取，但 Epic 还需要手动确认（可能是验证码/支付页）',
      url: page.url() || game.url,
    }
  } catch (error) {
    if (error instanceof AuthError) throw error
    log(`[epic] 浏览器领取失败：${shortError(error)}`)
    return {
      status: 'failed',
      message: `浏览器自动领取失败：${shortError(error)}`,
      url: game.url,
    }
  } finally {
    try {
      await context?.close()
    } catch {
      // 收摊失败不影响结果
    }
    try {
      await browser?.close()
    } catch {
      // 收摊失败不影响结果
    }
  }
}

async function findBrowserExecutable() {
  const { existsSync } = await import('node:fs')
  const candidates = [
    process.env.DSH_FREE_GAMES_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (existsSync(file)) return file
    } catch {
      // 继续找
    }
  }
  return ''
}

function epicCookies(cookie) {
  const pairs = []
  for (const part of String(cookie || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (name) pairs.push({ name, value })
  }
  return pairs.map((pair) => ({
    ...pair,
    domain: '.epicgames.com',
    path: '/',
    secure: true,
    sameSite: 'Lax',
    expires: -1,
  }))
}

async function dismissCookieBanner(page) {
  try {
    const button = page.getByRole('button', { name: /^(Accept All|Accept|全部接受|接受)$/i }).first()
    if (await button.isVisible({ timeout: 1200 })) await button.click({ timeout: 2000 })
  } catch {
    // 没有 banner 就算了
  }
}

async function clickFirst(page, patterns) {
  for (const pattern of patterns) {
    try {
      const button = page.getByRole('button', { name: pattern }).first()
      if (await button.isVisible({ timeout: 800 })) {
        await button.click({ timeout: 3500 })
        return true
      }
    } catch {
      // 试下一个
    }
  }
  return false
}

function isSuccessText(text) {
  return /Thanks for your order|感谢您的订购|已添加到库|Added to your library|In Library|已在库中|已拥有/i.test(text)
}

async function safeText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 4000 })
  } catch {
    return ''
  }
}