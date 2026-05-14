import type { ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import { formatBrDate } from './normalize'

/**
 * Build a CSV statement compatible with Excel BR (UTF-8 BOM + ; separator) and
 * also readable by GnuCash/YNAB import wizards. Columns aim at the lowest common
 * denominator most importers expose.
 */
const HEADER = ['Data', 'Descrição', 'Valor', 'Tipo', 'ID', 'Conta', 'Banco', 'Moeda'] as const

export interface CsvOptions {
  /** Field separator. Excel BR usually expects `;`. Default `;`. */
  separator?: ';' | ','
  /** Prepend UTF-8 BOM so Excel detects encoding correctly. Default true. */
  bom?: boolean
}

export function buildCsv(input: ExtractionResult | ExtractionResult[], opts: CsvOptions = {}): string {
  const results = Array.isArray(input) ? input : [input]
  if (results.length === 0) throw new Error('buildCsv: no results provided')
  const sep = opts.separator ?? ';'
  const bom = opts.bom !== false ? '﻿' : ''

  const lines: string[] = [HEADER.join(sep)]
  for (const result of results) {
    const accountName = result.account.name
    const bank = result.fi?.org ?? ''
    for (const tx of result.transactions) {
      lines.push(formatRow(tx, accountName, bank, sep))
    }
  }
  return `${bom + lines.join('\r\n')}\r\n`
}

function formatRow(tx: NormalizedTransaction, accountName: string, bank: string, sep: string): string {
  const signed = tx.type === 'debit' ? tx.amount.neg() : tx.amount
  // BR amount: comma decimal separator, no thousands separator (Excel BR default).
  const amount = signed.toFixed(2).replace('.', ',')
  return [
    formatBrDate(tx.postedAt),
    csvEscape(tx.description, sep),
    amount,
    tx.type === 'debit' ? 'Débito' : 'Crédito',
    csvEscape(tx.fitId, sep),
    csvEscape(accountName, sep),
    csvEscape(bank, sep),
    tx.currency,
  ].join(sep)
}

function csvEscape(value: string, sep: string): string {
  const needsQuote = value.includes(sep) || value.includes('"') || value.includes('\n') || value.includes('\r')
  if (!needsQuote) return value
  return `"${value.replace(/"/g, '""')}"`
}
