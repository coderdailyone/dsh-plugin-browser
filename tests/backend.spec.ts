/**
 * Pure-helper tests for the Playwright backend: proxy resolution and the
 * private launch environment. No real browser involved.
 */
import { describe, expect, it } from 'vitest'
import { sep } from 'node:path'
import { buildLaunchEnv, resolveProxy } from '../src/playwright-backend.js'
import { truncateText } from '../src/session.js'

describe('resolveProxy', () => {
  it('returns undefined when nothing is configured', () => {
    expect(resolveProxy({}, {})).toBeUndefined()
  })

  it('prefers explicit config over the environment', () => {
    expect(resolveProxy({ server: 'http://cfg:1' }, { DSH_BROWSER_PROXY: 'http://env:2' }))
      .toEqual({ server: 'http://cfg:1' })
  })

  it('falls back to $DSH_BROWSER_PROXY', () => {
    expect(resolveProxy({}, { DSH_BROWSER_PROXY: 'socks5://127.0.0.1:1080' }))
      .toEqual({ server: 'socks5://127.0.0.1:1080' })
  })

  it('ignores an empty env value', () => {
    expect(resolveProxy({}, { DSH_BROWSER_PROXY: '' })).toBeUndefined()
  })

  it('carries a configured bypass list alongside the server', () => {
    expect(resolveProxy({ server: 'http://p:1', bypass: 'localhost,127.0.0.1' }, {}))
      .toEqual({ server: 'http://p:1', bypass: 'localhost,127.0.0.1' })
  })

  it('applies the bypass to an env-resolved server too', () => {
    expect(resolveProxy({ bypass: 'localhost' }, { DSH_BROWSER_PROXY: 'http://env:2' }))
      .toEqual({ server: 'http://env:2', bypass: 'localhost' })
  })
})

describe('buildLaunchEnv', () => {
  it('points HOME and every XDG dir into the private home', () => {
    const env = buildLaunchEnv({ PATH: '/usr/bin', HOME: '/home/real' }, '/tmp/private')
    expect(env.HOME).toBe('/tmp/private')
    expect(env.XDG_CONFIG_HOME).toBe(['/tmp/private', '.config'].join(sep))
    expect(env.XDG_CACHE_HOME).toBe(['/tmp/private', '.cache'].join(sep))
    expect(env.XDG_DATA_HOME).toBe(['/tmp/private', '.local', 'share'].join(sep))
  })

  it('preserves unrelated variables and drops undefined ones', () => {
    const env = buildLaunchEnv({ PATH: '/usr/bin', EMPTY: undefined, XDG_CONFIG_HOME: '/home/real/.config' }, '/tmp/p')
    expect(env.PATH).toBe('/usr/bin')
    expect('EMPTY' in env).toBe(false)
    expect(env.XDG_CONFIG_HOME).toBe(['/tmp/p', '.config'].join(sep))
  })
})

describe('truncateText', () => {
  it('passes short text through untouched', () => {
    expect(truncateText('hello', 10)).toEqual({ text: 'hello', truncated: false })
  })

  it('cuts at the limit for plain text', () => {
    expect(truncateText('abcdef', 3)).toEqual({ text: 'abc', truncated: true })
  })

  it('never splits a surrogate pair at the cut', () => {
    const text = 'ab😀cd' // 😀 occupies indices 2-3
    const cut = truncateText(text, 3)
    expect(cut.truncated).toBe(true)
    expect(cut.text).toBe('ab')
    expect((cut.text.charCodeAt(cut.text.length - 1) & 0xfc00) === 0xd800).toBe(false)
  })

  it('keeps a pair that fits exactly inside the limit', () => {
    expect(truncateText('ab😀cd', 4)).toEqual({ text: 'ab😀', truncated: true })
  })
})
