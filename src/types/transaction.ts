import type Decimal from 'decimal.js'

export type AccountType = 'checking' | 'savings' | 'credit_card' | 'investment'

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
  bankId?: string
  name: string
  type: AccountType
  currency: string
}

export interface ExtractionResult {
  account: AccountInfo
  transactions: NormalizedTransaction[]
  periodStart: Date
  periodEnd: Date
  recipeSite: string
  recipeVersion: number
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
