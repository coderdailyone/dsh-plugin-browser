/**
 * The Playwright-backed `BrowserBackend`. Kept in its own module so `session.ts`
 * and the tool logic depend only on the minimal `BrowserBackend` interface and
 * stay testable without a real browser. Playwright is loaded lazily on first
 * launch, so composing the plugin never pays the import cost until the model
 * actually opens a page.
 * @module dsh-plugin-browser/playwright-backend
 */

import type { BrowserBackend, BrowserHandle, PageHandle } from './session.js'

/** Resolved launch options for the Chromium backend. */
export interface PlaywrightBackendOptions {
  /** Run without a visible window. Defaults to true; a headed run needs a display. */
  headless: boolean
  /** Explicit browser executable; omitted uses Playwright's bundled/os Chromium. */
  executablePath?: string
  /** User-Agent sent by the browser context. */
  userAgent: string
}

/**
 * A `BrowserBackend` that launches Chromium through `playwright-core`. The
 * heavy import is deferred to `launch()` so a composition that never navigates
 * imports nothing.
 */
export class PlaywrightBackend implements BrowserBackend {
  constructor(private readonly options: PlaywrightBackendOptions) {}

  async launch(): Promise<BrowserHandle> {
    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch({
      headless: this.options.headless,
      ...this.options.executablePath !== undefined ? { executablePath: this.options.executablePath } : {},
    })
    const context = await browser.newContext({ userAgent: this.options.userAgent })
    return {
      async newPage(): Promise<PageHandle> {
        const page = await context.newPage()
        return {
          goto: (url, opts) => page.goto(url, opts),
          url: () => page.url(),
          title: () => page.title(),
          content: () => page.content(),
          click: (selector, opts) => page.click(selector, opts),
          fill: (selector, value, opts) => page.fill(selector, value, opts),
          evaluate: <T>(fn: string) => page.evaluate(fn) as Promise<T>,
        }
      },
      async close(): Promise<void> {
        await browser.close()
      },
    }
  }
}
