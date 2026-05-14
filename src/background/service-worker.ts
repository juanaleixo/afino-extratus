import { buildCsv } from '@/engine/csv-generator'
import { buildOfx } from '@/engine/ofx-generator'
import {
  type AccountSummary,
  type CapturedHeaderReader,
  LoginRequiredError,
  type ProgressEvent,
  type StorageReader,
  planAccounts,
  runRecipe,
} from '@/engine/recipe-engine'
import { findRecipeBySite, listAllRecipes } from '@/recipes/_registry'
import type { PeriodFilter } from '@/recipes/_schema'
import { deleteCustomRecipe, importCustomRecipe } from '@/storage/custom-recipes'

console.log('[afino] SW loaded')

// ---------------------------------------------------------------------------
// Capture incoming request headers via webRequest (catches pre-existing tabs that
// the content script can't touch). Same storage as the content-script bridge, so
// readers don't care which path the value came from.
// ---------------------------------------------------------------------------
const CAPTURE_HOST_FILTERS = [
  '*://*.mercadopago.com.br/*',
  '*://*.rico.com.vc/*',
  '*://*.inter.co/*',
  '*://*.bancointer.com.br/*',
]
const INTERESTING_HEADER_RE = /^(authorization|csrf-token|x-[\w-]+)$/i

try {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      try {
        const host = new URL(details.url).host
        const headers: Record<string, string> = {}
        for (const h of details.requestHeaders ?? []) {
          if (h.value && INTERESTING_HEADER_RE.test(h.name) && !/^sec-/i.test(h.name)) {
            headers[h.name.toLowerCase()] = h.value
          }
        }
        if (Object.keys(headers).length > 0) {
          console.log('[afino] webRequest captured', host, Object.keys(headers))
          void storeCapturedHeaders(host, headers)
        }
      } catch {}
    },
    { urls: CAPTURE_HOST_FILTERS },
    ['requestHeaders', 'extraHeaders'],
  )
  console.log('[afino] webRequest capture installed')
} catch (err) {
  console.warn('[afino] webRequest capture unavailable', err)
}

interface ListRecipesMessage {
  type: 'list-recipes'
}
interface ListAccountsMessage {
  type: 'list-accounts'
  site: string
}
type ExportFormat = 'ofx' | 'csv' | 'both'
interface ExportMessage {
  type: 'export'
  site: string
  period?: PeriodFilter
  accountIds?: string[]
  format?: ExportFormat
}
interface ImportRecipeMessage {
  type: 'import-recipe'
  json: string
}
interface DeleteRecipeMessage {
  type: 'delete-recipe'
  site: string
}
interface CapturedHeadersMessage {
  type: 'captured-headers'
  host: string
  headers: Record<string, string>
}

type IncomingMessage =
  | ListRecipesMessage
  | ListAccountsMessage
  | ExportMessage
  | ImportRecipeMessage
  | DeleteRecipeMessage
  | CapturedHeadersMessage

chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
  console.log('[afino] message received', message.type)
  if (message.type === 'list-recipes') {
    handleList()
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (message.type === 'list-accounts') {
    handleListAccounts(message.site)
      .then((accounts) => sendResponse({ ok: true, accounts }))
      .catch((err: Error) => {
        const loginRequired = err instanceof LoginRequiredError || err.name === 'LoginRequiredError'
        sendResponse({ ok: false, error: err.message, loginRequired })
      })
    return true
  }

  if (message.type === 'export') {
    handleExport(message)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err: Error) => {
        const loginRequired = err instanceof LoginRequiredError || err.name === 'LoginRequiredError'
        sendResponse({ ok: false, error: err.message, loginRequired })
      })
    return true
  }

  if (message.type === 'import-recipe') {
    importCustomRecipe(message.json)
      .then((recipe) => sendResponse({ ok: true, site: recipe.site, label: recipe.label }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (message.type === 'delete-recipe') {
    deleteCustomRecipe(message.site)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (message.type === 'captured-headers') {
    void storeCapturedHeaders(message.host, message.headers)
    return false
  }

  return false
})

const CAPTURED_TTL_MS = 30 * 60 * 1000

async function storeCapturedHeaders(host: string, headers: Record<string, string>): Promise<void> {
  if (!host || Object.keys(headers).length === 0) return
  const KEY = `afino:captured:${host}`
  const now = Date.now()
  const existing = (await chrome.storage.local.get(KEY))[KEY] as
    | Record<string, { value: string; ts: number }>
    | undefined
  const map = existing ?? {}
  for (const [k, v] of Object.entries(headers)) {
    map[k.toLowerCase()] = { value: v, ts: now }
  }
  await chrome.storage.local.set({ [KEY]: map })
}

const chromeCapturedReader: CapturedHeaderReader = async ({ candidateHosts, headerName }) => {
  const name = headerName.toLowerCase()
  for (const host of candidateHosts) {
    const KEY = `afino:captured:${host}`
    const map = (await chrome.storage.local.get(KEY))[KEY] as Record<string, { value: string; ts: number }> | undefined
    const entry = map?.[name]
    if (entry && Date.now() - entry.ts < CAPTURED_TTL_MS) {
      console.log('[afino] capturedReader hit', { host, name, ts: entry.ts })
      return entry.value
    }
  }
  console.log('[afino] capturedReader miss', { name, candidateHosts })
  return null
}

async function handleList(): Promise<{
  recipes: Array<{ site: string; label: string; source: 'built-in' | 'custom' }>
  currentSite: string | null
}> {
  const all = await listAllRecipes()
  const recipes = all.map(({ recipe, source }) => ({ site: recipe.site, label: recipe.label, source }))
  const currentSite = await detectCurrentSite(all)
  return { recipes, currentSite }
}

async function detectCurrentSite(
  all: Array<{ recipe: { site: string; matchHosts: string[] } }>,
): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) return null
    const host = new URL(tab.url).host
    for (const { recipe } of all) {
      if (recipe.matchHosts.some((p) => hostMatches(host, p))) return recipe.site
    }
    return null
  } catch {
    return null
  }
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2)
    return host === suffix || host.endsWith(`.${suffix}`)
  }
  return host === pattern
}

async function handleListAccounts(site: string): Promise<AccountSummary[]> {
  const recipe = await findRecipeBySite(site)
  if (!recipe) throw new Error(`Recipe desconhecida: ${site}`)
  return planAccounts(
    recipe,
    instrumentedFetch(globalThis.fetch.bind(globalThis)),
    chromeStorageReader,
    chromeCapturedReader,
  )
}

/**
 * Reads a key from sessionStorage / localStorage of an open tab matching one of the recipe's hosts.
 * The token may live on a different origin than the API (e.g. Rico API at api.rico.com.vc, token at
 * arealogada.rico.com.vc). We try each candidate host until we find an open tab and a non-null value.
 *
 * The engine restricts fetches to matchHosts before we get here, so this can only ever read storage
 * for hosts the recipe author already declared.
 */
const chromeStorageReader: StorageReader = async ({ host, candidateHosts, type, key }) => {
  const search = [host, ...candidateHosts.filter((h) => h !== host)]
  console.log('[afino] storageReader: searching for', { type, key, search })
  for (const h of search) {
    const value = await tryReadStorageOnHost(h, type, key)
    console.log('[afino] storageReader: host', h, '→', value === null ? 'null' : `len=${value.length}`)
    if (value != null) return value
  }
  console.log('[afino] storageReader: nothing found for', { type, key, search })
  return null
}

async function tryReadStorageOnHost(
  host: string,
  type: 'sessionStorage' | 'localStorage',
  key: string,
): Promise<string | null> {
  if (host.includes('*')) return null
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({ url: `https://${host}/*` })
  } catch (err) {
    console.warn('[afino] tabs.query failed', host, err)
    return null
  }
  console.log('[afino] tabs.query', host, '→', tabs.length, 'tabs')
  const tab = tabs.find((t) => t.id != null)
  if (!tab?.id) return null
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [type, key],
      func: (storageType: 'sessionStorage' | 'localStorage', storageKey: string) => {
        const store: Storage = storageType === 'sessionStorage' ? window.sessionStorage : window.localStorage
        return {
          value: store.getItem(storageKey),
          // Echo a sample of available keys so we can see if the recipe used the wrong name.
          sampleKeys: Object.keys(store).slice(0, 20),
        }
      },
    })
    const out = result?.result as { value: string | null; sampleKeys: string[] } | undefined
    if (out) console.log('[afino] storage on', host, 'sampleKeys:', out.sampleKeys)
    return out?.value ?? null
  } catch (err) {
    console.warn('[afino] storage read failed', host, type, key, err)
    return null
  }
}

async function handleExport(req: ExportMessage): Promise<{
  accounts: number
  transactions: number
  files: number
  site: string
}> {
  console.log('[afino] export start', req)
  const recipe = await findRecipeBySite(req.site)
  if (!recipe) throw new Error(`Recipe desconhecida: ${req.site}`)
  console.log('[afino] recipe found', recipe.site, recipe.accounts.length, 'accounts')

  const results = await runRecipe({
    recipe,
    fetch: instrumentedFetch(globalThis.fetch.bind(globalThis)),
    period: req.period,
    accountIds: req.accountIds,
    onProgress: emitProgress,
    storageReader: chromeStorageReader,
    capturedReader: chromeCapturedReader,
  })
  console.log('[afino] runRecipe done', { results: results.length })

  const format: ExportFormat = req.format ?? 'ofx'
  const wantsOfx = format === 'ofx' || format === 'both'
  const wantsCsv = format === 'csv' || format === 'both'

  // One file per account (Afino's import flow expects one statement per account).
  let filesWritten = 0
  for (const result of results) {
    if (wantsOfx) {
      const ofx = buildOfx([result])
      await downloadDataUrl(
        ofx,
        'application/x-ofx',
        buildFilename(req.site, result.account.id, result.account.name, 'ofx'),
      )
      filesWritten += 1
    }
    if (wantsCsv) {
      const csv = buildCsv([result])
      await downloadDataUrl(csv, 'text/csv', buildFilename(req.site, result.account.id, result.account.name, 'csv'))
      filesWritten += 1
    }
  }

  return {
    accounts: results.length,
    transactions: results.reduce((s, r) => s + r.transactions.length, 0),
    files: filesWritten,
    site: req.site,
  }
}

async function downloadDataUrl(content: string, mime: string, filename: string): Promise<void> {
  // MV3 service workers don't expose URL.createObjectURL. Use a base64 data URL instead.
  const b64 = btoa(unescape(encodeURIComponent(content)))
  const url = `data:${mime};charset=utf-8;base64,${b64}`
  await chrome.downloads.download({ url, filename, saveAs: false })
}

function emitProgress(event: ProgressEvent): void {
  chrome.runtime.sendMessage({ type: 'export-progress', event }).catch(() => {
    // popup may have closed; ignore
  })
}

function instrumentedFetch(inner: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    console.log('[afino] fetch →', url)
    try {
      const r = await inner(input, init)
      console.log('[afino] fetch ←', r.status, url)
      return r
    } catch (err) {
      console.log('[afino] fetch ✗', url, err)
      throw err
    }
  }) as typeof fetch
}

function buildFilename(site: string, accountId: string, accountName: string, ext: 'ofx' | 'csv'): string {
  const safeSite = site.replace(/[^a-z0-9]/gi, '_')
  const safeAccount = accountName
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  const stamp = new Date().toISOString().slice(0, 10)
  const tag = safeAccount || accountId.replace(/[^a-z0-9]/gi, '-')
  return `afino-${safeSite}-${tag}-${stamp}.${ext}`
}
