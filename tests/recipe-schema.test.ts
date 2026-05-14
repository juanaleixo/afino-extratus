import { RECIPE_SCHEMA, parseRecipe } from '@/recipes/_schema'
import mercadopago from '@/recipes/mercadopago.com.br.json'
import { describe, expect, it } from 'vitest'

describe('parseRecipe', () => {
  it('aceita o JSON built-in do Mercado Pago', () => {
    const recipe = parseRecipe(mercadopago)
    expect(recipe.site).toBe('mercadopago.com.br')
    expect(recipe.accounts).toHaveLength(2)
    expect(recipe.accounts[0]?.kind).toBe('single')
    expect(recipe.accounts[1]?.kind).toBe('discovered')
  })

  it('rejeita objeto sem $schema', () => {
    expect(() => parseRecipe({ site: 'x', label: 'X', version: 1, accounts: [] })).toThrow(/\$schema/)
  })

  it('rejeita $schema com versão errada', () => {
    expect(() => parseRecipe({ $schema: 'wrong', site: 'x', label: 'X', version: 1, accounts: [] })).toThrow(/\$schema/)
  })

  it('exige accounts não vazia', () => {
    expect(() => parseRecipe({ $schema: RECIPE_SCHEMA, site: 'x', label: 'X', version: 1, accounts: [] })).toThrow(
      /accounts/,
    )
  })

  it('exige campos obrigatórios da fonte e da paginação', () => {
    expect(() =>
      parseRecipe({
        $schema: RECIPE_SCHEMA,
        site: 'x.com.br',
        label: 'X',
        version: 1,
        matchHosts: ['x.com.br'],
        accounts: [
          {
            kind: 'single',
            id: 'a',
            name: 'A',
            type: 'checking',
            currency: 'BRL',
            extract: {
              source: { type: 'rest-json' }, // missing url
              list: 'data',
              fields: {
                id: { path: 'id' },
                postedAt: { path: 'date' },
                amount: { path: 'amount' },
                description: { path: 'desc' },
                type: { creditWhenSign: '>=0' },
              },
            },
          },
        ],
      }),
    ).toThrow(/url/)
  })

  it('aceita matchHosts implícito como [site] quando ausente', () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'banco.com.br',
      label: 'Banco',
      version: 1,
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://banco.com.br/api' },
            list: 'data',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'desc' },
              type: { creditWhenSign: '>=0' },
            },
          },
        },
      ],
    })
    expect(recipe.matchHosts).toEqual(['banco.com.br'])
  })
})
