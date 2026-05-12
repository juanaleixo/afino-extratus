import { buildCsv } from '@/engine/csv-generator'
import { NordicLoginRequiredError } from '@/engine/nordic-ssr'
import { buildOfx } from '@/engine/ofx-generator'
import { runRecipe } from '@/engine/recipe-runner'
import { findRecipeBySite, recipes } from '@/recipes/_registry'
import type { PeriodFilter } from '@/recipes/_schema'

interface ListRecipesMessage {
  type: 'list-recipes'
}

interface ExportMessage {
  type: 'export'
  site: string
  format: 'ofx' | 'csv'
  period?: PeriodFilter
}

type IncomingMessage = ListRecipesMessage | ExportMessage

chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
  if (message.type === 'list-recipes') {
    sendResponse({
      ok: true,
      recipes: recipes.map((r) => ({ site: r.site, label: r.label })),
    })
    return false
  }

  if (message.type === 'export') {
    handleExport(message)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((err: Error) => {
        const loginRequired = err.name === 'NordicLoginRequiredError' || err instanceof NordicLoginRequiredError
        sendResponse({ ok: false, error: err.message, loginRequired })
      })
    return true
  }

  return false
})

async function handleExport(req: ExportMessage): Promise<{
  accounts: number
  transactions: number
  site: string
}> {
  const recipe = findRecipeBySite(req.site)
  if (!recipe) throw new Error(`Recipe desconhecida: ${req.site}`)

  const results = await runRecipe({
    recipe,
    fetch: globalThis.fetch.bind(globalThis),
    period: req.period,
  })

  const content = req.format === 'ofx' ? buildOfx(results) : buildCsv(results)
  const mime = req.format === 'ofx' ? 'application/x-ofx' : 'text/csv'

  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const filename = buildFilename(req.site, req.format)
  await chrome.downloads.download({ url, filename, saveAs: true })

  return {
    accounts: results.length,
    transactions: results.reduce((s, r) => s + r.transactions.length, 0),
    site: req.site,
  }
}

function buildFilename(site: string, format: 'ofx' | 'csv'): string {
  const safe = site.replace(/[^a-z0-9]/gi, '_')
  const stamp = new Date().toISOString().slice(0, 10)
  return `extratus-${safe}-${stamp}.${format}`
}
