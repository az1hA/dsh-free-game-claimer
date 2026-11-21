/**
 * Steam 的“限时免费”要先排除两类陷阱：
 *   1. 永久免费（free-to-play）——本来就在库里，不需要领；
 *   2. 免费周末（free weekend）——周末能玩，但**不会入库**。
 *
 * 发现：搜索 `maxprice=free&specials=1`，再用 appdetails 找 100% 折扣的包，
 * 最后看商店页有没有 “Free to Keep”。只有明确写着 free-to-keep 才领取。
 * 领取：`POST /checkout/addfreelicense`，form 里带 sessionid + subid。
 */
import { AuthError, parseCookie, request, shortError } from './http.mjs'

const STORE_HOME = 'https://store.steampowered.com/'
const SEARCH_URL =
  'https://store.steampowered.com/search/results/?query&start=0&count=50' +
  '&maxprice=free&specials=1&infinite=1&cc=us&l=english'
const APP_DETAILS = 'https://store.steampowered.com/api/appdetails'
const ADD_FREE_LICENSE = 'https://store.steampowered.com/checkout/addfreelicense'

export async function validateSteam(cookie) {
  const parsed = parseCookie(cookie)
  if (!parsed.sessionid) {
    throw new Error('Steam 登录信息缺少 sessionid，请关闭登录窗口后重新登录一次')
  }
  // 商店首页比 /account/ 更稳定：/account/ 有时会对已登录的原始 HTTP 请求
  // 返回 302 到自己（Akamai 风控），首页仍能正常给出 account_name。
  const res = await request(STORE_HOME, {
    cookie,
    redirect: 'manual',
    headers: { accept: 'text/html,application/xhtml+xml' },
  })
  if (res.status >= 300 && res.status < 400) {
    // 任何 3xx 都说明这次请求没有被当成已登录；不要显示笼统的 HTTP 302。
    throw new AuthError('Steam Cookie 已失效，请重新登录')
  }
  if (res.status === 400) {
    throw new Error('Steam 登录检查返回 HTTP 400（Cookie 头过长或冲突）。请关闭登录窗口后重新登录；仍然失败就点平台卡片的「清除」再登录。')
  }
  if (res.status !== 200) {
    throw new Error(`Steam 登录状态检查失败（HTTP ${res.status}）`)
  }
  const html = res.text || ''
  const accountName =
    html.match(/g_strAccountName\s*=\s*"([^"]+)"/i)?.[1] ||
    html.match(/class="account_name"[^>]*>([^<]+)</i)?.[1] ||
    html.match(/id="account_name"[^>]*>([^<]+)</i)?.[1] ||
    ''
  if (accountName.trim()) {
    return { account: accountName.trim(), detail: '已登录' }
  }
  if (/g_strAccountName\s*=\s*"([^"]+)"/i.test(html)) {
    const name = html.match(/g_strAccountName\s*=\s*"([^"]+)"/i)?.[1] || ''
    return { account: name || 'Steam 账号', detail: '已登录' }
  }
  if (/id="account_name"[^>]*>([^<]+)</i.test(html)) {
    const name = html.match(/id="account_name"[^>]*>([^<]+)</i)?.[1] || ''
    return { account: name.trim() || 'Steam 账号', detail: '已登录' }
  }
  if (/g_steamID|account_name|Steam Account/i.test(html)) {
    return { account: 'Steam 账号', detail: '已登录' }
  }
  throw new AuthError('Steam Cookie 未登录，请重新登录')
}

/**
 * 只返回“正在 100% 折扣、且商店页明确 Free to Keep”的游戏。
 * @returns {Promise<Array<{appid:string,title:string,url:string,subid:string,image:string}>>}
 */
export async function discoverSteam() {
  const res = await request(SEARCH_URL, {
    headers: { accept: 'application/json, text/javascript, */*; q=0.01' },
    timeout: 40_000,
  })
  if (res.status !== 200) throw new Error(`Steam 免费特惠搜索失败（HTTP ${res.status}）`)

  const html = String(res.json?.results_html || res.text || '')
  const ids = [...new Set([...html.matchAll(/data-ds-appid="(\d+)"/g)].map((m) => m[1]))]
  if (!ids.length) return []

  const out = []
  for (const appid of ids.slice(0, 16)) {
    try {
      const game = await inspectSteamApp(appid)
      if (game) out.push(game)
    } catch (error) {
      // 单个 app 详情失败不拖垮整轮
      if (error instanceof AuthError) throw error
    }
    await sleep(250)
  }
  return out
}

async function inspectSteamApp(appid) {
  const url =
    `${APP_DETAILS}?appids=${encodeURIComponent(appid)}&cc=us&l=english` +
    '&filters=basic,price_overview,package_groups'
  const res = await request(url, {
    headers: { accept: 'application/json' },
    timeout: 25_000,
  })
  if (res.status !== 200 || !res.json) return null
  const entry = res.json[appid]
  if (!entry?.success || !entry.data) return null
  const data = entry.data
  if (data.type !== 'game' && data.type !== 'dlc') return null
  if (data.is_free === true) return null

  const price = data.price_overview
  const discount = Number(price?.discount_percent || 0)
  const finalPrice = Number(price?.final ?? NaN)
  const subid = pickFreeSubid(data)
  if (discount !== 100 && !subid) return null
  if (Number.isFinite(finalPrice) && finalPrice !== 0 && !subid) return null

  const pageUrl = `https://store.steampowered.com/app/${appid}/?cc=us&l=english`
  const page = await request(pageUrl, {
    headers: { accept: 'text/html,application/xhtml+xml' },
    timeout: 25_000,
  })
  if (page.status !== 200) return null
  const text = String(page.text || '')
  if (/free weekend/i.test(text)) return null
  if (!/free to keep/i.test(text)) return null

  return {
    appid: String(appid),
    title: String(data.name || `Steam App ${appid}`),
    url: `https://store.steampowered.com/app/${appid}/`,
    subid: subid || '',
    image: String(data.header_image || ''),
  }
}

function pickFreeSubid(data) {
  const groups = Array.isArray(data.package_groups) ? data.package_groups : []
  for (const group of groups) {
    const subs = Array.isArray(group?.subs) ? group.subs : []
    for (const sub of subs) {
      const cents = Number(sub?.price_in_cents_with_discount)
      const pct = Number(sub?.percent_savings ?? sub?.discount_pct ?? 0)
      const option = String(sub?.option_text || '')
      if (Number.isFinite(cents) && cents === 0) {
        if (pct === 100 || /free/i.test(option) || !option) return String(sub.packageid || '')
      }
      if (pct === 100) return String(sub.packageid || '')
    }
  }
  return ''
}

/**
 * @returns {Promise<{status:'claimed'|'already'|'failed', message:string}>}
 */
export async function claimSteam(cookie, game) {
  if (!game.subid) {
    return { status: 'failed', message: '这个 Steam 条目没有找到可领取的免费包（可能只有免费周末）' }
  }
  const sessionid = parseCookie(cookie).sessionid
  if (!sessionid) throw new AuthError('Steam Cookie 里没有 sessionid，请重新登录后再试')

  const body = new URLSearchParams({
    action: 'add_to_cart',
    sessionid,
    subid: String(game.subid),
  }).toString()

  const res = await request(ADD_FREE_LICENSE, {
    method: 'POST',
    cookie,
    body,
    redirect: 'manual',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: 'https://store.steampowered.com',
      referer: game.url,
      'x-requested-with': 'XMLHttpRequest',
    },
  })

  if (res.status >= 300 && res.status < 400 && /login/i.test(res.location)) {
    throw new AuthError('Steam Cookie 已失效，请重新登录')
  }

  const json = res.json
  if (json && Number(json.success) === 1 && Number(json.purchaseresultdetail) === 0) {
    return { status: 'claimed', message: '已成功加入 Steam 库' }
  }
  const detail = Number(json?.purchaseresultdetail)
  if (Number(json?.success) === 1 && (detail === 15 || detail === 9)) {
    return { status: 'already', message: '这个 Steam 包已经在库里了' }
  }
  const reason = json ? `success=${json.success}, detail=${json.purchaseresultdetail ?? '?'}` : `HTTP ${res.status}`
  return { status: 'failed', message: `Steam 领取未成功（${reason}）` }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { shortError }