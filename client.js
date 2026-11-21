/**
 * dsh-free-games-claimer —— 设置页「喜加一」客户端
 *
 * 只做三件事：看状态、粘 Cookie、改设置。所有数据走同源
 * `/api/free-games-claimer/*`，不碰 document.body，只用设置页 slot。
 */
window.__ModuleLoader__.load({
  id: 'dsh-free-games-claimer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/api/free-games-claimer'
    const PLATFORMS = ['epic', 'gog', 'steam']
    const META = {
      epic: {
        label: 'Epic Games',
        hint: '每周限免。自动打开商店页点 Get；遇到验证码会保留链接让你手动完成。',
      },
      gog: {
        label: 'GOG',
        hint: '不定期 giveaway。登录后直接调 claim，没有独立列表接口。',
      },
      steam: {
        label: 'Steam',
        hint: '只领 Free to Keep；免费周末能玩但不入库，会被跳过。',
      },
    }

    const STATUS_TEXT = {
      claimed: '已入库',
      already: '在库中',
      available: '待领取',
      manual: '需手动',
      failed: '失败',
      skipped: '已跳过',
      'no-credential': '未登录',
      'auth-expired': '登录过期',
      error: '出错',
      none: '无活动',
    }

    function statusTone(status) {
      if (status === 'claimed' || status === 'already') return 'ok'
      if (status === 'failed' || status === 'auth-expired' || status === 'error') return 'bad'
      if (status === 'manual' || status === 'available') return 'warn'
      return 'idle'
    }

    function fmtTime(ts) {
      if (!ts) return '—'
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function fmtRelative(ts) {
      if (!ts) return '还没检查过'
      const diff = Date.now() - ts
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      return `${Math.floor(diff / 86_400_000)} 天前`
    }

    function api(path, options = {}) {
      return fetch(`${API}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      }).then(async (res) => {
        let json = null
        try {
          json = await res.json()
        } catch {
          json = null
        }
        if (!res.ok || !json || json.ok === false) {
          const error = new Error(json?.error || `请求失败（HTTP ${res.status}）`)
          error.status = res.status
          error.json = json
          throw error
        }
        return json
      })
    }

    function Button({ children, primary, danger, small, disabled, onClick, title }) {
      return h(
        'button',
        {
          type: 'button',
          'data-fgc-btn': '',
          'data-primary': primary ? '' : undefined,
          'data-danger': danger ? '' : undefined,
          'data-small': small ? '' : undefined,
          disabled,
          onClick,
          title,
        },
        children,
      )
    }

    function Switch({ checked, onChange, label, desc, disabled, ariaLabel }) {
      return h(
        'div',
        { 'data-fgc-switchrow': '' },
        h(
          'div',
          { 'data-fgc-switchtext': '' },
          h('div', { 'data-fgc-label': '' }, label),
          desc ? h('div', { 'data-fgc-desc': '' }, desc) : null,
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-label': ariaLabel || label,
            'aria-checked': checked ? 'true' : 'false',
            'data-fgc-switch': '',
            'data-on': checked ? '' : undefined,
            disabled,
            onClick: () => onChange(!checked),
          },
          h('span', { 'data-fgc-knob': '' }),
        ),
      )
    }

    function PlatformCard({
      platform,
      view,
      config,
      ready,
      login,
      lastLogin,
      selectedBrowser,
      onLogin,
      onCancel,
      onClear,
      onSave,
      busy,
      locked,
    }) {
      const meta = META[platform]
      const enabled = Boolean(config?.platforms?.[platform])
      const configured = Boolean(view?.configured)
      const active = Boolean(login?.active && login.platform === platform)
      const failure =
        lastLogin?.platform === platform && lastLogin.phase === 'error' ? lastLogin.message : ''
      const browserLabel = selectedBrowser?.label || ''
      const actionLabel = active
        ? '登录中…'
        : configured
          ? `重新登录（${browserLabel || '浏览器'}）`
          : browserLabel
            ? `打开 ${browserLabel} 登录`
            : '没有可用浏览器'

      return h(
        'div',
        {
          'data-fgc-card': '',
          'data-fgc-plat': platform,
          'data-off': ready && !enabled ? '' : undefined,
        },
        h(
          'div',
          { 'data-fgc-plathead': '' },
          h(
            'div',
            { 'data-fgc-platname': '' },
            h('span', { 'data-fgc-dot': '', 'data-tone': configured ? 'ok' : 'idle' }),
            h('span', null, meta.label),
          ),
          h(
            'span',
            { 'data-fgc-badge': '', 'data-tone': configured ? 'ok' : 'idle' },
            configured ? '已登录' : '未登录',
          ),
        ),
        h(
          'div',
          { 'data-fgc-platacct': '' },
          configured ? view.account || '凭证已保存' : active ? '等待浏览器登录…' : '还没登录',
        ),
        h('div', { 'data-fgc-plathint': '' }, meta.hint),
        active
          ? h(
              'div',
              { 'data-fgc-loginstate': '', role: 'status', 'aria-live': 'polite' },
              login.message || '请在弹出的浏览器窗口里完成登录',
            )
          : null,
        failure
          ? h(
              'div',
              { 'data-fgc-loginstate': '', 'data-tone': 'bad', role: 'alert' },
              failure,
            )
          : null,

        h(
          'div',
          { 'data-fgc-platfoot': '' },
          h(
            'div',
            { 'data-fgc-inline': '' },
            h(
              'button',
              {
                type: 'button',
                'data-fgc-textbtn': '',
                onClick: () => onLogin(platform),
                disabled: !ready || Boolean(busy) || !selectedBrowser || active || Boolean(locked),
              },
              actionLabel,
            ),
            active
              ? h(
                  'button',
                  {
                    type: 'button',
                    'data-fgc-textbtn': '',
                    disabled: Boolean(busy),
                    onClick: onCancel,
                  },
                  '取消登录',
                )
              : null,
            configured && !active
              ? h(
                  'button',
                  {
                    type: 'button',
                    'data-fgc-textbtn': '',
                    'data-danger': '',
                    disabled: !ready || Boolean(busy),
                    onClick: () => onClear(platform),
                  },
                  '清除',
                )
              : null,
          ),
          h(Switch, {
            checked: ready && enabled,
            disabled: !ready || Boolean(busy),
            onChange: (value) => onSave({ platforms: { [platform]: value } }),
            label: '参与每日检查',
            ariaLabel: `${meta.label} 参与每日检查`,
          }),
        ),
      )
    }

    function GameRow({ game }) {
      const tone = statusTone(game.status)
      return h(
        'div',
        { 'data-fgc-gamerow': '' },
        game.image
          ? h('img', { src: game.image, alt: '', 'data-fgc-thumb': '', loading: 'lazy' })
          : h('div', { 'data-fgc-thumb': '', 'data-empty': '' }),
        h(
          'div',
          { 'data-fgc-gameinfo': '' },
          h(
            'div',
            { 'data-fgc-gametitle': '' },
            game.url
              ? h('a', { href: game.url, target: '_blank', rel: 'noreferrer' }, game.title || '未命名')
              : game.title || '未命名',
          ),
          h('div', { 'data-fgc-gamemsg': '' }, game.message || ''),
        ),
        h('span', { 'data-fgc-badge': '', 'data-tone': tone }, STATUS_TEXT[game.status] || game.status || '—'),
      )
    }

    function RunResults({ run, onLogin }) {
      if (!run) {
        return h('div', { 'data-fgc-empty': '' }, '还没有检查记录。点右上角「立即检查」跑一轮。')
      }
      const platforms = Array.isArray(run.platforms) ? run.platforms : []
      return h(
        'div',
        { 'data-fgc-results': '' },
        h(
          'div',
          { 'data-fgc-summary': '' },
          h('span', null, `发现 ${run.summary?.found || 0} 个`),
          h('span', { 'data-fgc-dot': '' }),
          h('span', null, `入库 ${run.summary?.claimed || 0} 个`),
          run.summary?.owned ? h('span', null, `在库中 ${run.summary.owned} 个`) : null,
          run.summary?.manual ? h('span', null, `待手动 ${run.summary.manual} 个`) : null,
          run.summary?.failed ? h('span', null, `失败 ${run.summary.failed} 个`) : null,
          h('span', { 'data-fgc-muted': '' }, fmtTime(run.finishedAt || run.startedAt)),
        ),
        platforms.map((platform) => {
          const meta = META[platform.platform] || { label: platform.platform }
          const games = Array.isArray(platform.games) ? platform.games : []
          const owned = Number(platform.owned || 0)
          const manual = Number(platform.manual || 0)
          const badgeText = [
            owned ? `在库中 ${owned} 个` : '',
            manual ? `待手动 ${manual} 个` : '',
          ].filter(Boolean).join(' · ')
          return h(
            'div',
            { key: platform.platform, 'data-fgc-runplat': '' },
            h(
              'div',
              { 'data-fgc-runplathead': '' },
              h('span', { 'data-fgc-runplatname': '' }, meta.label),
              h(
                'span',
                {
                  'data-fgc-badge': '',
                  'data-tone': manual ? 'warn' : owned ? 'ok' : platform.ok === false ? 'bad' : 'idle',
                },
                badgeText || STATUS_TEXT[platform.status] || (platform.ok === false ? '有问题' : '完成'),
              ),
              h('span', { 'data-fgc-muted': '' }, platform.message || ''),
            ),
            games.length
              ? games.map((game, index) => h(GameRow, { key: `${platform.platform}-${index}`, game }))
              : null,
            platform.status === 'auth-expired'
              ? h(
                  'button',
                  { type: 'button', 'data-fgc-textbtn': '', onClick: () => onLogin(platform.platform) },
                  '重新登录',
                )
              : null,
          )
        }),
      )
    }

    function Panel() {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [intervalDraft, setIntervalDraft] = useState('1440')
      const alive = useRef(true)

      const load = useCallback(async (silent = false) => {
        if (!silent) setLoading(true)
        try {
          const next = await api('/status')
          if (!alive.current) return
          setData(next)
          setError('')
          if (!silent) setIntervalDraft(String(next.config?.intervalMinutes ?? 1440))
        } catch (e) {
          if (alive.current) setError(e.message || String(e))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(() => load(true), 8000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      // 登录窗口开着的时候刷新快一点，登录成功后 2 秒内就能看到状态。
      useEffect(() => {
        if (!data?.login?.active) return undefined
        const timer = setInterval(() => load(true), 2000)
        return () => clearInterval(timer)
      }, [data?.login?.active, load])

      const patchConfig = async (patch) => {
        setBusy('config')
        setError('')
        try {
          const next = await api('/config', { method: 'POST', body: JSON.stringify(patch) })
          setData(next)
          if (patch.intervalMinutes !== undefined) {
            setIntervalDraft(String(next.config?.intervalMinutes ?? patch.intervalMinutes))
          }
          setError('')
          setNotice('设置已保存')
        } catch (e) {
          setNotice('')
          setError(e.message || String(e))
        } finally {
          setBusy('')
        }
      }

      const startLogin = async (platform) => {
        setBusy(`login-${platform}`)
        setError('')
        setNotice('')
        try {
          const result = await api('/login', {
            method: 'POST',
            body: JSON.stringify({ platform, browser: config.browser || 'auto' }),
          })
          if (result.status) setData(result.status)
          const label = result.login?.browserLabel || '浏览器'
          setNotice(`已打开 ${label}，请在窗口里完成 ${META[platform]?.label || platform} 登录`)
        } catch (e) {
          setNotice('')
          setError(e.message || String(e))
        } finally {
          setBusy('')
        }
      }

      const cancelLogin = async () => {
        setBusy('login-cancel')
        setError('')
        try {
          const result = await api('/login/cancel', { method: 'POST', body: '{}' })
          if (result.status) setData(result.status)
          setNotice('已取消登录')
        } catch (e) {
          setNotice('')
          setError(e.message || String(e))
        } finally {
          setBusy('')
        }
      }

      const clearCredential = async (platform) => {
        if (!window.confirm(`确定清除 ${META[platform]?.label || platform} 的登录凭证吗？`)) return
        setBusy(`clear-${platform}`)
        setError('')
        try {
          const result = await api(`/credentials/${platform}`, { method: 'DELETE' })
          if (result.status) setData(result.status)
          setError('')
          setNotice('已清除登录凭证')
        } catch (e) {
          setNotice('')
          setError(e.message || String(e))
        } finally {
          setBusy('')
        }
      }

      const runNow = async () => {
        setBusy('run')
        setError('')
        try {
          const result = await api('/run', { method: 'POST', body: '{}' })
          if (result.busy) setNotice('上一轮还没跑完，稍等')
          else setNotice('开始检查，结果会自动刷新')
          if (result.status) setData(result.status)
          setError('')
          setTimeout(() => load(true), 2500)
        } catch (e) {
          setNotice('')
          setError(e.message || String(e))
        } finally {
          setBusy('')
        }
      }

      const config = data?.config || {}
      const ready = Boolean(data)
      const running = Boolean(data?.running)
      const anyCredential = PLATFORMS.some((platform) => data?.credentials?.[platform]?.configured)
      const browsers = data?.browsers || []
      const configuredBrowser = config.browser || 'auto'
      const selectedBrowser =
        configuredBrowser === 'auto'
          ? browsers.find((b) => b.id === 'chrome' && b.available) ||
            browsers.find((b) => b.available) ||
            null
          : browsers.find((b) => b.id === configuredBrowser && b.available) || null

      return h(
        'div',
        { 'data-fgc-wrap': '' },
        h(
          'div',
          { 'data-fgc-head': '' },
          h(
            'div',
            null,
            h('div', { 'data-fgc-title': '' }, '喜加一'),
            h('div', { 'data-fgc-sub': '' }, 'Epic / GOG / Steam 限时免费游戏，自动检查并入库。默认每天一轮。'),
          ),
          h(
            'div',
            { 'data-fgc-headactions': '' },
            data?.version ? h('span', { 'data-fgc-version': '' }, `v${data.version}`) : null,
            h(
              Button,
              { primary: true, disabled: busy === 'run' || running, onClick: runNow },
              running ? '检查中…' : '立即检查',
            ),
          ),
        ),

        error ? h('div', { 'data-fgc-banner': '', 'data-tone': 'bad', role: 'alert', 'aria-live': 'assertive' }, error) : null,
        notice ? h('div', { 'data-fgc-banner': '', 'data-tone': 'ok', role: 'status', 'aria-live': 'polite' }, notice) : null,

        h(
          'div',
          { 'data-fgc-status': '' },
          h(
            'div',
            null,
            h('span', { 'data-fgc-statuslabel': '' }, '上次检查'),
            h('strong', null, fmtTime(data?.lastCheckAt)),
            h('span', { 'data-fgc-muted': '' }, fmtRelative(data?.lastCheckAt)),
          ),
          h(
            'div',
            null,
            h('span', { 'data-fgc-statuslabel': '' }, '下次检查'),
            h(
              'strong',
              null,
              !ready ? '—' : config.enabled ? (data?.nextCheckAt ? fmtTime(data.nextCheckAt) : '即将') : '已暂停',
            ),
            h('span', { 'data-fgc-muted': '' }, data?.intervalText || ''),
          ),
          h(
            'div',
            { 'data-fgc-statusright': '' },
            h('span', { 'data-fgc-dot': '', 'data-tone': !ready ? 'idle' : running ? 'warn' : 'ok' }),
            h('span', null, !ready ? '加载中…' : running ? '正在检查…' : '空闲'),
          ),
        ),

        !anyCredential && !loading
          ? h(
              'div',
              { 'data-fgc-onboard': '' },
              h('div', { 'data-fgc-onboardtitle': '' }, '先登录一个平台'),
              h(
                'div',
                { 'data-fgc-desc': '' },
                '点下面平台卡片里的「打开浏览器登录」。会弹出一个正常浏览器窗口，登录成功后自动保存凭证并关闭；过期后重新登录即可。',
              ),
            )
          : null,

        h(
          'div',
          { 'data-fgc-sectiontitle': '' },
          '平台',
          h('span', { 'data-fgc-muted': '' }, '关掉的平台每日不检查'),
        ),
        h(
          'div',
          { 'data-fgc-grid': '' },
          PLATFORMS.map((platform) =>
            h(PlatformCard, {
              key: platform,
              platform,
              view: data?.credentials?.[platform] || {},
              config,
              ready,
              login: data?.login || null,
              lastLogin: data?.lastLogin || null,
              selectedBrowser,
              busy: Boolean(busy),
              locked: Boolean(data?.login) && data.login.platform !== platform,
              onLogin: startLogin,
              onCancel: cancelLogin,
              onSave: patchConfig,
              onClear: clearCredential,
            }),
          ),
        ),

        h(
          'div',
          { 'data-fgc-sectiontitle': '' },
          '设置',
        ),
        h(
          'div',
          { 'data-fgc-card': '' },
          h(Switch, {
            checked: ready && Boolean(config.enabled),
            disabled: !ready || Boolean(busy),
            onChange: (value) => patchConfig({ enabled: value }),
            label: '启用定时检查',
            desc: config.enabled ? '插件在后台按间隔检查' : '暂停自动检查，仍可手动点「立即检查」',
          }),
          h('div', { 'data-fgc-sep': '' }),
          h(Switch, {
            checked: ready && Boolean(config.autoClaim),
            disabled: !ready || Boolean(busy),
            onChange: (value) => patchConfig({ autoClaim: value }),
            label: '发现后自动入库',
            desc: '关掉就只记录免费游戏，不替你点领取',
          }),
          h('div', { 'data-fgc-sep': '' }),
          h(
            'div',
            { 'data-fgc-browserrow': '' },
            h(
              'div',
              null,
              h('div', { 'data-fgc-label': '', id: 'fgc-browser-label' }, '登录浏览器'),
              h(
                'div',
                { 'data-fgc-desc': '', id: 'fgc-browser-desc' },
                selectedBrowser
                  ? `当前会打开 ${selectedBrowser.label}；登录窗口需要你手动完成。`
                  : '本机没有找到 Chrome 或 Edge，登录按钮会不可用。',
              ),
            ),
            h(
              'select',
              {
                'data-fgc-select': '',
                value: configuredBrowser,
                'aria-labelledby': 'fgc-browser-label',
                'aria-describedby': 'fgc-browser-desc',
                disabled: !ready || Boolean(busy),
                onChange: (event) => patchConfig({ browser: event.target.value }),
              },
              h('option', { value: 'auto' }, '自动（优先 Chrome）'),
              browsers.map((browser) =>
                h(
                  'option',
                  { key: browser.id, value: browser.id, disabled: !browser.available },
                  `${browser.label}${browser.available ? '' : '（未安装）'}`,
                ),
              ),
            ),
          ),
          h('div', { 'data-fgc-sep': '' }),
          h(
            'div',
            { 'data-fgc-intervalrow': '' },
            h(
              'div',
              null,
              h('div', { 'data-fgc-label': '', id: 'fgc-interval-label' }, '检查间隔'),
              h('div', { 'data-fgc-desc': '', id: 'fgc-interval-desc' }, '默认 1440 分钟（每天一轮）。最短 15 分钟，最长 7 天。'),
            ),
            h(
              'div',
              { 'data-fgc-inline': '' },
              h('input', {
                'data-fgc-input': '',
                'data-fgc-interval': '',
                type: 'number',
                min: 15,
                max: 10080,
                step: 15,
                value: intervalDraft,
                'aria-labelledby': 'fgc-interval-label',
                'aria-describedby': 'fgc-interval-desc',
                onChange: (e) => setIntervalDraft(e.target.value),
              }),
              h('span', { 'data-fgc-muted': '' }, '分钟'),
              h(
                Button,
                {
                  small: true,
                  disabled: !ready || Boolean(busy) || String(intervalDraft) === String(config.intervalMinutes),
                  onClick: () => {
                    const value = Number(intervalDraft)
                    if (!Number.isFinite(value) || value < 15 || value > 10080) {
                      setError('检查间隔需要是 15–10080 之间的整数')
                      return
                    }
                    patchConfig({ intervalMinutes: value })
                  },
                },
                '保存',
              ),
            ),
          ),
        ),

        h(
          'div',
          { 'data-fgc-sectiontitle': '' },
          '最近一轮',
          data?.lastRun ? h('span', { 'data-fgc-muted': '' }, fmtTime(data.lastRun.startedAt)) : null,
        ),
        h('div', { 'data-fgc-card': '' }, h(RunResults, { run: data?.lastRun, onLogin: startLogin })),

        h(
          'div',
          { 'data-fgc-foot': '' },
          'GOG 没有公开列表接口；Steam 只处理 Free to Keep，免费周末不会入库。Epic 自动领取遇到验证码时会保留链接。',
        ),
      )
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { 'data-fgc-wrap': '' },
            h('div', { 'data-fgc-banner': '', 'data-tone': 'bad' }, `面板渲染失败：${this.state.error.message || this.state.error}`),
          )
        }
        return this.props.children
      }
    }

    const CSS = `
      [data-fgc-wrap]{display:flex;flex-direction:column;gap:12px;padding:4px 0 28px;max-width:880px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;}
      [data-fgc-head]{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px 0 4px;}
      [data-fgc-title]{font-size:20px;font-weight:650;letter-spacing:-.01em;}
      [data-fgc-sub]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b9098);margin-top:3px;max-width:560px;}
      [data-fgc-headactions]{display:flex;align-items:center;gap:8px;flex-shrink:0;}
      [data-fgc-version]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9098);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:99px;padding:2px 7px;}
      [data-fgc-btn]{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));color:inherit;border-radius:9px;padding:7px 12px;font:inherit;font-size:12px;line-height:16px;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s;white-space:nowrap;}
      [data-fgc-btn]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18));}
      [data-fgc-btn][data-primary]{background:var(--dsw-alias-button-primary-fill,#3b82f6);border-color:var(--dsw-alias-button-primary-fill,#3b82f6);color:var(--dsw-alias-label-on-color,#fff);}
      [data-fgc-btn][data-primary]:hover:not([disabled]){filter:brightness(.94);}
      [data-fgc-btn][data-small]{padding:4px 9px;font-size:11px;border-radius:8px;}
      [data-fgc-btn][data-danger]{color:var(--dsw-alias-label-error,#e5484d);border-color:transparent;background:transparent;padding:4px 5px;}
      [data-fgc-btn][disabled]{opacity:.45;cursor:default;}
      [data-fgc-card]{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.055));border-radius:12px;padding:13px 14px;}
      [data-fgc-status]{display:flex;align-items:center;gap:22px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.04));border-radius:11px;padding:10px 13px;}
      [data-fgc-status]>div{display:flex;align-items:baseline;gap:7px;min-width:0;}
      [data-fgc-statuslabel]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9098);}
      [data-fgc-statusright]{margin-left:auto;align-items:center!important;}
      [data-fgc-muted]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b9098);}
      [data-fgc-sectiontitle]{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#a7abb2);display:flex;align-items:center;justify-content:space-between;margin-top:6px;}
      [data-fgc-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(238px,1fr));gap:10px;}
      [data-fgc-plathead]{display:flex;align-items:center;justify-content:space-between;gap:8px;}
      [data-fgc-platname]{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px;}
      [data-fgc-platacct]{font-size:12px;color:var(--dsw-alias-label-secondary,#a7abb2);margin-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      [data-fgc-plathint]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b9098);margin-top:4px;min-height:32px;}
      [data-fgc-plat][data-off]{opacity:.62;}
      [data-fgc-platfoot]{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:10px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));}
      [data-fgc-inline]{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
      [data-fgc-textbtn]{appearance:none;border:0;background:transparent;color:var(--dsw-alias-link,#3b82f6);font:inherit;font-size:12px;padding:2px 0;cursor:pointer;}
      [data-fgc-textbtn][data-danger]{color:var(--dsw-alias-label-error,#e5484d);margin-left:8px;}
      [data-fgc-textbtn][disabled]{opacity:.45;cursor:default;}
      [data-fgc-dot]{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8b9098);display:inline-block;flex:0 0 auto;}
      [data-fgc-dot][data-tone="ok"]{background:var(--dsw-alias-state-success-secondary,#2fbf71);}
      [data-fgc-dot][data-tone="bad"]{background:var(--dsw-alias-label-error,#e5484d);}
      [data-fgc-dot][data-tone="warn"]{background:var(--dsw-alias-state-warn-label,#d99a2b);}
      [data-fgc-badge]{font-size:10px;line-height:15px;padding:1px 6px;border-radius:99px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-secondary,#a7abb2);white-space:nowrap;}
      [data-fgc-badge][data-tone="ok"]{color:var(--dsw-alias-state-success-secondary,#1f9d5c);background:rgba(47,191,113,.12);}
      [data-fgc-badge][data-tone="bad"]{color:var(--dsw-alias-state-error-secondary,#d93a3f);background:rgba(229,72,77,.12);}
      [data-fgc-badge][data-tone="warn"]{color:var(--dsw-alias-state-warn-label,#b47a16);background:rgba(217,154,43,.14);}
      [data-fgc-loginstate]{font-size:11px;line-height:16px;margin-top:8px;padding:6px 8px;border-radius:7px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));color:var(--dsw-alias-label-secondary,#a7abb2);}
      [data-fgc-loginstate][data-tone="bad"]{color:var(--dsw-alias-state-error-secondary,#d93a3f);background:rgba(229,72,77,.1);}
      [data-fgc-input]{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.26));background:var(--dsw-alias-bg-base,rgba(128,128,128,.06));color:inherit;border-radius:8px;padding:7px 9px;font:inherit;font-size:12px;}
      [data-fgc-select]{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.26));background:var(--dsw-alias-bg-base,rgba(128,128,128,.06));color:inherit;border-radius:8px;padding:6px 8px;font:inherit;font-size:12px;min-width:190px;}
      [data-fgc-input]:focus-visible,[data-fgc-select]:focus-visible,[data-fgc-btn]:focus-visible,[data-fgc-textbtn]:focus-visible,[data-fgc-switch]:focus-visible{outline:2px solid var(--dsw-alias-link,#3b82f6);outline-offset:1px;}
      [data-fgc-interval]{width:92px;}
      [data-fgc-error]{font-size:11px;color:var(--dsw-alias-label-error,#e5484d);margin-top:6px;line-height:16px;}
      [data-fgc-banner]{border-radius:9px;padding:8px 11px;font-size:12px;line-height:17px;}
      [data-fgc-banner][data-tone="bad"]{background:rgba(229,72,77,.1);color:var(--dsw-alias-state-error-secondary,#d93a3f);border:1px solid rgba(229,72,77,.25);}
      [data-fgc-banner][data-tone="ok"]{background:rgba(47,191,113,.1);color:var(--dsw-alias-state-success-secondary,#1f9d5c);border:1px solid rgba(47,191,113,.22);}
      [data-fgc-onboard]{border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.26));border-radius:11px;padding:11px 13px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.035));}
      [data-fgc-onboardtitle]{font-weight:600;font-size:13px;margin-bottom:3px;}
      [data-fgc-desc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b9098);}
      [data-fgc-switchrow]{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:2px 0;}
      [data-fgc-switchtext]{min-width:0;}
      [data-fgc-label]{font-size:12px;font-weight:550;}
      [data-fgc-switch]{appearance:none;width:34px;height:20px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));padding:0;position:relative;cursor:pointer;flex:0 0 auto;transition:background .16s,border-color .16s;}
      [data-fgc-switch][data-on]{background:var(--dsw-alias-button-primary-fill,#3b82f6);border-color:var(--dsw-alias-button-primary-fill,#3b82f6);}
      [data-fgc-knob]{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .16s;box-shadow:0 1px 2px rgba(0,0,0,.25);}
      [data-fgc-switch][data-on] [data-fgc-knob]{transform:translateX(14px);}
      [data-fgc-sep]{height:1px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.12));margin:11px 0;}
      [data-fgc-browserrow],[data-fgc-intervalrow]{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;}
      [data-fgc-summary]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12));}
      [data-fgc-runplat]{padding-top:9px;}
      [data-fgc-runplathead]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;}
      [data-fgc-runplatname]{font-weight:600;}
      [data-fgc-gamerow]{display:flex;align-items:center;gap:9px;padding:7px 0 2px;}
      [data-fgc-thumb]{width:54px;height:31px;border-radius:5px;object-fit:cover;flex:0 0 auto;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));}
      [data-fgc-thumb][data-empty]{display:block;}
      [data-fgc-gameinfo]{min-width:0;flex:1;}
      [data-fgc-gametitle]{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      [data-fgc-gametitle a]{color:inherit;text-decoration:none;}
      [data-fgc-gametitle a:hover]{text-decoration:underline;}
      [data-fgc-gamemsg]{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8b9098);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      [data-fgc-empty]{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b9098);padding:4px 0;}
      [data-fgc-foot]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b9098);padding:0 2px;}
      @media (prefers-reduced-motion: reduce){
        [data-fgc-btn],[data-fgc-switch],[data-fgc-knob]{transition:none;}
      }
      @media (max-width:620px){
        [data-fgc-head]{flex-direction:column;}
        [data-fgc-status]{gap:10px;}
        [data-fgc-statusright]{margin-left:0;}
        [data-fgc-grid]{grid-template-columns:1fr;}
      }
    `

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        const style = document.createElement('style')
        style.dataset.freeGamesClaimer = '1'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'free-games-claimer: styles')
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'free-games-claimer', order: 32, label: '喜加一' },
            () => h(Boundary, null, h(Panel)),
          ),
        )
      },
    }
  },
})