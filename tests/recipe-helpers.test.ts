import { hashFitId, scrollUntilStable, sleep, waitFor } from '@/engine/recipe-helpers'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    const t0 = Date.now()
    await sleep(20)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
  })
})

describe('waitFor', () => {
  it('returns the predicate value as soon as it is truthy', async () => {
    let attempts = 0
    const value = await waitFor(
      () => {
        attempts += 1
        return attempts >= 3 ? 'ready' : null
      },
      { intervalMs: 5, timeoutMs: 500 },
    )
    expect(value).toBe('ready')
    expect(attempts).toBe(3)
  })

  it('throws when the predicate never returns truthy before timeout', async () => {
    await expect(waitFor(() => null, { intervalMs: 5, timeoutMs: 30 })).rejects.toThrow(/timeout after 30ms/)
  })

  it('treats false the same as null (does not resolve with falsy values)', async () => {
    let calls = 0
    const value = await waitFor(
      () => {
        calls += 1
        if (calls < 2) return false
        return 42
      },
      { intervalMs: 5, timeoutMs: 200 },
    )
    expect(value).toBe(42)
  })
})

describe('scrollUntilStable', () => {
  it('returns once the count stops growing for `stableIterations` checks', async () => {
    let count = 0
    const counts = [10, 20, 30, 30, 30] // grows then plateaus
    let i = 0
    const result = await scrollUntilStable(
      () => {
        count = counts[i] ?? counts[counts.length - 1] ?? 0
        i += 1
        return count
      },
      { settleMs: 1, stableIterations: 2, scroller: null as unknown as Window },
    )
    expect(result).toBe(30)
  })

  it('respects maxIterations even if list keeps growing', async () => {
    let i = 0
    const result = await scrollUntilStable(
      () => {
        i += 1
        return i // always grows
      },
      { settleMs: 1, maxIterations: 5, scroller: null as unknown as Window },
    )
    // 1 initial read + 5 iterations of (scroll, read) = read #6
    expect(result).toBe(6)
  })
})

describe('hashFitId', () => {
  it('is deterministic for identical inputs (re-import dedup)', () => {
    const a = hashFitId(['2026-05-01', '40.00', 'Mercado'])
    const b = hashFitId(['2026-05-01', '40.00', 'Mercado'])
    expect(a).toBe(b)
  })

  it('differs when any input differs', () => {
    const base = hashFitId(['2026-05-01', '40.00', 'Mercado', 0])
    expect(hashFitId(['2026-05-02', '40.00', 'Mercado', 0])).not.toBe(base)
    expect(hashFitId(['2026-05-01', '40.01', 'Mercado', 0])).not.toBe(base)
    expect(hashFitId(['2026-05-01', '40.00', 'Padaria', 0])).not.toBe(base)
    expect(hashFitId(['2026-05-01', '40.00', 'Mercado', 1])).not.toBe(base)
  })

  it('accepts Decimal inputs without losing precision', () => {
    const a = hashFitId(['2026-05-01', new Decimal('0.10').plus('0.20')])
    const b = hashFitId(['2026-05-01', '0.3'])
    expect(a).toBe(b)
  })

  it('produces a fixed-length, e_-prefixed hex id', () => {
    expect(hashFitId(['anything'])).toMatch(/^e_[0-9a-f]{8}$/)
  })
})
