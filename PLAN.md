# Implementation plan: `dsh-plugin-browser`

A flagship community **browser-automation tool plugin** for DeepSeek Harness (`dsh`).
It registers model-facing browser tools into the `ctx.tools` seam, backed by
Chromium via `playwright-core`. The differentiator is a **security-first
navigation policy** re-checked on every action (host-label allowlist +
private-network block), which is the defense against the `allowed_domains`
bypass class (host substring matching, redirect escape) seen in other browser
agents.

This document is the complete spec. Three modules are already drafted as a
working starting point (`src/policy.ts`, `src/session.ts`,
`src/playwright-backend.ts`); treat them as review-and-complete, not sacred.
Everything else is to be built.

---

## 0. Ground rules (dsh contracts to honor)

Read these upstream references before coding; the plugin must obey them:

- Tool authoring: `docs/cookbook/adding-a-tool.md` in the dsh repo (clone at
  `~/git_projects/deepseek-harness`, pinned commit `47f9438`). Reference impls:
  `packages/web/tool-web` (two tools, one seam), `packages/terminal/tool-terminal`
  (six owner-isolated tools), `packages/shell/tool-bash` (background jobs).
- `defineTool` from `@deepseek-ai/dsh-tools`: args are validated against the
  schema before `execute` runs; `execute` returns ONE canonical JSON value the
  registry snapshots/validates/freezes; throwing or an invalid value ⇒ `isError`;
  honor `exec.signal`; `exec.agent`/`exec.token`/`exec.callId` are immutable.
- **Registrations are effects**: register through `ctx.tools.register(...)` and
  return/rely on the disposer; the browser session is torn down when the plugin
  fiber unloads.
- Render presenters (`presentCall`/`presentResult`) MUST be pure functions of
  args (+result): no I/O, no clock, no session reads — they run on replay too.
- Ship as a **dsh bundle** (`dsh.bundle.patch` → `cordis.patch.yml`) so
  `dsh plugin --profile web add dsh-plugin-browser` inserts the row.
- Testing policy ("verify the world, not the self-report"): keyless unit tests
  are the gate; a live smoke self-skips without a browser. Every security rule
  gets a fail-before test (introduce the regression, watch red, revert).
- Bilingual README with a `## Model Experience` section (What the model sees /
  Token effect / KV Cache effect) and `## Known Limitations and Deferred Work`.

The reference for the whole methodology is the study repo
`github.com/coderdailyone/deepseek-harness-study` (notes 05/06/08/10 are the
most relevant: jobs, seams, sandbox/policy, testing).

---

## 1. Package shape

```
dsh-plugin-browser/
├── package.json            # dsh.bundle + peer/runtime deps + publishConfig
├── tsconfig.json           # NodeNext, strict, exactOptionalPropertyTypes
├── cordis.patch.yml        # inserts the browser tool row
├── LICENSE                 # MIT
├── README.md / README.zh.md
├── PLAN.md                 # this file (drop before publish or move to docs/)
├── src/
│   ├── policy.ts           # DRAFTED — navigation policy (the security core)
│   ├── session.ts          # DRAFTED — BrowserSession over a BrowserBackend iface
│   ├── playwright-backend.ts # DRAFTED — lazy playwright-core Chromium backend
│   ├── tool.ts             # NEW — defineTool registrations + owner session registry
│   └── index.ts            # NEW — plugin name/inject/Config/apply
└── tests/
    ├── policy.spec.ts      # NEW — exhaustive, the security gate
    ├── session.spec.ts     # NEW — stub backend, no real browser
    ├── tool.spec.ts        # NEW — stub ctx, registration + owner isolation
    └── live.spec.ts        # NEW — real Chromium, self-skips
```

### package.json essentials

- `"name": "dsh-plugin-browser"`, `"version": "0.1.0"`, `"type": "module"`.
- `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
- `peerDependencies`: `@deepseek-ai/cordis` `^4.0.1`, `@deepseek-ai/dsh-tools`
  `0.0.1-rc.1` (pin to currently-published rc), `@deepseek-ai/schemastery`
  `^3.18.1`.
- `dependencies`: `playwright-core` `^1.62.0` (NOT `playwright` — we do not want
  its postinstall browser download; the user supplies a Chromium via
  `executablePath` or an already-installed Playwright browser).
- `devDependencies`: the three peers + `@types/node@^24` + `typescript@^5.9` +
  `vitest@^3.2`.
- `"engines": { "node": "^22.19.0 || >=24.0.0" }`.
- `"publishConfig": { "registry": "https://registry.npmjs.org/", "access": "public" }`.
- `"keywords": ["dsh-plugin","deepseek-harness","dsh","browser","playwright","automation","agent"]`.
- `"files": ["lib","src","cordis.patch.yml","README.md","README.zh.md"]`.
- scripts: `build: tsc`, `test: vitest run`, `prepublishOnly: npm run build && npm run test`.

---

## 2. Tool surface (model-facing design)

Follow the tool-terminal precedent: **several small, owner-isolated tools**, not
one mega-tool with an action union. Each has distinct args and a clear canonical
return. v1 tools:

| Tool | Args | Canonical return | Notes |
|---|---|---|---|
| `browser_navigate` | `url: string (required)` | `{ url, title, statusCode?, text, truncated }` | Opens the page lazily on first call; returns landed URL + extracted text |
| `browser_click` | `selector: string (required)` | `{ url, title, text, truncated }` | CSS selector; re-checks landed URL vs policy |
| `browser_fill` | `selector: string (required)`, `value: string (required)` | `{ url, title }` | Fill a form field |
| `browser_read_text` | *(none)* | `{ url, title, text, truncated }` | Re-extract current page text (after JS/interaction) |
| `browser_close` | *(none)* | `{ closed: true }` | Idempotent teardown of the owner's session |

Design rules:

- **Canonical return is a programmatic API** (Code Mode reaches these for free):
  return `url`/`title`/`statusCode`/`text`/`truncated` as fields, not prose.
  `output.render` writes the human-facing text (title, URL, a bounded text
  excerpt, a truncation note). Keep the model-facing text excerpt inside
  `maxTextChars`.
- **Owner isolation**: keep a `Map<SessionId, BrowserSession>` keyed by
  `exec.agent.session.id` (see tool-terminal's owner-scoped registry). A tool
  call resolves-or-creates the caller's session. Disposing the plugin fiber
  closes every session (await all closes).
- **Serialize per owner**: one page is not concurrency-safe. Queue calls per
  owner (a simple per-session promise chain / async mutex) so overlapping model
  calls run in submission order. Document this as intended (mirrors a human
  driving one tab).
- **Render intent** (pure): `presentCall(args)` → `{ card: 'generic', kind:
  'globe' or 'search', title: '<action> <url-or-selector>', rawInput }`.
  `presentResult` → generic with the bounded text/title. No `locations` (no file
  touched). No `terminal`/`diff` card.
- **exec.signal**: Playwright ops take a `timeout` but no AbortSignal. On
  `exec.signal` abort, best-effort: race the op against the signal and, on abort,
  surface `BROWSER_ABORTED`; the page/browser may still settle its op — acceptable
  for v1, note it. (Do NOT kill the shared browser on one call's cancel.)
- **Errors**: throw `BrowserError(code)` from session ops; the tool maps them to
  `isError` results with a model-readable message. Codes already drafted:
  `BROWSER_INVALID_URL`, `BROWSER_UNSUPPORTED_SCHEME`, `BROWSER_PRIVATE_NETWORK`,
  `BROWSER_HOST_NOT_ALLOWED`, `BROWSER_LAUNCH_FAILED`, `BROWSER_NAVIGATION_FAILED`,
  `BROWSER_ACTION_FAILED`, `BROWSER_NO_PAGE`, `BROWSER_CLOSED`. Add
  `BROWSER_ABORTED`.

Deferred (NOT in v1; list in Known Limitations): screenshots, accessibility-tree
snapshot, downloads, cookie/auth persistence, multi-tab, `run_in_background` via
`ctx.jobs`, PDF, file upload.

---

## 3. Configuration (schematery, all optional)

```
Config {
  allowedHosts?: string[]         // host-label allowlist; empty ⇒ any public host
  allowPrivateNetwork?: boolean   // default false — blocks loopback/private/link-local/CGNAT
  headless?: boolean              // default true
  executablePath?: string         // explicit Chromium; else playwright-core resolution / $DSH_BROWSER_EXECUTABLE
  userAgent?: string              // default a stable "dsh-plugin-browser/<version>" UA
  navigationTimeoutMs?: number    // default 30000, positive int
  actionTimeoutMs?: number        // default 15000, positive int
  maxTextChars?: number           // default 20000, positive int
}
```

- Env fallbacks: `executablePath` ← `$DSH_BROWSER_EXECUTABLE`. Do not read
  secrets. Validate positives at load (schema `.step(1).min(1)`), fail loud on
  bad config (dsh convention).
- The resolved policy handed to `BrowserSession` is
  `{ allowedHosts: allowedHosts ?? [], allowPrivateNetwork: allowPrivateNetwork ?? false }`.

---

## 4. Security requirements (the flagship value — non-negotiable)

1. **Every navigation AND every post-interaction URL is policy-checked.** After
   `navigate`/`click`, re-read `page.url()` and re-run `evaluateUrl`; a redirect
   or JS navigation that crosses into a disallowed host is refused
   (`BROWSER_HOST_NOT_ALLOWED`). This is drafted in `session.ts` — keep it.
2. **Allowlist matches on host labels, never substring.** `hostMatches` compares
   against the parsed `URL.hostname`: `example.com` matches `example.com` and
   `*.example.com` only. `example.com.evil.test`, `evil-example.com`, and
   `evil.test/?x=example.com` MUST NOT match. This is exactly the browser-use
   GHSA bug class; it must have dedicated fail-before tests.
3. **Private/loopback/link-local/CGNAT literals blocked by default.**
   `isPrivateHost` covers `localhost`/`*.localhost`, IPv4 `10/8 127/8 0/8
   192.168/16 169.254/16 172.16-31 100.64-127`, IPv6 `::1 :: fc.. fd.. fe80:`.
   Only `allowPrivateNetwork: true` permits them.
4. **Only `http`/`https` navigable.** `file:`, `data:`, `javascript:`, `chrome:`
   etc. refused by scheme.
5. **Honest residual**: DNS rebinding (a public name resolving to a private IP)
   is NOT defended here — literal-authority classification only, same posture as
   the dsh fetch seam. State this plainly in Known Limitations; do not claim a
   guarantee the code does not provide.

The whole of `policy.ts` is the security core. Its test file is the acceptance
gate for the plugin's headline claim.

---

## 5. Testing plan (dsh policy)

- **`policy.spec.ts` (the gate, exhaustive):**
  - `hostMatches`: exact, subdomain, leading-dot pattern, and the lookalike
    negatives (`example.com.evil.test`, `evil-example.com`, trailing-dot,
    empty pattern). Fail-before: replace `endsWith('.'+p)` with `includes(p)` →
    lookalike tests go red.
  - `isPrivateHost`: each range true, public IPs and names false, IPv6 literals.
  - `evaluateUrl`: invalid URL, each scheme rejection, private block on/off,
    allowlist empty vs populated, and the return-shape (`url`/`host`).
  - `describeDenial`: one assertion per kind (closed union).
- **`session.spec.ts` (stub `BrowserBackend`, no real browser):**
  - Redirect re-check: stub `page.url()` returns an off-allowlist host after
    `goto` ⇒ `navigate` rejects `BROWSER_HOST_NOT_ALLOWED` even though the
    requested URL was allowed. (Critical test.)
  - Lazy launch (no page until first navigate), `requirePage` guard on
    click/fill/read before navigate, error taxonomy for launch/goto/action
    failures with preserved `cause`, text truncation at `maxTextChars` with the
    `truncated` flag, `close()` idempotence and await, and closing-state guard.
- **`tool.spec.ts` (stub ctx capturing registrations):**
  - All five tools register; names and `inject: ['tools']`; config schema
    accepts/rejects; owner isolation (two different `exec.agent.session.id`
    values get two sessions; same id reuses one); canonical return shapes;
    `presentCall`/`presentResult` purity (call twice, deep-equal; no I/O).
  - `browser_navigate` maps a policy denial from the session into an `isError`
    result (not a throw out of the tool).
- **`live.spec.ts` (real Chromium, `describe.skipIf`):** skip unless a browser is
  resolvable (env `DSH_BROWSER_LIVE=1` and an executable found). Navigate to
  `https://example.com`, assert title contains "Example Domain" and text
  non-empty; assert a `browser_navigate` to `http://127.0.0.1:1/` rejects
  `BROWSER_PRIVATE_NETWORK`; assert a real cross-origin redirect to a
  non-allowlisted host rejects when an allowlist is set. Self-skip is a
  capability fact, not a cost signal.

Use a loopback/stub pattern like the Tavily plugin's HTTP double where a real
network is needed; prefer the stub `BrowserBackend` for everything except the
live smoke.

---

## 6. README (bilingual, both files)

- Install (`dsh plugin --profile web add dsh-plugin-browser`), the
  `--dump-config` verify line, and that a Chromium is required (bring your own
  via `executablePath`/`$DSH_BROWSER_EXECUTABLE`, or an installed Playwright
  browser).
- Config table (section 3).
- Behavior: the five tools, owner isolation, per-owner serialization, text
  extraction bound.
- **Security section** front-and-center: the continuous re-check, host-label
  matching (with the lookalike examples), private-network default block, scheme
  restriction — and the honest DNS-rebinding residual.
- `## Model Experience`: What the model sees (bounded page text + url/title; the
  tool names), Token effect (each read returns up to `maxTextChars`; tune it),
  KV Cache effect (results are ordinary tool results; no prompt-prefix change).
- `## Known Limitations and Deferred Work`: DNS rebinding not defended; no
  screenshots/a11y-snapshot/downloads/cookies/multi-tab/background jobs in v1;
  `playwright-core` needs a browser binary present; dsh is developer preview so
  expect lockstep peer bumps.
- License MIT.

---

## 7. Publish

- `npm run build && npm run test` green; live smoke run once locally with a real
  Chromium (this machine has `/usr/bin/google-chrome-stable` and a Playwright
  Chromium under `~/.cache/ms-playwright/chromium-1234`).
- Verify end-to-end against the local dsh checkout:
  `pnpm dsh plugin --profile web add <path>` → `--dump-config` shows the
  `# == dsh-plugin-browser` layer → the web profile boots.
- `npm publish` (registry pinned in `publishConfig`; account `codemycookieday`,
  granular token with bypass-2fa already configured on this machine).
- GitHub repo `coderdailyone/dsh-plugin-browser`, public, topics
  `dsh-plugin deepseek-harness playwright browser`.
- Follow-up: reply in dsh Discussions #1547 (Show & Tell) linking the plugin.

---

## 8. Acceptance criteria (all must hold)

1. `dsh plugin --profile web add dsh-plugin-browser` inserts the bundle layer and
   the web profile boots with the five browser tools visible in `--dump-config`.
2. With `allowedHosts: ['example.com']`, `browser_navigate` to
   `https://example.com` succeeds and returns page text; to
   `https://evil.example.com.attacker.test` it is refused `BROWSER_HOST_NOT_ALLOWED`.
3. A navigation that redirects to an off-allowlist host is refused even though
   the requested URL was allowed (session.spec proves it with a stub; live.spec
   proves it real).
4. `browser_navigate` to a `127.0.0.1`/`localhost`/`file:` target is refused by
   default; enabling `allowPrivateNetwork` permits the private host (but not the
   `file:` scheme).
5. Two agents (distinct session ids) get isolated browser sessions; disposing the
   plugin closes all sessions.
6. `npm test` passes keyless; `live.spec` self-skips without a browser and passes
   with one. Every security rule has a fail-before test.
7. Bilingual README present with Model Experience + Known Limitations; the
   DNS-rebinding residual is disclosed.

---

## 9. Open decisions for the human (answer before or during impl)

1. **Tool granularity** — plan recommends five small tools (tool-terminal
   precedent). Alternative: one `browser` tool with an `action` union. Pick one.
2. **v1 scope of "read"** — plain `innerText` extraction (planned) vs. an
   accessibility-tree/DOM-snapshot for more reliable selectors. Snapshot is more
   powerful but heavier; recommend shipping `innerText` in v1 and snapshot in
   0.2.
3. **Background navigation via `ctx.jobs`** — long page loads could register as
   background jobs (like tool-bash). Recommend NOT in v1 (foreground, timeout-
   bounded) to keep the surface small; revisit if users ask.
4. **Screenshots** — high demand but needs an image/attachment path
   (`ctx.attachments`) and a route-capable model. Defer to a later minor.

Defaults if unanswered: five tools, `innerText` read, foreground only, no
screenshots.
