/**
 * Convert a `PdfParseOutcome` (plugin + raw transactions) into the same `ExtractionResult` shape
 * that recipes and the OFX upload path produce. This is the join point: from here on the
 * generators and download flow are oblivious to the input source.
 */

import type { AccountInfo, ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import type { PdfParseOutcome } from './types'
import { djb2 } from './utils'

export interface NormalizePdfOptions {
  /** Original filename — feeds the synthetic FITID hash and the account display name. */
  filename?: string
  /** Bumped when the output shape changes. */
  sourceVersion?: number
}

export class PdfNormalizeError extends Error {}

export function normalizePdf(outcome: PdfParseOutcome, opts: NormalizePdfOptions = {}): ExtractionResult {
  const { plugin, transactions: rawTxs } = outcome
  if (rawTxs.length === 0) {
    throw new PdfNormalizeError(`${plugin.label}: nenhuma transação reconhecida no PDF`)
  }

  const filename = (opts.filename ?? '').replace(/\.pdf$/i, '')
  const accountId = filename ? `pdf-${plugin.id}-${djb2(filename)}` : `pdf-${plugin.id}`

  // Same convention used elsewhere in the project: synthetic FITID is `djb2(seed)-index`.
  // The seed includes the plugin id and the (cleaned) filename so two different uploads of the
  // same statement keep stable ids on re-import, but two files with overlapping content from
  // different banks/months don't collide.
  const seenIds = new Set<string>()
  const transactions: NormalizedTransaction[] = []
  for (let idx = 0; idx < rawTxs.length; idx++) {
    const tx = rawTxs[idx]
    if (!tx) continue
    const fitId = `pdf-${plugin.id}-${djb2(buildSeed(plugin.id, filename, tx, idx))}-${idx}`
    if (seenIds.has(fitId)) continue
    seenIds.add(fitId)
    transactions.push({
      fitId,
      postedAt: tx.postedAt,
      amount: tx.amount.abs(),
      currency: 'BRL',
      description: tx.description || '(sem descrição)',
      type: tx.type,
    })
  }

  const times = transactions.map((t) => t.postedAt.getTime())
  const periodStart = new Date(Math.min(...times))
  const periodEnd = new Date(Math.max(...times))

  const account: AccountInfo = {
    id: accountId,
    name: friendlyAccountName(plugin.label, filename),
    type: plugin.accountType,
    currency: 'BRL',
    bankId: plugin.bank?.id,
  }

  return {
    account,
    transactions,
    periodStart,
    periodEnd,
    recipeSite: `pdf:${plugin.id}`,
    recipeVersion: opts.sourceVersion ?? 1,
    fi: plugin.bank ? { org: plugin.bank.org, fid: plugin.bank.id } : undefined,
  }
}

function friendlyAccountName(label: string, filename: string): string {
  return filename ? `${label} — ${filename}` : label
}

function buildSeed(
  pluginId: string,
  filename: string,
  tx: { postedAt: Date; amount: { toString(): string }; description: string; type: 'credit' | 'debit' },
  idx: number,
): string {
  return [
    pluginId,
    filename,
    tx.postedAt.toISOString().slice(0, 10),
    tx.amount.toString(),
    tx.type,
    tx.description,
    idx,
  ].join('|')
}
