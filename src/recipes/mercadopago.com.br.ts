import { type BitacoraMovement, mapBitacoraMovement } from '@/engine/bitacora-mapper'
import { fetchNordicCtx } from '@/engine/nordic-ssr'
import { sleep } from '@/engine/recipe-helpers'
import type { AccountInfo, RecipeOutput } from '@/types/transaction'
import type { PeriodFilter, Recipe } from './_schema'

const BASE = 'https://www.mercadopago.com.br'
const PAGE_DELAY_MS = 250
const SAFETY_PAGE_LIMIT = 100

interface PotSummary {
  id: string
  name: string
}

interface BitacoraBinnacle {
  movements?: BitacoraMovement[]
}

interface BitacoraListResult {
  total?: number
  pages?: number
  binnacles?: BitacoraBinnacle[]
}

interface NordicCtxShape {
  appProps?: {
    pageProps?: {
      initialState?: { list?: { result?: BitacoraListResult } }
      hub?: { result?: { potsDataHub?: { result?: { pots?: Array<{ id?: unknown; name?: unknown }> } } } }
    }
  }
}

/**
 * Mercado Pago. Runs entirely from the background service worker —
 * the user just clicks the popup, picks the period, and exports.
 *
 * Endpoints used (all SSR Nordic, fetched with session cookies via host_permissions):
 *   GET /banking/balance/movements?page=N[&period=...]
 *   GET /savings/hub
 *   GET /savings/movements/<uuid>?page=N[&period=...]
 *
 * Periods other than 'year' are translated to MP's preset query param.
 * Pages overlap (the API paginates by day), so we dedupe by movement id.
 */
export const mercadopago: Recipe = {
  site: 'mercadopago.com.br',
  version: 2,
  label: 'Mercado Pago',

  extract: async ({ fetch, period }) => {
    const results: RecipeOutput[] = []

    const checking = await extractBitacora(fetch, '/banking/balance/movements', period, {
      id: 'mp-checking',
      name: 'Mercado Pago — Conta',
      type: 'checking',
      currency: 'BRL',
    })
    if (checking) results.push(checking)

    const pots = await discoverPots(fetch)
    for (const pot of pots) {
      const potResult = await extractBitacora(fetch, `/savings/movements/${pot.id}`, period, {
        id: `mp-pot-${pot.id}`,
        name: `Mercado Pago — Cofrinho ${pot.name}`,
        type: 'savings',
        currency: 'BRL',
      })
      if (potResult) results.push(potResult)
      await sleep(PAGE_DELAY_MS)
    }

    return results
  },
}

async function discoverPots(fetchFn: typeof fetch): Promise<PotSummary[]> {
  try {
    const ctx = (await fetchNordicCtx(`${BASE}/savings/hub`, fetchFn)) as NordicCtxShape
    const pots = ctx?.appProps?.pageProps?.hub?.result?.potsDataHub?.result?.pots ?? []
    return pots
      .filter((p): p is { id: unknown; name: unknown } => !!p && typeof p === 'object')
      .map((p) => ({ id: String(p.id ?? ''), name: String(p.name ?? 'Cofrinho') }))
      .filter((p) => p.id)
  } catch {
    return []
  }
}

async function extractBitacora(
  fetchFn: typeof fetch,
  basePath: string,
  period: PeriodFilter | undefined,
  account: AccountInfo,
): Promise<RecipeOutput | null> {
  const seen = new Map<string, BitacoraMovement>()
  let pages = 1

  for (let p = 1; p <= Math.max(pages, 1); p++) {
    const url = `${BASE}${basePath}?page=${p}${periodQuery(period)}`
    let ctx: NordicCtxShape
    try {
      ctx = (await fetchNordicCtx(url, fetchFn)) as NordicCtxShape
    } catch {
      // Login required, network blip, etc — bail out so other accounts can still try.
      break
    }
    const list = ctx?.appProps?.pageProps?.initialState?.list?.result
    if (!list) break
    if (p === 1) pages = list.pages ?? 1
    for (const binnacle of list.binnacles ?? []) {
      for (const movement of binnacle.movements ?? []) {
        if (movement?.id) seen.set(movement.id, movement)
      }
    }
    if (p >= SAFETY_PAGE_LIMIT) break
    if (p < pages) await sleep(PAGE_DELAY_MS)
  }

  const transactions = [...seen.values()].map(mapBitacoraMovement)
  if (transactions.length === 0) return null
  return { account, transactions }
}

function periodQuery(period: PeriodFilter | undefined): string {
  // 'all' (or no period) → MP returns its default range, which is "Last year".
  // The other presets map 1:1 to MP's period query param.
  if (!period || period.preset === 'all') return ''
  return `&period=${period.preset}`
}
