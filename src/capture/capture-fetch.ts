/**
 * Runs in the page's MAIN world. Patches window.fetch and XMLHttpRequest so any auth/identity
 * header the bank's SPA sends gets captured and forwarded to the extension via postMessage.
 *
 * MAIN world is required because in ISOLATED we'd be patching a different `window.fetch`,
 * leaving the page's calls untouched. Manifest V3 supports `world: "MAIN"` directly in the
 * content_scripts entry — no need to inject a <script> tag.
 *
 * We do NOT capture every header — only ones that look like auth/identity (Authorization,
 * x-* customs, csrf-token). Cookies don't appear here (HttpOnly is invisible to JS), and
 * we filter out automatic browser headers (User-Agent, Accept-*).
 */
;(() => {
  const TAG = 'afino-capture'
  console.log('[afino-capture] MAIN world loaded on', location.host)
  const INTERESTING_PREFIXES = ['x-']
  // Short-named identity headers some banks require alongside Bearer tokens (e.g. Inter's `cpfcnpj`
  // and `cardaccount` for credit-card endpoints, Itaú's `client_id`). Bare names are matched
  // verbatim — prefix-based capture would be too permissive.
  const INTERESTING_NAMES = new Set([
    'authorization',
    'csrf-token',
    'x-csrf-token',
    'cpfcnpj',
    'cardaccount',
    'client_id',
  ])
  const BORING = new Set([
    'accept',
    'accept-language',
    'accept-encoding',
    'user-agent',
    'referer',
    'origin',
    'content-type',
    'content-length',
    'cache-control',
    'pragma',
    'dnt',
    'priority',
  ])

  function isInteresting(name: string): boolean {
    const n = name.toLowerCase()
    if (BORING.has(n)) return false
    if (INTERESTING_NAMES.has(n)) return true
    if (n.startsWith('sec-')) return false
    if (INTERESTING_PREFIXES.some((p) => n.startsWith(p))) return true
    return false
  }

  function emit(host: string, headers: Record<string, string>): void {
    if (!host || Object.keys(headers).length === 0) return
    window.postMessage({ source: TAG, host, headers, ts: Date.now() }, '*')
  }

  function flatten(input: HeadersInit | undefined): Record<string, string> {
    const out: Record<string, string> = {}
    if (!input) return out
    if (input instanceof Headers) {
      input.forEach((v, k) => {
        if (isInteresting(k)) out[k.toLowerCase()] = v
      })
      return out
    }
    if (Array.isArray(input)) {
      for (const [k, v] of input) {
        if (isInteresting(k)) out[k.toLowerCase()] = v
      }
      return out
    }
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === 'string' && isInteresting(k)) out[k.toLowerCase()] = v
    }
    return out
  }

  // ---- fetch ----
  const origFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      let url: string
      const collected: Record<string, string> = {}
      if (input instanceof Request) {
        url = input.url
        input.headers.forEach((v, k) => {
          if (isInteresting(k)) collected[k.toLowerCase()] = v
        })
      } else {
        url = typeof input === 'string' ? input : input.toString()
      }
      Object.assign(collected, flatten(init?.headers))
      if (Object.keys(collected).length > 0) {
        const u = new URL(url, location.href)
        emit(u.host, collected)
      }
    } catch {
      // capturing must never break the page's own request
    }
    return origFetch(input as RequestInfo, init)
  }

  // ---- XMLHttpRequest ----
  type XhrPlus = XMLHttpRequest & { __afinoUrl?: string; __afinoHeaders?: Record<string, string> }

  const origOpen = XMLHttpRequest.prototype.open
  const origSetReq = XMLHttpRequest.prototype.setRequestHeader
  const origSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (this: XhrPlus, ...args: unknown[]) {
    const url = args[1]
    this.__afinoUrl = typeof url === 'string' ? url : String(url)
    this.__afinoHeaders = {}
    // The 3-arg and 5-arg overloads differ; relay everything verbatim.
    // biome-ignore lint/suspicious/noExplicitAny: relaying overloaded native call
    return (origOpen as any).apply(this, args)
  } as XMLHttpRequest['open']

  XMLHttpRequest.prototype.setRequestHeader = function (this: XhrPlus, name: string, value: string) {
    if (this.__afinoHeaders && isInteresting(name)) {
      this.__afinoHeaders[name.toLowerCase()] = value
    }
    return origSetReq.call(this, name, value)
  }

  XMLHttpRequest.prototype.send = function (this: XhrPlus, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      if (this.__afinoUrl && this.__afinoHeaders && Object.keys(this.__afinoHeaders).length > 0) {
        const u = new URL(this.__afinoUrl, location.href)
        emit(u.host, this.__afinoHeaders)
      }
    } catch {}
    return origSend.call(this, body as Document | XMLHttpRequestBodyInit | null)
  }
})()
