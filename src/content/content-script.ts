import { serializeResult } from '@/engine/normalize'
import { runRecipe } from '@/engine/recipe-runner'
import { findRecipeForUrl } from '@/recipes/_registry'
import type { SerializedExtractionResult } from '@/types/transaction'

interface ExtractMessage {
  type: 'extract'
}

interface PingMessage {
  type: 'ping'
}

type IncomingMessage = ExtractMessage | PingMessage

chrome.runtime.onMessage.addListener((message: IncomingMessage, _sender, sendResponse) => {
  if (message.type === 'ping') {
    const recipe = findRecipeForUrl(new URL(window.location.href))
    sendResponse({ ok: true, matched: !!recipe, label: recipe?.label ?? null })
    return false
  }

  if (message.type === 'extract') {
    runExtraction()
      .then((result: SerializedExtractionResult) => sendResponse({ ok: true, result }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  return false
})

async function runExtraction(): Promise<SerializedExtractionResult> {
  const recipe = findRecipeForUrl(new URL(window.location.href))
  if (!recipe) throw new Error('Nenhuma recipe corresponde a esta página')

  const result = await runRecipe({ recipe, document, window })
  return serializeResult(result)
}
