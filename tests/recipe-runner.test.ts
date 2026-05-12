import { runRecipe } from '@/engine/recipe-runner'
import type { Recipe } from '@/recipes/_schema'
import type { NormalizedTransaction, RecipeOutput } from '@/types/transaction'
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
    extract: async () => [
      {
        account: { id: 'acc', name: 'Test', type: 'checking', currency: 'BRL' },
        transactions: [tx('2026-05-10T00:00:00Z', 'a'), tx('2026-05-01T00:00:00Z', 'b')],
      },
    ],
    ...overrides,
  }
}

const noopFetch: typeof fetch = () => Promise.reject(new Error('fetch should not be called in this test'))

describe('runRecipe', () => {
  it('derives periodStart/periodEnd from min/max transaction dates regardless of input order', async () => {
    const results = await runRecipe({ recipe: makeRecipe(), fetch: noopFetch })
    expect(results).toHaveLength(1)
    expect(results[0]?.periodStart.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    expect(results[0]?.periodEnd.toISOString()).toBe('2026-05-10T00:00:00.000Z')
  })

  it('propagates recipe site and version into each result', async () => {
    const results = await runRecipe({ recipe: makeRecipe(), fetch: noopFetch })
    expect(results[0]?.recipeSite).toBe('test.com.br')
    expect(results[0]?.recipeVersion).toBe(7)
  })

  it('returns one ExtractionResult per RecipeOutput', async () => {
    const outputs: RecipeOutput[] = [
      {
        account: { id: 'a1', name: 'Checking', type: 'checking', currency: 'BRL' },
        transactions: [tx('2026-05-01T00:00:00Z', 't1')],
      },
      {
        account: { id: 's1', name: 'Pot', type: 'savings', currency: 'BRL' },
        transactions: [tx('2026-04-01T00:00:00Z', 't2'), tx('2026-04-15T00:00:00Z', 't3')],
      },
    ]
    const results = await runRecipe({
      recipe: makeRecipe({ extract: async () => outputs }),
      fetch: noopFetch,
    })
    expect(results).toHaveLength(2)
    expect(results[0]?.account.id).toBe('a1')
    expect(results[1]?.account.id).toBe('s1')
    expect(results[1]?.periodStart.toISOString()).toBe('2026-04-01T00:00:00.000Z')
    expect(results[1]?.periodEnd.toISOString()).toBe('2026-04-15T00:00:00.000Z')
  })

  it('filters out empty outputs', async () => {
    const outputs: RecipeOutput[] = [
      {
        account: { id: 'a1', name: 'Checking', type: 'checking', currency: 'BRL' },
        transactions: [tx('2026-05-01T00:00:00Z', 't1')],
      },
      {
        account: { id: 'empty', name: 'Empty pot', type: 'savings', currency: 'BRL' },
        transactions: [],
      },
    ]
    const results = await runRecipe({
      recipe: makeRecipe({ extract: async () => outputs }),
      fetch: noopFetch,
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.account.id).toBe('a1')
  })

  it('throws when ALL outputs are empty', async () => {
    await expect(runRecipe({ recipe: makeRecipe({ extract: async () => [] }), fetch: noopFetch })).rejects.toThrow(
      /Nenhuma transa/,
    )
  })

  it('passes fetch and period through to the recipe', async () => {
    let received: { fetch?: typeof fetch; period?: unknown } = {}
    const customFetch: typeof fetch = () => Promise.reject(new Error('unused'))
    await runRecipe({
      recipe: makeRecipe({
        extract: async (ctx) => {
          received = ctx
          return [
            {
              account: { id: 'a', name: 'A', type: 'checking', currency: 'BRL' },
              transactions: [tx('2026-05-01T00:00:00Z', 'x')],
            },
          ]
        },
      }),
      fetch: customFetch,
      period: { preset: 'last_week' },
    })
    expect(received.fetch).toBe(customFetch)
    expect(received.period).toEqual({ preset: 'last_week' })
  })
})
