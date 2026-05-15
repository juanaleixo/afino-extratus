import type { AccountSummary, ProgressEvent } from '@/engine/recipe-engine'
import type { PeriodPreset } from '@/recipes/_schema'
import helpUrl from './help.html?url'

interface RecipeSummary {
  site: string
  label: string
  source: 'built-in' | 'custom'
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const recipeSelect = $<HTMLSelectElement>('recipe-select')
const periodSelect = $<HTMLSelectElement>('period-select')
const formatSelect = $<HTMLSelectElement>('format-select')
const exportBtn = $<HTMLButtonElement>('export-ofx')
const statusEl = $<HTMLDivElement>('status')
const helpLink = $<HTMLAnchorElement>('help-link')

const currentCard = $<HTMLElement>('current-card')
const currentLabel = $<HTMLElement>('current-label')
const currentSource = $<HTMLSpanElement>('current-source')
const currentExportBtn = $<HTMLButtonElement>('current-export')

const importTextarea = $<HTMLTextAreaElement>('import-textarea')
const importBtn = $<HTMLButtonElement>('import-btn')
const deleteBtn = $<HTMLButtonElement>('delete-btn')
const ofxImportFile = $<HTMLInputElement>('ofx-import-file')
const ofxImportFormat = $<HTMLSelectElement>('ofx-import-format')
const ofxImportStatus = $<HTMLParagraphElement>('ofx-import-status')
const progressEl = $<HTMLDivElement>('progress')
const accountsRefreshBtn = $<HTMLButtonElement>('accounts-refresh')
const accountsListEl = $<HTMLDivElement>('accounts-list')

helpLink.href = helpUrl

let allRecipes: RecipeSummary[] = []
let detectedSite: string | null = null
/** Per-site cache of "selected" account ids. null = "all" (don't filter). */
const accountSelections = new Map<string, Set<string>>()
/** Per-site cache of the listed accounts so we don't re-fetch on every popup open. */
const accountListCache = new Map<string, AccountSummary[]>()

init().catch((err: Error) => setStatus(`Erro: ${err.message}`, 'error'))

async function init(): Promise<void> {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'export-progress') handleProgress(msg.event as ProgressEvent)
    return false
  })
  await refreshRecipes()
  exportBtn.addEventListener('click', () => exportNow(recipeSelect.value))
  currentExportBtn.addEventListener('click', () => exportNow(detectedSite ?? recipeSelect.value))
  importBtn.addEventListener('click', importRecipe)
  deleteBtn.addEventListener('click', deleteRecipe)
  ofxImportFile.addEventListener('change', () => {
    const file = ofxImportFile.files?.[0]
    if (file) void importOfxFile(file)
  })
  recipeSelect.addEventListener('change', () => {
    updateDeleteButton()
    renderAccountsList(recipeSelect.value)
  })
  accountsRefreshBtn.addEventListener('click', () => loadAccounts(recipeSelect.value, true))
  renderAccountsList(recipeSelect.value)
}

interface PerAccountProgress {
  name: string
  page: number
  totalPages: number | null
  pagesFetched: number
  txCollected: number
  done: boolean
}

let progressState: {
  totalAccounts: number
  byIndex: Map<number, PerAccountProgress>
} | null = null

function handleProgress(event: ProgressEvent): void {
  const bar = progressEl.firstElementChild as HTMLSpanElement
  switch (event.phase) {
    case 'starting':
      progressState = null
      progressEl.classList.remove('determinate')
      bar.style.width = ''
      setStatus('Iniciando…', null)
      break
    case 'discovering':
      setStatus('Descobrindo contas disponíveis…', null)
      break
    case 'planned':
      progressState = { totalAccounts: event.totalAccounts, byIndex: new Map() }
      progressEl.classList.add('determinate')
      bar.style.width = '0%'
      setStatus(`${event.totalAccounts} ${event.totalAccounts === 1 ? 'conta' : 'contas'} a processar`, null)
      break
    case 'page': {
      if (!progressState) break
      const prev = progressState.byIndex.get(event.accountIndex)
      progressState.byIndex.set(event.accountIndex, {
        name: event.accountName,
        page: event.page,
        totalPages: event.totalPages,
        pagesFetched: event.pagesFetched,
        txCollected: event.txCollected,
        done: prev?.done ?? false,
      })
      updateProgressUi()
      break
    }
    case 'account-done': {
      if (!progressState) break
      const prev = progressState.byIndex.get(event.accountIndex)
      progressState.byIndex.set(event.accountIndex, {
        name: event.accountName,
        page: prev?.page ?? 1,
        totalPages: prev?.totalPages ?? 1,
        pagesFetched: prev?.pagesFetched ?? 0,
        txCollected: event.transactions,
        done: true,
      })
      updateProgressUi()
      break
    }
    case 'done':
      // Force determinate so the 100% width actually applies (during the run we may be in
      // indeterminate mode for stopWhen-style pagination).
      progressEl.classList.add('determinate')
      bar.style.width = '100%'
      break
  }
}

function updateProgressUi(): void {
  if (!progressState) return
  const bar = progressEl.firstElementChild as HTMLSpanElement
  let sum = 0
  let doneCount = 0
  let anyUnknownInFlight = false
  const inFlight: PerAccountProgress[] = []
  for (let i = 0; i < progressState.totalAccounts; i++) {
    const s = progressState.byIndex.get(i)
    if (!s) continue
    if (s.done) {
      sum += 1
      doneCount += 1
    } else {
      // Use page/totalPages fraction only when the API gives a real total; otherwise the in-flight
      // account is "unknown progress" — we contribute 0 to the bar and pulse it indeterminate.
      if (s.totalPages && s.totalPages > 0) {
        sum += Math.min(1, s.page / s.totalPages)
      } else {
        anyUnknownInFlight = true
      }
      inFlight.push(s)
    }
  }

  // Determinate bar only when we have a real estimate. Otherwise let CSS animate the pulse.
  if (anyUnknownInFlight) {
    progressEl.classList.remove('determinate')
    bar.style.width = ''
  } else {
    progressEl.classList.add('determinate')
    const overall = sum / Math.max(1, progressState.totalAccounts)
    bar.style.width = `${Math.min(100, overall * 100).toFixed(1)}%`
  }

  const head = inFlight.slice(0, 2).map(formatInFlight).join(' · ')
  const more = inFlight.length > 2 ? ` +${inFlight.length - 2}` : ''
  const tail = `(${doneCount}/${progressState.totalAccounts} ${progressState.totalAccounts === 1 ? 'conta' : 'contas'})`
  setStatus(head ? `${head}${more} ${tail}` : `Processando ${tail}`, null)
}

function formatInFlight(s: PerAccountProgress): string {
  // When the API gives a real total, show "page X/Y"; otherwise show the cumulative page count
  // for this account (across extracts, windows and iterate items) so the user sees movement.
  const progress = s.totalPages && s.totalPages > 0 ? `pág ${s.page}/${s.totalPages}` : `${s.pagesFetched} págs`
  return s.txCollected > 0 ? `${s.name} · ${progress} · ${s.txCollected} tx` : `${s.name} · ${progress}`
}

async function refreshRecipes(): Promise<void> {
  const resp = await chrome.runtime.sendMessage({ type: 'list-recipes' })
  if (!resp?.ok) {
    setStatus('Falha ao listar bancos suportados', 'error')
    return
  }
  allRecipes = resp.recipes as RecipeSummary[]
  detectedSite = (resp.currentSite as string | null) ?? null

  recipeSelect.innerHTML = ''
  for (const r of allRecipes) {
    const opt = document.createElement('option')
    opt.value = r.site
    opt.textContent = r.source === 'custom' ? `${r.label} · custom` : r.label
    recipeSelect.appendChild(opt)
  }

  if (detectedSite) {
    recipeSelect.value = detectedSite
    showCurrentCard(detectedSite)
  } else {
    currentCard.classList.add('hidden')
  }
  updateDeleteButton()
}

function showCurrentCard(site: string): void {
  const recipe = allRecipes.find((r) => r.site === site)
  if (!recipe) {
    currentCard.classList.add('hidden')
    return
  }
  currentLabel.textContent = recipe.label
  currentSource.textContent = recipe.source === 'custom' ? 'Custom' : 'Built-in'
  currentSource.classList.toggle('badge-custom', recipe.source === 'custom')
  currentSource.classList.toggle('badge-muted', recipe.source !== 'custom')
  currentCard.classList.remove('hidden')
}

function updateDeleteButton(): void {
  const r = allRecipes.find((x) => x.site === recipeSelect.value)
  deleteBtn.hidden = !r || r.source !== 'custom'
}

async function exportNow(site: string): Promise<void> {
  if (!site) return
  const accountIds = resolveSelectedAccountIds(site)
  setBusy(true)
  setStatus('Extraindo… isso pode levar 5–15 segundos', null)
  try {
    const resp = await withTimeout(
      chrome.runtime.sendMessage({
        type: 'export',
        site,
        period: { preset: periodSelect.value as PeriodPreset },
        accountIds,
        format: formatSelect.value as 'ofx' | 'csv' | 'both',
      }),
      120000,
      'Sem resposta do service worker em 2min. Abra chrome://extensions → "service worker" no card Afino Extratus e veja o console.',
    )
    if (!resp?.ok) {
      if (resp?.loginRequired) {
        showLoginRequired(site)
      } else {
        setStatus(`Erro: ${resp?.error ?? 'desconhecido'}`, 'error')
      }
      return
    }
    const { accounts, transactions, files } = resp.summary as {
      accounts: number
      transactions: number
      files: number
    }
    setStatus(
      `${transactions} transações em ${accounts} ${accounts === 1 ? 'conta' : 'contas'} — ${files} ${files === 1 ? 'arquivo OFX baixado' : 'arquivos OFX baixados'}`,
      'ok',
    )
  } catch (err) {
    setStatus(`Erro: ${(err as Error).message}`, 'error')
  } finally {
    setBusy(false)
  }
}

function resolveSelectedAccountIds(site: string): string[] | undefined {
  const cached = accountListCache.get(site)
  const selected = accountSelections.get(site)
  if (!cached || !selected) return undefined
  // If everything is selected, omit the filter (saves a step and avoids surprise if accounts change between list and run).
  if (selected.size === cached.length) return undefined
  return [...selected]
}

async function importRecipe(): Promise<void> {
  const json = importTextarea.value.trim()
  if (!json) {
    setStatus('Cole o JSON da recipe antes de importar', 'error')
    return
  }
  setBusy(true)
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'import-recipe', json })
    if (!resp?.ok) {
      setStatus(`Erro: ${resp?.error ?? 'falha ao importar'}`, 'error')
      return
    }
    importTextarea.value = ''
    await refreshRecipes()
    recipeSelect.value = resp.site
    updateDeleteButton()
    setStatus(`Recipe "${resp.label}" importada`, 'ok')
  } finally {
    setBusy(false)
  }
}

async function importOfxFile(file: File): Promise<void> {
  setOfxImportStatus(`Lendo "${file.name}"…`, null)
  ofxImportFile.disabled = true
  try {
    // Decoding charset matters: BR banks ship windows-1252; reading as UTF-8 silently mojibakes
    // accents. Peek at the header (which is ASCII) to choose the decoder.
    const buffer = new Uint8Array(await file.arrayBuffer())
    const probe = new TextDecoder('latin1').decode(buffer.slice(0, 1024))
    const charset = pickCharset(probe)
    const content = new TextDecoder(charset).decode(buffer)

    const resp = await chrome.runtime.sendMessage({
      type: 'import-ofx-file',
      content,
      filename: file.name,
      format: ofxImportFormat.value as 'ofx' | 'csv' | 'both',
    })
    if (!resp?.ok) {
      setOfxImportStatus(`Erro: ${resp?.error ?? 'falha ao importar OFX'}`, 'error')
      return
    }
    const { accounts, transactions, files } = resp.summary as {
      accounts: number
      transactions: number
      files: number
    }
    setOfxImportStatus(
      `${transactions} transações em ${accounts} ${accounts === 1 ? 'conta' : 'contas'} · ${files} ${files === 1 ? 'arquivo baixado' : 'arquivos baixados'}`,
      'ok',
    )
  } catch (err) {
    setOfxImportStatus(`Erro: ${(err as Error).message}`, 'error')
  } finally {
    ofxImportFile.disabled = false
    // Reset so picking the same file twice in a row still triggers `change`.
    ofxImportFile.value = ''
  }
}

function pickCharset(headerProbe: string): string {
  const m = headerProbe.match(/CHARSET:\s*(\S+)/i)
  if (m) {
    const v = m[1]?.trim().toLowerCase()
    if (v === '1252') return 'windows-1252'
    if (v === '8859-1' || v === 'iso-8859-1') return 'iso-8859-1'
    if (v === 'utf-8' || v === 'utf8') return 'utf-8'
  }
  const m2 = headerProbe.match(/encoding\s*=\s*["']([^"']+)["']/i)
  if (m2?.[1]) return m2[1].toLowerCase()
  return 'utf-8'
}

function setOfxImportStatus(text: string, kind: 'ok' | 'error' | null): void {
  ofxImportStatus.textContent = text
  ofxImportStatus.style.color = kind === 'ok' ? 'var(--success)' : kind === 'error' ? 'var(--error)' : ''
}

async function deleteRecipe(): Promise<void> {
  const site = recipeSelect.value
  if (!site) return
  const r = allRecipes.find((x) => x.site === site)
  if (!r || r.source !== 'custom') return
  setBusy(true)
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'delete-recipe', site })
    if (!resp?.ok) {
      setStatus(`Erro: ${resp?.error ?? 'falha ao remover'}`, 'error')
      return
    }
    await refreshRecipes()
    setStatus(`Recipe "${r.label}" removida`, 'ok')
  } finally {
    setBusy(false)
  }
}

function showLoginRequired(site: string): void {
  statusEl.textContent = 'Você não está logado. '
  statusEl.classList.remove('ok')
  statusEl.classList.add('error')
  const link = document.createElement('span')
  link.className = 'action'
  link.textContent = `Abrir ${site} →`
  link.addEventListener('click', () => {
    chrome.tabs.create({ url: `https://${site}/` })
  })
  statusEl.appendChild(link)
}

function setStatus(text: string, kind: 'ok' | 'error' | null): void {
  statusEl.textContent = text
  statusEl.classList.remove('ok', 'error')
  if (kind) statusEl.classList.add(kind)
}

function setBusy(busy: boolean): void {
  exportBtn.disabled = busy
  currentExportBtn.disabled = busy
  importBtn.disabled = busy
  deleteBtn.disabled = busy
  accountsRefreshBtn.disabled = busy
  progressEl.hidden = !busy
  if (!busy) {
    progressEl.classList.remove('determinate')
    const bar = progressEl.firstElementChild as HTMLSpanElement
    bar.style.width = ''
    progressState = null
  } else {
    progressState = null
  }
}

async function loadAccounts(site: string, force: boolean): Promise<void> {
  if (!site) return
  if (!force && accountListCache.has(site)) {
    renderAccountsList(site)
    return
  }
  accountsRefreshBtn.disabled = true
  accountsListEl.innerHTML = '<span class="hint">Buscando contas…</span>'
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'list-accounts', site })
    if (!resp?.ok) {
      if (resp?.loginRequired) {
        accountsListEl.innerHTML = ''
        showLoginRequired(site)
        return
      }
      accountsListEl.innerHTML = `<span class="hint">Erro: ${resp?.error ?? 'falha ao listar contas'}</span>`
      return
    }
    const accounts = resp.accounts as AccountSummary[]
    accountListCache.set(site, accounts)
    accountSelections.set(site, new Set(accounts.map((a) => a.id)))
    renderAccountsList(site)
  } finally {
    accountsRefreshBtn.disabled = false
  }
}

function renderAccountsList(site: string): void {
  const cached = accountListCache.get(site)
  if (!cached) {
    accountsListEl.innerHTML =
      '<span class="hint">Clique "Carregar" para listar as contas que essa recipe descobre.</span>'
    return
  }
  const selected = accountSelections.get(site) ?? new Set(cached.map((a) => a.id))
  accountsSelections_set(site, selected)
  accountsListEl.innerHTML = ''
  for (const acc of cached) {
    const row = document.createElement('label')
    row.className = 'account-row'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = selected.has(acc.id)
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(acc.id)
      else selected.delete(acc.id)
      accountsSelections_set(site, selected)
    })
    const name = document.createElement('span')
    name.textContent = acc.name
    const meta = document.createElement('span')
    meta.className = 'account-meta'
    meta.textContent = `${acc.type} · ${acc.currency}`
    row.append(cb, name, meta)
    accountsListEl.appendChild(row)
  }
  const toolbar = document.createElement('div')
  toolbar.className = 'accounts-toolbar'
  const selectAll = document.createElement('a')
  selectAll.textContent = 'Marcar todas'
  selectAll.addEventListener('click', () => {
    for (const a of cached) selected.add(a.id)
    accountsSelections_set(site, selected)
    renderAccountsList(site)
  })
  const clear = document.createElement('a')
  clear.textContent = 'Desmarcar todas'
  clear.addEventListener('click', () => {
    selected.clear()
    accountsSelections_set(site, selected)
    renderAccountsList(site)
  })
  toolbar.append(selectAll, clear)
  accountsListEl.appendChild(toolbar)
}

function accountsSelections_set(site: string, set: Set<string>): void {
  accountSelections.set(site, set)
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))])
}
