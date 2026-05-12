import { NordicLoginRequiredError, fetchNordicCtx, parseNordicCtx } from '@/engine/nordic-ssr'
import { describe, expect, it, vi } from 'vitest'

function wrap(scriptBody: string): string {
  return `<!doctype html><html><head><script id="__NORDIC_RENDERING_CTX__" type="text/javascript">${scriptBody}</script></head><body></body></html>`
}

describe('parseNordicCtx', () => {
  it('extracts a simple JSON object after the = sign', () => {
    const html = wrap('_n.ctx.r={"foo":"bar","n":1};')
    expect(parseNordicCtx(html)).toEqual({ foo: 'bar', n: 1 })
  })

  it('handles braces inside string values without unbalancing', () => {
    const html = wrap('_n.ctx.r={"label":"a } b { c","ok":true};')
    expect(parseNordicCtx(html)).toEqual({ label: 'a } b { c', ok: true })
  })

  it('handles escaped quotes inside strings', () => {
    const html = wrap('_n.ctx.r={"s":"she said \\"hi\\""};')
    expect(parseNordicCtx(html)).toEqual({ s: 'she said "hi"' })
  })

  it('ignores characters after the first balanced object', () => {
    const html = wrap('_n.ctx.r={"first":true};_n.ctx.c={"second":false};')
    expect(parseNordicCtx(html)).toEqual({ first: true })
  })

  it('throws when the script tag is missing', () => {
    expect(() => parseNordicCtx('<html><body>no script</body></html>')).toThrow(/not found/)
  })

  it('throws when braces are unbalanced', () => {
    const html = `<script id="__NORDIC_RENDERING_CTX__">_n.ctx.r={"a":1,"b":{</script>`
    expect(() => parseNordicCtx(html)).toThrow(/Unbalanced/)
  })

  it('parses nested arrays and objects', () => {
    const html = wrap('_n.ctx.r={"list":[{"id":"a"},{"id":"b"}],"meta":{"total":2}};')
    expect(parseNordicCtx(html)).toEqual({ list: [{ id: 'a' }, { id: 'b' }], meta: { total: 2 } })
  })
})

describe('fetchNordicCtx', () => {
  function makeResponse(body: string, init: { status?: number } = {}): Response {
    return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'text/html' } })
  }

  it('uses the provided fetch and returns parsed context', async () => {
    const fakeFetch = vi.fn(async () => makeResponse(wrap('_n.ctx.r={"ok":true};')))
    const ctx = await fetchNordicCtx('https://example.com/page', fakeFetch as unknown as typeof fetch)
    expect(ctx).toEqual({ ok: true })
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('throws NordicLoginRequiredError when response lacks the Nordic context (login page)', async () => {
    const fakeFetch = vi.fn(async () => makeResponse('<html><body>Login page</body></html>'))
    await expect(fetchNordicCtx('https://example.com/x', fakeFetch as unknown as typeof fetch)).rejects.toBeInstanceOf(
      NordicLoginRequiredError,
    )
  })

  it('throws on non-OK HTTP status', async () => {
    const fakeFetch = vi.fn(async () => makeResponse('', { status: 500 }))
    await expect(fetchNordicCtx('https://example.com/x', fakeFetch as unknown as typeof fetch)).rejects.toThrow(/500/)
  })
})
