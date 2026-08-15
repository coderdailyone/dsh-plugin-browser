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
  snapshotValue = '- document'
  gotoCalls: { url: string; options: unknown }[] = []
  clickCalls: { selector: string }[] = []
  fillCalls: { selector: string; value: string }[] = []
  screenshotCalls: string[] = []
  pdfCalls: string[] = []
  setFilesCalls: { selector: string; path: string }[] = []
  evaluateCalls = 0
  titleCalls = 0
  gotoResult: { status(): number } | null = { status: () => 200 }
  gotoError: unknown
  clickError: unknown
  fillError: unknown
  evaluateError: unknown
  titleError: unknown
  closed = false
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
    this.titleCalls += 1
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

  async ariaSnapshot(options: { timeout: number }): Promise<string> {
    void options
    return this.snapshotValue
  }

  async screenshot(path: string, options: { timeout: number }): Promise<void> {
    void options
    this.screenshotCalls.push(path)
  }

  async pdf(path: string): Promise<void> {
    this.pdfCalls.push(path)
  }

  async setInputFiles(selector: string, path: string, options: { timeout: number }): Promise<void> {
    void options
    this.setFilesCalls.push({ selector, path })
  }

  async close(): Promise<void> {
    this.closed = true
  }

  isClosed(): boolean {
    return this.closed
  }
}

/** Backend double recording launches and handing out stub pages. */
class StubBackend implements BrowserBackend {
  launchCount = 0
  page!: StubPage
  /** Every page ever handed out or adopted, in order. */
  pages: StubPage[] = []
  launchError: unknown
  closeCalls = 0
  savedStates: string[] = []
  private pageListeners: ((page: PageHandle) => void)[] = []
  private downloadListeners: ((download: import('../src/session.js').DownloadEvent) => void)[] = []
  /** When armed via `deferClose()`, a pending `close()` blocks until released. */
  private releaseClose: (() => void) | undefined

  constructor() {
    this.resetPage()
  }

  resetPage(): StubPage {
    this.page = new StubPage()
    return this.page
  }

  /** Preconfigured pages handed out by upcoming `newPage()` calls, FIFO. */
  private queued: StubPage[] = []

  queuePage(page: StubPage): StubPage {
    this.queued.push(page)
    return page
  }

  takeQueued(): StubPage | undefined {
    return this.queued.shift()
  }

  /** Simulate the browser opening a page on its own (popup / window.open). */
  emitPopup(page: StubPage): StubPage {
    this.pages.push(page)
    for (const listener of this.pageListeners) listener(page)
    return page
  }

  emitDownload(download: import('../src/session.js').DownloadEvent): void {
    for (const listener of this.downloadListeners) listener(download)
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
    let created = 0
    return {
      async newPage() {
        created += 1
        const page = backend.takeQueued() ?? (created === 1 ? backend.page : new StubPage())
        backend.pages.push(page)
        return page
      },
      onPage(listener) {
        backend.pageListeners.push(listener)
      },
      onDownload(listener) {
        backend.downloadListeners.push(listener)
      },
      async saveStorageState(path: string) {
        backend.savedStates.push(path)
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

describe('snapshot and artifacts', () => {
  it('readSnapshot returns the bounded aria outline with the usual policy gates', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ maxTextChars: 12 }))
    await expectBrowserError(session.readSnapshot(), 'BROWSER_NO_PAGE')
    await session.navigate('https://example.com/')
    backend.page.snapshotValue = '- heading "Example Domain"'
    const bounded = await session.readSnapshot()
    expect(bounded).toEqual({ url: 'https://example.com/', title: 'Stub Title', snapshot: '- heading "E', truncated: true })
  })

  it('readSnapshot refuses a page scripted onto a disallowed host', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await session.navigate('https://example.com/')
    backend.page.urlValue = 'https://evil.test/moved'
    await expectBrowserError(session.readSnapshot(), 'BROWSER_HOST_NOT_ALLOWED')
  })

  it('screenshot and pdf write session-named files under the configured artifacts dir', async () => {
    const backend = new StubBackend()
    const dir = `${process.env.TMPDIR ?? '/tmp'}/dsh-browser-use-test-artifacts-${process.pid}`
    const session = new BrowserSession(backend, makeConfig({ artifactsDir: dir }))
    await session.navigate('https://example.com/')
    const shot = await session.screenshot()
    expect(shot.path).toBe(`${dir}/screenshot-1.png`)
    expect(shot.url).toBe('https://example.com/')
    const exported = await session.pdf()
    expect(exported.path).toBe(`${dir}/page-2.pdf`)
    expect(backend.page.screenshotCalls).toEqual([`${dir}/screenshot-1.png`])
    expect(backend.page.pdfCalls).toEqual([`${dir}/page-2.pdf`])
  })

  it('SECURITY: an off-policy page can never be screenshotted or exported', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await session.navigate('https://example.com/')
    backend.page.urlValue = 'https://evil.test/moved'
    await expectBrowserError(session.screenshot(), 'BROWSER_HOST_NOT_ALLOWED')
    await expectBrowserError(session.pdf(), 'BROWSER_HOST_NOT_ALLOWED')
    expect(backend.page.screenshotCalls).toHaveLength(0)
    expect(backend.page.pdfCalls).toHaveLength(0)
  })
})

describe('downloads, storage state, and uploads', () => {
  function fakeDownload(url: string, suggestedFilename: string) {
    const saved: string[] = []
    return {
      saved,
      event: {
        url,
        suggestedFilename,
        saveAs: async (path: string) => {
          saved.push(path)
        },
      },
    }
  }

  it('captures a download into the artifacts dir under a sanitized name', async () => {
    const backend = new StubBackend()
    const dir = `${process.env.TMPDIR ?? '/tmp'}/dsh-browser-use-test-dl-${process.pid}`
    const session = new BrowserSession(backend, makeConfig({ artifactsDir: dir }))
    await session.navigate('https://example.com/')
    const download = fakeDownload('https://example.com/report', '../../etc/evil name.pdf')
    backend.emitDownload(download.event)
    const rows = await session.downloads()
    expect(rows).toEqual([
      {
        index: 0,
        url: 'https://example.com/report',
        suggestedFilename: '../../etc/evil name.pdf',
        state: 'saved',
        path: `${dir}/download-1-evil_name.pdf`,
      },
    ])
    expect(download.saved).toEqual([`${dir}/download-1-evil_name.pdf`])
  })

  it('SECURITY: a download from a policy-refused URL is recorded but never written', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await session.navigate('https://example.com/')
    const download = fakeDownload('https://evil.test/payload.bin', 'payload.bin')
    backend.emitDownload(download.event)
    const rows = await session.downloads()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'refused', url: 'https://evil.test/payload.bin' })
    expect(rows[0]?.path).toBeUndefined()
    expect(download.saved).toHaveLength(0)
  })

  it('records a failing save as failed with the error preserved', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    await session.navigate('https://example.com/')
    backend.emitDownload({
      url: 'https://example.com/gone',
      suggestedFilename: 'gone.txt',
      saveAs: async () => {
        throw new Error('canceled by server')
      },
    })
    const rows = await session.downloads()
    expect(rows[0]).toMatchObject({ state: 'failed', error: 'Error: canceled by server' })
  })

  it('persists storage state on close when configured, and only then', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ storageStatePath: '/tmp/state.json' }))
    await session.navigate('https://example.com/')
    await session.close()
    expect(backend.savedStates).toEqual(['/tmp/state.json'])
    const plain = new StubBackend()
    const bare = new BrowserSession(plain, makeConfig())
    await bare.navigate('https://example.com/')
    await bare.close()
    expect(plain.savedStates).toEqual([])
  })

  it('uploads are disabled outright without an uploadsDir', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    await session.navigate('https://example.com/')
    await expectBrowserError(session.uploadFile('#file', 'notes.txt'), 'BROWSER_UPLOAD_NOT_ALLOWED')
    expect(backend.page.setFilesCalls).toHaveLength(0)
  })

  it('SECURITY: upload accepts only bare filenames inside uploadsDir — every traversal shape is refused', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ uploadsDir: '/srv/uploads' }))
    await session.navigate('https://example.com/')
    for (const bad of ['../secret', 'a/../../b', '/etc/passwd', 'dir/file.txt', 'C:\\x', '.', '..', '']) {
      await expectBrowserError(session.uploadFile('#file', bad), 'BROWSER_UPLOAD_NOT_ALLOWED')
    }
    expect(backend.page.setFilesCalls).toHaveLength(0)
    const outcome = await session.uploadFile('#file', 'notes.txt')
    expect(outcome.url).toBe('https://example.com/')
    expect(backend.page.setFilesCalls).toEqual([{ selector: '#file', path: '/srv/uploads/notes.txt' }])
  })
})

describe('tabs', () => {
  it('tabNew without a URL opens a blank tab that is unusable until navigated', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    const opened = await session.tabNew()
    expect(opened).toEqual({ index: 0, url: 'about:blank', title: '' })
    await expectBrowserError(session.readText(), 'BROWSER_NO_PAGE')
    const outcome = await session.navigate('https://example.com/')
    expect(outcome.url).toBe('https://example.com/')
  })

  it('tabNew enforces the policy before creating any page', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await expectBrowserError(session.tabNew('https://evil.test/'), 'BROWSER_HOST_NOT_ALLOWED')
    expect(backend.launchCount).toBe(0)
    expect(backend.pages).toHaveLength(0)
  })

  it('tabNew with a URL opens, navigates, and becomes the active tab', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    await session.navigate('https://example.com/first')
    const opened = await session.tabNew('https://example.org/second')
    expect(opened.index).toBe(1)
    expect(opened.url).toBe('https://example.org/second')
    // Subsequent reads hit the new tab, not the first one.
    const reading = await session.readText()
    expect(reading.url).toBe('https://example.org/second')
    expect(backend.pages[1]?.gotoCalls.map(call => call.url)).toEqual(['https://example.org/second'])
  })

  it('CRITICAL: a redirect on a new tab landing off the allowlist is refused', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await session.navigate('https://example.com/first')
    const redirecting = new StubPage()
    redirecting.landOn = 'https://evil.test/landed'
    backend.queuePage(redirecting)
    const error = await session.tabNew('https://example.com/redirector').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(BrowserError)
    expect((error as BrowserError).code).toBe('BROWSER_HOST_NOT_ALLOWED')
    expect(redirecting.gotoCalls).toHaveLength(1)
  })

  it('tabList reports urls and active flag, and reads titles only for policy-cleared tabs', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await session.navigate('https://example.com/first')
    const popup = new StubPage()
    popup.urlValue = 'https://evil.test/popup'
    backend.emitPopup(popup)
    const rows = await session.tabList()
    expect(rows).toEqual([
      { index: 0, active: true, url: 'https://example.com/first', allowed: true, title: 'Stub Title' },
      { index: 1, active: false, url: 'https://evil.test/popup', allowed: false },
    ])
    // The off-policy popup's title was never even read.
    expect(popup.titleCalls).toBe(0)
  })

  it('tabSelect switches the active tab and refuses off-policy or missing tabs', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig({ policy: exampleOnly }))
    await session.navigate('https://example.com/first')
    await session.tabNew('https://sub.example.com/second')
    const selected = await session.tabSelect(0)
    expect(selected).toEqual({ index: 0, url: 'https://example.com/first', title: 'Stub Title' })
    const reading = await session.readText()
    expect(reading.url).toBe('https://example.com/first')
    const popup = new StubPage()
    popup.urlValue = 'https://evil.test/popup'
    backend.emitPopup(popup)
    await expectBrowserError(session.tabSelect(2), 'BROWSER_HOST_NOT_ALLOWED')
    await expectBrowserError(session.tabSelect(9), 'BROWSER_NO_SUCH_TAB')
    await expectBrowserError(session.tabSelect(-1), 'BROWSER_NO_SUCH_TAB')
  })

  it('tabClose closes one tab, adjusts the active index, and the session survives', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    await session.navigate('https://example.com/a')
    await session.tabNew('https://example.com/b')
    await session.tabNew('https://example.com/c')
    // Close a tab before the active one: active stays on /c.
    const closedFirst = await session.tabClose(0)
    expect(closedFirst).toEqual({ closed: true, remaining: 2 })
    expect((await session.readText()).url).toBe('https://example.com/c')
    // Close the active tab: focus falls back to the survivor.
    await session.tabClose()
    expect((await session.readText()).url).toBe('https://example.com/b')
    // Closing the last tab leaves the session pageless, then navigate reopens.
    await session.tabClose()
    await expectBrowserError(session.readText(), 'BROWSER_NO_PAGE')
    const reopened = await session.navigate('https://example.com/again')
    expect(reopened.url).toBe('https://example.com/again')
    expect(backend.closeCalls).toBe(0)
  })

  it('prunes tabs the browser closed on its own, keeping the active tab stable', async () => {
    const backend = new StubBackend()
    const session = new BrowserSession(backend, makeConfig())
    await session.navigate('https://example.com/keep')
    const popup = new StubPage()
    popup.urlValue = 'https://example.com/popup'
    backend.emitPopup(popup)
    expect((await session.tabList())).toHaveLength(2)
    popup.closed = true
    const rows = await session.tabList()
    expect(rows).toEqual([
      { index: 0, active: true, url: 'https://example.com/keep', allowed: true, title: 'Stub Title' },
    ])
    expect((await session.readText()).url).toBe('https://example.com/keep')
  })
})
