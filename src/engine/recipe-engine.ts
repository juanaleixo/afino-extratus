import { NordicLoginRequiredError, fetchNordicCtx } from '@/engine/nordic-ssr'
import { parseBrAmount, parseBrDate } from '@/engine/normalize'
import { sleep } from '@/engine/recipe-helpers'
import type {
  AmountField,
  DateField,
  DescriptionField,
  ExtractSpec,
  FieldsSpec,
  IdField,
  IterateField,
  PathCondition,
  PeriodFilter,
  PeriodPreset,
  Recipe,
  Source,
  TypeField,
} from '@/recipes/_schema'
import type { AccountType, ExtractionResult, NormalizedTransaction, RecipeOutput } from '@/types/transaction'
import Decimal from 'decimal.js'

export type ProgressEvent =
  | { phase: 'starting' }
  | { phase: 'discovering' }
  | { phase: 'planned'; totalAccounts: number; accountNames: string[] }
  | {
      phase: 'page'
      accountIndex: number
      totalAccounts: number
      accountName: string
      page: number
      totalPages: number | null
    }
  | { phase: 'account-done'; accountIndex: number; totalAccounts: number; accountName: string; transactions: number }
  | { phase: 'done' }

export type ProgressListener = (event: ProgressEvent) => void

export interface RunRecipeOptions {
  recipe: Recipe
  fetch: typeof fetch
  period?: PeriodFilter
  /** When provided, only accounts whose id is in this set will be extracted. Empty/undefined = all. */
  accountIds?: string[]
  /** How many accounts to process in parallel. Default 4. Pages within an account stay sequential. */
  concurrency?: number
  onProgress?: ProgressListener
  /**
   * Reads a key from the active tab's session/local storage. Required when a recipe references
   * `{sessionStorage:KEY}` or `{localStorage:KEY}` in headers/body. The reader gets the host of
   * the URL being fetched and is expected to return the raw stored value (or null if missing).
   */
  storageReader?: StorageReader
  /**
   * Reads a header that the bank's own SPA recently sent (captured by the content script).
   * Required when a recipe references `{capturedHeader:NAME}` — typical for tokens that live in
   * memory rather than storage (Inter, Itaú).
   */
  capturedReader?: CapturedHeaderReader
}

export type StorageReader = (params: {
  /** Host of the URL being fetched (the request target). */
  host: string
  /** All hosts declared in the recipe's matchHosts — useful when storage lives on a different origin from the API. */
  candidateHosts: string[]
  type: 'sessionStorage' | 'localStorage'
  key: string
}) => Promise<string | null>

export type CapturedHeaderReader = (params: {
  candidateHosts: string[]
  headerName: string
}) => Promise<string | null>

/** Internal reader passed around after `wrapStorageReader` has injected `candidateHosts`. */
type InternalStorageReader = (params: {
  host: string
  type: 'sessionStorage' | 'localStorage'
  key: string
}) => Promise<string | null>

type InternalCapturedReader = (headerName: string) => Promise<string | null>

interface Resolvers {
  storage?: InternalStorageReader
  captured?: InternalCapturedReader
}

export interface AccountSummary {
  id: string
  name: string
  type: AccountType
  currency: string
}

export class LoginRequiredError extends Error {
  constructor(public readonly host: string) {
    super(`Sessão expirada ou login necessário em ${host}`)
    this.name = 'LoginRequiredError'
  }
}

interface PlannedAccount {
  id: string
  name: string
  type: AccountType
  currency: string
  /** One or more extracts that fill the same NormalizedTransaction map (deduped by fitId). */
  extracts: ExtractSpec[]
  vars: Record<string, string>
}

/** Resolves all accounts the recipe will operate on (runs discovery for `discovered` specs). */
export async function planAccounts(
  recipe: Recipe,
  fetchFn: typeof fetch,
  storageReader?: StorageReader,
  capturedReader?: CapturedHeaderReader,
): Promise<AccountSummary[]> {
  const safeFetch = restrictFetchToHosts(fetchFn, recipe.matchHosts)
  const resolvers: Resolvers = {
    storage: wrapStorageReader(storageReader, recipe.matchHosts),
    captured: wrapCapturedReader(capturedReader, recipe.matchHosts),
  }
  const planned = await resolvePlannedAccounts(recipe, safeFetch, resolvers)
  return planned.map(({ id, name, type, currency }) => ({ id, name, type, currency }))
}

export async function runRecipe(opts: RunRecipeOptions): Promise<ExtractionResult[]> {
  const { recipe, fetch: fetchFn, period, accountIds, onProgress, storageReader, capturedReader } = opts
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const emit = onProgress ?? (() => {})
  const safeFetch = restrictFetchToHosts(fetchFn, recipe.matchHosts)
  const resolvers: Resolvers = {
    storage: wrapStorageReader(storageReader, recipe.matchHosts),
    captured: wrapCapturedReader(capturedReader, recipe.matchHosts),
  }

  emit({ phase: 'starting' })

  const needsDiscovery = recipe.accounts.some((a) => a.kind === 'discovered')
  if (needsDiscovery) emit({ phase: 'discovering' })

  const allPlanned = await resolvePlannedAccounts(recipe, safeFetch, resolvers)
  const filter = accountIds && accountIds.length > 0 ? new Set(accountIds) : null
  const planned = filter ? allPlanned.filter((p) => filter.has(p.id)) : allPlanned

  if (planned.length === 0) {
    throw new Error('Nenhuma conta selecionada para exportar')
  }

  emit({ phase: 'planned', totalAccounts: planned.length, accountNames: planned.map((p) => p.name) })
  console.log('[afino] runRecipe period', period, 'concurrency', concurrency)

  // Output slots preserve the planned order, so the produced ExtractionResult[] is deterministic
  // even though accounts finish out of order under concurrent execution.
  const slots: Array<RecipeOutput | null> = planned.map(() => null)

  // Per-account failures (an extract that throws non-login HTTP errors) shouldn't kill the export
  // — collect them and let the rest succeed. LoginRequiredError still escalates because that's a
  // user-visible state the popup needs to react to.
  const failures: Array<{ name: string; error: Error }> = []
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, planned.length) }, async () => {
    while (true) {
      const i = nextIndex
      if (i >= planned.length) return
      nextIndex = i + 1
      const p = planned[i] as PlannedAccount
      try {
        // Multiple extracts merged into a single deduped Map (same fitId from different sources = 1 tx).
        const merged = new Map<string, NormalizedTransaction>()
        const activeExtracts = p.extracts.filter((ex) => {
          if (!ex.runOnlyForPresets) return true
          const preset = period?.preset ?? 'all'
          return ex.runOnlyForPresets.includes(preset)
        })
        for (const ex of activeExtracts) {
          const txs = await runExtract(ex, safeFetch, period, p.vars, resolvers, (page, totalPages) => {
            emit({
              phase: 'page',
              accountIndex: i,
              totalAccounts: planned.length,
              accountName: p.name,
              page,
              totalPages,
            })
          })
          for (const tx of txs) merged.set(tx.fitId, tx)
        }
        const finalTxs = [...merged.values()]
        emit({
          phase: 'account-done',
          accountIndex: i,
          totalAccounts: planned.length,
          accountName: p.name,
          transactions: finalTxs.length,
        })
        if (finalTxs.length > 0) {
          slots[i] = {
            account: { id: p.id, name: p.name, type: p.type, currency: p.currency },
            transactions: finalTxs,
          }
        }
      } catch (err) {
        if (err instanceof LoginRequiredError) throw err
        const e = err as Error
        console.warn('[afino] account failed, skipping', p.name, e.message)
        failures.push({ name: p.name, error: e })
        emit({
          phase: 'account-done',
          accountIndex: i,
          totalAccounts: planned.length,
          accountName: p.name,
          transactions: 0,
        })
      }
    }
  })
  await Promise.all(workers)
  if (failures.length > 0) {
    console.warn('[afino] some accounts failed:', failures.map((f) => `${f.name}: ${f.error.message}`).join(' | '))
  }

  emit({ phase: 'done' })

  const populated = slots.filter((o): o is RecipeOutput => o !== null && o.transactions.length > 0)
  if (populated.length === 0) {
    // If everything failed, surface the most informative error instead of the generic "no transactions".
    if (failures.length > 0) throw failures[0]?.error
    throw new Error('Nenhuma transação encontrada — verifique se está logado no banco e se há movimento no período')
  }
  return populated.map((o) => finalizeResult(o, recipe))
}

async function resolvePlannedAccounts(
  recipe: Recipe,
  safeFetch: typeof fetch,
  resolvers: Resolvers,
): Promise<PlannedAccount[]> {
  const planned: PlannedAccount[] = []
  for (const spec of recipe.accounts) {
    if (spec.kind === 'single') {
      const extracts = spec.extracts && spec.extracts.length > 0 ? spec.extracts : spec.extract ? [spec.extract] : []
      if (extracts.length === 0) throw new Error(`accounts[${spec.id}]: nenhum extract definido`)
      planned.push({
        id: spec.id,
        name: spec.name,
        type: spec.type,
        currency: spec.currency,
        extracts,
        vars: {},
      })
    } else {
      const subs = await discoverSubAccounts(spec.discover, safeFetch, resolvers)
      for (const sub of subs) {
        // Expose every discovered field as `{discovered.<key>}`. `id` and `name` are guaranteed by
        // the schema parser; extras (e.g. `product`) come along verbatim.
        const vars: Record<string, string> = {}
        for (const [k, v] of Object.entries(sub)) vars[`discovered.${k}`] = v
        planned.push({
          id: `${spec.idPrefix}-${sub.id}`,
          name: applyTemplate(spec.nameTemplate, vars),
          type: spec.type,
          currency: spec.currency,
          extracts: [spec.extract],
          vars,
        })
      }
    }
  }
  return planned
}

async function discoverSubAccounts(
  d: import('@/recipes/_schema').DiscoveredAccountSpec['discover'],
  fetchFn: typeof fetch,
  resolvers: Resolvers,
): Promise<Array<Record<string, string>>> {
  const root = await fetchSource(d.source, fetchFn, {}, resolvers)
  const items = collectList(root, d.list)
  return items
    .map((item) => {
      const out: Record<string, string> = {}
      for (const [key, path] of Object.entries(d.fields)) {
        const v = readPath(item, path)
        out[key] = v == null ? '' : String(v)
      }
      return out
    })
    .filter((s) => s.id && s.id.length > 0)
}

async function runExtract(
  spec: ExtractSpec,
  fetchFn: typeof fetch,
  period: PeriodFilter | undefined,
  vars: Record<string, string>,
  resolvers: Resolvers,
  onPage?: (page: number, totalPages: number | null) => void,
): Promise<NormalizedTransaction[]> {
  const periodVars = resolvePeriodVars(spec, period)
  const seen = new Map<string, NormalizedTransaction>()

  if (spec.iterate) {
    const it = spec.iterate
    const filter = it.filter
    const delay = it.delayMs ?? 250
    const max = it.max ?? 500
    const root = await fetchSource(it.source, fetchFn, { ...vars, ...periodVars }, resolvers)
    const allItems = collectList(root, it.list)
    const items = filter ? allItems.filter((item) => matchesCondition(item, filter)) : allItems
    const limit = Math.min(items.length, max)
    for (let i = 0; i < limit; i++) {
      const item = items[i]
      const iterVars: Record<string, string> = { ...vars, ...periodVars }
      for (const [key, fieldSpec] of Object.entries(it.fields)) {
        const v = resolveIterateField(item, fieldSpec)
        if (v != null) iterVars[key] = v
      }
      await runSingleWindow(spec, fetchFn, iterVars, resolvers, seen, onPage)
      if (i < limit - 1) await sleep(delay)
    }
    return [...seen.values()]
  }

  if (spec.windowedHistory) {
    const wh = spec.windowedHistory
    const windowMs = wh.windowDays * 86_400_000
    const windowDelay = wh.delayMs ?? 500
    const startVar = wh.startVar ?? 'windowStart'
    const endVar = wh.endVar ?? 'windowEnd'
    const fmt = wh.format ?? 'iso-utc'
    const now = Date.now()
    const presetWindow = period ? presetWindowDays(period.preset) : null
    // When the user picks a short period (last_week, month, ...), we don't need to walk the full
    // history — one window covering exactly the requested span is enough. Only `all` triggers the
    // multi-window walk.
    if (presetWindow !== null) {
      const end = new Date(now)
      const start = new Date(now - presetWindow * 86_400_000)
      const windowVars = {
        ...vars,
        ...periodVars,
        [startVar]: formatPeriodVar(start.toISOString(), fmt),
        [endVar]: formatPeriodVar(end.toISOString(), fmt),
      }
      await runSingleWindow(spec, fetchFn, windowVars, resolvers, seen, onPage)
      return [...seen.values()]
    }

    const horizonMs = wh.maxYears * 365 * 86_400_000
    const windows = Math.max(1, Math.ceil(horizonMs / windowMs))
    for (let w = 0; w < windows; w++) {
      const end = new Date(now - w * windowMs)
      const start = new Date(end.getTime() - windowMs)
      const windowVars = {
        ...vars,
        ...periodVars,
        [startVar]: formatPeriodVar(start.toISOString(), fmt),
        [endVar]: formatPeriodVar(end.toISOString(), fmt),
      }
      const sizeBefore = seen.size
      await runSingleWindow(spec, fetchFn, windowVars, resolvers, seen, onPage)
      // No new transactions in this window → we've gone past the bank's available history.
      if (seen.size === sizeBefore) break
      if (w < windows - 1) await sleep(windowDelay)
    }
    return [...seen.values()]
  }

  await runSingleWindow(spec, fetchFn, { ...vars, ...periodVars }, resolvers, seen, onPage)
  return [...seen.values()]
}

async function runSingleWindow(
  spec: ExtractSpec,
  fetchFn: typeof fetch,
  vars: Record<string, string>,
  resolvers: Resolvers,
  seen: Map<string, NormalizedTransaction>,
  onPage?: (page: number, totalPages: number | null) => void,
): Promise<void> {
  const pagination = spec.pagination ?? { type: 'none' }
  const delay = spec.delayMs ?? 250

  if (pagination.type === 'none') {
    onPage?.(1, 1)
    const root = await fetchSource(spec.source, fetchFn, vars, resolvers)
    for (const tx of collectList(root, spec.list, spec.inheritFromParent).map((it) => mapItem(it, spec.fields, vars))) {
      if (tx) seen.set(tx.fitId, tx)
    }
    return
  }

  if (pagination.type === 'page-count') {
    const startPage = pagination.startPage ?? 1
    const max = pagination.max ?? 100
    let total: number | null = null
    const lastPage = startPage + max - 1

    for (let p = startPage; p <= lastPage; p++) {
      const knownTotal = total !== null ? total - startPage + 1 : null
      onPage?.(p - startPage + 1, knownTotal)
      const root = await fetchSource(spec.source, fetchFn, { ...vars, page: String(p) }, resolvers)
      if (pagination.totalPath && total === null) {
        const t = readPath(root, pagination.totalPath)
        if (typeof t === 'number' && Number.isFinite(t)) {
          total = t
          onPage?.(1, total - startPage + 1)
        }
      }
      if (pagination.stopWhen && matchesCondition(root, pagination.stopWhen)) break
      const items = collectList(root, spec.list, spec.inheritFromParent)
      if (items.length === 0) break
      // Stop if every item we just got is a duplicate of what we already have — protects against
      // backends that keep returning the same window past the actual end (Inter does this).
      const sizeBefore = seen.size
      for (const tx of items.map((it) => mapItem(it, spec.fields, vars))) {
        if (tx) seen.set(tx.fitId, tx)
      }
      if (seen.size === sizeBefore) break
      if (total !== null && p >= total) break
      await sleep(delay)
    }
    return
  }

  if (pagination.type === 'page-until-empty') {
    const startPage = pagination.startPage ?? 1
    const max = pagination.max ?? 100
    const pageSize = pagination.pageSize
    for (let p = startPage; p < startPage + max; p++) {
      onPage?.(p - startPage + 1, null)
      const root = await fetchSource(
        spec.source,
        fetchFn,
        { ...vars, page: String(p), pageSize: String(pageSize) },
        resolvers,
      )
      const items = collectList(root, spec.list, spec.inheritFromParent)
      for (const tx of items.map((it) => mapItem(it, spec.fields, vars))) {
        if (tx) seen.set(tx.fitId, tx)
      }
      if (items.length < pageSize) break
      await sleep(delay)
    }
    return
  }

  // cursor
  const max = pagination.max ?? 100
  let cursor = ''
  for (let i = 0; i < max; i++) {
    onPage?.(i + 1, null)
    const root = await fetchSource(spec.source, fetchFn, { ...vars, cursor }, resolvers)
    for (const tx of collectList(root, spec.list, spec.inheritFromParent).map((it) => mapItem(it, spec.fields, vars))) {
      if (tx) seen.set(tx.fitId, tx)
    }
    const next = readPath(root, pagination.nextPath)
    if (typeof next !== 'string' || next.length === 0) break
    cursor = next
    await sleep(delay)
  }
  return
}

/**
 * Turns the user-selected period preset into the variables the URL/body templates need:
 *   - When `periodMap[preset]` is a string, returns `{ period: <string> }` (single var, legacy).
 *   - When it is an object, formats each value via `dateFormat[key]` and returns it.
 * Date-like inputs ('now', '-7d', '+3m', ISO strings) get resolved relative to `Date.now()`.
 */
function resolvePeriodVars(spec: ExtractSpec, period: PeriodFilter | undefined): Record<string, string> {
  if (!period || !spec.periodMap) return { period: '' }
  const value = spec.periodMap[period.preset]
  if (value === undefined) return { period: '' }
  if (typeof value === 'string') return { period: value }
  const out: Record<string, string> = {}
  const formats = spec.dateFormat ?? {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = formatPeriodVar(v, formats[k])
  }
  return out
}

function formatPeriodVar(value: string, format: import('@/recipes/_schema').DateFormat | undefined): string {
  if (!format) return value
  const date = parseRelativeDate(value)
  if (!date) return value
  switch (format) {
    case 'iso-utc':
      return date.toISOString()
    case 'iso':
      return date.toISOString()
    case 'iso-date':
      return date.toISOString().slice(0, 10)
    case 'br-date': {
      const d = new Date(date)
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
    }
    case 'unix-ms':
      return String(date.getTime())
    case 'unix-s':
      return String(Math.floor(date.getTime() / 1000))
  }
}

/** Maps a period preset to a window size in days. Returns null for `all` (meaning "no cap"). */
function presetWindowDays(preset: PeriodPreset): number | null {
  switch (preset) {
    case 'today':
      return 1
    case 'yesterday':
      return 2
    case 'last_week':
      return 7
    case 'last_two_weeks':
      return 14
    case 'month':
      return 30
    default:
      return null
  }
}

/** 'now' | 'today' | '-7d' | '+1m' | ISO 8601 → Date. Returns null if unrecognized. */
function parseRelativeDate(value: string): Date | null {
  const trimmed = value.trim()
  const now = new Date()
  if (trimmed === 'now' || trimmed === 'today') return now
  const rel = trimmed.match(/^([+-]?\d+)([dhm])$/)
  if (rel) {
    const amount = Number(rel[1])
    const unit = rel[2]
    const ms = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000
    return new Date(now.getTime() + amount * ms)
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function fetchSource(
  source: Source,
  fetchFn: typeof fetch,
  vars: Record<string, string>,
  resolvers: Resolvers,
): Promise<unknown> {
  const url = applyTemplate(source.url, vars)
  const host = new URL(url).host
  if (source.type === 'ssr-nordic') {
    try {
      return await fetchNordicCtx(url, fetchFn)
    } catch (err) {
      if (err instanceof NordicLoginRequiredError) throw new LoginRequiredError(host)
      throw err
    }
  }
  if (source.type === 'ssr-next') {
    return fetchNextData(url, fetchFn)
  }
  // rest-json
  const headers = source.headers
    ? await resolveTokensInValues(applyTemplateValues(source.headers, vars), host, resolvers)
    : {}
  const init: RequestInit = {
    method: source.method ?? 'GET',
    headers: { Accept: 'application/json', ...headers },
    credentials: 'include',
    redirect: 'follow',
  }
  if (source.method === 'POST' && source.body) {
    const body = await resolveTokensInDeep(applyTemplateDeep(source.body, vars), host, resolvers)
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const resp = await fetchFn(url, init)
  if (resp.status === 401 || resp.status === 403) {
    throw new LoginRequiredError(host)
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`)
  return resp.json()
}

/**
 * Wraps a user-provided reader so callers don't have to pass `candidateHosts` everywhere.
 * The recipe's matchHosts becomes the search space for tabs (the storage may live on a
 * different origin than the API: e.g. Rico API at api.rico.com.vc, token at arealogada.rico.com.vc).
 */
function wrapStorageReader(
  reader: StorageReader | undefined,
  candidateHosts: string[],
): InternalStorageReader | undefined {
  if (!reader) return undefined
  return (params) => reader({ ...params, candidateHosts })
}

function wrapCapturedReader(
  reader: CapturedHeaderReader | undefined,
  candidateHosts: string[],
): InternalCapturedReader | undefined {
  if (!reader) return undefined
  return (headerName) => reader({ candidateHosts, headerName })
}

/** Patterns the engine substitutes inside header values and POST bodies. */
const STORAGE_TOKEN_RE = /\{(sessionStorage|localStorage):([^}]+)\}/g
const CAPTURED_TOKEN_RE = /\{capturedHeader:([^}]+)\}/g

async function resolveTokensInValues(
  obj: Record<string, string>,
  host: string,
  resolvers: Resolvers,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = await resolveTokensInString(v, host, resolvers)
  }
  return out
}

async function resolveTokensInString(value: string, host: string, resolvers: Resolvers): Promise<string> {
  let result = value
  // {sessionStorage|localStorage:KEY}
  if (STORAGE_TOKEN_RE.test(result)) {
    if (!resolvers.storage) {
      throw new Error('Recipe usa {sessionStorage|localStorage:KEY} mas nenhum storageReader foi configurado')
    }
    const tokens: Array<{ raw: string; type: 'sessionStorage' | 'localStorage'; key: string }> = []
    STORAGE_TOKEN_RE.lastIndex = 0
    let match: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
    while ((match = STORAGE_TOKEN_RE.exec(result)) !== null) {
      tokens.push({ raw: match[0], type: match[1] as 'sessionStorage' | 'localStorage', key: match[2] as string })
    }
    for (const t of tokens) {
      const resolved = await resolvers.storage({ host, type: t.type, key: t.key })
      if (resolved == null) throw new LoginRequiredError(host)
      result = result.split(t.raw).join(resolved)
    }
  }
  // {capturedHeader:NAME}
  if (CAPTURED_TOKEN_RE.test(result)) {
    if (!resolvers.captured) {
      throw new Error('Recipe usa {capturedHeader:NAME} mas nenhum capturedReader foi configurado')
    }
    const tokens: Array<{ raw: string; name: string }> = []
    CAPTURED_TOKEN_RE.lastIndex = 0
    let match: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
    while ((match = CAPTURED_TOKEN_RE.exec(result)) !== null) {
      tokens.push({ raw: match[0], name: match[1] as string })
    }
    for (const t of tokens) {
      const resolved = await resolvers.captured(t.name)
      if (resolved == null) throw new LoginRequiredError(host)
      result = result.split(t.raw).join(resolved)
    }
  }
  return result
}

async function resolveTokensInDeep(value: unknown, host: string, resolvers: Resolvers): Promise<unknown> {
  if (typeof value === 'string') return resolveTokensInString(value, host, resolvers)
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveTokensInDeep(v, host, resolvers)))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = await resolveTokensInDeep(v, host, resolvers)
    return out
  }
  return value
}

async function fetchNextData(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const resp = await fetchFn(url, {
    credentials: 'include',
    headers: { Accept: 'text/html' },
    redirect: 'follow',
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`)
  const html = await resp.text()
  if (!html.includes('__NEXT_DATA__')) throw new LoginRequiredError(new URL(url).host)
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m?.[1]) throw new Error('__NEXT_DATA__ não encontrado')
  return JSON.parse(m[1])
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

function mapItem(item: unknown, fields: FieldsSpec, vars: Record<string, string>): NormalizedTransaction | null {
  const fitId = resolveId(item, fields.id, vars)
  const postedAt = resolveDate(item, fields.postedAt)
  const amount = resolveAmount(item, fields.amount)
  if (!fitId || !postedAt || !amount) return null

  const description = resolveDescription(item, fields.description, vars) || '(sem descrição)'
  const type = resolveType(item, fields.type, amount)
  const currency = resolveCurrency(item, fields.currency)

  return {
    fitId,
    postedAt,
    amount: amount.abs(),
    currency: currency || '', // caller fills account currency if empty (downstream)
    description,
    type,
  }
}

function resolveId(item: unknown, spec: IdField, vars: Record<string, string>): string | null {
  if ('template' in spec) {
    const out = expandTemplate(spec.template, item, vars)
    return out.length > 0 ? out : null
  }
  if ('paths' in spec) {
    const parts = spec.paths.map((p) => readPath(item, p))
    if (parts.some((v) => v == null)) return null
    return parts.map(String).join(spec.join ?? '|')
  }
  const v = readPath(item, spec.path)
  return v == null ? null : String(v)
}

function resolveDate(item: unknown, spec: DateField): Date | null {
  const paths = 'paths' in spec ? spec.paths : [spec.path]
  for (const p of paths) {
    const raw = readPath(item, p)
    if (raw == null) continue
    const d = parseDateRaw(String(raw), spec.format)
    if (d) return d
  }
  return null
}

const PT_MONTH_ABBR: Record<string, string> = {
  jan: '01',
  fev: '02',
  mar: '03',
  abr: '04',
  mai: '05',
  jun: '06',
  jul: '07',
  ago: '08',
  set: '09',
  out: '10',
  nov: '11',
  dez: '12',
}

function parseDateRaw(raw: string, format: import('@/recipes/_schema').DateFormat | undefined): Date | null {
  if (format === 'br-date') {
    // 1) "Sábado, 23/08/2025" → extract DD/MM/YYYY
    const numeric = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    if (numeric) {
      try {
        return parseBrDate(`${numeric[1]}/${numeric[2]}/${numeric[3]}`)
      } catch {
        return null
      }
    }
    // 2) "Sexta, 13 fev. 2026" → "13/02/2026" via PT month abbrev
    const ptAbbr = raw.match(/(\d{1,2})\s+([a-zà-ú]{3})\.?\s+(\d{4})/i)
    if (ptAbbr) {
      const day = ptAbbr[1]?.padStart(2, '0')
      const month = PT_MONTH_ABBR[ptAbbr[2]?.toLowerCase() ?? '']
      const year = ptAbbr[3]
      if (day && month && year) {
        try {
          return parseBrDate(`${day}/${month}/${year}`)
        } catch {
          return null
        }
      }
    }
    return null
  }
  if (format === 'unix-ms') {
    const n = Number(raw)
    return Number.isFinite(n) ? new Date(n) : null
  }
  if (format === 'unix-s') {
    const n = Number(raw)
    return Number.isFinite(n) ? new Date(n * 1000) : null
  }
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

function resolveAmount(item: unknown, spec: AmountField): Decimal | null {
  if ('fractionPath' in spec) {
    const f = readPath(item, spec.fractionPath)
    const c = readPath(item, spec.centsPath)
    if (f == null) return null
    const fStr = String(f).replace(/\./g, '')
    const cStr = String(c ?? '00')
      .padStart(2, '0')
      .slice(0, 2)
    if (!/^-?\d+$/.test(fStr)) return null
    try {
      return new Decimal(`${fStr}.${cStr}`)
    } catch {
      return null
    }
  }
  if ('format' in spec && spec.format === 'br') {
    try {
      return parseBrAmount(String(readPath(item, spec.path) ?? ''))
    } catch {
      return null
    }
  }
  const numeric = spec as { path: string; scale?: number }
  const v = readPath(item, numeric.path)
  if (v == null) return null
  try {
    return new Decimal(String(v).replace(',', '.')).times(numeric.scale ?? 1)
  } catch {
    return null
  }
}

function resolveDescription(item: unknown, spec: DescriptionField, vars: Record<string, string>): string {
  if ('path' in spec) return String(readPath(item, spec.path) ?? '').trim()
  let prefix = ''
  for (const p of spec.prefixes ?? []) {
    if (matchesCondition(item, p.when)) {
      prefix = p.value
      break
    }
  }
  const body = expandTemplate(spec.template, item, vars)
  return (prefix + body).trim()
}

/**
 * Template with two layers:
 *   - `{path}` resolves a path within the item, falling back to `vars[path]` (when provided).
 *     `vars` carries upstream context — discovered fields (`discovered.id`), iterate fields
 *     (`cycle.billingCycle`), pagination, etc. — making them addressable in fitId / description
 *     templates without injecting them into every item.
 *   - `[...]` is an optional group: kept only if every `{path}` inside it resolves to a non-empty value.
 *
 * Lets a recipe say `"{title}[ — {description}]"` and have the connector disappear when description is absent.
 */
function expandTemplate(tpl: string, item: unknown, vars?: Record<string, string>): string {
  const resolve = (path: string): string | null => {
    const v = readPath(item, path.trim())
    if (v != null && v !== '') return String(v)
    if (vars) {
      const fromVar = vars[path.trim()]
      if (fromVar != null && fromVar !== '') return fromVar
    }
    return null
  }
  const withGroups = tpl.replace(/\[([^\[\]]*)\]/g, (_, group: string) => {
    let allOk = true
    const expanded = group.replace(/\{([^}]+)\}/g, (_match, path: string) => {
      const r = resolve(path)
      if (r === null) {
        allOk = false
        return ''
      }
      return r
    })
    return allOk ? expanded : ''
  })
  return withGroups.replace(/\{([^}]+)\}/g, (_match, path: string) => {
    return resolve(path) ?? ''
  })
}

function resolveType(item: unknown, spec: TypeField, amount: Decimal): 'credit' | 'debit' {
  if ('fixed' in spec) return spec.fixed
  if ('creditWhenSign' in spec) {
    const sign = spec.creditWhenSign
    const isCredit = sign === '>=0' || sign === 'non-negative' ? amount.gte(0) : amount.gt(0)
    return isCredit ? 'credit' : 'debit'
  }
  if ('creditWhen' in spec) return matchesCondition(item, spec.creditWhen) ? 'credit' : 'debit'
  return matchesCondition(item, spec.debitWhen) ? 'debit' : 'credit'
}

function resolveCurrency(item: unknown, spec: import('@/recipes/_schema').CurrencyField | undefined): string {
  if (!spec) return ''
  if ('const' in spec) return spec.const
  const v = readPath(item, spec.path)
  return typeof v === 'string' ? v : ''
}

function resolveIterateField(item: unknown, spec: IterateField): string | null {
  if ('const' in spec) return spec.const
  const v = readPath(item, spec.path)
  if (v == null) return null
  const str = String(v)
  if ('mapValues' in spec && spec.mapValues) return spec.mapValues[str] ?? str
  return str
}

function matchesCondition(item: unknown, cond: PathCondition): boolean {
  const v = readPath(item, cond.path)
  if (cond.exists === true) return v != null && v !== ''
  if (cond.exists === false) return v == null || v === ''
  if (cond.equals !== undefined) return String(v ?? '') === cond.equals
  if (cond.notEquals !== undefined) return String(v ?? '') !== cond.notEquals
  return false
}

// ---------------------------------------------------------------------------
// Path resolution + templates
// ---------------------------------------------------------------------------

/** Resolve `a.b[0].c` returning a single value, or `binnacles[*].movements[*]` returning an array (from collectList only). */
function readPath(root: unknown, path: string): unknown {
  if (!path) return root
  const segments = pathSegments(path)
  let cur: unknown = root
  for (const seg of segments) {
    if (cur == null) return undefined
    if (seg === '*') return cur
    if (/^\d+$/.test(seg)) {
      cur = Array.isArray(cur) ? cur[Number(seg)] : undefined
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/** Like readPath but flattens `[*]` segments into a list of items. */
/**
 * Walk a path like `data[*].bankStatements[*].transactions[*]` and return the leaf items.
 *
 * `inheritFromParent`: when set, each leaf item gets fields copied from its immediate object
 * ancestor (the object whose array contained it). Useful when the leaf needs context from the
 * parent — e.g. Inter's "Pagamento de fatura" transactions don't carry a date in `detail.data`,
 * but the `bankStatements[]` parent has `day` ("Sexta, 13 fev. 2026"). With `inheritFromParent: ['day']`
 * the engine attaches that to each transaction so a `postedAt` path can read it.
 */
function collectList(root: unknown, path: string, inheritFromParent?: string[]): unknown[] {
  const segments = pathSegments(path)
  // Track each frontier node together with the most recent object ancestor (parent).
  let frontier: Array<{ value: unknown; parent: Record<string, unknown> | null }> = [{ value: root, parent: null }]
  for (const seg of segments) {
    const next: typeof frontier = []
    for (const { value: node, parent } of frontier) {
      if (node == null) continue
      if (seg === '*') {
        // Array expansion does not change the parent (parent stays the object that held this array).
        if (Array.isArray(node)) for (const item of node) next.push({ value: item, parent })
      } else if (/^\d+$/.test(seg)) {
        if (Array.isArray(node)) {
          const v = node[Number(seg)]
          if (v !== undefined) next.push({ value: v, parent })
        }
      } else if (typeof node === 'object') {
        const v = (node as Record<string, unknown>)[seg]
        if (v !== undefined) next.push({ value: v, parent: node as Record<string, unknown> })
      }
    }
    frontier = next
  }
  const items = frontier.flatMap(({ value, parent }) =>
    (Array.isArray(value) ? value : [value]).map((v) => ({ value: v, parent })),
  )
  if (!inheritFromParent || inheritFromParent.length === 0) return items.map(({ value }) => value)
  return items.map(({ value, parent }) => {
    if (!parent || typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const key of inheritFromParent) {
      if (out[key] === undefined && parent[key] !== undefined) out[key] = parent[key]
    }
    return out
  })
}

function pathSegments(path: string): string[] {
  return path
    .split('.')
    .flatMap((p) => p.split(/\[(\*|\d+)\]/g))
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function applyTemplate(tpl: string, vars: Record<string, string>): string {
  const withGroups = tpl.replace(/\[([^\[\]]*)\]/g, (_, group: string) => {
    let allOk = true
    const expanded = group.replace(/\{([\w.]+)\}/g, (_match, key: string) => {
      const v = vars[key]
      if (v == null || v === '') {
        allOk = false
        return ''
      }
      return v
    })
    return allOk ? expanded : ''
  })
  return withGroups.replace(/\{([\w.]+)\}/g, (_match, key: string) => {
    const v = vars[key]
    return v == null ? '' : v
  })
}

function applyTemplateDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return applyTemplate(value, vars)
  if (Array.isArray(value)) return value.map((v) => applyTemplateDeep(v, vars))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = applyTemplateDeep(v, vars)
    return out
  }
  return value
}

function applyTemplateValues(obj: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = applyTemplate(v, vars)
  return out
}

// ---------------------------------------------------------------------------
// Security: restrict fetches to the recipe's declared hosts
// ---------------------------------------------------------------------------

function restrictFetchToHosts(fetchFn: typeof fetch, hosts: string[]): typeof fetch {
  const matchers = hosts.map(hostPatternToRegex)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let host: string
    try {
      host = new URL(url).host
    } catch {
      throw new Error(`URL inválida: ${url}`)
    }
    if (!matchers.some((re) => re.test(host))) {
      throw new Error(`Recipe tentou chamar host não autorizado: ${host}`)
    }
    return fetchFn(input, init)
  }) as typeof fetch
}

function hostPatternToRegex(pattern: string): RegExp {
  // Support `*.example.com` (wildcard subdomain). Bare host is exact match.
  const escaped = pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')
  return new RegExp(`^${escaped}$`, 'i')
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

function finalizeResult(output: RecipeOutput, recipe: Recipe): ExtractionResult {
  const txs = output.transactions.map((t) => ({ ...t, currency: t.currency || output.account.currency }))
  const times = txs.map((t) => t.postedAt.getTime())
  const account = applyBankInfo(output.account, recipe.bank)
  const periodEnd = new Date(Math.max(...times))
  return {
    account,
    transactions: txs,
    periodStart: new Date(Math.min(...times)),
    periodEnd,
    balance: deriveBalance(txs, periodEnd),
    fi: recipe.bank?.org ? { org: recipe.bank.org, fid: recipe.bank.id } : undefined,
    recipeSite: recipe.site,
    recipeVersion: recipe.version,
  }
}

function applyBankInfo(
  account: import('@/types/transaction').AccountInfo,
  bank: Recipe['bank'],
): import('@/types/transaction').AccountInfo {
  if (!bank) return account
  return {
    ...account,
    bankId: account.bankId ?? bank.id,
    branchId: account.branchId ?? bank.branchId,
  }
}

function deriveBalance(
  txs: NormalizedTransaction[],
  asOf: Date,
): import('@/types/transaction').AccountBalance | undefined {
  if (txs.length === 0) return undefined
  // Sum signed amounts. NOTE: this is the net change in the period, not the absolute ledger balance.
  // We expose it because the OFX 1.0.2 spec marks LEDGERBAL as required, and most importers tolerate
  // a derived value better than an absent block. Recipes that have a real balance source can override.
  const total = txs.reduce((acc, t) => (t.type === 'credit' ? acc.plus(t.amount) : acc.minus(t.amount)), new Decimal(0))
  return { amount: total, asOf, source: 'derived-from-transactions' }
}
