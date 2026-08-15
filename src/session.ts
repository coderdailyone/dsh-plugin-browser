/**
 * One owner-isolated Playwright browser session and the operations the tool
 * exposes over it. The session owns an ordered list of tabs (pages) with one
 * active tab, lazily launched on first navigation and torn down with the
 * plugin fiber. Every operation re-checks the navigation policy — a page can
 * be steered to a new origin by a link or a redirect, so the allowlist is
 * enforced continuously, not once at `open`. Pages the browser opens on its
 * own (popups, `window.open`) are adopted into the tab list but never become
 * active or readable without passing the same policy.
 * @module dsh-plugin-browser-use/session
 */

import { evaluateUrl, describeDenial, type NavigationPolicy } from './policy.js'

/**
 * Cut `text` at `maxChars` characters without splitting a surrogate pair: when
 * the cut would land inside an astral character (emoji, rare CJK), the cut
 * moves left so the result never ends in a lone high surrogate.
 */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  let end = maxChars
  while (end > 0 && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

/** The Playwright surface this module needs, kept minimal so it is stubbable in tests. */
export interface BrowserBackend {
  launch(): Promise<BrowserHandle>
}

/** A download some page initiated; the session decides where (or whether) it lands. */
export interface DownloadEvent {
  readonly url: string
  readonly suggestedFilename: string
  saveAs(path: string): Promise<void>
}

/** A launched browser; owns page creation, browser-initiated events, and teardown. */
export interface BrowserHandle {
  newPage(): Promise<PageHandle>
  close(): Promise<void>
  /** Subscribe to pages the browser opens on its own (popups, `window.open`). */
  onPage(listener: (page: PageHandle) => void): void
  /** Subscribe to downloads initiated by any page in this browser. */
  onDownload(listener: (download: DownloadEvent) => void): void
  /** Persist cookies/localStorage to `path` as a Playwright storage state file. */
  saveStorageState(path: string): Promise<void>
}

/** The subset of a Playwright page the session drives. */
export interface PageHandle {
  goto(url: string, options: { waitUntil: 'load' | 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null>
  url(): string
  title(): Promise<string>
  click(selector: string, options: { timeout: number }): Promise<void>
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>
  evaluate<T>(fn: string): Promise<T>
  /** Aria snapshot of the page body (role/name outline), for reliable targeting. */
  ariaSnapshot(options: { timeout: number }): Promise<string>
  /** Write a PNG of the current viewport to `path`. */
  screenshot(path: string, options: { timeout: number }): Promise<void>
  /** Write a PDF of the current page to `path` (Chromium headless only). */
  pdf(path: string): Promise<void>
  /** Attach a local file to an `<input type=file>`. */
  setInputFiles(selector: string, path: string, options: { timeout: number }): Promise<void>
  close(): Promise<void>
  isClosed(): boolean
}

/** A structured error the tool maps to a model-facing `isError` result. */
export class BrowserError extends Error {
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options)
    this.name = 'BrowserError'
  }
}

/** Outcome of one navigation or interaction, before text extraction. */
export interface ActionOutcome {
  readonly url: string
  readonly title: string
  readonly statusCode?: number
}

/** A full read of the current page: where it landed plus its bounded text. */
export interface PageReading extends ActionOutcome {
  readonly text: string
  readonly truncated: boolean
}

/** One row of the tab list. `title` is read only for policy-cleared tabs. */
export interface TabInfo {
  readonly index: number
  readonly active: boolean
  readonly url: string
  /** Whether the tab's current URL clears the navigation policy. */
  readonly allowed: boolean
  readonly title?: string
}

/** Resolved session tunables. */
export interface SessionConfig {
  readonly policy: NavigationPolicy
  readonly navigationTimeoutMs: number
  readonly actionTimeoutMs: number
  /** Upper bound on extracted page text handed to the model, in characters. */
  readonly maxTextChars: number
}

/**
 * A lazily-launched browser session holding an ordered tab list with one
 * active tab. Not concurrency-safe by design: the tool serializes calls per
 * owner, matching a human driving one window. Teardown is idempotent and
 * awaits the backend's close.
 */
export class BrowserSession {
  private handle: BrowserHandle | undefined
  private tabs: PageHandle[] = []
  private activeIndex = 0
  private closing: Promise<void> | undefined

  constructor(
    private readonly backend: BrowserBackend,
    private readonly config: SessionConfig,
  ) {}

  /** Enforce the navigation policy or throw a `BrowserError` the tool surfaces. */
  private enforce(rawUrl: string): string {
    const verdict = evaluateUrl(rawUrl, this.config.policy)
    if ('kind' in verdict) {
      throw new BrowserError(`navigation refused: ${describeDenial(verdict)}`, `BROWSER_${verdict.kind.toUpperCase().replace(/-/g, '_')}`)
    }
    return verdict.url.toString()
  }

  private assertOpen(): void {
    if (this.closing !== undefined) throw new BrowserError('browser session is closing', 'BROWSER_CLOSED')
  }

  /** Launch the browser once; adopt any page the browser opens on its own. */
  private async ensureHandle(): Promise<BrowserHandle> {
    if (this.handle !== undefined) return this.handle
    try {
      this.handle = await this.backend.launch()
    } catch (error: unknown) {
      throw new BrowserError(`failed to launch browser: ${String(error)}`, 'BROWSER_LAUNCH_FAILED', { cause: error })
    }
    this.handle.onPage(page => {
      // Popups join the tab list but never steal focus; every read or
      // interaction on them still passes the policy gates.
      if (!this.tabs.includes(page)) this.tabs.push(page)
    })
    return this.handle
  }

  /** Drop externally-closed tabs, keeping the active tab stable when it survives. */
  private prune(): void {
    if (this.tabs.length === 0) return
    const activePage = this.tabs[this.activeIndex]
    this.tabs = this.tabs.filter(page => !page.isClosed())
    const kept = activePage === undefined ? -1 : this.tabs.indexOf(activePage)
    this.activeIndex = kept >= 0 ? kept : 0
  }

  private async ensureActivePage(): Promise<PageHandle> {
    this.assertOpen()
    this.prune()
    const existing = this.tabs[this.activeIndex]
    if (existing !== undefined) return existing
    const handle = await this.ensureHandle()
    let page: PageHandle
    try {
      page = await handle.newPage()
    } catch (error: unknown) {
      throw new BrowserError(`failed to open a page: ${String(error)}`, 'BROWSER_LAUNCH_FAILED', { cause: error })
    }
    this.adoptTab(page, { activate: true })
    return page
  }

  /** Add `page` to the tab list unless already adopted; optionally focus it. */
  private adoptTab(page: PageHandle, options: { activate: boolean }): number {
    let index = this.tabs.indexOf(page)
    if (index < 0) {
      this.tabs.push(page)
      index = this.tabs.length - 1
    }
    if (options.activate) this.activeIndex = index
    return index
  }

  /** Navigate the active tab to a policy-cleared URL and report the landed page. */
  async navigate(rawUrl: string): Promise<ActionOutcome> {
    const target = this.enforce(rawUrl)
    const page = await this.ensureActivePage()
    return this.gotoOn(page, target)
  }

  private async gotoOn(page: PageHandle, target: string): Promise<ActionOutcome> {
    let response: { status(): number } | null
    try {
      response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
    } catch (error: unknown) {
      throw new BrowserError(`navigation to ${target} failed: ${String(error)}`, 'BROWSER_NAVIGATION_FAILED', { cause: error })
    }
    // A redirect may have crossed into a disallowed origin; re-check the landed URL.
    this.enforce(page.url())
    return { url: page.url(), title: await this.readTitleOf(page), ...response !== null ? { statusCode: response.status() } : {} }
  }

  /** Click a selector, refusing to interact with an off-policy page, then re-assert the landed URL. */
  async click(selector: string): Promise<ActionOutcome> {
    const page = this.requirePage()
    // Refuse to interact at all with a page scripted onto a disallowed host,
    // then re-check after the click (it may itself navigate).
    this.enforceInteractive(page)
    try {
      await page.click(selector, { timeout: this.config.actionTimeoutMs })
    } catch (error: unknown) {
      throw new BrowserError(`click on ${selector} failed: ${String(error)}`, 'BROWSER_ACTION_FAILED', { cause: error })
    }
    this.enforce(page.url())
    return { url: page.url(), title: await this.readTitleOf(page) }
  }

  /** Fill a form field by selector, with the same pre- and post-action checks. */
  async fill(selector: string, value: string): Promise<ActionOutcome> {
    const page = this.requirePage()
    this.enforceInteractive(page)
    try {
      await page.fill(selector, value, { timeout: this.config.actionTimeoutMs })
    } catch (error: unknown) {
      throw new BrowserError(`fill on ${selector} failed: ${String(error)}`, 'BROWSER_ACTION_FAILED', { cause: error })
    }
    this.enforce(page.url())
    return { url: page.url(), title: await this.readTitleOf(page) }
  }

  /**
   * Re-read the current page: its landed URL (re-checked against the policy —
   * page JS may have navigated since the last action), its title, and its
   * visible text bounded to `maxTextChars`.
   */
  async readText(): Promise<PageReading> {
    const page = this.requirePage()
    this.enforceInteractive(page)
    const title = await this.readTitleOf(page)
    let raw: string
    try {
      raw = await page.evaluate<string>('document.body ? document.body.innerText : ""')
    } catch (error: unknown) {
      throw new BrowserError(`text extraction failed: ${String(error)}`, 'BROWSER_ACTION_FAILED', { cause: error })
    }
    const normalized = raw.replace(/\n{3,}/g, '\n\n').trim()
    const bounded = truncateText(normalized, this.config.maxTextChars)
    return {
      url: page.url(),
      title,
      text: bounded.text,
      truncated: bounded.truncated,
    }
  }

  /**
   * Open a new tab, optionally navigating it. The policy runs before the tab
   * is even created, so a refused URL never spawns a page. A blank tab lands
   * on `about:blank` and only becomes usable after a navigate.
   */
  async tabNew(rawUrl?: string): Promise<ActionOutcome & { index: number }> {
    this.assertOpen()
    const target = rawUrl !== undefined ? this.enforce(rawUrl) : undefined
    const handle = await this.ensureHandle()
    this.prune()
    let page: PageHandle
    try {
      page = await handle.newPage()
    } catch (error: unknown) {
      throw new BrowserError(`failed to open a page: ${String(error)}`, 'BROWSER_LAUNCH_FAILED', { cause: error })
    }
    const index = this.adoptTab(page, { activate: true })
    if (target === undefined) return { index, url: page.url(), title: '' }
    const outcome = await this.gotoOn(page, target)
    return { index, ...outcome }
  }

  /** List every tab. Titles are read only for tabs whose URL clears the policy. */
  async tabList(): Promise<TabInfo[]> {
    this.assertOpen()
    this.prune()
    const rows: TabInfo[] = []
    for (const [index, page] of this.tabs.entries()) {
      const url = page.url()
      const allowed = url !== 'about:blank' && !('kind' in evaluateUrl(url, this.config.policy))
      let title: string | undefined
      if (allowed) {
        try {
          title = await page.title()
        } catch {
          title = undefined
        }
      }
      rows.push({ index, active: index === this.activeIndex, url, allowed, ...title !== undefined ? { title } : {} })
    }
    return rows
  }

  /**
   * Make a tab active. Selecting a tab parked on a disallowed host is refused
   * outright — an off-policy popup can be listed and closed, never focused.
   */
  async tabSelect(index: number): Promise<ActionOutcome & { index: number }> {
    this.assertOpen()
    this.prune()
    const page = this.requireTab(index)
    const url = page.url()
    if (url !== 'about:blank') this.enforce(url)
    this.activeIndex = index
    return { index, url, title: url === 'about:blank' ? '' : await this.readTitleOf(page) }
  }

  /** Close one tab (the active one by default); the session survives with the rest. */
  async tabClose(index?: number): Promise<{ closed: true; remaining: number }> {
    this.assertOpen()
    this.prune()
    const target = index ?? this.activeIndex
    const page = this.requireTab(target)
    try {
      await page.close()
    } catch (error: unknown) {
      throw new BrowserError(`closing tab ${target} failed: ${String(error)}`, 'BROWSER_ACTION_FAILED', { cause: error })
    }
    this.tabs.splice(target, 1)
    if (target < this.activeIndex) this.activeIndex -= 1
    if (this.activeIndex >= this.tabs.length) this.activeIndex = Math.max(0, this.tabs.length - 1)
    return { closed: true, remaining: this.tabs.length }
  }

  private requireTab(index: number): PageHandle {
    if (!Number.isInteger(index) || index < 0 || index >= this.tabs.length) {
      throw new BrowserError(`no tab at index ${index} (${this.tabs.length} open)`, 'BROWSER_NO_SUCH_TAB')
    }
    const page = this.tabs[index]
    if (page === undefined) throw new BrowserError(`no tab at index ${index}`, 'BROWSER_NO_SUCH_TAB')
    return page
  }

  private async readTitleOf(page: PageHandle): Promise<string> {
    try {
      return await page.title()
    } catch (error: unknown) {
      throw new BrowserError(`title read failed: ${String(error)}`, 'BROWSER_ACTION_FAILED', { cause: error })
    }
  }

  private requirePage(): PageHandle {
    this.assertOpen()
    this.prune()
    const page = this.tabs[this.activeIndex]
    if (page === undefined) throw new BrowserError('no page open; navigate first', 'BROWSER_NO_PAGE')
    return page
  }

  /** A page that exists but never landed a real navigation (about:blank) is not yet usable. */
  private enforceInteractive(page: PageHandle): void {
    if (page.url() === 'about:blank') {
      throw new BrowserError('no page open; navigate first', 'BROWSER_NO_PAGE')
    }
    this.enforce(page.url())
  }

  /** Idempotently close the browser, awaiting the backend's teardown. */
  async close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const handle = this.handle
    this.tabs = []
    this.activeIndex = 0
    this.handle = undefined
    if (handle === undefined) {
      this.closing = Promise.resolve()
      return this.closing
    }
    this.closing = handle.close()
    return this.closing
  }
}
