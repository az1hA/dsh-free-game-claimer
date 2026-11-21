/**
 * GOG 的限时免费（giveaway）没有公开的“列表”接口：
 *   - `https://www.gog.com/giveaway/api/get` 目前 404
 *   - 真正的入口是 `GET https://www.gog.com/giveaway/claim`
 *     带 Cookie 直接领取：201 成功、409 已领、401 未登录、404 当前没活动
 * 所以 GOG 的“检查 + 领取”是同一个请求，不做自动领取时只能跳过。
 */
import { AuthError, request } from './http.mjs'

export const GOG_CLAIM_URL = 'https://www.gog.com/giveaway/claim'
export const GOG_USER_URL = 'https://www.gog.com/userData.json'

export async function validateGog(cookie) {
  const res = await request(GOG_USER_URL, {
    cookie,
    headers: { accept: 'application/json' },
  })
  if (res.status === 401) throw new AuthError('GOG Cookie 已失效，请重新登录')
  if (res.status !== 200 || !res.json) {
    throw new Error(`GOG 登录状态检查失败（HTTP ${res.status}）`)
  }
  const loggedIn = res.json.isLoggedIn === true || res.json.isLoggedIn === 'true'
  if (!loggedIn) throw new AuthError('GOG Cookie 未登录，请重新登录')
  return {
    account: String(res.json.username || res.json.email || '').trim() || 'GOG 账号',
    detail: '已登录',
  }
}

/**
 * @returns {Promise<{status:'claimed'|'already'|'none', title:string, message:string}>}
 */
export async function claimGog(cookie) {
  const res = await request(GOG_CLAIM_URL, {
    cookie,
    redirect: 'manual',
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: 'https://www.gog.com/',
      'x-requested-with': 'XMLHttpRequest',
    },
  })

  if (res.status === 401) throw new AuthError('GOG Cookie 已失效，请重新登录')
  if (res.status === 404) {
    return { status: 'none', title: '', message: 'GOG 当前没有正在进行的限时免费活动' }
  }
  if (res.status === 409) {
    return {
      status: 'already',
      title: titleFrom(res),
      message: '这个 GOG 限免游戏已经在库里了',
    }
  }
  if (res.status === 201 || res.status === 200) {
    return {
      status: 'claimed',
      title: titleFrom(res),
      message: '已成功加入 GOG 库',
    }
  }
  if (res.status >= 300 && res.status < 400) {
    if (/login/i.test(res.location)) throw new AuthError('GOG Cookie 已失效，请重新登录')
    return { status: 'none', title: '', message: `GOG 返回了跳转（HTTP ${res.status}）` }
  }
  throw new Error(`GOG 领取失败（HTTP ${res.status}）${res.json?.message ? `：${res.json.message}` : ''}`)
}

function titleFrom(res) {
  const json = res.json
  if (!json || typeof json !== 'object') return ''
  const candidates = [
    json.title,
    json.game?.title,
    json.product?.title,
    json.productTitle,
    json.name,
  ]
  return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '').trim()
}