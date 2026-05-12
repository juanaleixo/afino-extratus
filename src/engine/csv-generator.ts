import type { ExtractionResult } from '@/types/transaction'
import { formatBrDate } from './normalize'

/**
 * Consolidated CSV with one row per transaction. When the input has multiple
 * accounts, all rows go into the same file and the account name appears in
 * the "Conta" column so the consumer can filter / pivot.
 */
export function buildCsv(input: ExtractionResult | ExtractionResult[]): string {
  const results = Array.isArray(input) ? input : [input]
  const header = ['Data', 'Descrição', 'Valor', 'Moeda', 'Conta', 'ID']
  const rows = results.flatMap((result) =>
    result.transactions.map((t) => {
      const signed = t.type === 'debit' ? t.amount.neg() : t.amount
      return [
        formatBrDate(t.postedAt),
        t.description,
        signed.toFixed(2).replace('.', ','),
        t.currency,
        result.account.name,
        t.fitId,
      ]
    }),
  )
  return [header, ...rows].map((cols) => cols.map(escapeCsv).join(',')).join('\r\n')
}

function escapeCsv(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`
  return field
}
