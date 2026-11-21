/**
 * 共用的 HTTP 小工具。
 *
 * Node 26 的 fetch 默认不信任 Windows 系统证书库，Steam 会直接抛
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`。启动时把系统 CA 并进默认证书列表，
 * 只做一次；失败也不影响其他平台。
 */
import tls from 'node:tls'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

let tlsReady = false
function ensureSystemCA() {
  if (tlsReady) return
  tlsReady = true
  try {
    const system = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : []
    const merged = [...new Set([...tls.rootCertificates, ...system])]
    tls.setDefaultCACertificates(merged)
  } catch {
    // 证书合并失败时保持 Node 默认行为，平台模块会各自报错
  }
}

export class HttpError extends Error {
  constructor(message, status = 0, body = '') {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = String(body || '').slice(0, 500)
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
    this.code = 'AUTH_REQUIRED'
  }
}

/**
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:any, cookie?:string,
 *          redirect?:RequestRedirect, timeout?:number}} [opts]
 */
export async function request(url, opts = {}) {
  ensureSystemCA()
  const headers = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.headers || {}),
  }
  let body = opts.body
  if (body && typeof body === 'object' && !(body instanceof URLSearchParams) && !Buffer.isBuffer(body)) {
    body = new URLSearchParams(body).toString()
    headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded'
  }
  const signal = AbortSignal.timeout(opts.timeout ?? 30_000)
  let res
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body,
      redirect: opts.redirect || 'manual',
      signal,
    })
  } catch (error) {
    const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? `请求超时（${Math.round((opts.timeout ?? 30_000) / 1000)} 秒）`
      : `网络请求失败：${error?.message || String(error)}`
    throw new HttpError(message, 0, url)
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: res.headers,
    location: res.headers.get('location') || '',
    text,
    json,
  }
}

export function parseCookie(cookie) {
  const out = {}
  for (const part of String(cookie || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

export function shortError(error) {
  const text = String(error?.message || error || '未知错误')
  return text.replace(/\s+/g, ' ').slice(0, 300)
}