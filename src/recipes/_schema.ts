import type { RecipeOutput } from '@/types/transaction'

export type PeriodPreset = 'today' | 'yesterday' | 'last_week' | 'last_two_weeks' | 'month' | 'all'

export interface PeriodFilter {
  preset: PeriodPreset
}

/** Runtime context passed to Recipe.extract. The service worker provides
 *  `globalThis.fetch` bound, which carries the user's bank-session cookies
 *  thanks to the extension's host_permissions for the target site. */
export interface RecipeContext {
  fetch: typeof fetch
  period?: PeriodFilter
}

export interface Recipe {
  /** Stable identifier, e.g. 'mercadopago.com.br'. Used by the popup as the dropdown key. */
  site: string

  /** Bump on non-backward-compatible changes. */
  version: number

  /** Human label shown in the dropdown. */
  label: string

  /** Extracts one RecipeOutput per account on the site. */
  extract: (ctx: RecipeContext) => Promise<RecipeOutput[]>
}
