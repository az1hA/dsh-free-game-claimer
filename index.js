/**
 * dsh-free-games-claimer —— host 半端
 *
 * 设置页的“喜加一”：
 *   - Epic / GOG / Steam 三个平台，打开可见 Chrome/Edge 窗口登录；
 *   - 默认每天检查一轮，间隔可改；
 *   - 每个平台可以单独关掉，关掉的平台不检查；
 *   - 发现限时免费后自动领取（可关），结果写进设置页。
 *
 * 设计取舍：
 *   - 不用 DSH 的 schedule 服务：它本质上是“往会话投递 prompt”，会创建/恢复
 *     Session，不适合静默后台任务；这里用插件自己的 timer + 启动补跑。
 *   - Cookie 走 ctx.credentials 的 grant 记录，不写进 config.json / 日志 / 界面。
 *   - 发现与领取按平台能力分级：GOG 直接 claim；Steam 只碰 free-to-keep；
 *     Epic 用 Playwright 兜底，失败就保留链接并说“需要手动”。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BROWSER_CHOICES,
  PLATFORMS,
  PLATFORM_LABELS,
  intervalText,
  loadStore,
  maskCookie,
  nextCheckAt,
  normalizeConfig,
  normalizeCookie,
  saveStore,
  stateDirOf,
} from './lib/state.mjs'
import { AuthError, shortError } from './lib/http.mjs'
import { claimEpicWithBrowser, discoverEpic, validateEpic } from './lib/epic.mjs'
import { claimGog, validateGog } from './lib/gog.mjs'
import { claimSteam, discoverSteam, validateSteam } from './lib/steam.mjs'
import {
  closeBrowserContext,
  detectBrowsers,
  hasLoginCookies,
  launchVisibleLogin,
  readPlatformCookies,
  resolveBrowser,
  serializeCookies,
} from './lib/browser.mjs'

export const name = 'free-games-claimer'
export const inject = ['credentials']
export const optional = ['webServer']

const API_PREFIX = '/api/free-games-claimer'
const VERSION = readVersion()

function readVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.1.0')
  } catch {
    return '0.1.0'
  }
}

const CRED_KEY = (platform) => `free-games-claimer/${platform}`

export function apply(ctx) {
  const stateDir = stateDirOf(ctx)
  let store = loadStore(stateDir)
  let running = null
  let login = null
  let lastLogin = null
  let disposed = false

  const log = (line) => {
    const text = `[${new Date().toISOString()}] ${line}`
    try {
      appendFileSync(join(stateDir, 'duty.log'), `${text}\n`, 'utf8')
    } catch {
      // 日志写不了不影响主流程
    }
  }

  const persist = () => {
    try {
      saveStore(stateDir, store)
    } catch (error) {
      log(`保存状态失败：${shortError(error)}`)
    }
  }

  const credentials = () => {
    try {
      return ctx.get('credentials')
    } catch {
      return undefined
    }
  }

  async function readCredential(platform) {
    const service = credentials()
    if (!service) return null
    try {
      const record = await service.readRecord(CRED_KEY(platform))
      if (!record || record.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') return null
      const payload = record.payload
      if (!payload.cookie) return null
      return {
        cookie: String(payload.cookie),
        account: String(payload.account || ''),
        savedAt: String(payload.savedAt || ''),
        browser: String(payload.browser || ''),
        userAgent: String(payload.userAgent || ''),
      }
    } catch (error) {
      log(`读取 ${platform} 凭证失败：${shortError(error)}`)
      return null
    }
  }

  async function writeCredential(platform, payload) {
    const service = credentials()
    if (!service) throw new Error('DSH 的 credentials 服务不可用，无法保存登录凭证')
    await service.modifyRecord(CRED_KEY(platform), async () => ({
      kind: 'grant',
      payload: {
        cookie: payload.cookie,
        account: payload.account || '',
        savedAt: payload.savedAt || new Date().toISOString(),
        browser: payload.browser || '',
        userAgent: payload.userAgent || '',
      },
    }))
  }

  async function deleteCredential(platform) {
    const service = credentials()
    if (!service) return
    try {
      await service.deleteRecord(CRED_KEY(platform))
    } catch (error) {
      log(`删除 ${platform} 凭证失败：${shortError(error)}`)
      throw error
    }
  }

  async function credentialView(platform) {
    const hit = await readCredential(platform)
    if (!hit) return { configured: false }
    return {
      configured: true,
      account: hit.account || '',
      savedAt: hit.savedAt || '',
      masked: maskCookie(hit.cookie),
    }
  }

  async function allCredentialViews() {
    const out = {}
    for (const platform of PLATFORMS) out[platform] = await credentialView(platform)
    return out
  }

  function loginView() {
    if (!login) return null
    return {
      active: true,
      platform: login.platform,
      browser: login.browser.id,
      browserLabel: login.browser.label,
      phase: login.phase,
      message: login.message,
      startedAt: login.startedAt,
    }
  }

  function rememberLogin(session, phase, message) {
    lastLogin = {
      platform: session.platform,
      browser: session.browser.id,
      browserLabel: session.browser.label,
      phase,
      message,
      at: Date.now(),
    }
  }

  function startLogin(platform, preferred) {
    if (!PLATFORMS.includes(platform)) throw new Error(`未知平台：${platform}`)
    if (login) return { ok: false, busy: true, error: '已经有一个登录窗口在等待，请先完成或取消它' }

    const choice = BROWSER_CHOICES.includes(preferred) ? preferred : store.config.browser
    const browser = resolveBrowser(choice)
    if (!browser) {
      throw new Error(
        choice === 'chrome'
          ? '没有找到 Chrome，请先在设置里改用 Edge，或选择“自动”'
          : choice === 'edge'
            ? '没有找到 Edge，请先在设置里改用 Chrome，或选择“自动”'
            : '本机没有找到 Chrome 或 Edge，请先安装一个浏览器',
      )
    }

    const session = {
      platform,
      browser,
      phase: 'opening',
      message: `正在打开 ${browser.label}…`,
      startedAt: Date.now(),
      cancelled: false,
      finished: false,
      context: null,
    }
    login = session
    lastLogin = null
    log(`开始 ${platform} 可见登录（${browser.label}）`)
    void runLogin(session)
    return { ok: true, login: loginView() }
  }

  async function runLogin(session) {
    const profileDir = join(stateDir, 'browser', session.platform)
    try {
      const launched = await launchVisibleLogin({
        platform: session.platform,
        browser: session.browser,
        profileDir,
      })
      session.context = launched.context
      try {
        session.userAgent = await launched.page.evaluate(() => navigator.userAgent)
      } catch {
        session.userAgent = ''
      }

      if (session.cancelled || disposed) {
        await closeBrowserContext(session.context)
        return
      }

      session.phase = 'waiting'
      session.message = `请在弹出的 ${session.browser.label} 窗口里完成登录，登录成功后窗口会自动关闭`
      let closed = false
      launched.context.once('close', () => {
        closed = true
      })

      const deadline = Date.now() + 10 * 60_000
      let lastCookies = []
      while (!disposed && !session.cancelled && !closed && Date.now() < deadline) {
        await sleep(2000)
        if (disposed || session.cancelled || closed) break

        let cookies = []
        try {
          cookies = await readPlatformCookies(launched.context, session.platform)
        } catch {
          break
        }
        lastCookies = cookies
        if (!hasLoginCookies(session.platform, cookies)) continue

        // Steam 的 store 首页会刷新 Akamai 风控 Cookie；不先走这一步，
        // 用原始 HTTP 请求 /account/ 有时会被 302 回自己。
        if (session.platform === 'steam') {
          await launched.page.goto('https://store.steampowered.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          }).catch(() => {})
          try {
            cookies = await readPlatformCookies(launched.context, session.platform)
          } catch {
            // 继续用已取到的 Cookie
          }
        }

        const cookie = serializeCookies(cookies)
        if (!cookie) continue

        session.phase = 'verifying'
        session.message = '检测到登录，正在验证…'
        try {
          const info = await validateCredential(session.platform, cookie)
          await writeCredential(session.platform, {
            cookie,
            account: info.account || '',
            savedAt: new Date().toISOString(),
            browser: session.browser.id,
            userAgent: session.userAgent || '',
          })
          session.phase = 'success'
          session.message = `已登录：${info.account || '账号'}`
          session.finished = true
          rememberLogin(session, 'success', session.message)
          log(`已保存 ${session.platform} 登录凭证（账号：${info.account || '未知'}）`)
          await closeBrowserContext(launched.context)
          return
        } catch (error) {
          if (error instanceof AuthError) {
            session.phase = 'waiting'
            session.message = '还没检测到有效登录，请继续在窗口里完成登录'
            continue
          }
          log(`${session.platform} 登录验证失败：${shortError(error)}`)
          session.phase = 'waiting'
          session.message = `验证失败：${shortError(error)}`
        }
      }

      // 用户可能看到“确认账户”页就直接关窗了；关窗后再用最后一次读到的
      // Cookie 验证一次，能保存就保存，不要白等 10 分钟。
      if (closed && !session.finished && !session.cancelled) {
        const cookie = serializeCookies(lastCookies)
        if (cookie && hasLoginCookies(session.platform, lastCookies)) {
          try {
            const info = await validateCredential(session.platform, cookie)
            await writeCredential(session.platform, {
              cookie,
              account: info.account || '',
              savedAt: new Date().toISOString(),
              browser: session.browser.id,
            })
            session.phase = 'success'
            session.message = `已登录：${info.account || '账号'}`
            session.finished = true
            rememberLogin(session, 'success', session.message)
            log(`已保存 ${session.platform} 登录凭证（关窗后验证，账号：${info.account || '未知'}）`)
            return
          } catch (error) {
            log(`${session.platform} 关窗后验证失败：${shortError(error)}`)
          }
        }
      }

      if (!session.finished && !session.cancelled) {
        session.phase = 'error'
        session.message = closed
          ? '登录窗口被关闭了，没有保存凭证'
          : '等待登录超时（10 分钟），请重新打开登录窗口'
        rememberLogin(session, 'error', session.message)
        log(`${session.platform} 登录未完成：${session.message}`)
      }
    } catch (error) {
      session.phase = 'error'
      session.message = `打开登录窗口失败：${shortError(error)}`
      rememberLogin(session, 'error', session.message)
      log(`${session.platform} 打开登录窗口失败：${shortError(error)}`)
    } finally {
      if (session.context) await closeBrowserContext(session.context)
      if (login === session) login = null
    }
  }

  async function cancelLogin() {
    const session = login
    if (!session) return false
    session.cancelled = true
    session.phase = 'cancelled'
    session.message = '已取消登录'
    rememberLogin(session, 'cancelled', session.message)
    log(`${session.platform} 登录已取消`)
    await closeBrowserContext(session.context)
    if (login === session) login = null
    return true
  }

  async function status() {
    const values = await allCredentialViews()
    const browsers = detectBrowsers().map(({ id, label, available }) => ({ id, label, available }))
    const resolved = resolveBrowser(store.config.browser)
    return {
      ok: true,
      version: VERSION,
      config: store.config,
      intervalText: intervalText(store.config.intervalMinutes),
      nextCheckAt: nextCheckAt(store.config, store.runtime),
      lastCheckAt: store.runtime.lastCheckAt,
      lastFinishedAt: store.runtime.lastFinishedAt,
      running: Boolean(running),
      credentials: values,
      browsers,
      resolvedBrowser: resolved?.id || null,
      login: loginView(),
      lastLogin,
      lastRun: store.runtime.lastRun,
      history: store.runtime.history.slice(0, 10),
    }
  }

  async function validateCredential(platform, cookie) {
    if (platform === 'epic') return validateEpic(cookie)
    if (platform === 'gog') return validateGog(cookie)
    if (platform === 'steam') return validateSteam(cookie)
    throw new Error(`未知平台：${platform}`)
  }

  async function runEpic(credential, config) {
    const cookie = credential.cookie
    const games = await discoverEpic()
    const results = []
    if (!games.length) {
      return {
        platform: 'epic',
        ok: true,
        found: 0,
        claimed: 0,
        message: '当前没有 Epic 限时免费游戏',
        games: results,
      }
    }
    for (const game of games.slice(0, 4)) {
      if (!config.autoClaim) {
        results.push({
          title: game.title,
          url: game.url,
          image: game.image,
          status: 'available',
          message: '发现限免（未开启自动领取）',
        })
        continue
      }
      const claimed = await claimEpicWithBrowser(
        cookie,
        game,
        log,
        credential.userAgent,
        join(stateDir, 'browser', 'epic'),
      )
      results.push({
        title: game.title,
        url: claimed.url || game.url,
        image: game.image,
        status: claimed.status,
        message: claimed.message,
      })
    }
    return summarizePlatform('epic', results)
  }

  async function runGog(cookie, config) {
    if (!config.autoClaim) {
      return {
        platform: 'gog',
        ok: true,
        found: 0,
        claimed: 0,
        message: '自动领取已关闭；GOG 没有独立列表接口，这轮跳过',
        games: [],
      }
    }
    const claimed = await claimGog(cookie)
    if (claimed.status === 'none') {
      return { platform: 'gog', ok: true, found: 0, claimed: 0, message: claimed.message, games: [] }
    }
    return summarizePlatform('gog', [
      {
        title: claimed.title || 'GOG 限时免费游戏',
        url: 'https://www.gog.com/',
        image: '',
        status: claimed.status,
        message: claimed.message,
      },
    ])
  }

  async function runSteam(cookie, config) {
    const games = await discoverSteam()
    const results = []
    if (!games.length) {
      return {
        platform: 'steam',
        ok: true,
        found: 0,
        claimed: 0,
        message: 'Steam 当前没有可入库的限时免费游戏（免费周末不算）',
        games: [],
      }
    }
    for (const game of games.slice(0, 8)) {
      if (!config.autoClaim) {
        results.push({
          title: game.title,
          url: game.url,
          image: game.image,
          status: 'available',
          message: '发现 free-to-keep（未开启自动领取）',
        })
        continue
      }
      const claimed = await claimSteam(cookie, game)
      results.push({
        title: game.title,
        url: game.url,
        image: game.image,
        status: claimed.status,
        message: claimed.message,
      })
    }
    return summarizePlatform('steam', results)
  }

  function summarizePlatform(platform, games) {
    const found = games.length
    const claimed = games.filter((game) => game.status === 'claimed').length
    const owned = games.filter((game) => game.status === 'already').length
    const failed = games.filter((game) => game.status === 'failed').length
    const manual = games.filter((game) => game.status === 'manual').length
    const suffix = [
      owned ? `在库中 ${owned} 个` : '',
      manual ? `待手动 ${manual} 个` : '',
    ].filter(Boolean).join('，')
    return {
      platform,
      ok: failed === 0,
      found,
      claimed,
      owned,
      failed,
      manual,
      message: found ? `发现 ${found} 个，入库 ${claimed} 个${suffix ? `，${suffix}` : ''}` : '没有发现',
      games,
    }
  }

  async function executeRun(trigger) {
    const startedAt = Date.now()
    const run = {
      startedAt,
      finishedAt: null,
      trigger,
      ok: true,
      summary: { found: 0, claimed: 0, owned: 0, failed: 0, manual: 0 },
      platforms: [],
      error: '',
    }
    try {
      for (const platform of PLATFORMS) {
        if (!store.config.platforms[platform]) continue
        const credential = await readCredential(platform)
        if (!credential) {
          run.platforms.push({
            platform,
            ok: false,
            status: 'no-credential',
            found: 0,
            claimed: 0,
            failed: 0,
            message: `未登录 ${PLATFORM_LABELS[platform]}，这轮跳过`,
            games: [],
          })
          continue
        }
        try {
          let result
          if (platform === 'epic') result = await runEpic(credential, store.config)
          else if (platform === 'gog') result = await runGog(credential.cookie, store.config)
          else result = await runSteam(credential.cookie, store.config)
          run.platforms.push(result)
        } catch (error) {
          if (error instanceof AuthError) {
            run.platforms.push({
              platform,
              ok: false,
              status: 'auth-expired',
              found: 0,
              claimed: 0,
              failed: 0,
              message: `${PLATFORM_LABELS[platform]} 登录已过期，请在设置页重新登录`,
              games: [],
            })
            continue
          }
          run.platforms.push({
            platform,
            ok: false,
            status: 'error',
            found: 0,
            claimed: 0,
            failed: 0,
            message: shortError(error),
            games: [],
          })
        }
      }
      for (const platform of run.platforms) {
        run.summary.found += Number(platform.found || 0)
        run.summary.claimed += Number(platform.claimed || 0)
        run.summary.owned += Number(platform.owned || 0)
        run.summary.failed += Number(platform.failed || 0)
        run.summary.manual += Number(platform.manual || 0)
      }
      run.ok = run.platforms.every((platform) => platform.ok !== false || platform.status === 'no-credential')
    } catch (error) {
      run.ok = false
      run.error = shortError(error)
    } finally {
      run.finishedAt = Date.now()
      store.runtime.lastCheckAt = startedAt
      store.runtime.lastFinishedAt = run.finishedAt
      store.runtime.lastRun = run
      store.runtime.history = [
        {
          at: startedAt,
          trigger,
          ok: run.ok,
          found: run.summary.found,
          claimed: run.summary.claimed,
          owned: run.summary.owned,
          failed: run.summary.failed,
          manual: run.summary.manual,
          platforms: run.platforms.map((platform) => ({
            platform: platform.platform,
            ok: platform.ok,
            found: platform.found,
            claimed: platform.claimed,
            message: platform.message,
          })),
        },
        ...store.runtime.history,
      ].slice(0, 30)
      persist()
      log(`检查完成：found=${run.summary.found} claimed=${run.summary.claimed} owned=${run.summary.owned} failed=${run.summary.failed}`)
    }
    return run
  }

  function startRun(trigger = 'manual') {
    if (running) return { ok: true, started: false, busy: true }
    running = executeRun(trigger)
      .catch((error) => {
        log(`检查异常：${shortError(error)}`)
        return null
      })
      .finally(() => {
        running = null
      })
    return { ok: true, started: true, busy: false }
  }

  const timer = setInterval(() => {
    if (disposed || running || !store.config.enabled) return
    if (Date.now() >= nextCheckAt(store.config, store.runtime)) {
      log(`到达检查时间（${intervalText(store.config.intervalMinutes)}）`)
      startRun('auto')
    }
  }, 30_000)
  ctx.effect(() => () => {
    disposed = true
    clearInterval(timer)
    if (login) {
      login.cancelled = true
      void closeBrowserContext(login.context)
    }
  }, 'free-games-claimer: 定时检查')

  // 启动补跑：上次检查已经过期（或从未检查）就等 10 秒跑一轮。
  const boot = setTimeout(() => {
    if (disposed) return
    if (store.config.enabled && Date.now() >= nextCheckAt(store.config, store.runtime)) {
      startRun('startup')
    }
  }, 10_000)
  ctx.effect(() => () => clearTimeout(boot), 'free-games-claimer: 启动补跑')

  async function handle(req, res, url) {
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const path = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && (path === '/' || path === '/status')) {
      sendJson(res, 200, await status())
      return
    }

    

    if (req.method === 'GET' && path === '/history') {
      sendJson(res, 200, { ok: true, history: store.runtime.history })
      return
    }

    if (req.method === 'POST' && path === '/config') {
      const body = await readJsonBody(req)
      const patch = body && typeof body === 'object' ? body : {}
      store.config = normalizeConfig({
        ...store.config,
        ...patch,
        platforms: {
          ...store.config.platforms,
          ...(patch.platforms && typeof patch.platforms === 'object' ? patch.platforms : {}),
        },
      })
      persist()
      sendJson(res, 200, await status())
      return
    }

    if (req.method === 'POST' && path === '/run') {
      const result = startRun('manual')
      sendJson(res, 200, { ...result, status: await status() })
      return
    }

    if (req.method === 'POST' && path === '/login') {
      const body = await readJsonBody(req)
      const platform = String(body?.platform || '')
      if (!PLATFORMS.includes(platform)) {
        sendJson(res, 400, { ok: false, error: '未知平台' })
        return
      }
      const preferred = String(body?.browser || store.config.browser)
      if (!BROWSER_CHOICES.includes(preferred)) {
        sendJson(res, 400, { ok: false, error: '未知浏览器选项' })
        return
      }
      try {
        const result = startLogin(platform, preferred)
        if (!result.ok) {
          sendJson(res, 409, { ...result, status: await status() })
          return
        }
        sendJson(res, 202, { ...result, status: await status() })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: shortError(error) })
      }
      return
    }

    if (req.method === 'POST' && path === '/login/cancel') {
      const canceled = await cancelLogin()
      sendJson(res, 200, { ok: true, canceled, status: await status() })
      return
    }

    if (req.method === 'POST' && path === '/credentials') {
      const body = await readJsonBody(req)
      const platform = String(body?.platform || '')
      if (!PLATFORMS.includes(platform)) {
        sendJson(res, 400, { ok: false, error: '未知平台' })
        return
      }
      let cookie
      try {
        cookie = normalizeCookie(body?.cookie)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: shortError(error) })
        return
      }
      let info
      try {
        info = await validateCredential(platform, cookie)
      } catch (error) {
        const auth = error instanceof AuthError
        sendJson(res, auth ? 401 : 400, {
          ok: false,
          error: shortError(error),
          authRequired: auth,
        })
        return
      }
      try {
        await writeCredential(platform, {
          cookie,
          account: info.account || '',
          savedAt: new Date().toISOString(),
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: shortError(error) })
        return
      }
      log(`已保存 ${platform} 登录凭证（账号：${info.account || '未知'}）`)
      sendJson(res, 200, {
        ok: true,
        account: info.account || '',
        status: await status(),
      })
      return
    }

    if (req.method === 'DELETE' && (path === '/credentials' || path.startsWith('/credentials/'))) {
      const platform = path.startsWith('/credentials/')
        ? decodeURIComponent(path.slice('/credentials/'.length))
        : String(url.searchParams.get('platform') || '')
      if (!PLATFORMS.includes(platform)) {
        sendJson(res, 400, { ok: false, error: '未知平台' })
        return
      }
      try {
        await deleteCredential(platform)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: shortError(error) })
        return
      }
      log(`已删除 ${platform} 登录凭证`)
      sendJson(res, 200, { ok: true, status: await status() })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.get('webServer').register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            try {
              await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
            } catch (error) {
              log(`HTTP 处理失败：${shortError(error)}`)
              if (!res.headersSent) sendJson(res, 500, { ok: false, error: shortError(error) })
              else res.end()
            }
          },
        }),
      'free-games-claimer: /api/free-games-claimer 路由',
    )
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sendJson(res, statusCode, value) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve(null)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}