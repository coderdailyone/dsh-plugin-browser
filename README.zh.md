# dsh-plugin-browser

一个 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件：通过 `playwright-core` 驱动 Chromium，为模型提供五个真实浏览器工具 —— 导航、点击、填充、读文本、关闭。

差异化价值是**安全优先的导航策略**：每一个 URL 都会在**每次操作前、每次导航落地后**重新校验 —— 主机标签白名单 + 私有网络拦截，重定向和链接点击同样覆盖。

[English](./README.md)

## 安装

```bash
dsh plugin --profile web add dsh-plugin-browser
dsh --profile web --dump-config   # 应能看到 "# == dsh-plugin-browser" 补丁层
```

需要一个 Chromium，按以下顺序解析：

1. 配置项 `executablePath`
2. 环境变量 `$DSH_BROWSER_EXECUTABLE`
3. 操作系统常见安装位置（Chrome / Chromium / Edge / Brave）
4. Playwright 自带浏览器（`npx playwright install chromium`）

## 配置

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `allowedHosts` | `string[]` | `[]` | 主机标签白名单。`example.com` 匹配 `example.com` 与 `*.example.com`；按主机标签匹配，绝不按子串。空 = 任意公共主机。 |
| `allowPrivateNetwork` | `boolean` | `false` | 是否放行环回 / 私有 / 链路本地地址。默认关闭。 |
| `headless` | `boolean` | `true` | 无窗口运行。 |
| `executablePath` | `string` | — | 显式指定 Chromium 路径。回退顺序：`$DSH_BROWSER_EXECUTABLE` → 系统常见位置 → Playwright。 |
| `userAgent` | `string` | `dsh-plugin-browser/<版本>` | 浏览器上下文的 User-Agent。 |
| `navigationTimeoutMs` | `≥1 整数` | `30000` | 每次导航的加载预算。 |
| `actionTimeoutMs` | `≥1 整数` | `15000` | 每次点击 / 填充 / 读取的预算。 |
| `maxTextChars` | `≥1 整数` | `20000` | 提取页面文本的硬上限。 |

## 五个工具

| 工具 | 模型看到的结果 |
| --- | --- |
| `browser_navigate` | 落地页的 `{ url, title, statusCode, text, truncated }` |
| `browser_click` | 点击导航落定后的 `{ url, title }` |
| `browser_fill` | 填充字段后的 `{ url, title }` |
| `browser_read_text` | 当前页面的 `{ url, title, text, truncated }` |
| `browser_close` | `{ closed: true }` —— 幂等 |

每个 agent 会话拥有独立浏览器；同一 owner 的调用按提交顺序串行。所有失败都以普通 `isError` 工具结果返回（绝不抛出异常），带 `BROWSER_*` 错误码，例如 `BROWSER_HOST_NOT_ALLOWED`、`BROWSER_PRIVATE_NETWORK`、`BROWSER_NO_PAGE`、`BROWSER_NAVIGATION_FAILED`、`BROWSER_ACTION_FAILED`、`BROWSER_LAUNCH_FAILED`、`BROWSER_CLOSED`、`BROWSER_ABORTED`、`BROWSER_UNSUPPORTED_SCHEME`、`BROWSER_INVALID_URL`。

## 安全模型

- **持续复查。** 策略在每次操作前执行、并在每次导航后再次执行 —— `browser_navigate` 校验的是**落地 URL**，因此即使请求 URL 合法，重定向（或链接点击）跨入未授权主机也会被拒绝。
- **主机标签匹配，绝不子串匹配。** `allowedHosts: ["example.com"]` 匹配 `example.com` 和 `sub.example.com`，但**不**匹配 `evil-example.com` 或 `evil.example.com.attacker.test`。
- **默认拦截私有网络。** 环回、私有、链路本地、ULA 及 IPv4 映射写法（`127.0.0.1`、`10.0.0.5`、`::1`、`::ffff:127.0.0.1`、`fc00::/7` 十六进制形式等）默认拒绝，除非显式开启 `allowPrivateNetwork` —— 且设置了白名单时，私有主机也必须名列其中。
- **规范化主机比较。** 大小写、尾部点号、IPv6 方括号在校验前统一归一化；无法解析的一律拒绝（fail-closed）。
- **协议白名单。** 仅允许 `http:` / `https:` 导航；`file:`、`data:`、`javascript:` 等一律拒绝。
- **诚实的残留风险：不防御 DNS rebinding。** 若一个主机名在校验与建连之间从公共 IP 解析到私有 IP，仍可能触达内网。如果你的环境在意这一点，请把 harness 放进网络隔离沙箱运行，不要只依赖本插件。

## 模型体验

**模型看到什么：** 五个工具名（`browser_navigate`、`browser_click`、`browser_fill`、`browser_read_text`、`browser_close`）；导航与读取返回落地 URL、标题、HTTP 状态（仅导航）和有界的可见文本 —— 没有截图、DOM 转储或 Cookie。

**Token 效应：** 每次 `browser_navigate` / `browser_read_text` 最多返回 `maxTextChars`（默认 20,000）字符页面文本；调小更省，调大适配密集页面。`browser_click` / `browser_fill` 只返回 URL + 标题。

**KV 缓存效应：** 无 —— 结果都是普通工具结果，追加在对话尾部；不改写提示前缀。

## 已知限制与后续工作

- 不防御 DNS rebinding（见上）。
- v1 没有截图、无障碍快照、下载、Cookie 访问、多标签页或后台任务。
- `playwright-core` 需要本机存在浏览器二进制（见安装）。
- dsh 处于开发者预览阶段，peer 版本可能需要同步升级。

## 开发

```bash
npm install
npm run build    # tsc → lib/
npm test         # vitest run（58 个测试；live 冒烟默认自跳过）
```

设置 `DSH_BROWSER_LIVE=1` 且能解析到浏览器时（可用 `DSH_BROWSER_EXECUTABLE` 指定），live 冒烟会驱动真实 Chromium：

```bash
DSH_BROWSER_LIVE=1 npm test
```

代码分层：`src/policy.ts`（纯 URL 策略）→ `src/session.ts`（浏览器会话、逐操作复查）→ `src/tool.ts`（dsh 工具定义、owner 注册表）→ `src/index.ts`（插件入口）。

## 许可证

MIT
