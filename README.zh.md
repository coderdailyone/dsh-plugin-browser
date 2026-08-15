# dsh-plugin-browser-use

一个 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件,给模型一个真实浏览器——导航、点击、填表、读取、截图、多标签、下载——底层是 `playwright-core` 驱动的 Chromium。

它的差异化是**安全优先的设计**:每个 URL 在**每次操作前、每次导航落地后**都会重新过一遍 host 标签白名单和私网拦截——重定向、链接点击、弹窗、后台加载、下载全部在内。并且没有任何工具接受模型给出的文件路径:插件写下的每个文件都落在受约束目录里,文件名由插件自己生成。

[English](./README.md)

## 安装

```bash
dsh plugin --profile web add dsh-plugin-browser-use
dsh --profile web --dump-config   # 应能看到 "# == dsh-plugin-browser-use" 配置层
```

需要一个 Chromium。插件按以下顺序解析:

1. `executablePath` 配置
2. `$DSH_BROWSER_EXECUTABLE`
3. 常见系统位置(Chrome / Chromium / Edge / Brave)
4. Playwright 自己的浏览器解析(`npx playwright install chromium`)

## 配置

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `allowedHosts` | `string[]` | `[]` | host 标签白名单。`example.com` 匹配 `example.com` 与 `*.example.com`;按 host 标签匹配,绝不做子串匹配。空 = 任意公网主机。 |
| `allowPrivateNetwork` | `boolean` | `false` | 允许回环/私网/链路本地目标。默认关。 |
| `headless` | `boolean` | `true` | 无窗口运行。 |
| `executablePath` | `string` | — | 显式指定 Chromium。回退到 `$DSH_BROWSER_EXECUTABLE`、系统位置、Playwright。 |
| `userAgent` | `string` | `dsh-plugin-browser-use/<版本>` | 浏览器上下文的 User-Agent。 |
| `proxyServer` | `string` | — | 浏览器流量代理(如 `http://127.0.0.1:7890`、`socks5://…`)。Chromium 不认 `$http_proxy` 类环境变量,需要代理的机器请设置这里(或 `$DSH_BROWSER_PROXY`)。 |
| `proxyBypass` | `string` | — | 逗号分隔的绕过代理主机列表。 |
| `navigationTimeoutMs` | `int ≥ 1` | `30000` | 每次导航的加载预算。 |
| `actionTimeoutMs` | `int ≥ 1` | `15000` | 每次点击/填表/读取/截图的预算。 |
| `maxTextChars` | `int ≥ 1` | `20000` | 提取的页面文本与快照的硬上限。 |
| `artifactsDir` | `string` | 私有临时目录 | 截图/PDF/下载的落盘位置。文件名全部由插件生成。 |
| `storageStatePath` | `string` | — | 关闭时把 Cookie/localStorage 持久化到此文件,启动时加载。文件里是活凭据,注意保护。多 agent 并发时最后关的胜出。 |
| `uploadsDir` | `string` | —(上传禁用) | 只有此目录里的文件可以被上传,且只接受裸文件名。 |

## 工具一览

| 工具 | 模型可见结果 |
| --- | --- |
| `browser_navigate` | 落地页的 `{ url, title, statusCode, text, truncated }` |
| `browser_navigate_background` | `{ jobId, index, url }` —— 在不抢焦点的新标签里作为后台任务加载 |
| `browser_click` | 点击引发的导航稳定后的 `{ url, title, text, truncated }` |
| `browser_fill` | 填表后的 `{ url, title }` |
| `browser_read_text` | 当前页重读 `{ url, title, text, truncated }` |
| `browser_read_snapshot` | `{ url, title, snapshot, truncated }` —— aria 角色/名称大纲,选择器更稳 |
| `browser_screenshot` | `{ path, url, title }` —— PNG 落 `artifactsDir`,插件命名 |
| `browser_pdf` | `{ path, url, title }` —— PDF 落 `artifactsDir`(仅 headless) |
| `browser_downloads` | `{ downloads: [{ index, url, suggestedFilename, state, path?, error? }] }` |
| `browser_upload` | `{ url, title }` —— 把 `uploadsDir` 里的文件附到 `<input type=file>` |
| `browser_tab_new` | `{ index, url, title, statusCode? }` —— 新活动标签,创建前先过策略 |
| `browser_tab_list` | `{ tabs: [{ index, active, url, allowed, title? }] }` |
| `browser_tab_select` | `{ index, url, title }` —— 离策略标签无法被聚焦 |
| `browser_tab_close` | `{ closed: true, remaining }` |
| `browser_close` | `{ closed: true }` —— 关整个浏览器,幂等 |

每个 agent 会话拥有一个隔离浏览器和有序标签列表;同一 owner 的调用按提交顺序串行(`browser_navigate_background` 是有意的例外——它的加载在队列之外进行)。所有失败都以带 `BROWSER_*` 码的普通 `isError` 工具结果呈现(绝不抛异常),如 `BROWSER_HOST_NOT_ALLOWED`、`BROWSER_PRIVATE_NETWORK`、`BROWSER_NO_PAGE`、`BROWSER_NO_SUCH_TAB`、`BROWSER_UPLOAD_NOT_ALLOWED`、`BROWSER_JOBS_UNAVAILABLE`、`BROWSER_NAVIGATION_FAILED`、`BROWSER_ACTION_FAILED`、`BROWSER_LAUNCH_FAILED`、`BROWSER_CLOSED`、`BROWSER_ABORTED`、`BROWSER_UNSUPPORTED_SCHEME`、`BROWSER_INVALID_URL`。

后台加载需要 profile 里有 jobs 注册表(`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`);没有时该工具以 `BROWSER_JOBS_UNAVAILABLE` 关闭失败。任务以 `browser` 类别注册。

## 安全模型

- **持续复查。** 策略在每次操作前运行,每次导航后再运行一次——`browser_navigate` 检查的是*落地* URL,所以跨入被禁主机的重定向(或链接点击)即使请求的 URL 被允许也会被拒。后台加载同样有出发前和落地后双重检查。
- **host 标签匹配,绝不子串。** `allowedHosts: ["example.com"]` 匹配 `example.com` 和 `sub.example.com`,但**不**匹配 `evil-example.com` 或 `evil.example.com.attacker.test`。
- **私网默认拦截。** 回环、私网、链路本地、唯一本地及 IPv4-mapped 各种拼写(`127.0.0.1`、`10.0.0.5`、`::1`、`::ffff:127.0.0.1`、`fc00::/7` 十六进制形式……)默认拒绝,除非显式打开 `allowPrivateNetwork`——且设置了白名单时私网主机也必须在名单内。
- **规范化比较。** 大小写、结尾点、IPv6 方括号在比较前统一规范化;解析不了的一律 fail-closed。
- **scheme 限制。** 只有 `http:` 和 `https:` 可导航;`file:`、`data:`、`javascript:` 等一律拒绝。
- **永远没有模型控制的路径。** 截图、PDF、下载只写进 `artifactsDir`,文件名由插件构建(下载文件名净化为单个安全路径段)。上传只接受操作者配置的 `uploadsDir` 内的裸文件名——分隔符和 `..` 直接拒绝,未配置时该工具整体禁用。
- **弹窗夹带不进来。** 浏览器自己打开的页面进入标签列表但绝不抢焦点;离策略弹窗可以被列出、被关闭,但不能被聚焦、读取或截图——连标题都不会去取。
- **下载同样过策略。** 来自被拒 URL 的下载记录为 `refused`,永不落盘。
- **被圈住的浏览器进程。** 每次启动都有一个 OS 临时目录下的私有 `HOME`/XDG 树(关闭时删除),配置、crashpad、缓存永远碰不到操作者的真实家目录。
- **诚实的残差:DNS rebinding 不设防。** 一个在检查和连接之间从公网 IP 变成私网 IP 的主机名仍可能触达内网服务。同样,跳向被拒主机的重定向虽然挡住了模型,但发现该重定向的那次请求已由浏览器发出。若这些对你的环境重要,请把 harness 跑在网络隔离的沙箱里,不要只依赖本插件。

## 模型体验

**模型看到什么:** 十五个 `browser_*` 工具;导航与读取返回落地 URL、标题、HTTP 状态(仅导航)以及有界的可见文本或 aria 大纲。截图/PDF 返回路径而非图像内容——要给视觉模型看,请配合支持附件的部署。

**Token 影响:** 每次导航/读取/快照最多返回 `maxTextChars`(默认 20,000)字符;省钱调小,密页调大。点击返回一次新读取;填表、标签、产物类工具只返回小而固定的形状。

**KV 缓存影响:** 无——结果是追加到对话的普通工具结果,不改写 prompt 前缀。

## 已知限制与后续工作

- DNS rebinding 不设防;被拒的重定向仍花费一次出站请求(见安全模型)。
- 截图/PDF 存为文件,不作为图像内容返回——接入 `ctx.attachments` 供视觉模型使用是后续工作。
- Cookie 持久化是单个 storage-state 文件:并发 agent 下最后关闭者胜出。
- Playwright 的 `goto` 无法中途打断:取消后台任务只做标记,由导航超时兜底收束。
- `playwright-core` 需要本机有浏览器二进制(见安装)。
- dsh 处于 developer preview,peer 版本需要跟着锁步升级。

## 开发

```bash
npm install
npm run build    # tsc → lib/
npm test         # vitest run(96 个测试;live 冒烟自动跳过)
```

设置 `DSH_BROWSER_LIVE=1` 且能解析到浏览器时,live 冒烟套件驱动真实 Chromium(可用 `DSH_BROWSER_EXECUTABLE` 钉住一个):

```bash
DSH_BROWSER_LIVE=1 npm test
```

代码分层:`src/policy.ts`(纯 URL 策略)→ `src/session.ts`(浏览器会话:标签、产物、下载、逐操作复查)→ `src/tool.ts`(dsh 工具定义、owner 注册表)→ `src/index.ts`(插件入口)。CI 在 Node 22/24 上跑类型检查 + 免密钥套件。

## 许可证

MIT

## 非关联声明

本项目**与 [browser-use](https://github.com/browser-use/browser-use) 项目及公司没有任何关联**,底层通过 `playwright-core` 直接驱动 Chromium,不包含任何 browser-use 代码。
