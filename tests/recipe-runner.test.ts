import { runRecipe } from '@/engine/recipe-runner'
import type { Recipe } from '@/recipes/_schema'
import type { NormalizedTransaction } from '@/types/transaction'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'

function tx(date: string, fitId: string): NormalizedTransaction {
  return {
    fitId,
    postedAt: new Date(date),
    amount: new Decimal('10.00'),
    currency: 'BRL',
    description: 'item',
    type: 'credit',
  }
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    site: 'test.com.br',
    version: 7,
    label: 'Test',
    match: () => true,
    detectAccount: () => ({ id: 'acc', name: 'Test', type: 'checking', currency: 'BRL' }),
    extract: async () => [tx('2026-05-10T00:00:00Z', 'a'), tx('2026-05-01T00:00:00Z', 'b')],
    ...overrides,
  }
}

describe('runRecipe', () => {
  it('derives periodStart/periodEnd from min/max transaction dates regardless of input order', async () => {
    const result = await runRecipe({
      recipe: makeRecipe(),
      document: {} as Document,
      window: {} as Window,
    })
    expect(result.periodStart.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    expect(result.periodEnd.toISOString()).toBe('2026-05-10T00:00:00.000Z')
  })

  it('propagates recipe site and version into the result', async () => {
    const result = await runRecipe({
      recipe: makeRecipe(),
      document: {} as Document,
      window: {} as Window,
    })
    expect(result.recipeSite).toBe('test.com.br')
    expect(result.recipeVersion).toBe(7)
  })

  it('throws when detectAccount returns null', async () => {
    await expect(
      runRecipe({
        recipe: makeRecipe({ detectAccount: () => null }),
        document: {} as Document,
        window: {} as Window,
      }),
    ).rejects.toThrow(/identificar a conta/)
  })

  it('throws when extract returns no transactions (avoid emitting empty OFX)', async () => {
    await expect(
      runRecipe({
        recipe: makeRecipe({ extract: async () => [] }),
        document: {} as Document,
        window: {} as Window,
      }),
    ).rejects.toThrow(/Nenhuma transa/)
  })

  it('propagates errors thrown inside extract verbatim', async () => {
    await expect(
      runRecipe({
        recipe: makeRecipe({
          extract: async () => {
            throw new Error('selector mudou')
          },
        }),
        document: {} as Document,
        window: {} as Window,
      }),
    ).rejects.toThrow('selector mudou')
  })
})
