import type { PeriodPreset } from '@/recipes/_schema'
import helpUrl from './help.html?url'

const recipeSelect = document.getElementById('recipe-select') as HTMLSelectElement
const periodSelect = document.getElementById('period-select') as HTMLSelectElement
const ofxBtn = document.getElementById('export-ofx') as HTMLButtonElement
const csvBtn = document.getElementById('export-csv') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLDivElement
const helpLink = document.getElementById('help-link') as HTMLAnchorElement

helpLink.href = helpUrl

init().catch((err: Error) => setStatus(`Erro: ${err.message}`, 'error'))

async function init(): Promise<void> {
  const resp = await chrome.runtime.sendMessage({ type: 'list-recipes' })
  if (!resp?.ok) {
    setStatus('Falha ao listar bancos suportados', 'error')
    return
  }

  recipeSelect.innerHTML = ''
  for (const r of resp.recipes as Array<{ site: string; label: string }>) {
    const opt = document.createElement('option')
    opt.value = r.site
    opt.textContent = r.label
    recipeSelect.appendChild(opt)
  }

  ofxBtn.addEventListener('click', () => exportNow('ofx'))
  csvBtn.addEventListener('click', () => exportNow('csv'))
}

async function exportNow(format: 'ofx' | 'csv'): Promise<void> {
  ofxBtn.disabled = true
  csvBtn.disabled = true
  setStatus('Extraindo… isso pode levar 5–15 segundos', null)

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'export',
      site: recipeSelect.value,
      format,
      period: { preset: periodSelect.value as PeriodPreset },
    })
    if (!resp?.ok) {
      if (resp?.loginRequired) {
        showLoginRequired(recipeSelect.value)
      } else {
        setStatus(`Erro: ${resp?.error ?? 'desconhecido'}`, 'error')
      }
      return
    }
    const { accounts, transactions } = resp.summary as { accounts: number; transactions: number }
    setStatus(
      `${transactions} transações em ${accounts} ${accounts === 1 ? 'conta' : 'contas'} — download iniciado`,
      'ok',
    )
  } catch (err) {
    setStatus(`Erro: ${(err as Error).message}`, 'error')
  } finally {
    ofxBtn.disabled = false
    csvBtn.disabled = false
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
