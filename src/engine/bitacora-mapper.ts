import type { NormalizedTransaction } from '@/types/transaction'
import Decimal from 'decimal.js'

/**
 * Maps a Mercado Pago "bitacora" movement (returned by /banking/balance/movements
 * and /savings/movements/<uuid> in the Nordic SSR context) to a NormalizedTransaction.
 */

export interface BitacoraAmount {
  fraction: string
  cents: string
  currency_id: string
}

export interface BitacoraMetadata {
  type?: 'in' | 'out' | 'income'
  kind?: string
  detail?: string
  generated_from?: string
  recipe?: string
  reference_id?: number | string
  description?: string
}

export interface BitacoraMovement {
  id: string
  ledger_datetime: string
  amount: BitacoraAmount
  title?: string
  description?: string
  detail_id?: string
  metadata?: BitacoraMetadata
}

export function mapBitacoraMovement(m: BitacoraMovement): NormalizedTransaction {
  const amount = parseBitacoraAmount(m.amount)
  const isCredit = m.metadata?.type !== 'out'
  return {
    fitId: m.id,
    postedAt: new Date(m.ledger_datetime),
    amount: amount.abs(),
    currency: m.amount.currency_id || 'BRL',
    description: buildDescription(m),
    type: isCredit ? 'credit' : 'debit',
  }
}

export function parseBitacoraAmount(a: BitacoraAmount): Decimal {
  const fracRaw = (a.fraction ?? '0').toString()
  const cents = ((a.cents ?? '00').toString() || '00').padStart(2, '0').slice(0, 2)
  const fracClean = fracRaw.replace(/\./g, '')
  if (!/^-?\d+$/.test(fracClean)) throw new Error(`Invalid bitacora amount fraction: ${a.fraction}`)
  return new Decimal(`${fracClean}.${cents}`)
}

function buildDescription(m: BitacoraMovement): string {
  const title = (m.title || '').trim()
  const desc = (m.description || '').trim()
  const base = desc ? (title ? `${title} — ${desc}` : desc) : title

  const md = m.metadata || {}
  let prefix = ''
  if (md.recipe === 'fund-asset_management_gain') prefix = 'Rendimento · '
  else if (md.kind === 'fund_reallocation') prefix = 'Cofrinho · '
  else if (md.detail === 'pix') prefix = 'Pix · '

  const combined = prefix + base
  return combined.trim() || '(sem descrição)'
}
