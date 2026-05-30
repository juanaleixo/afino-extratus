/**
 * Contract for a PDF statement plugin. Each bank/card lives in its own file under `plugins/`
 * and exports a `PdfPlugin` object.
 *
 * The architecture mirrors banksheet's plugin system, ported to the Extratus invariants:
 *   - Amounts are `Decimal`, never `number`.
 *   - Dates are real `Date` instances (UTC instant) parsed from the BR-locale strings.
 *   - Plugins emit `RawPdfTransaction[]`; the shared normalizer wraps them into an
 *     `ExtractionResult` so the rest of the pipeline (OFX/CSV generators) stays unchanged.
 */

import type { AccountType } from '@/types/transaction'
import type Decimal from 'decimal.js'

export interface PdfPlugin {
  /** Stable identifier — used as the plugin name in UI and as the `recipeSite` token in output. */
  id: string
  /** Display label shown to the user when detection succeeds. */
  label: string
  /** Country code, ISO 3166-1 alpha-2. Currently informative only. */
  country: string
  /** What kind of account this plugin produces (every BR plugin so far is credit_card). */
  accountType: AccountType
  /** Optional FI metadata propagated to the OFX `<FI>` block. */
  bank?: { id: string; org: string }
  /**
   * Heuristic check on the extracted text. Use stable markers (CNPJ, issuer name, "FATURA"
   * keyword) rather than nominal labels — banks rename product lines frequently.
   */
  detect(text: string): boolean
  /**
   * Parse the extracted text into raw transactions. Implementation is free to use regex,
   * cursor walks, lookaheads — whatever the layout demands. Errors should surface via thrown
   * `Error` (a confused plugin throwing tells the caller to try the next one).
   */
  parse(text: string): RawPdfTransaction[]
}

export interface RawPdfTransaction {
  /** Posted date — already parsed into a UTC `Date` at São Paulo midnight when ambiguous. */
  postedAt: Date
  /** Absolute amount. Sign comes from `type`. */
  amount: Decimal
  /** Trimmed description. The normalizer copies it verbatim into `description`. */
  description: string
  /** Direction. `credit` = inflow (payment, refund). `debit` = expense. */
  type: 'credit' | 'debit'
  /** Optional structured installment marker (e.g. `02/12`). */
  installment?: { current: number; total: number }
  /** Original PDF line for debugging — kept out of the final OFX. */
  raw?: string
}

export interface PdfParseOutcome {
  plugin: PdfPlugin
  transactions: RawPdfTransaction[]
}
