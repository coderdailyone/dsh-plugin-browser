# dsh-plugin-browser

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that gives the model five real-browser tools — navigate, click, fill, read text, close — backed by Chromium through `playwright-core`.

Its differentiator is a **security-first navigation policy**: every URL is re-checked against a host-label allowlist and a private-network block **on every action and again after every navigation** — including redirects and link clicks.

[中文文档](./README.zh.md)

## Install

```bash
dsh plugin --profile web add @codemycookieday/dsh-plugin-browser
dsh --profile web --dump-config   # should show the "# == dsh-plugin-browser" layer
```

A Chromium is required. The plugin resolves one in this order:

1. `executablePath` config
2. `$DSH_BROWSER_EXECUTABLE`
3. Well-known OS locations (Chrome / Chromium / Edge / Brave)
4. Playwright's own browser resolution (`npx playwright install chromium`)

## Configuration

| key | type | default | meaning |
| --- | --- | --- | --- |
| `allowedHosts` | `string[]` | `[]` | Host-label allowlist. `example.com` matches `example.com` and `*.example.com`; matching is on host labels, never substrings. Empty = any public host. |
| `allowPrivateNetwork` | `boolean` | `false` | Permit loopback / private / link-local targets. Off by default. |
| `headless` | `boolean` | `true` | Run without a window. |
| `executablePath` | `string` | — | Explicit Chromium binary. Falls back to `$DSH_BROWSER_EXECUTABLE`, OS locations, then Playwright. |
| `userAgent` | `string` | `dsh-plugin-browser/<version>` | User-Agent for the browser context. |
| `navigationTimeoutMs` | `int ≥ 1` | `30000` | Page-load budget per navigation. |
| `actionTimeoutMs` | `int ≥ 1` | `15000` | Budget per click / fill / read. |
| `maxTextChars` | `int ≥ 1` | `20000` | Hard bound on extracted page text. |

## The five tools

| tool | model-facing result |
| --- | --- |
| `browser_navigate` | `{ url, title, statusCode, text, truncated }` of the landed page |
| `browser_click` | `{ url, title }` after the click's navigation settles |
| `browser_fill` | `{ url, title }` after filling a field |
| `browser_read_text` | `{ url, title, text, truncated }` re-read of the current page |
| `browser_close` | `{ closed: true }` — idempotent |

Each agent session owns an isolated browser; calls from one owner are serialized in submission order. All failures surface as ordinary `isError` tool results with a `BROWSER_*` code (never a thrown exception), e.g. `BROWSER_HOST_NOT_ALLOWED`, `BROWSER_PRIVATE_NETWORK`, `BROWSER_NO_PAGE`, `BROWSER_NAVIGATION_FAILED`, `BROWSER_ACTION_FAILED`, `BROWSER_LAUNCH_FAILED`, `BROWSER_CLOSED`, `BROWSER_ABORTED`, `BROWSER_UNSUPPORTED_SCHEME`, `BROWSER_INVALID_URL`.

## Security model

- **Continuous re-check.** The policy runs before every action, and again after every navigation — `browser_navigate` checks the *landed* URL, so a redirect (or a link click) that crosses into a disallowed host is refused even when the requested URL was allowed.
- **Host-label matching, never substrings.** `allowedHosts: ["example.com"]` matches `example.com` and `sub.example.com` but **not** `evil-example.com` or `evil.example.com.attacker.test`.
- **Private networks blocked by default.** Loopback, private, link-local, unique-local, and IPv4-mapped spellings (`127.0.0.1`, `10.0.0.5`, `::1`, `::ffff:127.0.0.1`, `fc00::/7` hex forms, …) are refused unless `allowPrivateNetwork` is explicitly enabled — and when an allowlist is set, private hosts must be on it too.
- **Canonical host comparison.** Case, trailing dots, and IPv6 brackets are normalized before comparison; anything unparseable fails closed.
- **Scheme restriction.** Only `http:` and `https:` navigate; `file:`, `data:`, `javascript:`, and other schemes are refused outright.
- **Honest residual: DNS rebinding is not defended.** A hostname that resolves from public to private IPs between the check and the connection can still reach internal services. If that matters in your environment, run the harness in a network-isolated sandbox; do not rely on this plugin alone.

## Model Experience

**What the model sees:** five tool names (`browser_navigate`, `browser_click`, `browser_fill`, `browser_read_text`, `browser_close`); navigation and reads return the landed URL, title, HTTP status (navigation only), and bounded visible text — no screenshots, DOM dumps, or cookies.

**Token effect:** each `browser_navigate` / `browser_read_text` returns up to `maxTextChars` (default 20,000) characters of page text; shrink it for cheaper sessions, grow it for dense pages. `browser_click` / `browser_fill` return only URL + title.

**KV cache effect:** none — results are ordinary tool results appended to the conversation; nothing rewrites the prompt prefix.

## Known limitations and deferred work

- DNS rebinding not defended (see above).
- No screenshots, accessibility snapshots, downloads, cookie access, multi-tab, or background jobs in v1.
- `playwright-core` needs a browser binary present (see Install).
- dsh is a developer preview; expect lockstep peer-version bumps.

## Development

```bash
npm install
npm run build    # tsc → lib/
npm test         # vitest run (58 tests; live smoke self-skips)
```

The live smoke suite runs a real Chromium when `DSH_BROWSER_LIVE=1` and a browser resolves (set `DSH_BROWSER_EXECUTABLE` to pin one):

```bash
DSH_BROWSER_LIVE=1 npm test
```

Layout: `src/policy.ts` (pure URL policy) → `src/session.ts` (browser session, per-action re-checks) → `src/tool.ts` (dsh tool definitions, owner registry) → `src/index.ts` (plugin entry).

## License

MIT
