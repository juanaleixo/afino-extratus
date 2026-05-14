import type Decimal from 'decimal.js'

export type AccountType = 'checking' | 'savings' | 'credit_card' | 'investment' | 'pending'

export interface NormalizedTransaction {
  /** Stable identifier for this transaction. Used as OFX FITID and for dedup. */
  fitId: string
  postedAt: Date
  amount: Decimal
  currency: string
  description: string
  type: 'debit' | 'credit'
}

export interface AccountInfo {
  id: string
  /** ISPB (8 digits) or other identifier expected by the importer in <BANKID>. */
  bankId?: string
  /** Branch code (BR: 4 digits). */
  branchId?: string
  name: string
  type: AccountType
  currency: string
}

/** What a Recipe produces for one account. The runner fills in period and recipe metadata. */
export interface RecipeOutput {
  account: AccountInfo
  transactions: NormalizedTransaction[]
}

export interface AccountBalance {
  /** Signed amount: positive = credit, negative = debit. */
  amount: import('decimal.js').default
  asOf: Date
  /** Where the value came from. `derived-from-transactions` is the net change in the period, not the absolute balance. */
  source: 'fetched' | 'derived-from-transactions'
}

export interface ExtractionResult extends RecipeOutput {
  periodStart: Date
  periodEnd: Date
  /** Optional ledger balance at periodEnd. Emitted as <LEDGERBAL> in OFX when present. */
  balance?: AccountBalance
  recipeSite: string
  recipeVersion: number
  /** Optional financial institution identification, used in <FI> in OFX. */
  fi?: { org: string; fid?: string }
}

export interface SerializedTransaction {
  fitId: string
  postedAt: string
  amount: string
  currency: string
  description: string
  type: 'debit' | 'credit'
}

export interface SerializedExtractionResult {
  account: AccountInfo
  transactions: SerializedTransaction[]
  periodStart: string
  periodEnd: string
  recipeSite: string
  recipeVersion: number
}
