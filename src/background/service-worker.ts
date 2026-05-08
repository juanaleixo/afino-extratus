import { buildCsv } from '@/engine/csv-generator'
import { buildOfx } from '@/engine/ofx-generator'
import { deserializeResult } from '@/engine/normalize'
import type { SerializedExtractionResult } from '@/types/transaction'

interface ExportRequest {
  type: 'export'
  format: 'ofx' | 'csv'
  result: SerializedExtractionResult
}

type RequestMessage = ExportRequest

chrome.runtime.onMessage.addListener((message: RequestMessage, _sender, sendResponse) => {
  if (message.type === 'export') {
    handleExport(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }))
    return true
  }
  return false
})

async function handleExport(req: ExportRequest): Promise<void> {
  const result = deserializeResult(req.result)
  const content = req.format === 'ofx' ? buildOfx(result) : buildCsv(result)
  const mime = req.format === 'ofx' ? 'application/x-ofx' : 'text/csv'

  // OFX 1.0.2 uses Windows-1252 / USASCII per header; normalizing here keeps importers happy.
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)

  const filename = buildFilename(result.recipeSite, req.format)
  await chrome.downloads.download({ url, filename, saveAs: true })
}

function buildFilename(site: string, format: 'ofx' | 'csv'): string {
  const safe = site.replace(/[^a-z0-9]/gi, '_')
  const stamp = new Date().toISOString().slice(0, 10)
  return `extratus-${safe}-${stamp}.${format}`
}
