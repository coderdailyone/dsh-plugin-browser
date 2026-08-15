/**
 * The five model-facing browser tools and the owner-isolated session registry
 * they dispatch through. Each agent session gets its own lazily-launched
 * browser page (owner isolation); calls on one owner's page serialize through
 * a promise chain, matching a human driving one tab. Every canonical return is
 * a programmatic object (`url`/`title`/`statusCode`/`text`/`truncated`), so
 * Code Mode reaches the fields for free; `output.render` writes the
 * human/model-facing text.
 * @module dsh-plugin-browser/tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { BrowserError, BrowserSession, type BrowserBackend } from './session.js'
import type { NavigationPolicy } from './policy.js'

/** Resolved deployment tunables the tools close over. */
export interface BrowserToolOptions {
  /** Factory creating one session per owner (fresh config snapshot per owner). */
  readonly backend: BrowserBackend
  /** The navigation policy re-checked on every action and read. */
  readonly policy: NavigationPolicy
  readonly navigationTimeoutMs: number
  readonly actionTimeoutMs: number
  readonly maxTextChars: number
}

/** Owner key for a call without an agent: all anonymous calls share one session. */
const UNOWNED_KEY = '\0unowned'

/** Cooperative budget headroom added to each Playwright timeout, for extraction. */
const TIMEOUT_HEADROOM_MS = 10_000

/** The notice appended when the page text was cut at `maxTextChars`. */
const TRUNCATION_FOOTER = '\n\n(Page text truncated. Narrow the target or re-read after interacting.)'

/** Resolve the per-owner session key from an execution's agent identity. */
function ownerKeyOf(exec: { readonly agent?: { readonly session: { readonly id: unknown } } }): string {
  const id = exec.agent?.session.id
  return typeof id === 'string' ? id : UNOWNED_KEY
}

/** One owner's session plus the promise chain serializing its operations. */
class OwnedSession {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly session: BrowserSession) {}

  /**
   * Queue one operation on the owner's page. Overlapping model calls run in
   * submission order; a failed operation does not break the chain.
   */
  run<T>(op: (session: BrowserSession) => Promise<T>): Promise<T> {
    const result = this.chain.then(
      () => op(this.session),
      () => op(this.session),
    )
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/**
 * The owner-isolated session registry: one `BrowserSession` per agent session
 * id. Creating the plugin's fiber teardown closes every session.
 */
export class BrowserSessions {
  private readonly owned = new Map<string, OwnedSession>()

  constructor(private readonly factory: () => BrowserSession) {}

  /** Resolve-or-create the caller's owned session. */
  for(key: string): OwnedSession {
    let owned = this.owned.get(key)
    if (owned === undefined) {
      owned = new OwnedSession(this.factory())
      this.owned.set(key, owned)
    }
    return owned
  }

  /** Idempotently close and forget one owner's session. */
  async close(key: string): Promise<void> {
    const owned = this.owned.get(key)
    if (owned === undefined) return
    this.owned.delete(key)
    await owned.session.close()
  }

  /** Close every session (plugin fiber teardown). Awaits all closes. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.owned.keys()].map(key => this.close(key)))
  }

  /** Number of live (created, not yet closed) owner sessions. */
  get size(): number {
    return this.owned.size
  }
}

/**
 * Race one session operation against the caller's cancellation signal.
 * Playwright accepts no AbortSignal; on abort the tool settles immediately
 * with `BROWSER_ABORTED` while the page's own operation may still settle in
 * the background (never killing the shared browser) — v1 posture, documented.
 */
function raceAbort<T>(signal: AbortSignal, op: Promise<T>): Promise<T> {
  if (signal.aborted) {
    void op.catch(() => undefined)
    throw new BrowserError('browser call aborted before dispatch', 'BROWSER_ABORTED')
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new BrowserError('browser call aborted', 'BROWSER_ABORTED'))
    }
    function cleanup(): void {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    op.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

/** Narrow an unknown thrown value to a model-readable message. */
export function describeError(error: unknown): string {
  if (error instanceof BrowserError) return error.message
  return String(error)
}

/** Model-facing text for a landed page reading. */
function formatReading(header: string, value: { readonly statusCode?: number; readonly text: string; readonly truncated: boolean }): string {
  const status = value.statusCode !== undefined ? ` (HTTP ${value.statusCode})` : ''
  const body = `${header}${status}\n\n${value.text}${value.truncated ? TRUNCATION_FOOTER : ''}`
  return body
}

/** One bounded model-facing text block. */
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Bounded excerpt of a page reading for the completed-call card title. */
function readingTitle(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const { url } = meta as { url?: unknown }
  return typeof url === 'string' ? url : undefined
}

/**
 * Create the five browser tool definitions over an owner-isolated registry.
 * Each `execute` resolves the caller's session, serializes onto it, and races
 * the caller's cancellation signal; policy denials and backend failures throw
 * `BrowserError`, which the tool registry materializes as `isError` results.
 */
export function createBrowserTools(registry: BrowserSessions, options: BrowserToolOptions): ToolDefinition[] {
  const sessionConfig = {
    policy: options.policy,
    navigationTimeoutMs: options.navigationTimeoutMs,
    actionTimeoutMs: options.actionTimeoutMs,
    maxTextChars: options.maxTextChars,
  }
  const newSession = (): BrowserSession => new BrowserSession(options.backend, sessionConfig)

  const navigate = defineTool({
    name: 'browser_navigate',
    description:
      'Open a URL in the session browser page (creating the page on first use) and return the landed URL, title, HTTP status, and the page text. Only http/https targets pass the navigation policy; redirects and scripted navigation are re-checked after landing.',
    parameters: {
      url: { type: 'string', required: true, description: 'The absolute http(s) URL to navigate to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true, description: 'The landed URL after redirects.' },
          title: { type: 'string', required: true, description: 'The landed page title.' },
          statusCode: { type: 'integer', description: 'HTTP status of the main navigation response, when recorded.' },
          text: { type: 'string', required: true, description: 'The page visible text, bounded by maxTextChars.' },
          truncated: { type: 'boolean', required: true, description: 'Whether the page text was cut at maxTextChars.' },
        },
      },
      render: (_args, value) => textBlock(formatReading(`Opened ${value.url}`, value)),
      presentationMeta: (_args, value) => ({ url: value.url, title: value.title, truncated: value.truncated }),
    },
    timeoutMs: options.navigationTimeoutMs + TIMEOUT_HEADROOM_MS,
    async execute(args, exec) {
      const owned = registry.for(ownerKeyOf(exec))
      return raceAbort(
        exec.signal,
        owned.run(async session => {
          const outcome = await session.navigate(args.url)
          const reading = await session.readText()
          return {
            url: reading.url,
            title: reading.title,
            ...outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {},
            text: reading.text,
            truncated: reading.truncated,
          }
        }),
      )
    },
    presentCall: args => ({ card: 'generic', title: args.url, kind: 'fetch', rawInput: args.url }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined
      const title = readingTitle(result.meta)
      return title === undefined ? undefined : { card: 'generic', title }
    },
  })

  const click = defineTool({
    name: 'browser_click',
    description:
      'Click an element on the current browser page by CSS selector, then return the landed URL, title, and page text. The URL after the click is re-checked against the navigation policy.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the element to click.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(formatReading(`At ${value.url}`, value)),
      presentationMeta: (_args, value) => ({ url: value.url, title: value.title, truncated: value.truncated }),
    },
    timeoutMs: options.actionTimeoutMs + TIMEOUT_HEADROOM_MS,
    async execute(args, exec) {
      const owned = registry.for(ownerKeyOf(exec))
      return raceAbort(
        exec.signal,
        owned.run(async session => {
          await session.click(args.selector)
          const reading = await session.readText()
          return { url: reading.url, title: reading.title, text: reading.text, truncated: reading.truncated }
        }),
      )
    },
    presentCall: args => ({ card: 'generic', title: `Click ${args.selector}`, kind: 'execute', rawInput: args.selector }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined
      const title = readingTitle(result.meta)
      return title === undefined ? undefined : { card: 'generic', title }
    },
  })

  const fill = defineTool({
    name: 'browser_fill',
    description: 'Fill a form field on the current browser page by CSS selector, then return the landed URL and title.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the input to fill.' },
      value: { type: 'string', required: true, description: 'The text to type into the field.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (args, value) => textBlock(`Filled ${args.selector}\nAt ${value.url}\nTitle: ${value.title}`),
      presentationMeta: (_args, value) => ({ url: value.url, title: value.title }),
    },
    timeoutMs: options.actionTimeoutMs + TIMEOUT_HEADROOM_MS,
    async execute(args, exec) {
      const owned = registry.for(ownerKeyOf(exec))
      return raceAbort(exec.signal, owned.run(session => session.fill(args.selector, args.value)))
    },
    presentCall: args => ({ card: 'generic', title: `Fill ${args.selector}`, kind: 'edit', rawInput: { selector: args.selector, value: args.value } }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined
      const title = readingTitle(result.meta)
      return title === undefined ? undefined : { card: 'generic', title }
    },
  })

  const readText = defineTool({
    name: 'browser_read_text',
    description:
      'Re-read the current browser page: its (policy re-checked) URL, title, and visible text — after JavaScript has settled or an interaction changed the page.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(formatReading(`At ${value.url}`, value)),
      presentationMeta: (_args, value) => ({ url: value.url, title: value.title, truncated: value.truncated }),
    },
    timeoutMs: options.actionTimeoutMs + TIMEOUT_HEADROOM_MS,
    async execute(_args, exec) {
      const owned = registry.for(ownerKeyOf(exec))
      return raceAbort(exec.signal, owned.run(session => session.readText()))
    },
    presentCall: () => ({ card: 'generic', title: 'Read page text', kind: 'read', rawInput: undefined }),
    presentResult: (_args, result) => {
      if (result.isError) return undefined
      const title = readingTitle(result.meta)
      return title === undefined ? undefined : { card: 'generic', title }
    },
  })

  const close = defineTool({
    name: 'browser_close',
    description: 'Close this session\'s browser page (idempotent). A later navigation opens a fresh page.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
        },
      },
      render: () => textBlock('Browser closed.'),
      presentationMeta: () => ({}),
    },
    timeoutMs: 15_000,
    async execute(_args, exec) {
      await raceAbort(exec.signal, registry.close(ownerKeyOf(exec)))
      return { closed: true }
    },
    presentCall: () => ({ card: 'generic', title: 'Close browser', kind: 'other', rawInput: undefined }),
    presentResult: (_args, result) => (result.isError ? undefined : { card: 'generic', title: 'Browser closed' }),
  })

  return [navigate, click, fill, readText, close]
}
