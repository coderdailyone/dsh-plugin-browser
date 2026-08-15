/**
 * `dsh-plugin-browser-use`: browser-automation tools for the DeepSeek Harness.
 * Registers five model-facing tools (`browser_navigate`, `browser_click`,
 * `browser_fill`, `browser_read_text`, `browser_close`) into `ctx.tools`,
 * backed by Chromium through `playwright-core`. The differentiator is a
 * security-first navigation policy (host-label allowlist + private-network
 * block) re-checked on every action, not once at open.
 * @module dsh-plugin-browser-use
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { PlaywrightBackend } from './playwright-backend.js'
import { BrowserSession } from './session.js'
import { BrowserSessions, createBrowserTools } from './tool.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-plugin-browser-use'

/** Services required by the browser tool suite. */
export const inject = ['tools']

/** Plugin version stamped into the default User-Agent. Keep in lockstep with package.json. */
const VERSION = '0.2.1'

/** Default bound on one returned page text (the `maxTextChars` config). */
export const DEFAULT_MAX_TEXT_CHARS = 20_000

/** Default navigation timeout (the `navigationTimeoutMs` config). */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

/** Default click/fill/read timeout (the `actionTimeoutMs` config). */
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000

export const Config = z.object({
  allowedHosts: z.array(z.string()).default([]).description('Allowed host patterns (empty = any public host). "example.com" matches example.com and its subdomains; matching is on host labels, never substrings.'),
  allowPrivateNetwork: z.boolean().default(false).description('Permit loopback/private/link-local http(s) targets. Default false.'),
  headless: z.boolean().default(true).description('Run Chromium without a visible window. Default true.'),
  executablePath: z.string().description('Explicit Chromium executable. Falls back to $DSH_BROWSER_EXECUTABLE, then Playwright resolution.'),
  userAgent: z.string().description('User-Agent for the browser context. Defaults to "dsh-plugin-browser-use/<version>".'),
  proxyServer: z.string().description('Proxy for browser traffic, e.g. "http://127.0.0.1:7890" or "socks5://127.0.0.1:1080". Chromium ignores $http_proxy-style env vars, so set this (or $DSH_BROWSER_PROXY) when the machine needs a proxy. Unset = direct connection.'),
  proxyBypass: z.string().description('Comma-separated hosts that bypass the proxy, e.g. "localhost,127.0.0.1".'),
  navigationTimeoutMs: z.number().step(1).min(1).default(DEFAULT_NAVIGATION_TIMEOUT_MS).description('Navigation timeout in milliseconds. Default 30000.'),
  actionTimeoutMs: z.number().step(1).min(1).default(DEFAULT_ACTION_TIMEOUT_MS).description('Click/fill/read timeout in milliseconds. Default 15000.'),
  maxTextChars: z.number().step(1).min(1).default(DEFAULT_MAX_TEXT_CHARS).description('Upper bound on returned page text, in characters. Default 20000.'),
  artifactsDir: z.string().description('Directory for screenshots/PDFs. The plugin names every file itself; models never supply paths. Default: a private per-session directory under the OS temp dir.'),
})

type ResolvedConfig = ReturnType<typeof Config>

/** Fail loud on config the schema DSL cannot express (plan: dsh convention). */
function assertValidConfig(config: ResolvedConfig): void {
  for (const [key, value] of [
    ['navigationTimeoutMs', config.navigationTimeoutMs],
    ['actionTimeoutMs', config.actionTimeoutMs],
    ['maxTextChars', config.maxTextChars],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`dsh-plugin-browser-use: ${key} must be a positive integer`)
  }
  if (config.allowedHosts.some(pattern => pattern.trim().length === 0)) {
    throw new Error('dsh-plugin-browser-use: allowedHosts entries must be non-empty host labels')
  }
}

/**
 * Register the five browser tools and the fiber-scoped teardown that closes
 * every owner session when the enclosing plugin fiber unloads. Both the
 * tool registrations and the `ctx.effect` disposer are effect-scoped.
 */
export function registerBrowserTools(
  ctx: Context,
  registry: BrowserSessions,
  options: Parameters<typeof createBrowserTools>[1],
): void {
  for (const tool of createBrowserTools(registry, options)) {
    ctx.tools.register(tool)
  }
  ctx.effect(() => () => registry.closeAll())
}

/**
 * Compose the plugin: resolve config, build the Playwright backend and the
 * owner-isolated session registry, and register the tool surface with its
 * fiber-scoped teardown.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  assertValidConfig(config)
  const resolved = {
    policy: {
      allowedHosts: config.allowedHosts ?? [],
      allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    },
    headless: config.headless ?? true,
    executablePath: config.executablePath ?? process.env.DSH_BROWSER_EXECUTABLE,
    userAgent: config.userAgent ?? `dsh-plugin-browser-use/${VERSION}`,
    navigationTimeoutMs: config.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    actionTimeoutMs: config.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    maxTextChars: config.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
  }
  const backend = new PlaywrightBackend({
    headless: resolved.headless,
    ...resolved.executablePath !== undefined ? { executablePath: resolved.executablePath } : {},
    userAgent: resolved.userAgent,
    ...config.proxyServer !== undefined ? { proxyServer: config.proxyServer } : {},
    ...config.proxyBypass !== undefined ? { proxyBypass: config.proxyBypass } : {},
  })
  const registry = new BrowserSessions(() =>
    new BrowserSession(backend, {
      policy: resolved.policy,
      navigationTimeoutMs: resolved.navigationTimeoutMs,
      actionTimeoutMs: resolved.actionTimeoutMs,
      maxTextChars: resolved.maxTextChars,
      ...config.artifactsDir !== undefined ? { artifactsDir: config.artifactsDir } : {},
    }),
  )
  registerBrowserTools(ctx, registry, {
    backend,
    policy: resolved.policy,
    navigationTimeoutMs: resolved.navigationTimeoutMs,
    actionTimeoutMs: resolved.actionTimeoutMs,
    maxTextChars: resolved.maxTextChars,
  })
}
