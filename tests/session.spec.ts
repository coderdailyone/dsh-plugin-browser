/**
 * Session behavior over a stub backend — no real browser. Pins the critical
 * security property (post-redirect URL re-check), the lazy launch, the error
 * taxonomy with preserved causes, text truncation, and close semantics.
 */
import { describe, expect, it } from 'vitest'
import { BrowserError, BrowserSession, type BrowserBackend, type BrowserHandle, type PageHandle } from '../src/session.js'
import type { NavigationPolicy } from '../src/policy.js'

const allowAll: NavigationPolicy = { allowedHosts: [], allowPrivateNetwork: false }
const exampleOnly: NavigationPolicy = { allowedHosts: ['example.com'], allowPrivateNetwork: false }

function makeConfig(overrides: Partial<ConstructorParameters<typeof BrowserSession>[1]> = {}) {
  return {
    policy: allowAll,
    navigationTimeoutMs: 5_000,
    actionTimeoutMs: 5_000,
    maxTextChars: 50,
    ...overrides,
  }
}

/** A fully controllable PageHandle double. */
class StubPage implements PageHandle {
  urlValue = 'about:blank'
  titleValue = 'Stub Title'
  textValue = 'stub page text'
  gotoCalls: { url: string; options: unknown }[] = []
  clickCalls: { selector: string }[] = []
  fillCalls: { selector: string; value: string }[] = []
  evaluateCalls = 0
  gotoResult: { status(): number } | null = { status: () => 200 }
  gotoError: unknown
  clickError: unknown
  fillError: unknown
  evaluateError: unknown
  titleError: unknown
  /** URL the page "lands" on after goto (redirect simulation). */
  landOn: string | undefined

  url(): string {
    return this.urlValue
  }

  async goto(url: string, options: { waitUntil: 'load' | 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null> {
    this.gotoCalls.push({ url, options })
    if (this.gotoError !== undefined) throw this.gotoError
    this.urlValue = this.landOn ?? url
    return this.gotoResult
  }

  async title(): Promise<string> {
    if (this.titleError !== undefined) throw this.titleError
    return this.titleValue
  }

  async click(selector: string, options: { timeout: number }): Promise<void> {
    void options
    this.clickCalls.push({ selector })
    if (this.clickError !== undefined) throw this.clickError
  }

  async fill(selector: string, value: string, options: { timeout: number }): Promise<void> {
    void options
    this.fillCalls.push({ selector, value })
    if (this.fillError !== undefined) throw this.fillError
  }

  async evaluate<T>(fn: string): Promise<T> {
    void fn
    this.evaluateCalls += 1
    if (this.evaluateError !== undefined) throw this.evaluateError
    return this.textValue as T
  }
}

/** Backend double recording launches and handing out stub pages. */
class StubBackend implements BrowserBackend {
  launchCount = 0
  page!: StubPage
  launchError: unknown
  closeCalls = 0
  /** When armed via `deferClose()`, a pending `close()` blocks until released. */
  private releaseClose: (() => void) | undefined

  constructor() {
    this.resetPage()
  }

  resetPage(): StubPage {
    this.page = new StubPage()
    return this.page
  }

  /** Arm the gate so the next backend close hangs until `finishClose()`. */
  deferClose(): void {
    this.releaseClose = undefined
    void new Promise<void>(resolve => {
      this.releaseClose = resolve
    })
  }

  finishClose(): void {
    this.releaseClose?.()
  }

  async launch(): Promise<BrowserHandle> {
    this.launchCount += 1
    if (this.launchError !== undefined) throw this.launchError
    const backend = this
    const page = this.page
    return {
      async newPage() {
        return page
      },
      async close() {
        backend.closeCalls += 1
        if (backend.releaseClose !== undefined) {
          await new Promise<void>(resolve => {
            const prev = backend.releaseClose
            backend.releaseClose = resolve
            prev?.()
          })
        }
      },
    }
  }
}

/** Expect a BrowserError with the given code; returns it for cause checks. */
async function expectBrowserError(promise: Promise<unknown>, code: string): Promise<BrowserError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserError)
    const browserError = error as BrowserError
    expect(browserError.code).toBe(code)
    return browserError
  }
  throw new Error(`expected a BrowserError with code ${code}`)
}

describe('BrowserSession', () => {
  it('launches lazily: nothing starts until the first navigate', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    expect(backend.launchCount).toBe(0)
    const outcome = await session.navigate('https://example.com/start')
    expect(backend.launchCount).toBe(1)
    expect(outcome).toEqual({ url: 'https://example.com/start', title: 'Stub Title', statusCode: 200 })
    // A second navigate reuses the same page, no second launch.
    await session.navigate('https://example.com/next')
    expect(backend.launchCount).toBe(1)
    expect(backend.page.gotoCalls.map(call => call.url)).toEqual(['https://example.com/start', 'https://example.com/next'])
  })

  it('refuses a disallowed target before launching anything', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await expectBrowserError(session.navigate('https://evil.test/'), 'BROWSER_HOST_NOT_ALLOWED')
    expect(backend.launchCount).toBe(0)
    await expectBrowserError(session.navigate('file:///etc/passwd'), 'BROWSER_UNSUPPORTED_SCHEME')
    await expectBrowserError(session.navigate('http://127.0.0.1:1/'), 'BROWSER_PRIVATE_NETWORK')
    expect(backend.launchCount).toBe(0)
  })

  it('CRITICAL: refuses a redirect that lands off the allowlist even though the requested URL was allowed', async () => {
    const backend = new StubBackend()
    const page = backend.resetPage()
    page.landOn = 'https://evil.test/redirected'
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    // The requested URL clears the allowlist; the landed URL does not.
    const error = await expectBrowserError(session.navigate('https://example.com/redirector'), 'BROWSER_HOST_NOT_ALLOWED')
    expect(error.message).toContain('evil.test')
    expect(page.gotoCalls).toHaveLength(1)
  })

  it('readText re-checks the policy: page JS may have navigated since the last action', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await session.navigate('https://example.com/landing')
    // Scripted navigation to an off-list host between actions.
    backend.page.urlValue = 'https://evil.test/scripted'
    await expectBrowserError(session.readText(), 'BROWSER_HOST_NOT_ALLOWED')
  })

  it('click and fill re-check the landed URL against the policy', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await session.navigate('https://example.com/landing')
    backend.page.urlValue = 'https://sub.example.com/clicked'
    const outcome = await session.click('#next')
    expect(outcome.url).toBe('https://sub.example.com/clicked')
    backend.page.urlValue = 'https://evil.test/filled'
    await expectBrowserError(session.fill('#q', 'x'), 'BROWSER_HOST_NOT_ALLOWED')
    expect(backend.page.fillCalls).toHaveLength(0)
  })

  it('requires a page: click/fill/read before any navigate fail with BROWSER_NO_PAGE', async () => {
    const session = new BrowserSession(new StubBackend(), makeConfig())
    await expectBrowserError(session.click('#x'), 'BROWSER_NO_PAGE')
    await expectBrowserError(session.fill('#x', 'y'), 'BROWSER_NO_PAGE')
    await expectBrowserError(session.readText(), 'BROWSER_NO_PAGE')
  })

  it('maps launch failure to BROWSER_LAUNCH_FAILED with the cause preserved', async () => {
    const backend = new StubBackend()
    backend.launchError = new Error('spawn failed')
    const session = new BrowserSession(backend, makeConfig())
    const error = await expectBrowserError(session.navigate('https://example.com/'), 'BROWSER_LAUNCH_FAILED')
    expect((error.cause as Error).message).toBe('spawn failed')
  })

  it('maps goto failure to BROWSER_NAVIGATION_FAILED with the cause preserved', async () => {
    const backend = new StubBackend()
    backend.page.gotoError = new Error('net::ERR_CONNECTION_REFUSED')
    const session = new BrowserSession(backend, makeConfig())
    const error = await expectBrowserError(session.navigate('https://example.com/'), 'BROWSER_NAVIGATION_FAILED')
    expect((error.cause as Error).message).toBe('net::ERR_CONNECTION_REFUSED')
  })

  it('maps click/fill/extract failures to BROWSER_ACTION_FAILED with the cause preserved', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    await session.navigate('https://example.com/landing')
    backend.page.clickError = new Error('timeout 5000ms exceeded')
    let error = await expectBrowserError(session.click('#missing'), 'BROWSER_ACTION_FAILED')
    expect((error.cause as Error).message).toContain('timeout')
    backend.page.fillError = new Error('element not editable')
    error = await expectBrowserError(session.fill('#q', 'v'), 'BROWSER_ACTION_FAILED')
    expect((error.cause as Error).message).toContain('not editable')
    backend.page.evaluateError = new Error('execution context destroyed')
    error = await expectBrowserError(session.readText(), 'BROWSER_ACTION_FAILED')
    expect((error.cause as Error).message).toContain('execution context')
  })

  it('readText truncates at maxTextChars and flags the cut', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ maxTextChars: 10 }))
    await session.navigate('https://example.com/landing')
    backend.page.textValue = 'a'.repeat(40)
    const truncated = await session.readText()
    expect(truncated.text).toBe('a'.repeat(10))
    expect(truncated.truncated).toBe(true)
    backend.page.textValue = 'short'
    const full = await session.readText()
    expect(full).toEqual({ url: 'https://example.com/landing', title: 'Stub Title', text: 'short', truncated: false })
  })

  it('omits statusCode when the backend records no navigation response', async () => {
    const backend = new StubBackend()
    backend.page.gotoResult = null
    const session = new BrowserSession(backend, makeConfig())
    const outcome = await session.navigate('https://example.com/landing')
    expect(outcome).toEqual({ url: 'https://example.com/landing', title: 'Stub Title' })
    expect('statusCode' in outcome).toBe(false)
  })

  it('permits private hosts only when the policy allows them (scheme still enforced)', async () => {
    const permissive: NavigationPolicy = { allowedHosts: [], allowPrivateNetwork: true }
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: permissive }))
    const outcome = await session.navigate('http://127.0.0.1:8080/self')
    expect(outcome.url).toBe('http://127.0.0.1:8080/self')
    await expectBrowserError(session.navigate('file:///etc/passwd'), 'BROWSER_UNSUPPORTED_SCHEME')
  })

  it('close is idempotent and awaits the backend teardown', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    await session.navigate('https://example.com/landing')
    await session.close()
    await session.close()
    expect(backend.closeCalls).toBe(1)
  })

  it('guards the closing state: operations during teardown fail with BROWSER_CLOSED', async () => {
    const backend = new StubBackend()
    backend.deferClose()
    const session = new BrowserSession(backend, makeConfig())
    await session.navigate('https://example.com/landing')
    const closing = session.close()
    await expectBrowserError(session.navigate('https://example.com/other'), 'BROWSER_CLOSED')
    await expectBrowserError(session.readText(), 'BROWSER_CLOSED')
    backend.finishClose()
    await closing
  })

  it('close without a launch resolves without touching the backend', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    await session.close()
    expect(backend.closeCalls).toBe(0)
  })
})
