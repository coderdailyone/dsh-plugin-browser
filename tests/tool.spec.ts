/**
 * The plugin composed into a REAL cordis context with a REAL ToolRuntime (and
 * a stub browser backend): registration, config, owner isolation, canonical
 * returns through the registry pipeline, presenter purity, error mapping, and
 * fiber teardown closing every session.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../src/index.js'
import { registerBrowserTools } from '../src/index.js'
import { BrowserSessions, createBrowserTools, type BrowserToolOptions } from '../src/tool.js'
import { BrowserSession, type BrowserBackend, type BrowserHandle, type PageHandle } from '../src/session.js'
import type { NavigationPolicy } from '../src/policy.js'

/** A recording, fully controllable page double. */
class StubPage implements PageHandle {
  urlValue = 'about:blank'
  titleValue = 'Stub Title'
  textValue = 'page body text'
  gotoCalls: string[] = []
  landOn: string | undefined
  gotoError: unknown
  /** When set, goto hangs until the gate resolves. */
  gotoGate: Promise<void> | undefined

  url(): string {
    return this.urlValue
  }

  async goto(url: string, options: { waitUntil: 'load' | 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null> {
    void options
    this.gotoCalls.push(url)
    if (this.gotoGate !== undefined) await this.gotoGate
    if (this.gotoError !== undefined) throw this.gotoError
    this.urlValue = this.landOn ?? url
    return { status: () => 200 }
  }

  async title(): Promise<string> {
    return this.titleValue
  }

  async click(): Promise<void> {}

  async fill(): Promise<void> {}

  async evaluate<T>(fn: string): Promise<T> {
    void fn
    return this.textValue as T
  }
}

/** Backend double counting launches and closes. */
class StubBackend implements BrowserBackend {
  launchCount = 0
  closeCount = 0
  pages: StubPage[] = []

  async launch(): Promise<BrowserHandle> {
    this.launchCount += 1
    const backend = this
    const page = new StubPage()
    this.pages.push(page)
    return {
      async newPage() {
        return page
      },
      async close() {
        backend.closeCount += 1
      },
    }
  }
}

const allowAll: NavigationPolicy = { allowedHosts: [], allowPrivateNetwork: false }

/** Compose the REAL plugin (Playwright backend, no navigation → no launch). */
async function composePlugin(rawConfig: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = ctx.plugin({ ...plugin, apply: c => plugin.apply(c, plugin.Config(rawConfig)) })
  await fiber
  return { ctx, fiber }
}

/** Compose the tool surface over a stub backend through a disposable fiber. */
async function composeStub(
  policy: NavigationPolicy = allowAll,
  backend: StubBackend = new StubBackend(),
  options: Partial<BrowserToolOptions> = {},
) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const resolved: BrowserToolOptions = {
    backend,
    policy,
    navigationTimeoutMs: 5_000,
    actionTimeoutMs: 5_000,
    maxTextChars: 50,
    ...options,
  }
  const registry = new BrowserSessions(() =>
    new BrowserSession(backend, {
      policy,
      navigationTimeoutMs: resolved.navigationTimeoutMs,
      actionTimeoutMs: resolved.actionTimeoutMs,
      maxTextChars: resolved.maxTextChars,
    }),
  )
  const fiber = ctx.plugin({
    name: 'browser-stub',
    inject: ['tools'],
    apply: c => registerBrowserTools(c, registry, resolved),
  })
  await fiber
  return { ctx, backend, registry, fiber }
}

/** Build a registry execution input with an optional owning agent session. */
let callSequence = 0
function execution(name: string, args: unknown, owner?: string, signal = new AbortController().signal) {
  callSequence += 1
  return {
    callId: `call-${callSequence}`,
    name,
    arguments: args,
    signal,
    ...(owner !== undefined ? { agent: { session: { id: owner } } } : {}),
  } as never as Parameters<ToolRuntime['execute']>[0]
}

/** Flatten a result's model-facing text. */
function resultText(result: { isError: boolean; content: unknown[] }): string {
  return result.content.map(block => ('text' in (block as object) ? (block as { text: string }).text : '')).join('')
}

describe('plugin composition', () => {
  it('registers all five tools with the expected names', async () => {
    const { ctx, fiber } = await composePlugin()
    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const expected of ['browser_navigate', 'browser_click', 'browser_fill', 'browser_read_text', 'browser_close']) {
      expect(names, expected).toContain(expected)
    }
    expect(plugin.inject).toEqual(['tools'])
    expect(plugin.name).toBe('dsh-plugin-browser')
    await fiber.dispose()
  })

  it('Config fills schema defaults and rejects invalid values', () => {
    const defaults = plugin.Config({})
    expect(defaults.allowPrivateNetwork).toBe(false)
    expect(defaults.headless).toBe(true)
    expect(defaults.navigationTimeoutMs).toBe(30_000)
    expect(defaults.actionTimeoutMs).toBe(15_000)
    expect(defaults.maxTextChars).toBe(20_000)
    expect(defaults.allowedHosts).toEqual([])
    expect(() => plugin.Config({ navigationTimeoutMs: 0 })).toThrow()
    expect(() => plugin.Config({ maxTextChars: 1.5 })).toThrow()
    expect(() => plugin.Config({ allowedHosts: 'example.com' } as never)).toThrow()
  })

  it('apply fails loud on an allowlist entry that is not a host label', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    expect(() => plugin.apply(ctx, plugin.Config({ allowedHosts: ['  '] }))).toThrow(/allowedHosts/)
  })
})

describe('tool pipeline over a stub backend', () => {
  it('navigate returns the canonical reading shape through the real registry', async () => {
    const { ctx, backend, fiber } = await composeStub()
    const result = await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/' }, 'owner-a'))
    expect(result.isError).toBe(false)
    if (!result.isError) {
      expect(result.value).toEqual({
        url: 'https://example.com/',
        title: 'Stub Title',
        statusCode: 200,
        text: 'page body text',
        truncated: false,
      })
    }
    expect(backend.launchCount).toBe(1)
    await fiber.dispose()
  })

  it('maps a policy denial into an isError result (never a throw out of the pipeline)', async () => {
    const { ctx, fiber } = await composeStub({ allowedHosts: ['example.com'], allowPrivateNetwork: false })
    const result = await ctx.tools.execute(execution('browser_navigate', { url: 'https://evil.test/' }, 'owner-a'))
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('not in the configured allowlist')
    await fiber.dispose()
  })

  it('CRITICAL: a redirect landing off the allowlist is refused end-to-end', async () => {
    const backend = new StubBackend()
    const { ctx, fiber } = await composeStub({ allowedHosts: ['example.com'], allowPrivateNetwork: false }, backend)
    // The requested URL clears the allowlist; the landed URL does not.
    backend.pages[0] = new StubPage()
    const page = backend.pages[0]
    backend.launch = async () => {
      const handle: BrowserHandle = {
        newPage: async () => page,
        close: async () => {},
      }
      return handle
    }
    page.landOn = 'https://evil.test/redirected'
    const result = await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/redirector' }, 'owner-a'))
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('BROWSER_HOST_NOT_ALLOWED')
    await fiber.dispose()
  })

  it('isolates owners: distinct session ids get distinct sessions, the same id is reused', async () => {
    const { ctx, backend, fiber } = await composeStub()
    await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/' }, 'owner-a'))
    await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/2' }, 'owner-a'))
    expect(backend.launchCount).toBe(1)
    await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.org/' }, 'owner-b'))
    expect(backend.launchCount).toBe(2)
    await fiber.dispose()
  })

  it('serializes overlapping calls on one owner in submission order', async () => {
    const { ctx, backend, fiber } = await composeStub()
    const first = ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/first' }, 'owner-a'))
    const second = ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/second' }, 'owner-a'))
    await Promise.all([first, second])
    expect(backend.pages[0]?.gotoCalls).toEqual(['https://example.com/first', 'https://example.com/second'])
    await fiber.dispose()
  })

  it('browser_close is idempotent and a later navigate reopens the owner page', async () => {
    const { ctx, backend, fiber } = await composeStub()
    await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/' }, 'owner-a'))
    const result = await ctx.tools.execute(execution('browser_close', {}, 'owner-a'))
    expect(result.isError).toBe(false)
    if (!result.isError) expect(result.value).toEqual({ closed: true })
    expect(backend.closeCount).toBe(1)
    await ctx.tools.execute(execution('browser_close', {}, 'owner-a'))
    expect(backend.closeCount).toBe(1)
    const again = await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/again' }, 'owner-a'))
    expect(again.isError).toBe(false)
    expect(backend.launchCount).toBe(2)
    await fiber.dispose()
  })

  it('disposing the plugin fiber closes every owner session', async () => {
    const { ctx, backend, fiber } = await composeStub()
    await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/' }, 'owner-a'))
    await ctx.tools.execute(execution('browser_navigate', { url: 'https://example.org/' }, 'owner-b'))
    expect(backend.closeCount).toBe(0)
    await fiber.dispose()
    expect(backend.closeCount).toBe(2)
  })

  it('read/fill/click before navigate surfaces BROWSER_NO_PAGE as isError', async () => {
    const { ctx, fiber } = await composeStub()
    for (const [name, args] of [
      ['browser_read_text', {}],
      ['browser_fill', { selector: '#q', value: 'v' }],
      ['browser_click', { selector: '#x' }],
    ] as const) {
      const result = await ctx.tools.execute(execution(name, args, 'owner-a'))
      expect(result.isError, name).toBe(true)
      expect(resultText(result), name).toContain('BROWSER_NO_PAGE')
    }
    await fiber.dispose()
  })

  it('an aborted signal settles the call as an error without killing the shared browser', async () => {
    const backend = new StubBackend()
    const { ctx, fiber } = await composeStub(allowAll, backend)
    const controller = new AbortController()
    let releaseGoto: (() => void) | undefined
    // Pre-arm the first page so the lazily created stub page gates its goto.
    const gated = new StubPage()
    gated.gotoGate = new Promise<void>(resolve => {
      releaseGoto = resolve
    })
    const originalLaunch = backend.launch.bind(backend)
    backend.launch = async () => {
      const page = gated
      return { newPage: async () => page, close: async () => {} }
    }
    void originalLaunch
    const pending = ctx.tools.execute(execution('browser_navigate', { url: 'https://example.com/slow' }, 'owner-a', controller.signal))
    await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(resultText(result).toLowerCase()).toContain('abort')
    // Aborting one call never tore the browser down.
    expect(backend.closeCount).toBe(0)
    releaseGoto?.()
    await new Promise(resolve => setImmediate(resolve))
    await fiber.dispose()
  })
})

describe('presenter purity', () => {
  it('presentCall and presentResult are deterministic pure functions of their inputs', async () => {
    const { ctx, fiber } = await composeStub()
    const navigate = ctx.tools.get('browser_navigate')
    const click = ctx.tools.get('browser_click')
    const fill = ctx.tools.get('browser_fill')
    const read = ctx.tools.get('browser_read_text')
    const close = ctx.tools.get('browser_close')
    expect([navigate, click, fill, read, close].every(tool => tool !== undefined)).toBe(true)
    if (!navigate || !click || !fill || !read || !close) return
    const successResult = {
      content: [{ type: 'text', text: 'x' }] as never,
      isError: false,
      meta: { url: 'https://example.com/', title: 'T', truncated: false },
    }
    for (const [tool, args] of [
      [navigate, { url: 'https://example.com/' }],
      [click, { selector: '#next' }],
      [fill, { selector: '#q', value: 'v' }],
      [read, {}],
      [close, {}],
    ] as const) {
      const callA = tool.presentCall?.(args)
      const callB = tool.presentCall?.(args)
      expect(callB, tool.name).toEqual(callA)
      if (callA !== undefined) {
        expect(callA.card, tool.name).toBe('generic')
        expect(typeof callA.title, tool.name).toBe('string')
      }
      const resultA = tool.presentResult?.(args, successResult)
      const resultB = tool.presentResult?.(args, successResult)
      expect(resultB, tool.name).toEqual(resultA)
      // A failure keeps the generic fallback (undefined), not a throw.
      expect(tool.presentResult?.(args, { content: [], isError: true }), tool.name).toBeUndefined()
    }
    await fiber.dispose()
  })

  it('presentResult projects the landed URL into the completed card title', async () => {
    const { ctx, fiber } = await composeStub()
    const navigate = ctx.tools.get('browser_navigate')
    const view = navigate?.presentResult?.({ url: 'https://example.com/requested' }, {
      content: [],
      isError: false,
      meta: { url: 'https://example.com/landed', title: 'Landed', truncated: false },
    })
    expect(view).toEqual({ card: 'generic', title: 'https://example.com/landed' })
    await fiber.dispose()
  })
})
