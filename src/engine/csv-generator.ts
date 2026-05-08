import type { ExtractionResult } from '@/types/transaction'
import { formatBrDate } from './normalize'

export function buildCsv(result: ExtractionResult): string {
  const header = ['Data', 'Descrição', 'Valor', 'Moeda', 'ID']
  const rows = result.transactions.map((t) => {
    const signed = t.type === 'debit' ? t.amount.neg() : t.amount
    return [formatBrDate(t.postedAt), t.description, signed.toFixed(2).replace('.', ','), t.currency, t.fitId]
  })
  return [header, ...rows].map((cols) => cols.map(escapeCsv).join(',')).join('\r\n')
}

function escapeCsv(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replace(/"/g, '""')}"`
  return field
}
