import { formatBrDate } from '@/engine/normalize'
import type { SerializedExtractionResult } from '@/types/transaction'

const statusEl = document.getElementById('status') as HTMLDivElement
const ofxBtn = document.getElementById('export-ofx') as HTMLButtonElement
const csvBtn = document.getElementById('export-csv') as HTMLButtonElement

init().catch((err: Error) => setStatus(`Erro: ${err.message}`, 'error'))

async function init(): Promise<void> {
  const tab = await getActiveTab()
  if (!tab?.id || !tab.url) {
    setStatus('Aba inválida')
    return
  }

  let pingResp: { matched: boolean; label: string | null } | null = null
  try {
    pingResp = await chrome.tabs.sendMessage(tab.id, { type: 'ping' })
  } catch {
    // Content script not loaded on this page (no host_permissions match)
  }

  if (!pingResp?.matched) {
    setStatus('Site não suportado ainda. Veja src/recipes/ para contribuir.')
    return
  }

  setStatus(`${pingResp.label} detectado`, 'matched')
  ofxBtn.disabled = false
  csvBtn.disabled = false
  ofxBtn.addEventListener('click', () => exportFor(tab.id as number, 'ofx'))
  csvBtn.addEventListener('click', () => exportFor(tab.id as number, 'csv'))
}

async function exportFor(tabId: number, format: 'ofx' | 'csv'): Promise<void> {
  ofxBtn.disabled = true
  csvBtn.disabled = true
  setStatus('Extraindo…')

  try {
    const extractResp = await chrome.tabs.sendMessage(tabId, { type: 'extract' })
    if (!extractResp?.ok) throw new Error(extractResp?.error ?? 'Falha ao extrair')

    const result = extractResp.result as SerializedExtractionResult
    setStatus(`${summarize(result)} — gerando ${format.toUpperCase()}…`, 'matched')

    const exportResp = await chrome.runtime.sendMessage({
      type: 'export',
      format,
      result,
    })
    if (!exportResp?.ok) throw new Error(exportResp?.error ?? 'Falha ao exportar')

    setStatus(`${summarize(result)} — download iniciado`, 'matched')
  } catch (err) {
    setStatus(`Erro: ${(err as Error).message}`, 'error')
  } finally {
    ofxBtn.disabled = false
    csvBtn.disabled = false
  }
}

function summarize(result: SerializedExtractionResult): string {
  const n = result.transactions.length
  const start = formatBrDate(new Date(result.periodStart))
  const end = formatBrDate(new Date(result.periodEnd))
  const range = start === end ? start : `${start} – ${end}`
  return `${n} ${n === 1 ? 'transação' : 'transações'} (${range})`
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  return tabs[0]
}

function setStatus(text: string, kind: 'matched' | 'error' | null = null): void {
  statusEl.textContent = text
  statusEl.classList.remove('matched', 'error')
  if (kind) statusEl.classList.add(kind)
}
