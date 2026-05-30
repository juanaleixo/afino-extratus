/**
 * Static registry of PDF plugins. New plugins are added by importing them here.
 *
 * Detection is first-match-wins (banksheet's pattern). If two plugins claim the same text,
 * the one that's earlier in the list wins — order by specificity (CNPJ-based detectors before
 * nominal ones).
 */

import { nubankCartao } from './plugins/nubank-cartao'
import type { PdfParseOutcome, PdfPlugin } from './types'

export const PDF_PLUGINS: readonly PdfPlugin[] = [nubankCartao]

export class PdfPluginNotDetectedError extends Error {
  constructor() {
    super('Nenhum plugin reconheceu este PDF. Confirme que é uma fatura de cartão de crédito BR suportada.')
    this.name = 'PdfPluginNotDetectedError'
  }
}

/**
 * Detect a plugin from the extracted text and run its parser. Throws `PdfPluginNotDetectedError`
 * if no plugin claims the text, or the plugin's own error if parsing fails (the caller decides
 * whether to fall back to "no plugin" — usually the answer is no, since detection is the
 * filter).
 */
export function detectAndParse(text: string): PdfParseOutcome {
  const plugin = PDF_PLUGINS.find((p) => safeDetect(p, text))
  if (!plugin) throw new PdfPluginNotDetectedError()
  const transactions = plugin.parse(text)
  return { plugin, transactions }
}

function safeDetect(plugin: PdfPlugin, text: string): boolean {
  try {
    return plugin.detect(text)
  } catch {
    return false
  }
}
