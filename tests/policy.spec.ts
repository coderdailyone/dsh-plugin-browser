/**
 * The security gate for dsh-plugin-browser-use: exhaustive tests over the
 * navigation policy. Every security rule the plugin's headline claim rests on
 * is pinned here with dedicated fail-before cases — mutate `hostMatches` to a
 * substring `includes` and the lookalike block goes red (verified during
 * development by introducing exactly that regression).
 */
import { describe, expect, it } from 'vitest'
import { describeDenial, evaluateUrl, hostMatches, isPrivateHost, type NavigationPolicy } from '../src/policy.js'

const allowAll: NavigationPolicy = { allowedHosts: [], allowPrivateNetwork: false }

describe('hostMatches', () => {
  it('matches the exact host', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true)
  })

  it('matches a subdomain of the pattern host', () => {
    expect(hostMatches('www.example.com', 'example.com')).toBe(true)
    expect(hostMatches('a.b.example.com', 'example.com')).toBe(true)
  })

  it('matches a leading-dot pattern identically to the bare pattern', () => {
    expect(hostMatches('example.com', '.example.com')).toBe(true)
    expect(hostMatches('www.example.com', '.example.com')).toBe(true)
    expect(hostMatches('evil.test', '.example.com')).toBe(false)
  })

  it('never matches a lookalike authority that merely contains the pattern', () => {
    // The browser-use GHSA bug class: substring matching lets
    // `example.com.evil.test` and `evil-example.com` through.
    expect(hostMatches('example.com.evil.test', 'example.com')).toBe(false)
    expect(hostMatches('evil-example.com', 'example.com')).toBe(false)
    expect(hostMatches('notexample.com', 'example.com')).toBe(false)
    expect(hostMatches('example.company', 'example.com')).toBe(false)
  })

  it('never matches a pattern appearing only in a query or path', () => {
    expect(hostMatches('evil.test', 'example.com')).toBe(false)
  })

  it('matches only on whole host labels (deep-suffix must align a dot)', () => {
    expect(hostMatches('xexample.com', 'example.com')).toBe(false)
    expect(hostMatches('www.xexample.com', 'example.com')).toBe(false)
  })

  it('is case-insensitive, trims pattern whitespace and dots, and tolerates a host FQDN trailing dot', () => {
    expect(hostMatches('EXAMPLE.com', 'Example.COM ')).toBe(true)
    expect(hostMatches('example.com', '.example.com.')).toBe(true)
  })

  it('rejects an empty or dot-only pattern', () => {
    expect(hostMatches('example.com', '')).toBe(false)
    expect(hostMatches('example.com', '.')).toBe(false)
    expect(hostMatches('example.com', '   ')).toBe(false)
  })

  it('treats an FQDN trailing-dot host as the same host, but never a deeper suffix smuggle', () => {
    expect(hostMatches('example.com.', 'example.com')).toBe(true)
    expect(hostMatches('a.example.com.', 'example.com')).toBe(true)
    expect(hostMatches('evil.test.', 'example.com')).toBe(false)
    expect(hostMatches('example.com..', 'example.com')).toBe(false)
  })
})

describe('isPrivateHost', () => {
  it('blocks localhost and *.localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('app.localhost')).toBe(true)
    expect(isPrivateHost('evil-localhost')).toBe(false)
  })

  it('blocks the IPv4 private, loopback, link-local, CGNAT, and this-host ranges', () => {
    for (const host of [
      '10.0.0.1', '10.255.255.255',
      '127.0.0.1', '127.8.8.8',
      '0.0.0.0', '0.1.2.3',
      '192.168.1.1', '192.168.0.100',
      '169.254.169.254', '169.254.1.1',
      '172.16.0.1', '172.31.255.255',
      '100.64.0.1', '100.127.255.255',
    ]) {
      expect(isPrivateHost(host), host).toBe(true)
    }
  })

  it('permits public IPv4 hosts just outside those ranges', () => {
    for (const host of [
      '8.8.8.8', '9.255.255.255', '11.0.0.1',
      '126.255.255.255', '128.0.0.1',
      '172.15.255.255', '172.32.0.1',
      '100.63.255.255', '100.128.0.1',
      '192.169.0.1', '192.167.255.255', '169.255.0.1', '169.253.0.1',
    ]) {
      expect(isPrivateHost(host), host).toBe(false)
    }
  })

  it('blocks the IPv6 loopback, unspecified, unique-local, link-local, and IPv4-mapped literals, bracketed or bare', () => {
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('::')).toBe(true)
    expect(isPrivateHost('fc00::1')).toBe(true)
    expect(isPrivateHost('fdab:cd::1')).toBe(true)
    expect(isPrivateHost('fe80::1')).toBe(true)
    // Node's URL keeps brackets in `hostname`; both spellings must classify.
    expect(isPrivateHost('[fd00::1]')).toBe(true)
    expect(isPrivateHost('[::1]')).toBe(true)
    // IPv4-mapped loopback in both dotted and canonical-hex spelling.
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true)
    expect(isPrivateHost('[::ffff:10.0.0.1]')).toBe(true)
    // Unparseable mapped forms fail closed.
    expect(isPrivateHost('::ffff:zz')).toBe(true)
  })

  it('permits public IPv6 and ordinary names (an fc/fd domain name is NOT a private literal)', () => {
    expect(isPrivateHost('2606:4700::1111')).toBe(false)
    expect(isPrivateHost('[2606:4700::1111]')).toBe(false)
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('fc.example.com')).toBe(false)
    expect(isPrivateHost('fd.test')).toBe(false)
    expect(isPrivateHost('localhost.example.com')).toBe(false)
  })

  it('does not treat a non-quad or out-of-range literal as IPv4', () => {
    expect(isPrivateHost('10.0.0')).toBe(false)
    expect(isPrivateHost('10.0.0.256')).toBe(false)
    expect(isPrivateHost('10.0.0.0.1')).toBe(false)
    expect(isPrivateHost('127.0.0.one')).toBe(false)
  })
})

describe('evaluateUrl', () => {
  it('returns the parsed URL and lowercased host for a public https target', () => {
    const verdict = evaluateUrl('https://Example.COM/path?q=1', allowAll)
    expect('url' in verdict).toBe(true)
    if (!('url' in verdict)) throw new Error('unreachable')
    expect(verdict.url).toBeInstanceOf(URL)
    expect(verdict.host).toBe('example.com')
    expect(verdict.url.hostname).toBe('example.com')
  })

  it('refuses an invalid URL', () => {
    expect(evaluateUrl('not a url', allowAll)).toEqual({ kind: 'invalid-url' })
    expect(evaluateUrl('', allowAll)).toEqual({ kind: 'invalid-url' })
    expect(evaluateUrl('/relative/path', allowAll)).toEqual({ kind: 'invalid-url' })
  })

  it('refuses every non-http(s) scheme by name', () => {
    expect(evaluateUrl('file:///etc/passwd', allowAll)).toEqual({ kind: 'unsupported-scheme', scheme: 'file' })
    expect(evaluateUrl('data:text/html,hi', allowAll)).toEqual({ kind: 'unsupported-scheme', scheme: 'data' })
    expect(evaluateUrl('javascript:alert(1)', allowAll)).toEqual({ kind: 'unsupported-scheme', scheme: 'javascript' })
    expect(evaluateUrl('chrome://version', allowAll)).toEqual({ kind: 'unsupported-scheme', scheme: 'chrome' })
    expect(evaluateUrl('ftp://example.com/', allowAll)).toEqual({ kind: 'unsupported-scheme', scheme: 'ftp' })
    expect(evaluateUrl('about:blank', allowAll)).toEqual({ kind: 'unsupported-scheme', scheme: 'about' })
  })

  it('blocks private literals (IPv4, IPv6, mapped, bracketed) by default and permits them when allowPrivateNetwork is on', () => {
    const permissive: NavigationPolicy = { allowedHosts: [], allowPrivateNetwork: true }
    expect(evaluateUrl('http://127.0.0.1:8080/', allowAll)).toEqual({ kind: 'private-network', host: '127.0.0.1' })
    expect(evaluateUrl('http://localhost/', allowAll)).toEqual({ kind: 'private-network', host: 'localhost' })
    expect(evaluateUrl('http://192.168.1.10/admin', allowAll)).toEqual({ kind: 'private-network', host: '192.168.1.10' })
    expect(evaluateUrl('http://[fd00::1]/', allowAll)).toEqual({ kind: 'private-network', host: 'fd00::1' })
    expect(evaluateUrl('http://[::1]/', allowAll)).toEqual({ kind: 'private-network', host: '::1' })
    // The parser hands us the hex spelling; the mapped reduction still blocks.
    expect(evaluateUrl('http://[::ffff:127.0.0.1]/', allowAll)).toEqual({ kind: 'private-network', host: '::ffff:7f00:1' })
    expect(evaluateUrl('http://[2606:4700::1111]/', allowAll)).toMatchObject({ host: '2606:4700::1111' })
    expect(evaluateUrl('http://127.0.0.1:8080/', permissive)).toMatchObject({ host: '127.0.0.1' })
    expect(evaluateUrl('http://localhost/', permissive)).toMatchObject({ host: 'localhost' })
    expect(evaluateUrl('http://[fd00::1]/', permissive)).toMatchObject({ host: 'fd00::1' })
  })

  it('checks the private rule before an empty allowlist clears everything', () => {
    // Even with no allowlist, loopback stays blocked: the two rules are
    // independent and order-stable.
    expect(evaluateUrl('https://169.254.169.254/latest/meta-data/', allowAll)).toEqual({
      kind: 'private-network',
      host: '169.254.169.254',
    })
  })

  it('with a populated allowlist, refuses off-list hosts on host labels', () => {
    const policy: NavigationPolicy = { allowedHosts: ['example.com'], allowPrivateNetwork: false }
    expect(evaluateUrl('https://example.com/', policy)).toMatchObject({ host: 'example.com' })
    expect(evaluateUrl('https://www.example.com/', policy)).toMatchObject({ host: 'www.example.com' })
    expect(evaluateUrl('https://example.com.evil.test/', policy)).toEqual({ kind: 'host-not-allowed', host: 'example.com.evil.test' })
    expect(evaluateUrl('https://evil-example.com/', policy)).toEqual({ kind: 'host-not-allowed', host: 'evil-example.com' })
    expect(evaluateUrl('https://evil.test/?x=example.com', policy)).toEqual({ kind: 'host-not-allowed', host: 'evil.test' })
    expect(evaluateUrl('https://sub.example.com.attacker.test/', policy)).toEqual({
      kind: 'host-not-allowed',
      host: 'sub.example.com.attacker.test',
    })
  })

  it('with an empty allowlist, permits any public host', () => {
    for (const url of ['https://example.com/', 'https://any-other.org/x', 'http://93.184.216.34/']) {
      expect(evaluateUrl(url, allowAll)).toMatchObject({ host: expect.any(String) })
    }
  })

  it('blocks a private host even when the allowlist names it (private rule wins)', () => {
    const policy: NavigationPolicy = { allowedHosts: ['localhost', '127.0.0.1'], allowPrivateNetwork: false }
    expect(evaluateUrl('http://localhost/', policy)).toEqual({ kind: 'private-network', host: 'localhost' })
    expect(evaluateUrl('http://127.0.0.1/', policy)).toEqual({ kind: 'private-network', host: '127.0.0.1' })
  })
})

describe('describeDenial', () => {
  it('renders one readable sentence per denial kind', () => {
    expect(describeDenial({ kind: 'invalid-url' })).toBe('the target is not a valid absolute URL')
    expect(describeDenial({ kind: 'unsupported-scheme', scheme: 'file' })).toBe('scheme "file" is not navigable; only http and https are allowed')
    expect(describeDenial({ kind: 'private-network', host: '127.0.0.1' })).toContain('private/loopback')
    expect(describeDenial({ kind: 'host-not-allowed', host: 'evil.test' })).toContain('not in the configured allowlist')
  })
})
