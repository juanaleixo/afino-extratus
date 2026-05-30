/**
 * pdfjs-dist wrapper. Runs in the popup (DOM context) — NOT in the service worker, which
 * lacks the `Worker`/`OffscreenCanvas`/`URL.createObjectURL` plumbing pdfjs needs.
 *
 * Flow:
 *   1. Popup picks up a `File`, calls `extractText(buffer)` to get the raw text.
 *   2. Popup runs the plugin registry against the text.
 *   3. Popup ships the resulting `ExtractionResult[]` to the service worker for OFX/CSV
 *      generation and download — same pipeline as the recipe-driven path.
 *
 * We use `pdfjs-dist/legacy/build/pdf.mjs` because that bundle ships ES2017 syntax (works on the
 * older Chrome versions still in the field) and tolerates the MV3 popup environment without
 * an extra build hook. The worker is loaded with Vite's `?url` import — at build time Vite
 * resolves to a local asset URL, dodging the CSP block on remote workers.
 */

// biome-ignore lint/suspicious/noExplicitAny: pdfjs-dist legacy build has loose types
type PdfJsModule = any

let modulePromise: Promise<PdfJsModule> | undefined

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const lib = await import('pdfjs-dist/legacy/build/pdf.mjs')
      // Use the bundled worker. Vite emits a hashed asset URL via the `?url` query.
      const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')).default
      lib.GlobalWorkerOptions.workerSrc = workerUrl
      return lib
    })()
  }
  return modulePromise
}

export interface ExtractTextOptions {
  /** Password for protected PDFs (Inter, C6 ship password-locked statements). */
  password?: string
}

/**
 * Extract concatenated text from a PDF, separating pages with the same sentinel banksheet uses.
 * Each item's `hasEOL` flag is honored so logical lines stay intact even when pdfjs emits each
 * text run as its own item.
 */
export async function extractText(buffer: ArrayBuffer | Uint8Array, opts: ExtractTextOptions = {}): Promise<string> {
  const lib = await loadPdfJs()

  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const params: Record<string, unknown> = { data, useSystemFonts: true }
  if (opts.password) params.password = opts.password

  const doc = await lib.getDocument(params).promise
  try {
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const items = content.items as Array<{ str?: string; hasEOL?: boolean }>
      let pageText = ''
      for (const item of items) {
        if (typeof item.str !== 'string') continue
        pageText += item.str
        if (item.hasEOL) pageText += '\n'
      }
      pages.push(pageText)
      page.cleanup?.()
    }
    return pages.join('\n--- PAGE BREAK ---\n')
  } finally {
    await doc.destroy?.()
  }
}
