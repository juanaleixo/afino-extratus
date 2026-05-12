/**
 * Mercado Libre / Mercado Pago server-render their app state into a
 * `<script id="__NORDIC_RENDERING_CTX__">` block in the HTML. This is a
 * JS assignment (`_n.ctx.r = { ... };`) — not pure JSON — so we extract
 * the first balanced object literal after the `=` sign.
 */

export class NordicLoginRequiredError extends Error {
  constructor(url: string) {
    super(`Login required for ${url}`)
    this.name = 'NordicLoginRequiredError'
  }
}

export async function fetchNordicCtx(url: string, fetchFn: typeof fetch = globalThis.fetch): Promise<unknown> {
  const response = await fetchFn(url, {
    credentials: 'include',
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`Nordic fetch failed: ${response.status} ${url}`)
  }
  const html = await response.text()
  // Login pages don't carry the Nordic context; detect explicitly.
  if (!html.includes('__NORDIC_RENDERING_CTX__')) {
    throw new NordicLoginRequiredError(url)
  }
  return parseNordicCtx(html)
}

export function parseNordicCtx(html: string): unknown {
  const match = html.match(/id="__NORDIC_RENDERING_CTX__"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) throw new Error('__NORDIC_RENDERING_CTX__ not found in HTML')
  const src = match[1] as string

  const eqIdx = src.indexOf('=')
  if (eqIdx < 0) throw new Error('No assignment found in __NORDIC_RENDERING_CTX__')

  let depth = 0
  let start = -1
  let end = -1
  let inString = false
  let stringChar = ''
  let prevChar = ''

  for (let i = eqIdx; i < src.length; i++) {
    const c = src[i] as string
    if (inString) {
      if (c === stringChar && prevChar !== '\\') inString = false
    } else {
      if (c === '"' || c === "'") {
        inString = true
        stringChar = c
      } else if (c === '{') {
        if (start < 0) start = i
        depth++
      } else if (c === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    prevChar = c
  }

  if (start < 0 || end < 0) throw new Error('Unbalanced braces in __NORDIC_RENDERING_CTX__')
  return JSON.parse(src.slice(start, end))
}
