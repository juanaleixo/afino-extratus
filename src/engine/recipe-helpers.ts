import type Decimal from 'decimal.js'

/** Sleep for `ms` milliseconds. Use between paginated requests to avoid antibot. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WaitForOptions {
  /** Maximum total wait time in ms before throwing. Default 5000. */
  timeoutMs?: number
  /** Polling interval in ms. Default 100. */
  intervalMs?: number
}

/**
 * Poll `predicate` until it returns a truthy value, then resolve with that value.
 * Throws if the timeout elapses first.
 *
 * Example:
 *   const list = await waitFor(() => document.querySelector('[data-testid="tx-list"]'))
 */
export async function waitFor<T>(predicate: () => T | null | undefined | false, opts: WaitForOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const intervalMs = opts.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs

  while (true) {
    const value = predicate()
    if (value) return value
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: timeout after ${timeoutMs}ms`)
    }
    await sleep(intervalMs)
  }
}

export interface ScrollUntilStableOptions {
  /** Max scroll iterations before giving up. Default 50. */
  maxIterations?: number
  /** Time to wait after each scroll for new content to load (ms). Default 500. */
  settleMs?: number
  /** How many consecutive iterations with no count change mark the list "stable". Default 2. */
  stableIterations?: number
  /** The container that scrolls. Default `window`. */
  scroller?: Window | HTMLElement
}

/**
 * Scrolls to bottom repeatedly until `countItems()` stops growing across
 * `stableIterations` consecutive checks. Use for infinite-scroll lists.
 *
 * Returns the final item count.
 */
export async function scrollUntilStable(
  countItems: () => number,
  opts: ScrollUntilStableOptions = {},
): Promise<number> {
  const maxIterations = opts.maxIterations ?? 50
  const settleMs = opts.settleMs ?? 500
  const requiredStable = opts.stableIterations ?? 2
  const scroller = opts.scroller ?? (typeof window !== 'undefined' ? window : null)

  let lastCount = countItems()
  let stableSeen = 0

  for (let i = 0; i < maxIterations; i++) {
    scrollToBottom(scroller)
    await sleep(settleMs)

    const current = countItems()
    if (current === lastCount) {
      stableSeen += 1
      if (stableSeen >= requiredStable) return current
    } else {
      stableSeen = 0
      lastCount = current
    }
  }

  return lastCount
}

function scrollToBottom(scroller: Window | HTMLElement | null): void {
  if (!scroller) return
  if (isWindow(scroller)) {
    const doc = scroller.document?.documentElement
    if (doc) scroller.scrollTo({ top: doc.scrollHeight, behavior: 'auto' })
    return
  }
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' })
}

function isWindow(value: Window | HTMLElement): value is Window {
  return typeof (value as Window).scrollTo === 'function' && 'document' in value
}

/**
 * Deterministic FITID for transactions whose source has no stable internal ID.
 * Same inputs always produce the same FITID — required so that re-importing
 * the same period doesn't duplicate entries in the consumer's tool.
 *
 * Inputs are joined with `|` and hashed with FNV-1a 32-bit (truncated to 8 hex chars,
 * then prefixed with `e_` to flag it as Extratus-derived rather than bank-issued).
 *
 * This is NOT cryptographic — it's a stable bucketing hash. Collisions in a single
 * statement are vanishingly unlikely given (date, amount, description, index) inputs.
 */
export function hashFitId(parts: ReadonlyArray<string | number | Decimal>): string {
  const input = parts.map((p) => (typeof p === 'string' ? p : p.toString())).join('|')
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return `e_${hash.toString(16).padStart(8, '0')}`
}
