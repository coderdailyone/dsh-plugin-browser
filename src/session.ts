/**
 * One owner-isolated Playwright browser session and the operations the tool
 * exposes over it. The session owns exactly one page, lazily launched on first
 * navigation and torn down with the plugin fiber. Every operation re-checks the
 * navigation policy — a page can be steered to a new origin by a link or a
 * redirect, so the allowlist is enforced continuously, not once at `open`.
 * @module dsh-plugin-browser-use/session
 */

import { evaluateUrl, describeDenial, type NavigationPolicy } from './policy.js'

/** The Playwright surface this module needs, kept minimal so it is stubbable in tests. */
export interface BrowserBackend {
  launch(): Promise<BrowserHandle>
}

/** A launched browser; owns page creation and teardown. */
export interface BrowserHandle {
  newPage(): Promise<PageHandle>
  close(): Promise<void>
}

/** The subset of a Playwright page the session drives. */
export interface PageHandle {
  goto(url: string, options: { waitUntil: 'load' | 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null>
  url(): string
  title(): Promise<string>
  click(selector: string, options: { timeout: number }): Promise<void>
  fill(selector: string, value: string, options: { timeout: number }): Promise<void>
  evaluate<T>(fn: string): Promise<T>
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

/** Resolved session tunables. */
export interface SessionConfig {
  readonly policy: NavigationPolicy
  readonly navigationTimeoutMs: number
  readonly actionTimeoutMs: number
  /** Upper bound on extracted page text handed to the model, in characters. */
  readonly maxTextChars: number
}

/**
 * A lazily-launched, single-page browser session. Not concurrency-safe by
 * design: the tool serializes calls per owner, matching a human driving one
 * tab. Teardown is idempotent and awaits the backend's close.
 */
export class BrowserSession {
  private handle: BrowserHandle | undefined
  private page: PageHandle | undefined
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

  private async ensurePage(): Promise<PageHandle> {
    if (this.closing !== undefined) throw new BrowserError('browser session is closing', 'BROWSER_CLOSED')
    if (this.page !== undefined) return this.page
    try {
      this.handle = await this.backend.launch()
      this.page = await this.handle.newPage()
      return this.page
    } catch (error: unknown) {
      throw new BrowserError(`failed to launch browser: ${String(error)}`, 'BROWSER_LAUNCH_FAILED', { cause: error })
    }
  }

  /** Navigate to a policy-cleared URL and report the landed page. */
  async navigate(rawUrl: string): Promise<ActionOutcome> {
    const target = this.enforce(rawUrl)
    const page = await this.ensurePage()
    let response: { status(): number } | null
    try {
      response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs })
    } catch (error: unknown) {
      throw new BrowserError(`navigation to ${target} failed: ${String(error)}`, 'BROWSER_NAVIGATION_FAILED', { cause: error })
    }
    // A redirect may have crossed into a disallowed origin; re-check the landed URL.
    this.enforce(page.url())
    return { url: page.url(), title: await page.title(), ...response !== null ? { statusCode: response.status() } : {} }
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
    return { url: page.url(), title: await this.readTitle() }
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
    return { url: page.url(), title: await this.readTitle() }
  }

  /**
   * Re-read the current page: its landed URL (re-checked against the policy —
   * page JS may have navigated since the last action), its title, and its
   * visible text bounded to `maxTextChars`.
   */
  async readText(): Promise<PageReading> {
    const page = this.requirePage()
    this.enforceInteractive(page)
    const title = await this.readTitle()
    let raw: string
    try {
      raw = await page.evaluate<string>('document.body ? document.body.innerText : ""')
    } catch (error: unknown) {
      throw new BrowserError(`text extraction failed: ${String(error)}`, 'BROWSER_ACTION_FAILED', { cause: error })
    }
    const normalized = raw.replace(/\n{3,}/g, '\n\n').trim()
    const truncated = normalized.length > this.config.maxTextChars
    return {
      url: page.url(),
      title,
      text: truncated ? normalized.slice(0, this.config.maxTextChars) : normalized,
      truncated,
    }
  }

  private async readTitle(): Promise<string> {
    try {
      return await this.requirePage().title()
    } catch (error: unknown) {
      throw new BrowserError(`title read failed: ${String(error)}`, 'BROWSER_ACTION_FAILED', { cause: error })
    }
  }

  private requirePage(): PageHandle {
    if (this.closing !== undefined) throw new BrowserError('browser session is closing', 'BROWSER_CLOSED')
    if (this.page === undefined) throw new BrowserError('no page open; navigate first', 'BROWSER_NO_PAGE')
    return this.page
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
    this.page = undefined
    this.handle = undefined
    if (handle === undefined) {
      this.closing = Promise.resolve()
      return this.closing
    }
    this.closing = handle.close()
    return this.closing
  }
}
