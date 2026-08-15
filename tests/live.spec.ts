/**
 * Live smoke against a REAL Chromium. Self-skips (a capability fact, not a
 * cost signal) unless DSH_BROWSER_LIVE=1 and a browser binary resolves: set
 * DSH_BROWSER_EXECUTABLE, have a macOS Chrome installed, or a Playwright
 * browser under ~/.cache/ms-playwright.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { BrowserSession, BrowserError, type PageHandle } from '../src/session.js'
import { PlaywrightBackend } from '../src/playwright-backend.js'

/** Resolve a Chromium executable the way a user would supply one. */
function resolveExecutable(): string | undefined {
  const fromEnv = process.env.DSH_BROWSER_EXECUTABLE
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(macChrome)) return macChrome
  const cache = join(homedir(), '.cache', 'ms-playwright')
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith('chromium')) continue
      for (const platform of ['mac', 'mac-arm64', 'linux', 'linux-x64']) {
        const candidate = join(cache, entry, 'chrome-' + platform, 'chrome')
        if (existsSync(candidate)) return candidate
        const macApp = join(cache, entry, 'chrome-' + platform, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
        if (existsSync(macApp)) return macApp
      }
    }
  }
  return undefined
}

const enabled = process.env.DSH_BROWSER_LIVE === '1'
const executable = resolveExecutable()
const live = enabled && executable !== undefined

/** A cross-origin redirect double: 302 from loopback to an off-allowlist host. */
let redirectServer: Server | undefined
let redirectPort = 0
async function startRedirectServer(target: string): Promise<void> {
  await new Promise<void>(resolve => {
    redirectServer = createServer((request, response) => {
      response.writeHead(302, { location: target })
      response.end()
    })
    redirectServer.listen(0, '127.0.0.1', () => {
      const address = redirectServer?.address()
      redirectPort = typeof address === 'object' && address !== null ? address.port : 0
      resolve()
    })
  })
}

function backend(): PlaywrightBackend {
  return new PlaywrightBackend({
    headless: true,
    ...(executable !== undefined ? { executablePath: executable } : {}),
    userAgent: 'dsh-plugin-browser/live-test',
  })
}

afterAll(async () => {
  const server = redirectServer
  if (server === undefined) return
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe.skipIf(!live)('live Chromium smoke', { timeout: 120_000 }, () => {
  it(
    'navigates to https://example.com and reads title and text',
    async () => {
      const session = new BrowserSession(backend(), {
        policy: { allowedHosts: [], allowPrivateNetwork: false },
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 15_000,
        maxTextChars: 20_000,
      })
      try {
        const outcome = await session.navigate('https://example.com/')
        expect(outcome.url).toBe('https://example.com/')
        expect(outcome.statusCode).toBe(200)
        const reading = await session.readText()
        expect(reading.title).toContain('Example Domain')
        expect(reading.text.length).toBeGreaterThan(0)
        expect(reading.truncated).toBe(false)
      } finally {
        await session.close()
      }
    },
    120_000,
  )

  it(
    'refuses a loopback target by default with BROWSER_PRIVATE_NETWORK',
    async () => {
      const session = new BrowserSession(backend(), {
        policy: { allowedHosts: [], allowPrivateNetwork: false },
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 15_000,
        maxTextChars: 20_000,
      })
      try {
        await expect(session.navigate('http://127.0.0.1:1/')).rejects.toMatchObject({
          code: 'BROWSER_PRIVATE_NETWORK',
        } satisfies Partial<BrowserError>)
      } finally {
        await session.close()
      }
    },
    120_000,
  )

  it(
    'refuses a real cross-origin redirect landing off the allowlist',
    async () => {
      await startRedirectServer('https://example.org/')
      // The redirecting origin (loopback) is explicitly permitted AND
      // allowlisted; only the landed host is off the list, so the refusal can
      // come from the post-landing re-check alone — the redirect defense.
      const session = new BrowserSession(backend(), {
        policy: { allowedHosts: ['example.com', '127.0.0.1'], allowPrivateNetwork: true },
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 15_000,
        maxTextChars: 20_000,
      })
      try {
        const error = await session.navigate(`http://127.0.0.1:${redirectPort}/redirect`).catch((reason: unknown) => reason)
        expect(error).toBeInstanceOf(BrowserError)
        expect((error as BrowserError).code).toBe('BROWSER_HOST_NOT_ALLOWED')
        expect((error as BrowserError).message).toContain('example.org')
      } finally {
        await session.close()
      }
    },
    120_000,
  )

  it(
    'clicks a link that navigates within the allowlist and re-reads the landed page',
    async () => {
      const session = new BrowserSession(backend(), {
        policy: { allowedHosts: ['example.com'], allowPrivateNetwork: false },
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 15_000,
        maxTextChars: 20_000,
      })
      try {
        await session.navigate('https://example.com/')
        const page = (session as unknown as { page?: PageHandle }).page
        expect(page).toBeDefined()
        // example.com's classic page has one link (iana.org, off-allowlist):
        // clicking it must be refused by the post-click re-check.
        const outcome = session.click('a')
        await expect(outcome).rejects.toMatchObject({ code: 'BROWSER_HOST_NOT_ALLOWED' } satisfies Partial<BrowserError>)
      } finally {
        await session.close()
      }
    },
    120_000,
  )
})

describe.skipIf(live)('live smoke self-skip', () => {
  it('reports the capability fact, not a failure', () => {
    expect(live).toBe(false)
  })
})
