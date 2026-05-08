import type { AccountInfo, NormalizedTransaction } from '@/types/transaction'

export interface RecipeContext {
  document: Document
  window: Window
}

export interface Recipe {
  /** Domain identifier, e.g. 'mercadopago.com.br'. */
  site: string

  /** Bump on non-backward-compatible changes (lets consumers detect schema breaks). */
  version: number

  /** Short human-readable name shown in the popup. */
  label: string

  /** Returns true when the current page matches this recipe. */
  match: (url: URL) => boolean

  /** Detects the account being viewed. Return null if not on an account page. */
  detectAccount: (ctx: RecipeContext) => AccountInfo | null

  /** Extracts all visible transactions. Recipe is responsible for paginating. */
  extract: (ctx: RecipeContext) => Promise<NormalizedTransaction[]>
}
