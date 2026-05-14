import type { AccountType } from '@/types/transaction'

export type PeriodPreset = 'today' | 'yesterday' | 'last_week' | 'last_two_weeks' | 'month' | 'all'

export interface PeriodFilter {
  preset: PeriodPreset
}

export const RECIPE_SCHEMA = 'afino-extratus-recipe/v1'

// ---------------------------------------------------------------------------
// Sources — how to fetch one page of data and turn the response into JSON
// ---------------------------------------------------------------------------

export interface SourceSsrNordic {
  type: 'ssr-nordic'
  /** Absolute URL. Supports {page}, {cursor}, {period} and discovery vars (e.g. {discovered.id}). */
  url: string
}

export interface SourceSsrNext {
  type: 'ssr-next'
  url: string
}

export interface SourceRestJson {
  type: 'rest-json'
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

export type Source = SourceSsrNordic | SourceSsrNext | SourceRestJson

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationNone {
  type: 'none'
}
export interface PaginationPageCount {
  type: 'page-count'
  /**
   * Dot path inside the parsed response that holds the total page count (read on first request).
   * Optional — when absent, the loop runs until `stopWhen` triggers, items come empty, or `max` hits.
   */
  totalPath?: string
  /** Stop the loop early when this condition matches the response root (any page). */
  stopWhen?: PathCondition
  /** First page index, default 1. */
  startPage?: number
  /** Hard cap to avoid runaways. Default 100. */
  max?: number
}
export interface PaginationCursor {
  type: 'cursor'
  /** Dot path holding the next-cursor value; empty/absent => done. */
  nextPath: string
  /** Hard cap. Default 100. */
  max?: number
}
/**
 * Iterates pages until a response returns fewer items than `pageSize` (or zero).
 * Suitable for APIs that don't expose a total page/count field (e.g. Rico).
 */
export interface PaginationPageUntilEmpty {
  type: 'page-until-empty'
  pageSize: number
  startPage?: number
  max?: number
}

export type Pagination = PaginationNone | PaginationPageCount | PaginationCursor | PaginationPageUntilEmpty

// ---------------------------------------------------------------------------
// Field resolvers — declarative transforms from a JSON item to typed fields
// ---------------------------------------------------------------------------

/**
 * Identifier resolver.
 *   - `{ path }`: single field.
 *   - `{ paths, join }`: composite from many paths joined by `join` (default `|`).
 *   - `{ template }`: synthetic id built from a `{path}` template — useful when the source
 *     has no stable id (e.g. open credit-card invoice items). Must produce identical strings
 *     across re-imports of the same period.
 */
export type IdField = { path: string } | { paths: string[]; join?: string } | { template: string }

export type DateFormat = 'iso' | 'iso-utc' | 'iso-date' | 'br-date' | 'unix-ms' | 'unix-s'
/**
 * Date resolver. Accepts a single `path` or a list of `paths` tried in order — useful when the
 * source has different fields per transaction type (e.g. Inter uses `data.transactionDate` for
 * Pix but `data.aboutTransaction.purchaseDate` for "Compra no débito").
 */
export type DateField = { path: string; format?: DateFormat } | { paths: string[]; format?: DateFormat }

/** Description as plain path, or template with optional conditional prefixes. */
export type DescriptionField =
  | { path: string }
  | {
      template: string
      prefixes?: Array<{ when: PathCondition; value: string }>
    }

export interface PathCondition {
  path: string
  /** Equality test against a literal. Use one of these. */
  equals?: string
  notEquals?: string
  exists?: boolean
}

/** Amount — multiple shapes. Always normalized to absolute value; sign comes from `type`. */
export type AmountField =
  | { path: string; scale?: number } // raw number * scale (default 1)
  | { path: string; format: 'br' } // "1.234,56"
  | { fractionPath: string; centsPath: string } // Bitácora-style: "fraction.cents"

/** Type field — choose one rule. */
export type TypeField =
  | { creditWhenSign: '>=0' | '>0' | 'positive' | 'non-negative' } // sign of `amount` decides
  | { creditWhen: PathCondition }
  | { debitWhen: PathCondition }
  | { fixed: 'credit' | 'debit' }

/** Optional per-tx currency override. Either pull from a path or fix as a literal. */
export type CurrencyField = { path: string } | { const: string }

export interface FieldsSpec {
  id: IdField
  postedAt: DateField
  amount: AmountField
  description: DescriptionField
  type: TypeField
  currency?: CurrencyField
}

// ---------------------------------------------------------------------------
// Account specs
// ---------------------------------------------------------------------------

/**
 * Per-preset value substituted into the URL/body. Two shapes:
 *   - `string`: a single `{period}` placeholder. URL: `?period={period}` + map `month → '30d'`.
 *   - `Record<string, string>`: multi-variable, e.g. `{ periodStart: '-7d', periodEnd: 'now' }`.
 *     Each key becomes a `{periodStart}` / `{periodEnd}` placeholder. Date-like values
 *     ('now', '-7d', '+1m', ISO timestamps) get resolved/formatted via `dateFormat`.
 */
export type PeriodMapValue = string | Record<string, string>

export interface ExtractSpec {
  source: Source
  pagination?: Pagination
  periodMap?: Partial<Record<PeriodPreset, PeriodMapValue>>
  /** Maps each variable name produced by `periodMap` to a date format. Default 'iso'. */
  dateFormat?: Record<string, DateFormat>
  /**
   * For backends that cap history at N days per request (e.g. Inter, ~2 years), iterate the
   * extraction in fixed-size windows from "now" backwards, merging results. Each window runs
   * the full pagination loop. Stops early if a window brings no new transactions.
   */
  windowedHistory?: WindowedHistory
  /**
   * Fetches a runtime list of items (e.g. credit-card invoice cycles) and runs the rest of this
   * extract once per item, injecting fields from each item as template vars. All results are
   * merged into the same account (dedup by fitId). Mutually exclusive with `windowedHistory`.
   * Use for endpoints shaped as "list of cycles/bills/periods, then transactions per cycle".
   */
  iterate?: IterateSpec
  /** Dot path to the array of items inside the parsed response. Use `[*]` to flatten arrays. */
  list: string
  fields: FieldsSpec
  /** Polite delay between paginated requests, ms. Default 250. */
  delayMs?: number
  /**
   * When set, this extract only runs for the listed period presets. Useful when an extract
   * covers historical data and shouldn't be triggered by short-period selections (e.g. Inter's
   * paginated `/transactions` should only run for `all` since the backend ignores date filters).
   */
  runOnlyForPresets?: PeriodPreset[]
  /**
   * Field names to copy from the immediate parent into each leaf item produced by `list`.
   * Useful when the leaf lacks context the parent has — e.g. Inter's transactions sometimes
   * have no date in `detail.data`, but the `bankStatements[]` parent has `day`.
   */
  inheritFromParent?: string[]
}

/**
 * One field resolver inside an `IterateSpec`. Pulls a value from each iterated item and exposes
 * it as a template var.
 *   - `{ path }`: direct read.
 *   - `{ path, mapValues }`: read then translate (e.g. `'aberta' → 'OPEN'`). Unknown values pass through.
 *   - `{ const }`: literal — useful for splitting one iterate across multiple cases.
 */
export type IterateField = { path: string } | { path: string; mapValues: Record<string, string> } | { const: string }

export interface IterateSpec {
  /** Where to fetch the iteration list (e.g. `/v2/faturas/resumos`). */
  source: Source
  /** Dot path to the list of items inside the parsed response. Supports `[*]`. */
  list: string
  /**
   * Map var name → field resolver. Each key becomes a `{key}` template var visible to URL,
   * headers, body of the per-item extract. Keys may contain dots (e.g. `cycle.id`).
   */
  fields: Record<string, IterateField>
  /** When set, items not matching this condition are skipped (no per-item fetch). */
  filter?: PathCondition
  /** Polite delay between per-item extract runs, ms. Default 250. */
  delayMs?: number
  /** Hard cap on iterations. Default 500. */
  max?: number
}

export interface WindowedHistory {
  /** Window width in days. E.g. Inter limits to ~2 years → 730. */
  windowDays: number
  /** Maximum years to look back from today. Hard ceiling. */
  maxYears: number
  /** Variable name exposed to URL/body templates for the window start. Default `windowStart`. */
  startVar?: string
  /** Variable name for the window end. Default `windowEnd`. */
  endVar?: string
  /** Date format applied to the window vars (default `iso-utc`). */
  format?: DateFormat
  /** Polite delay between windows, ms. Default 500. */
  delayMs?: number
}

export interface SingleAccountSpec {
  kind: 'single'
  id: string
  name: string
  type: AccountType
  currency: string
  /** A single extraction. Use either this or `extracts` (which takes precedence). */
  extract?: ExtractSpec
  /**
   * Multiple extractions merged into the same account. Useful when one endpoint covers recent
   * transactions and another covers historical (Inter does this: `/home` for ~70 days, paginated
   * `/transactions` for older data). Dedup by `fitId` keeps each transaction once.
   */
  extracts?: ExtractSpec[]
}

export interface DiscoveredAccountSpec {
  kind: 'discovered'
  /** Stable id prefix; per-discovery id appended. */
  idPrefix: string
  type: AccountType
  currency: string
  /** How to discover the list of sub-accounts. */
  discover: {
    source: Source
    list: string
    /**
     * Map var names → JSON paths inside each discovered item. `id` and `name` are required.
     * Every key is exposed downstream as `{discovered.<key>}` in URL, headers, and body templates.
     * Example: `{ id: 'cardAccount', name: 'productDescription', product: 'productCode' }` →
     * `{discovered.id}`, `{discovered.name}`, `{discovered.product}`.
     */
    fields: { id: string; name: string } & Record<string, string>
  }
  /** Template to extract one sub-account; URL/headers/body may reference any `{discovered.<key>}`. */
  extract: ExtractSpec
  /** Account name template, e.g. "Banco — Cofrinho {discovered.name}". */
  nameTemplate: string
}

export type AccountSpec = SingleAccountSpec | DiscoveredAccountSpec

// ---------------------------------------------------------------------------
// Recipe (the only kind there is)
// ---------------------------------------------------------------------------

export interface BankInfo {
  /** ISPB (8 digits) or other code expected by the importer in <BANKID>/<FID>. */
  id?: string
  /** Bank display name, used in <FI><ORG>. */
  org?: string
  /** Default branch (used as <BRANCHID>) when an account doesn't override. */
  branchId?: string
}

export interface Recipe {
  $schema: typeof RECIPE_SCHEMA
  site: string
  version: number
  label: string
  /** Match patterns for current-tab detection. Each pattern is a host glob like `*.bank.com.br`. */
  matchHosts: string[]
  accounts: AccountSpec[]
  bank?: BankInfo
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function parseRecipe(input: unknown): Recipe {
  if (!isObject(input)) throw new Error('Recipe deve ser um objeto JSON')
  if (input.$schema !== RECIPE_SCHEMA) {
    throw new Error(`Campo "$schema" deve ser "${RECIPE_SCHEMA}"`)
  }
  const site = requireString(input, 'site')
  const label = requireString(input, 'label')
  const version = requireNumber(input, 'version')
  const matchHosts = Array.isArray(input.matchHosts)
    ? input.matchHosts.filter((v): v is string => typeof v === 'string')
    : [site]
  const accounts = input.accounts
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('Campo "accounts" deve ser uma lista não vazia')
  }
  return {
    $schema: RECIPE_SCHEMA,
    site,
    version,
    label,
    matchHosts,
    accounts: accounts.map((a, i) => parseAccount(a, i)),
    bank: parseBankInfo(input.bank),
  }
}

function parseBankInfo(input: unknown): BankInfo | undefined {
  if (!isObject(input)) return undefined
  const out: BankInfo = {}
  if (typeof input.id === 'string' && input.id.length > 0) out.id = input.id
  if (typeof input.org === 'string' && input.org.length > 0) out.org = input.org
  if (typeof input.branchId === 'string' && input.branchId.length > 0) out.branchId = input.branchId
  return Object.keys(out).length > 0 ? out : undefined
}

function parseAccount(input: unknown, i: number): AccountSpec {
  if (!isObject(input)) throw new Error(`accounts[${i}] deve ser objeto`)
  if (input.kind === 'discovered') return parseDiscovered(input, i)
  if (input.kind === 'single' || input.kind === undefined) return parseSingle(input, i)
  throw new Error(`accounts[${i}].kind inválido: ${String(input.kind)}`)
}

function parseSingle(input: Record<string, unknown>, i: number): SingleAccountSpec {
  const hasExtracts = Array.isArray(input.extracts) && input.extracts.length > 0
  const extracts = hasExtracts
    ? (input.extracts as unknown[]).map((e, j) => parseExtract(e, `accounts[${i}].extracts[${j}]`))
    : undefined
  const extract = !hasExtracts ? parseExtract(input.extract, `accounts[${i}].extract`) : undefined
  return {
    kind: 'single',
    id: requireString(input, 'id', `accounts[${i}]`),
    name: requireString(input, 'name', `accounts[${i}]`),
    type: requireAccountType(input.type, `accounts[${i}].type`),
    currency: requireString(input, 'currency', `accounts[${i}]`),
    extract,
    extracts,
  }
}

function parseDiscovered(input: Record<string, unknown>, i: number): DiscoveredAccountSpec {
  const discover = input.discover
  if (!isObject(discover)) throw new Error(`accounts[${i}].discover deve ser objeto`)
  const dFields = discover.fields
  if (!isObject(dFields)) throw new Error(`accounts[${i}].discover.fields deve ser objeto`)

  const id = requireString(dFields, 'id', `accounts[${i}].discover.fields`)
  const name = requireString(dFields, 'name', `accounts[${i}].discover.fields`)
  const fields: { id: string; name: string } & Record<string, string> = { id, name }
  for (const [k, v] of Object.entries(dFields)) {
    if (k === 'id' || k === 'name') continue
    if (typeof v === 'string' && v.length > 0) fields[k] = v
  }

  return {
    kind: 'discovered',
    idPrefix: requireString(input, 'idPrefix', `accounts[${i}]`),
    type: requireAccountType(input.type, `accounts[${i}].type`),
    currency: requireString(input, 'currency', `accounts[${i}]`),
    discover: {
      source: parseSource(discover.source, `accounts[${i}].discover.source`),
      list: requireString(discover, 'list', `accounts[${i}].discover`),
      fields,
    },
    extract: parseExtract(input.extract, `accounts[${i}].extract`),
    nameTemplate: requireString(input, 'nameTemplate', `accounts[${i}]`),
  }
}

function parseExtract(input: unknown, scope: string): ExtractSpec {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  const iterate = parseIterate(input.iterate, `${scope}.iterate`)
  const windowedHistory = parseWindowedHistory(input.windowedHistory)
  if (iterate && windowedHistory) {
    throw new Error(`${scope}: iterate e windowedHistory são mutuamente exclusivos`)
  }
  return {
    source: parseSource(input.source, `${scope}.source`),
    pagination: parsePagination(input.pagination),
    periodMap: parsePeriodMap(input.periodMap),
    dateFormat: parseDateFormatMap(input.dateFormat),
    windowedHistory,
    iterate,
    list: requireString(input, 'list', scope),
    fields: parseFields(input.fields, `${scope}.fields`),
    delayMs: typeof input.delayMs === 'number' ? input.delayMs : 250,
    runOnlyForPresets: parsePresetList(input.runOnlyForPresets),
    inheritFromParent: Array.isArray(input.inheritFromParent)
      ? input.inheritFromParent.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : undefined,
  }
}

function parseIterate(input: unknown, scope: string): IterateSpec | undefined {
  if (input === undefined) return undefined
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  const rawFields = input.fields
  if (!isObject(rawFields) || Object.keys(rawFields).length === 0) {
    throw new Error(`${scope}.fields deve ser objeto não vazio`)
  }
  const fields: Record<string, IterateField> = {}
  for (const [key, value] of Object.entries(rawFields)) {
    fields[key] = parseIterateField(value, `${scope}.fields.${key}`)
  }
  return {
    source: parseSource(input.source, `${scope}.source`),
    list: requireString(input, 'list', scope),
    fields,
    filter: isObject(input.filter) ? parsePathCondition(input.filter, `${scope}.filter`) : undefined,
    delayMs: typeof input.delayMs === 'number' ? input.delayMs : 250,
    max: typeof input.max === 'number' ? input.max : 500,
  }
}

function parseIterateField(input: unknown, scope: string): IterateField {
  if (typeof input === 'string') return { path: input }
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto ou string (atalho p/ path)`)
  if (typeof input.const === 'string') return { const: input.const }
  if (typeof input.path !== 'string' || input.path.length === 0) {
    throw new Error(`${scope}: precisa de "path" (string) ou "const" (string)`)
  }
  if (isObject(input.mapValues)) {
    const mapValues: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.mapValues)) {
      if (typeof v === 'string') mapValues[k] = v
    }
    if (Object.keys(mapValues).length > 0) return { path: input.path, mapValues }
  }
  return { path: input.path }
}

function parsePresetList(input: unknown): PeriodPreset[] | undefined {
  if (!Array.isArray(input)) return undefined
  const valid: PeriodPreset[] = ['today', 'yesterday', 'last_week', 'last_two_weeks', 'month', 'all']
  const out = input.filter((v): v is PeriodPreset => typeof v === 'string' && (valid as string[]).includes(v))
  return out.length > 0 ? out : undefined
}

function parseWindowedHistory(input: unknown): WindowedHistory | undefined {
  if (!isObject(input)) return undefined
  return {
    windowDays: requireNumber(input, 'windowDays', 'windowedHistory'),
    maxYears: requireNumber(input, 'maxYears', 'windowedHistory'),
    startVar: typeof input.startVar === 'string' ? input.startVar : 'windowStart',
    endVar: typeof input.endVar === 'string' ? input.endVar : 'windowEnd',
    format:
      input.format === 'iso' ||
      input.format === 'iso-utc' ||
      input.format === 'iso-date' ||
      input.format === 'br-date' ||
      input.format === 'unix-ms' ||
      input.format === 'unix-s'
        ? input.format
        : 'iso-utc',
    delayMs: typeof input.delayMs === 'number' ? input.delayMs : 500,
  }
}

function parsePeriodMap(input: unknown): ExtractSpec['periodMap'] {
  if (!isObject(input)) return undefined
  const out: Record<string, PeriodMapValue> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value
    else if (isObject(value)) {
      const sub: Record<string, string> = {}
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === 'string') sub[k] = v
      }
      if (Object.keys(sub).length > 0) out[key] = sub
    }
  }
  return out as ExtractSpec['periodMap']
}

function parseDateFormatMap(input: unknown): ExtractSpec['dateFormat'] {
  if (!isObject(input)) return undefined
  const out: Record<string, DateFormat> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v === 'iso' || v === 'iso-utc' || v === 'iso-date' || v === 'br-date' || v === 'unix-ms' || v === 'unix-s')
      out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseSource(input: unknown, scope: string): Source {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  const url = requireString(input, 'url', scope)
  if (input.type === 'ssr-nordic') return { type: 'ssr-nordic', url }
  if (input.type === 'ssr-next') return { type: 'ssr-next', url }
  if (input.type === 'rest-json') {
    return {
      type: 'rest-json',
      url,
      method: input.method === 'POST' ? 'POST' : 'GET',
      headers: isObject(input.headers) ? (input.headers as Record<string, string>) : undefined,
      body: isObject(input.body) ? (input.body as Record<string, unknown>) : undefined,
    }
  }
  throw new Error(`${scope}.type inválido: ${String(input.type)}`)
}

function parsePagination(input: unknown): Pagination {
  if (!isObject(input)) return { type: 'none' }
  if (input.type === 'page-count') {
    return {
      type: 'page-count',
      totalPath: typeof input.totalPath === 'string' && input.totalPath.length > 0 ? input.totalPath : undefined,
      stopWhen: isObject(input.stopWhen) ? parsePathCondition(input.stopWhen, 'pagination.stopWhen') : undefined,
      startPage: typeof input.startPage === 'number' ? input.startPage : 1,
      max: typeof input.max === 'number' ? input.max : 100,
    }
  }
  if (input.type === 'cursor') {
    return {
      type: 'cursor',
      nextPath: requireString(input, 'nextPath', 'pagination'),
      max: typeof input.max === 'number' ? input.max : 100,
    }
  }
  if (input.type === 'page-until-empty') {
    return {
      type: 'page-until-empty',
      pageSize: requireNumber(input, 'pageSize', 'pagination'),
      startPage: typeof input.startPage === 'number' ? input.startPage : 1,
      max: typeof input.max === 'number' ? input.max : 100,
    }
  }
  return { type: 'none' }
}

function parseFields(input: unknown, scope: string): FieldsSpec {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  return {
    id: parseIdField(input.id, `${scope}.id`),
    postedAt: parseDateField(input.postedAt, `${scope}.postedAt`),
    amount: parseAmountField(input.amount, `${scope}.amount`),
    description: parseDescriptionField(input.description, `${scope}.description`),
    type: parseTypeField(input.type, `${scope}.type`),
    currency: parseCurrencyField(input.currency, `${scope}.currency`),
  }
}

function parseCurrencyField(input: unknown, scope: string): CurrencyField | undefined {
  if (!isObject(input)) return undefined
  if (typeof input.const === 'string' && input.const.length > 0) return { const: input.const }
  if (typeof input.path === 'string' && input.path.length > 0) return { path: input.path }
  throw new Error(`${scope}: precisa de "path" (string) ou "const" (string)`)
}

function parseIdField(input: unknown, scope: string): IdField {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  if (typeof input.template === 'string' && input.template.length > 0) {
    return { template: input.template }
  }
  if (Array.isArray(input.paths)) {
    return {
      paths: input.paths.filter((v): v is string => typeof v === 'string'),
      join: typeof input.join === 'string' ? input.join : '|',
    }
  }
  return { path: requireString(input, 'path', scope) }
}

function parseDateField(input: unknown, scope: string): DateField {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  const format = input.format
  const fmt: DateFormat =
    format === 'iso' ||
    format === 'iso-utc' ||
    format === 'iso-date' ||
    format === 'br-date' ||
    format === 'unix-ms' ||
    format === 'unix-s'
      ? format
      : 'iso'
  if (Array.isArray(input.paths)) {
    const paths = input.paths.filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (paths.length === 0) throw new Error(`${scope}.paths não pode ser vazio`)
    return { paths, format: fmt }
  }
  return { path: requireString(input, 'path', scope), format: fmt }
}

function parseAmountField(input: unknown, scope: string): AmountField {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  if (typeof input.fractionPath === 'string' && typeof input.centsPath === 'string') {
    return { fractionPath: input.fractionPath, centsPath: input.centsPath }
  }
  if (input.format === 'br') return { path: requireString(input, 'path', scope), format: 'br' }
  return { path: requireString(input, 'path', scope), scale: typeof input.scale === 'number' ? input.scale : 1 }
}

function parseDescriptionField(input: unknown, scope: string): DescriptionField {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  if (typeof input.template === 'string') {
    const prefixes = Array.isArray(input.prefixes)
      ? input.prefixes.filter(isObject).map((p) => ({
          when: parsePathCondition(p.when, `${scope}.prefixes[].when`),
          value: requireString(p, 'value', `${scope}.prefixes[]`),
        }))
      : undefined
    return { template: input.template, prefixes }
  }
  return { path: requireString(input, 'path', scope) }
}

function parseTypeField(input: unknown, scope: string): TypeField {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  if (
    input.creditWhenSign === '>=0' ||
    input.creditWhenSign === '>0' ||
    input.creditWhenSign === 'positive' ||
    input.creditWhenSign === 'non-negative'
  ) {
    return { creditWhenSign: input.creditWhenSign }
  }
  if (input.fixed === 'credit' || input.fixed === 'debit') return { fixed: input.fixed }
  if (isObject(input.creditWhen)) {
    return { creditWhen: parsePathCondition(input.creditWhen, `${scope}.creditWhen`) }
  }
  if (isObject(input.debitWhen)) {
    return { debitWhen: parsePathCondition(input.debitWhen, `${scope}.debitWhen`) }
  }
  throw new Error(`${scope}: especifique creditWhenSign | creditWhen | debitWhen | fixed`)
}

function parsePathCondition(input: unknown, scope: string): PathCondition {
  if (!isObject(input)) throw new Error(`${scope} deve ser objeto`)
  return {
    path: requireString(input, 'path', scope),
    equals: typeof input.equals === 'string' ? input.equals : undefined,
    notEquals: typeof input.notEquals === 'string' ? input.notEquals : undefined,
    exists: typeof input.exists === 'boolean' ? input.exists : undefined,
  }
}

function requireAccountType(v: unknown, scope: string): AccountType {
  if (v === 'checking' || v === 'savings' || v === 'credit_card' || v === 'investment' || v === 'pending') return v
  if (v === 'credit-card') return 'credit_card'
  throw new Error(`${scope} inválido: ${String(v)}`)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function requireString(obj: Record<string, unknown>, key: string, scope = ''): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${scope ? `${scope}.` : ''}${key} é obrigatório (string)`)
  }
  return v
}
function requireNumber(obj: Record<string, unknown>, key: string, scope = ''): number {
  const v = obj[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${scope ? `${scope}.` : ''}${key} é obrigatório (number)`)
  }
  return v
}
