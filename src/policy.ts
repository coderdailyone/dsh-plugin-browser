/**
 * Navigation policy for the browser tool: which URLs a model-driven browser may
 * reach. The rules are deliberately host-based and re-checked on every action,
 * never a one-time substring match, because a model that can navigate can also
 * follow a link, submit a form, or trigger a redirect to somewhere the initial
 * check never saw.
 * @module dsh-plugin-browser/policy
 */

/** Resolved navigation policy applied to every URL the browser is asked to reach. */
export interface NavigationPolicy {
  /**
   * Allowed host patterns. Empty = allow any public host (subject to the
   * private-network rule). A pattern matches a URL's host, never its full URL:
   * `example.com` matches `example.com` and (with the leading dot) its
   * subdomains, and is compared against the parsed `URL.hostname` so a
   * lookalike authority such as `example.com.evil.test` or
   * `evil.test/?x=example.com` never matches.
   */
  readonly allowedHosts: readonly string[]
  /** Permit `http:`/`https:` only when true also covers loopback/private ranges. */
  readonly allowPrivateNetwork: boolean
}

/** Why a URL was refused; carried on the thrown error for the model to read. */
export type PolicyDenial =
  | { kind: 'invalid-url' }
  | { kind: 'unsupported-scheme'; scheme: string }
  | { kind: 'private-network'; host: string }
  | { kind: 'host-not-allowed'; host: string }

/** A URL cleared by the policy, decomposed for the caller. */
export interface PolicyAllowed {
  readonly url: URL
  readonly host: string
}

/** Only these schemes are ever navigable; everything else is refused by scheme. */
const NAVIGABLE_SCHEMES = new Set(['http:', 'https:'])

/**
 * Decide whether `rawUrl` may be navigated to under `policy`. Returns the
 * parsed URL on success or a structured denial; it never throws and never
 * performs I/O (DNS is not resolved here — the private-network rule blocks
 * literal private authorities and leaves DNS-rebinding defense to the browser
 * context's own network, matching the fetch seam's posture).
 * @param rawUrl - the model-supplied navigation target.
 * @param policy - the resolved navigation policy.
 * @returns the parsed URL/host, or a structured `PolicyDenial`.
 */
export function evaluateUrl(rawUrl: string, policy: NavigationPolicy): PolicyAllowed | PolicyDenial {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'invalid-url' }
  }
  if (!NAVIGABLE_SCHEMES.has(url.protocol)) {
    return { kind: 'unsupported-scheme', scheme: url.protocol.replace(/:$/, '') }
  }
  // Node's URL keeps IPv6 brackets in `hostname`; strip them (plus one FQDN
  // trailing dot) so every downstream check sees one canonical host form.
  const host = canonicalHost(url.hostname)
  if (!policy.allowPrivateNetwork && isPrivateHost(host)) {
    return { kind: 'private-network', host }
  }
  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.some(pattern => hostMatches(host, pattern))) {
    return { kind: 'host-not-allowed', host }
  }
  return { url, host }
}

/**
 * Canonical host form: lowercased, IPv6 brackets stripped, one trailing dot
 * dropped (the DNS root label). A double trailing dot survives as a mismatch
 * everywhere, so nothing fail-opens.
 */
function canonicalHost(hostname: string): string {
  let host = hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

/**
 * Match a URL host against one allowlist pattern. A bare pattern matches that
 * exact host; a `.`-prefixed pattern (or the same bare host) additionally
 * matches any subdomain. Matching is on host labels, so `evil-example.com`
 * never matches `example.com` and a pattern can never match a partial label.
 * @param host - the lowercased URL hostname.
 * @param pattern - one allowlist entry.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
  if (normalized.length === 0) return false
  const canonical = canonicalHost(host)
  if (canonical === normalized) return true
  return canonical.endsWith(`.${normalized}`)
}

/**
 * True for a host literal that names the local machine or a private/reserved
 * range. Only literal authorities are classified here; a public name that
 * resolves to a private address is out of scope (see {@link evaluateUrl}).
 * Accepts the raw or bracket-stripped IPv6 spelling.
 * @param host - the URL hostname (any case; brackets and one trailing dot tolerated).
 */
export function isPrivateHost(host: string): boolean {
  const canonical = canonicalHost(host)
  if (canonical === 'localhost' || canonical.endsWith('.localhost')) return true
  // A colon can occur in a URL host only for an IPv6 literal (brackets are
  // already stripped), which guards the hex-prefix checks below from ever
  // firing on an ordinary domain name such as `fc.example.com`.
  if (canonical.includes(':')) {
    if (canonical === '::1' || canonical === '::') return true
    // IPv4-mapped literals reduce to their embedded IPv4; the URL parser may
    // hand us either the dotted (`::ffff:127.0.0.1`) or the canonical hex
    // (`::ffff:7f00:1`) spelling, so accept both. Anything else under
    // `::ffff:` fails closed.
    const mapped = /^::ffff:(.*)$/.exec(canonical)
    if (mapped !== null) {
      const embedded = mapped[1] ?? ''
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(embedded)) return isPrivateHost(embedded)
      const groups = embedded.split(':').filter(group => group.length > 0)
      if (groups.length === 2 && groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) {
        const high = Number.parseInt(groups[0] ?? '', 16)
        const low = Number.parseInt(groups[1] ?? '', 16)
        return isPrivateHost(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`)
      }
      return true
    }
    // Unique-local (fc00::/7, i.e. fc*/fd*), link-local (fe80::/10). The
    // prefix test is deliberately conservative: a public literal such as
    // `fce::1` is refused too — fail closed beats fail open here.
    if (canonical.startsWith('fc') || canonical.startsWith('fd') || canonical.startsWith('fe80:')) return true
    return false
  }
  const ipv4 = parseIpv4(canonical)
  if (ipv4 === undefined) return false
  const [a, b] = ipv4
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  return false
}

/** Parse a dotted-quad IPv4 literal, or undefined when `host` is not one. */
function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  const nums = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (nums.some(n => Number.isNaN(n) || n < 0 || n > 255)) return undefined
  return nums as [number, number, number, number]
}

/** Render a denial as a model-facing sentence. */
export function describeDenial(denial: PolicyDenial): string {
  switch (denial.kind) {
    case 'invalid-url':
      return 'the target is not a valid absolute URL'
    case 'unsupported-scheme':
      return `scheme "${denial.scheme}" is not navigable; only http and https are allowed`
    case 'private-network':
      return `host "${denial.host}" is a private/loopback address, blocked by default; enable allowPrivateNetwork to permit it`
    case 'host-not-allowed':
      return `host "${denial.host}" is not in the configured allowlist`
  }
}
