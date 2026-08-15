/**
 * The Playwright-backed `BrowserBackend`. Kept in its own module so `session.ts`
 * and the tool logic depend only on the minimal `BrowserBackend` interface and
 * stay testable without a real browser. Playwright is loaded lazily on first
 * launch, so composing the plugin never pays the import cost until the model
 * actually opens a page.
 * @module dsh-plugin-browser-use/playwright-backend
 */

import { existsSync } from 'node:fs'
import type { BrowserBackend, BrowserHandle, PageHandle } from './session.js'

/** Resolved launch options for the Chromium backend. */
export interface PlaywrightBackendOptions {
  /** Run without a visible window. Defaults to true; a headed run needs a display. */
  headless: boolean
  /** Explicit browser executable; omitted auto-detects and finally defers to Playwright's own resolution. */
  executablePath?: string
  /** User-Agent sent by the browser context. */
  userAgent: string
}

/** Well-known Chromium-family locations per platform, most stable first. */
const KNOWN_LOCATIONS: Partial<Readonly<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
}

/** Config → env → well-known OS locations; undefined defers to Playwright. */
function resolveExecutable(configured: string | undefined): string | undefined {
  if (configured !== undefined && configured.length > 0) return configured
  const fromEnv = process.env.DSH_BROWSER_EXECUTABLE
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  for (const candidate of KNOWN_LOCATIONS[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * A `BrowserBackend` that launches Chromium through `playwright-core`. The
 * heavy import is deferred to `launch()` so a composition that never navigates
 * imports nothing.
 */
export class PlaywrightBackend implements BrowserBackend {
  constructor(private readonly options: PlaywrightBackendOptions) {}

  async launch(): Promise<BrowserHandle> {
    const executablePath = resolveExecutable(this.options.executablePath)
    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch({
      headless: this.options.headless,
      ...executablePath !== undefined ? { executablePath } : {},
    })
    const context = await browser.newContext({ userAgent: this.options.userAgent })
    return {
      async newPage(): Promise<PageHandle> {
        const page = await context.newPage()
        return {
          goto: (url, opts) => page.goto(url, opts),
          url: () => page.url(),
          title: () => page.title(),
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
