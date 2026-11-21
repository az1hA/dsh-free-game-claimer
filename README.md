# 喜加一 · dsh-free-games-claimer

[![CI](https://github.com/az1hA/dsh-free-game-claimer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/az1hA/dsh-free-game-claimer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/az1hA/dsh-free-game-claimer?display_name=tag)](https://github.com/az1hA/dsh-free-game-claimer/releases)

在 DeepSeek Harness 的「设置 → 喜加一」里管理 Epic Games、GOG、Steam 三个平台的限时免费游戏。

- 默认每天检查一轮，间隔可改（15 分钟 ~ 7 天）。
- 每个平台可单独开关；关掉的平台不检查。
- 发现限时免费后自动入库（可关）；关闭时只记录发现，不替你领取。
- 登录用可见的 Chrome / Edge 窗口，登录成功后自动保存凭证并关闭窗口。
- 登录凭证存进 DSH 的 credentials 存储，不写进日志、`state.json` 或设置页。

## 平台能力

| 平台 | 发现 | 自动入库 | 说明 |
| --- | --- | --- | --- |
| Epic Games | 官方 `freeGamesPromotions` 接口 | 无头 Edge 打开商店页，点 Get / Place Order | 遇到验证码会保留链接并标记「需手动」 |
| GOG | 领取接口本身 | `GET /giveaway/claim` | 没有独立列表接口；只有正在进行的 giveaway 才会被领到 |
| Steam | 搜索免费特惠 + `appdetails` | `addfreelicense` | 只处理 Free to Keep；免费周末会跳过 |

## 登录方式

在「设置 → 喜加一」里先选「登录浏览器」：

- **自动（优先 Chrome）**：装了就开 Chrome，没装就用 Edge。
- **Chrome** / **Edge**：指定用哪个；没装的选项会置灰。

然后点平台卡片里的「打开 Chrome 登录」/「打开 Edge 登录」。会弹出一个正常（非无头）浏览器窗口，手动完成账号密码、邮箱验证码或二次验证。插件每 2 秒检查一次登录 Cookie：

- 检测到有效登录后，自动把 Cookie 写进 DSH credentials，并关闭窗口。
- 用户在窗口里关掉或 10 分钟没完成，会提示重新登录。
- 登录中可点「取消登录」，立即关掉窗口。

每个平台使用独立浏览器 profile：`$DSH_HOME/free-games-claimer/browser/<platform>/`。Cookie 只通过 `ctx.credentials.modifyRecord` 写入 DSH 凭据库。

## 安装

从 [Releases](https://github.com/az1hA/dsh-free-game-claimer/releases) 下载 `dsh-free-game-claimer-*.tgz`，然后：

```text
plugin_manager action=install_bundle target=<tgz 的绝对路径>
```

也可以直接用本地目录安装（链接 checkout）：

```text
plugin_manager action=install_bundle target=<此目录的绝对路径>
```

插件依赖 `playwright-core`，登录和 Epic 自动领取都复用系统 Chrome/Edge，不需要额外下载浏览器。

## 开发

```bash
npm ci
npm run check
npm pack
```

`npm run check` 会校验 `package.json`、`cordis.patch.yml`、导出、依赖和所有 JS 语法；CI 在 Ubuntu（Node 22 / 24）和 Windows（Node 22）上跑同一套检查。

发布新版本：

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.2.5"
git tag v0.2.5
git push origin main --tags
```

推送 `v*` tag 会触发 Release workflow：重新检查、`npm pack`，并把 tgz 作为 GitHub Release 附件。

数据目录：`$DSH_HOME/free-games-claimer/`（`state.json`、`duty.log`、`browser/<platform>/`）。

## 已知限制

- Epic 的领取接口需要 OAuth + accountId，网页 GraphQL 又受 Cloudflare 保护，所以自动领取走浏览器，成功率取决于页面结构和验证码。
- GOG 的活动不定期，且没有公开列表接口；没有活动时显示「当前没有活动」。
- Steam 的免费周末不是入库游戏，插件会跳过。
- Epic 页面显示「In Library」时会单独标成「在库中」，不计入入库数，也不会再标「待手动」。
- 任何平台都不保证 100% 自动；失败时保留商店链接，方便手动完成。
- 本插件不会进行任何支付操作，只针对 0 元入库。

## License

MIT