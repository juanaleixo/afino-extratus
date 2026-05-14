import { LoginRequiredError, planAccounts, runRecipe } from '@/engine/recipe-engine'
import { type PeriodPreset, RECIPE_SCHEMA, type Recipe, parseRecipe } from '@/recipes/_schema'
import { describe, expect, it } from 'vitest'

function recipeWith(overrides: Partial<Parameters<typeof parseRecipe>[0]> = {}): Recipe {
  return parseRecipe({
    $schema: RECIPE_SCHEMA,
    site: 'banco.com.br',
    label: 'Banco',
    version: 1,
    matchHosts: ['api.banco.com.br', 'banco.com.br'],
    accounts: [
      {
        kind: 'single',
        id: 'checking',
        name: 'Banco — Conta',
        type: 'checking',
        currency: 'BRL',
        extract: {
          source: { type: 'rest-json', url: 'https://api.banco.com.br/extrato?page={page}[&period={period}]' },
          pagination: { type: 'page-count', totalPath: 'totalPages', max: 10 },
          periodMap: { month: '30d', last_week: '7d' },
          list: 'data.items',
          fields: {
            id: { path: 'id' },
            postedAt: { path: 'date', format: 'iso' },
            amount: { path: 'amount', scale: 0.01 },
            description: { template: '{title}[ — {description}]' },
            type: { creditWhen: { path: 'kind', equals: 'in' } },
          },
        },
      },
    ],
    ...overrides,
  } as Record<string, unknown>)
}

function mockFetch(map: Record<string, unknown>): typeof fetch {
  return ((url: RequestInfo | URL) => {
    const key = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    const body = map[key]
    if (body === undefined) return Promise.reject(new Error(`unexpected url: ${key}`))
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
  }) as typeof fetch
}

describe('runRecipe — REST + paginação por contagem', () => {
  it('itera páginas até o total e dedupa por id', async () => {
    const fetchFn = mockFetch({
      'https://api.banco.com.br/extrato?page=1': {
        totalPages: 2,
        data: {
          items: [
            { id: 'a', date: '2026-05-10T00:00:00Z', amount: 1000, kind: 'in', title: 'Pix recebido' },
            { id: 'b', date: '2026-05-09T00:00:00Z', amount: 5000, kind: 'out', title: 'Compra' },
          ],
        },
      },
      'https://api.banco.com.br/extrato?page=2': {
        totalPages: 2,
        data: {
          items: [
            { id: 'b', date: '2026-05-09T00:00:00Z', amount: 5000, kind: 'out', title: 'Compra' }, // dup
            {
              id: 'c',
              date: '2026-05-08T00:00:00Z',
              amount: 250,
              kind: 'in',
              title: 'Cashback',
              description: 'Cartão',
            },
          ],
        },
      },
    })

    const results = await runRecipe({ recipe: recipeWith(), fetch: fetchFn })
    expect(results).toHaveLength(1)
    const txs = results[0]?.transactions ?? []
    expect(txs).toHaveLength(3)
    expect(txs.find((t) => t.fitId === 'a')?.type).toBe('credit')
    expect(txs.find((t) => t.fitId === 'b')?.type).toBe('debit')
    expect(txs.find((t) => t.fitId === 'c')?.description).toBe('Cashback — Cartão')
    expect(txs.find((t) => t.fitId === 'a')?.amount.toString()).toBe('10')
  })

  it('substitui {period} via periodMap', async () => {
    const calls: string[] = []
    const fetchFn = ((url: RequestInfo | URL) => {
      const u = String(url)
      calls.push(u)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            totalPages: 1,
            data: { items: [{ id: 'x', date: '2026-05-01T00:00:00Z', amount: 100, kind: 'in', title: 'T' }] },
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch

    await runRecipe({ recipe: recipeWith(), fetch: fetchFn, period: { preset: 'month' } })
    expect(calls[0]).toBe('https://api.banco.com.br/extrato?page=1&period=30d')
  })

  it('omite o grupo opcional [&period=...] quando period é "all"', async () => {
    const calls: string[] = []
    const fetchFn = ((url: RequestInfo | URL) => {
      calls.push(String(url))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            totalPages: 1,
            data: { items: [{ id: 'x', date: '2026-05-01T00:00:00Z', amount: 100, kind: 'in', title: 'T' }] },
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch

    await runRecipe({ recipe: recipeWith(), fetch: fetchFn, period: { preset: 'all' } })
    expect(calls[0]).toBe('https://api.banco.com.br/extrato?page=1')
  })

  it('mapeia 401 para LoginRequiredError', async () => {
    const fetchFn = (() => Promise.resolve(new Response('unauthorized', { status: 401 }))) as typeof fetch
    await expect(runRecipe({ recipe: recipeWith(), fetch: fetchFn })).rejects.toBeInstanceOf(LoginRequiredError)
  })

  it('rejeita fetches a hosts fora de matchHosts', async () => {
    const recipe = recipeWith({
      matchHosts: ['only.com'],
    } as Record<string, unknown>)
    const fetchFn = (() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))) as typeof fetch
    await expect(runRecipe({ recipe, fetch: fetchFn })).rejects.toThrow(/host não autorizado/)
  })
})

describe('runRecipe — campos exóticos', () => {
  it('combina fractionPath + centsPath em decimal estável', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/x' },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date', format: 'iso' },
              amount: { fractionPath: 'a.fraction', centsPath: 'a.cents' },
              description: { path: 'title' },
              type: { creditWhen: { path: 'kind', notEquals: 'out' } },
            },
          },
        },
      ],
    })
    const fetchFn = mockFetch({
      'https://b.com/x': {
        items: [
          { id: '1', date: '2026-05-01T00:00:00Z', a: { fraction: '1.234', cents: '56' }, title: 'T', kind: 'in' },
          { id: '2', date: '2026-05-02T00:00:00Z', a: { fraction: '-450', cents: '00' }, title: 'D', kind: 'out' },
        ],
      },
    })
    const r = await runRecipe({ recipe, fetch: fetchFn })
    const txs = r[0]?.transactions ?? []
    expect(txs.find((t) => t.fitId === '1')?.amount.toString()).toBe('1234.56')
    expect(txs.find((t) => t.fitId === '2')?.amount.toString()).toBe('450')
    expect(txs.find((t) => t.fitId === '2')?.type).toBe('debit')
  })

  it('aplica prefixos condicionais de description', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/x' },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: {
                template: '{title}[ — {description}]',
                prefixes: [
                  { when: { path: 'meta.kind', equals: 'pix' }, value: 'Pix · ' },
                  { when: { path: 'meta.kind', equals: 'investment' }, value: 'Rendimento · ' },
                ],
              },
              type: { creditWhenSign: '>=0' },
            },
          },
        },
      ],
    })
    const fetchFn = mockFetch({
      'https://b.com/x': {
        items: [
          {
            id: '1',
            date: '2026-05-01T00:00:00Z',
            amount: 100,
            title: 'João',
            description: '5x',
            meta: { kind: 'pix' },
          },
          { id: '2', date: '2026-05-02T00:00:00Z', amount: 5, title: 'Cofrinho', meta: { kind: 'investment' } },
          { id: '3', date: '2026-05-03T00:00:00Z', amount: -10, title: 'Sabesp', meta: { kind: 'utility' } },
        ],
      },
    })
    const r = await runRecipe({ recipe, fetch: fetchFn })
    const txs = r[0]?.transactions ?? []
    expect(txs.find((t) => t.fitId === '1')?.description).toBe('Pix · João — 5x')
    expect(txs.find((t) => t.fitId === '2')?.description).toBe('Rendimento · Cofrinho')
    expect(txs.find((t) => t.fitId === '3')?.description).toBe('Sabesp')
  })
})

describe('runRecipe — discovered accounts', () => {
  it('itera sub-contas descobertas e injeta {discovered.id}/{discovered.name}', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'discovered',
          idPrefix: 'pot',
          type: 'savings',
          currency: 'BRL',
          discover: {
            source: { type: 'rest-json', url: 'https://b.com/hub' },
            list: 'pots',
            fields: { id: 'id', name: 'name' },
          },
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/p/{discovered.id}' },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'title' },
              type: { creditWhenSign: '>=0' },
            },
          },
          nameTemplate: 'B — Cofrinho {discovered.name}',
        },
      ],
    })
    const fetchFn = mockFetch({
      'https://b.com/hub': {
        pots: [
          { id: 'p1', name: 'Viagem' },
          { id: 'p2', name: 'Carro' },
        ],
      },
      'https://b.com/p/p1': {
        items: [{ id: 'a1', date: '2026-05-01T00:00:00Z', amount: 100, title: 'Aporte' }],
      },
      'https://b.com/p/p2': {
        items: [{ id: 'a2', date: '2026-05-02T00:00:00Z', amount: 200, title: 'Aporte' }],
      },
    })
    const r = await runRecipe({ recipe, fetch: fetchFn })
    expect(r).toHaveLength(2)
    expect(r[0]?.account.id).toBe('pot-p1')
    expect(r[0]?.account.name).toBe('B — Cofrinho Viagem')
    expect(r[1]?.account.id).toBe('pot-p2')
  })

  it('windowedHistory itera múltiplas janelas e para quando uma janela vem vazia', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: {
              type: 'rest-json',
              url: 'https://b.com/x?page={page}&from={windowStart}&to={windowEnd}',
            },
            windowedHistory: { windowDays: 730, maxYears: 4, format: 'iso-utc' },
            pagination: { type: 'page-count', max: 5 },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'desc' },
              type: { creditWhenSign: 'positive' },
            },
            delayMs: 0,
          },
        },
      ],
    })

    const calls: string[] = []
    const fetchFn = ((url: RequestInfo | URL) => {
      const u = String(url)
      calls.push(u)
      // Each window's first page returns one unique tx; subsequent pages or any other window return empty.
      const m = u.match(/page=(\d+)&from=([^&]+)/)
      const page = m ? Number(m[1]) : 1
      const fromYear = m ? new Date(decodeURIComponent(m[2] ?? '')).getUTCFullYear() : 0
      let items: unknown[] = []
      if (page === 1 && fromYear >= 2024) items = [{ id: 'recent', date: '2026-01-01T00:00:00Z', amount: 1, desc: 'r' }]
      else if (page === 1 && fromYear >= 2022)
        items = [{ id: 'old', date: '2023-01-01T00:00:00Z', amount: 2, desc: 'o' }]
      // older windows → empty
      return Promise.resolve(new Response(JSON.stringify({ items }), { status: 200 }))
    }) as typeof fetch

    const r = await runRecipe({ recipe, fetch: fetchFn })
    const txs = r[0]?.transactions ?? []
    expect(txs.map((t) => t.fitId).sort()).toEqual(['old', 'recent'])
    // Engine iterates until a window brings nothing new — should not exhaust maxYears blindly.
    expect(calls.length).toBeLessThanOrEqual(6)
    expect(calls[0]).toMatch(/from=.+&to=.+/)
  })

  it('id por template gera fitId estável a partir de campos da transação', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'credit-card',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/x' },
            list: '[*]',
            fields: {
              id: { template: 'cc-{date}-{amount}-{description}' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'description' },
              type: { creditWhen: { path: 'type', equals: 'CREDIT' } },
            },
          },
        },
      ],
    })
    const fetchFn = mockFetch({
      'https://b.com/x': [
        { date: '2026-05-01T00:00:00Z', amount: 12.5, description: 'Padaria', type: 'DEBIT' },
        { date: '2026-05-02T00:00:00Z', amount: 100, description: 'Cashback', type: 'CREDIT' },
      ],
    })
    const r = await runRecipe({ recipe, fetch: fetchFn })
    const txs = r[0]?.transactions ?? []
    expect(txs.map((t) => t.fitId)).toEqual([
      'cc-2026-05-01T00:00:00Z-12.5-Padaria',
      'cc-2026-05-02T00:00:00Z-100-Cashback',
    ])
    // 'credit-card' (com hífen) deve ser aceito como alias de credit_card.
    expect(r[0]?.account.type).toBe('credit_card')
  })

  it('AccountType pending é aceito e cai como CHECKING no OFX (downstream)', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'pending',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/x' },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'desc' },
              type: { creditWhenSign: 'positive' },
            },
          },
        },
      ],
    })
    const fetchFn = mockFetch({
      'https://b.com/x': { items: [{ id: '1', date: '2026-05-01T00:00:00Z', amount: 1, desc: 'futuro' }] },
    })
    const r = await runRecipe({ recipe, fetch: fetchFn })
    expect(r[0]?.account.type).toBe('pending')
  })

  it('page-count sem totalPath + stopWhen: itera até stopWhen ser true (Inter)', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/x?page={page}' },
            pagination: {
              type: 'page-count',
              max: 10,
              stopWhen: { path: 'metadata.noContent', equals: 'true' },
            },
            list: 'data[*].bankStatements[*].transactions[*]',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'desc' },
              type: { creditWhen: { path: 'op', equals: 'C' } },
            },
            delayMs: 0,
          },
        },
      ],
    })

    const fetchFn = mockFetch({
      'https://b.com/x?page=1': {
        metadata: { noContent: false },
        data: [
          {
            bankStatements: [
              { transactions: [{ id: '1', date: '2026-05-01T00:00:00Z', amount: 10, op: 'C', desc: 'a' }] },
            ],
          },
        ],
      },
      'https://b.com/x?page=2': {
        metadata: { noContent: false },
        data: [
          {
            bankStatements: [
              { transactions: [{ id: '2', date: '2026-05-02T00:00:00Z', amount: 5, op: 'D', desc: 'b' }] },
              { transactions: [{ id: '3', date: '2026-05-02T00:00:00Z', amount: 3, op: 'C', desc: 'c' }] },
            ],
          },
        ],
      },
      'https://b.com/x?page=3': { metadata: { noContent: true }, data: [] },
    })

    const r = await runRecipe({ recipe, fetch: fetchFn })
    const txs = r[0]?.transactions ?? []
    expect(txs.map((t) => t.fitId).sort()).toEqual(['1', '2', '3'])
    expect(txs.find((t) => t.fitId === '1')?.type).toBe('credit')
    expect(txs.find((t) => t.fitId === '2')?.type).toBe('debit')
  })

  it('page-until-empty: para quando uma página vem com menos itens que pageSize', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/x?Page={page}&PageSize={pageSize}' },
            pagination: { type: 'page-until-empty', pageSize: 3, max: 10 },
            list: 'events',
            fields: {
              id: { path: 'entryNumber' },
              postedAt: { path: 'date' },
              amount: { path: 'value' },
              currency: { const: 'BRL' },
              description: { path: 'description' },
              type: { creditWhenSign: 'positive' },
            },
            delayMs: 0,
          },
        },
      ],
    })

    const fetchFn = mockFetch({
      'https://b.com/x?Page=1&PageSize=3': {
        events: [
          { entryNumber: 1, date: '2026-05-01T00:00:00Z', value: 10, description: 'a' },
          { entryNumber: 2, date: '2026-05-02T00:00:00Z', value: -5, description: 'b' },
          { entryNumber: 3, date: '2026-05-03T00:00:00Z', value: 20, description: 'c' },
        ],
      },
      'https://b.com/x?Page=2&PageSize=3': {
        events: [
          { entryNumber: 4, date: '2026-05-04T00:00:00Z', value: -7, description: 'd' },
          { entryNumber: 5, date: '2026-05-05T00:00:00Z', value: 1, description: 'e' },
        ],
      },
    })

    const r = await runRecipe({ recipe, fetch: fetchFn })
    const txs = r[0]?.transactions ?? []
    expect(txs).toHaveLength(5)
    expect(txs.find((t) => t.fitId === '1')?.type).toBe('credit')
    expect(txs.find((t) => t.fitId === '2')?.type).toBe('debit')
    expect(txs[0]?.currency).toBe('BRL')
  })

  it('periodMap multi-var + dateFormat resolvem placeholders na URL', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/x?StartDate={periodStart}&EndDate={periodEnd}' },
            periodMap: { last_week: { periodStart: '-7d', periodEnd: 'now' } },
            dateFormat: { periodStart: 'iso-utc', periodEnd: 'iso-utc' },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'value' },
              description: { path: 'desc' },
              type: { creditWhenSign: 'non-negative' },
            },
            delayMs: 0,
          },
        },
      ],
    })

    const calls: string[] = []
    const fetchFn = ((url: RequestInfo | URL) => {
      calls.push(String(url))
      return Promise.resolve(
        new Response(JSON.stringify({ items: [{ id: 'x', date: '2026-05-10T00:00:00Z', value: 1, desc: 'y' }] }), {
          status: 200,
        }),
      )
    }) as typeof fetch

    await runRecipe({ recipe, fetch: fetchFn, period: { preset: 'last_week' as PeriodPreset } })
    expect(calls[0]).toMatch(/StartDate=.+T.+Z&EndDate=.+T.+Z/)
  })

  it('storageReader resolve {sessionStorage:KEY} no header Authorization', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'a',
          name: 'A',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: {
              type: 'rest-json',
              url: 'https://b.com/x',
              headers: { Authorization: 'Bearer {sessionStorage:Authorization}' },
            },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'value' },
              description: { path: 'desc' },
              type: { creditWhenSign: 'positive' },
            },
          },
        },
      ],
    })

    let receivedAuth: string | null = null
    const fetchFn = ((_url: RequestInfo | URL, init?: RequestInit) => {
      receivedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null
      return Promise.resolve(
        new Response(JSON.stringify({ items: [{ id: 't1', date: '2026-05-01T00:00:00Z', value: 1, desc: 'x' }] }), {
          status: 200,
        }),
      )
    }) as typeof fetch

    await runRecipe({
      recipe,
      fetch: fetchFn,
      storageReader: async ({ host, candidateHosts, type, key }) => {
        expect(host).toBe('b.com')
        expect(candidateHosts).toEqual(['b.com'])
        expect(type).toBe('sessionStorage')
        expect(key).toBe('Authorization')
        return 'TOKEN-XYZ'
      },
    })
    expect(receivedAuth).toBe('Bearer TOKEN-XYZ')
  })

  it('paraleliza contas com concurrency e preserva a ordem do resultado', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'discovered',
          idPrefix: 'p',
          type: 'savings',
          currency: 'BRL',
          discover: {
            source: { type: 'rest-json', url: 'https://b.com/hub' },
            list: 'pots',
            fields: { id: 'id', name: 'name' },
          },
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/p/{discovered.id}' },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'title' },
              type: { creditWhenSign: '>=0' },
            },
          },
          nameTemplate: 'P {discovered.name}',
        },
      ],
    })

    const order: string[] = []
    const fetchFn = ((url: RequestInfo | URL) => {
      const u = String(url)
      order.push(u)
      if (u === 'https://b.com/hub') {
        return Promise.resolve(
          new Response(JSON.stringify({ pots: [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: `${n}` })) }), {
            status: 200,
          }),
        )
      }
      // Simulate variable response time so finishing order != planned order without concurrency control.
      const delay = u.endsWith('p1') ? 30 : u.endsWith('p2') ? 5 : u.endsWith('p3') ? 20 : 10
      return new Promise<Response>((resolve) =>
        setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({
                  items: [{ id: `t-${u.split('/').pop()}`, date: '2026-05-01T00:00:00Z', amount: 1, title: 'x' }],
                }),
                { status: 200 },
              ),
            ),
          delay,
        ),
      )
    }) as typeof fetch

    const start = Date.now()
    const results = await runRecipe({ recipe, fetch: fetchFn, concurrency: 4 })
    const elapsed = Date.now() - start

    // Output preserves the planned order p1, p2, p3, p4 regardless of arrival.
    expect(results.map((r) => r.account.id)).toEqual(['p-p1', 'p-p2', 'p-p3', 'p-p4'])
    // Sequential would take ≥30+5+20+10 = 65ms; parallel ≤ ~30ms + slack.
    expect(elapsed).toBeLessThan(120)
  })

  it('planAccounts lista contas sem extrair, e accountIds filtra runRecipe', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'main',
          name: 'B — Conta',
          type: 'checking',
          currency: 'BRL',
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/main' },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'title' },
              type: { creditWhenSign: '>=0' },
            },
          },
        },
        {
          kind: 'discovered',
          idPrefix: 'pot',
          type: 'savings',
          currency: 'BRL',
          discover: {
            source: { type: 'rest-json', url: 'https://b.com/hub' },
            list: 'pots',
            fields: { id: 'id', name: 'name' },
          },
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/p/{discovered.id}' },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'title' },
              type: { creditWhenSign: '>=0' },
            },
          },
          nameTemplate: 'B — Cofrinho {discovered.name}',
        },
      ],
    })
    const fetchFn = mockFetch({
      'https://b.com/hub': {
        pots: [
          { id: 'p1', name: 'Viagem' },
          { id: 'p2', name: 'Carro' },
        ],
      },
      'https://b.com/main': { items: [{ id: 'm1', date: '2026-05-01T00:00:00Z', amount: 50, title: 'X' }] },
      'https://b.com/p/p1': { items: [{ id: 'a1', date: '2026-05-01T00:00:00Z', amount: 100, title: 'Aporte' }] },
      'https://b.com/p/p2': { items: [{ id: 'a2', date: '2026-05-02T00:00:00Z', amount: 200, title: 'Aporte' }] },
    })

    const summaries = await planAccounts(recipe, fetchFn)
    expect(summaries.map((s) => s.id)).toEqual(['main', 'pot-p1', 'pot-p2'])

    const r = await runRecipe({ recipe, fetch: fetchFn, accountIds: ['pot-p2'] })
    expect(r).toHaveLength(1)
    expect(r[0]?.account.id).toBe('pot-p2')
  })
})

describe('runRecipe — engine extensions', () => {
  it('templating de vars em headers (page, discovered.*) chega ao fetch', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'discovered',
          idPrefix: 'card',
          type: 'credit_card',
          currency: 'BRL',
          discover: {
            source: { type: 'rest-json', url: 'https://b.com/cards' },
            list: '[*]',
            fields: { id: 'cardAccount', name: 'productDescription', product: 'productCode' },
          },
          extract: {
            source: {
              type: 'rest-json',
              url: 'https://b.com/tx?page={page}',
              headers: {
                cardaccount: '{discovered.id}',
                product: '{discovered.product}',
                page: '{page}',
              },
            },
            pagination: { type: 'page-count', startPage: 1, max: 1 },
            list: 'items',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'desc' },
              type: { creditWhenSign: 'positive' },
            },
            delayMs: 0,
          },
          nameTemplate: 'Cartão {discovered.name}',
        },
      ],
    })

    const captured: Record<string, string>[] = []
    const fetchFn = ((url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u === 'https://b.com/cards') {
        return Promise.resolve(
          new Response(
            JSON.stringify([{ cardAccount: 'CARD-XYZ', productDescription: 'PLATINUM', productCode: '15' }]),
            {
              status: 200,
            },
          ),
        )
      }
      captured.push((init?.headers ?? {}) as Record<string, string>)
      return Promise.resolve(
        new Response(JSON.stringify({ items: [{ id: 't1', date: '2026-05-01T00:00:00Z', amount: 1, desc: 'x' }] }), {
          status: 200,
        }),
      )
    }) as typeof fetch

    await runRecipe({ recipe, fetch: fetchFn })
    expect(captured[0]?.cardaccount).toBe('CARD-XYZ')
    expect(captured[0]?.product).toBe('15')
    expect(captured[0]?.page).toBe('1')
  })

  it('discovery emite campos extras como {discovered.<key>} (id+name+product)', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'discovered',
          idPrefix: 'card',
          type: 'credit_card',
          currency: 'BRL',
          discover: {
            source: { type: 'rest-json', url: 'https://b.com/cards' },
            list: '[*]',
            fields: { id: 'token', name: 'label', product: 'productCode', tier: 'tier' },
          },
          extract: {
            source: { type: 'rest-json', url: 'https://b.com/{discovered.id}/{discovered.product}/{discovered.tier}' },
            list: '[*]',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'desc' },
              type: { creditWhenSign: 'positive' },
            },
            delayMs: 0,
          },
          nameTemplate: '{discovered.name} ({discovered.product}/{discovered.tier})',
        },
      ],
    })

    const calls: string[] = []
    const fetchFn = ((url: RequestInfo | URL) => {
      const u = String(url)
      calls.push(u)
      if (u === 'https://b.com/cards') {
        return Promise.resolve(
          new Response(JSON.stringify([{ token: 'T1', label: 'Black', productCode: '17', tier: 'premium' }]), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify([{ id: 'a', date: '2026-05-01T00:00:00Z', amount: 1, desc: 'x' }]), {
          status: 200,
        }),
      )
    }) as typeof fetch

    const r = await runRecipe({ recipe, fetch: fetchFn })
    expect(calls).toContain('https://b.com/T1/17/premium')
    expect(r[0]?.account.name).toBe('Black (17/premium)')
  })

  it('iterate-then-extract: agrega um item por ciclo dentro de uma única conta', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'cc',
          name: 'Cartão',
          type: 'credit_card',
          currency: 'BRL',
          extract: {
            iterate: {
              source: { type: 'rest-json', url: 'https://b.com/cycles' },
              list: '[*]',
              fields: { 'cycle.id': 'billingCycle' },
              delayMs: 0,
            },
            source: {
              type: 'rest-json',
              url: 'https://b.com/tx',
              headers: { closingdate: '{cycle.id}' },
            },
            list: '[*]',
            fields: {
              id: { template: 'cc-{cycle.id}-{id}' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'desc' },
              type: { creditWhenSign: 'positive' },
            },
            delayMs: 0,
          },
        },
      ],
    })

    const requestedCycles: string[] = []
    const fetchFn = ((url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (u === 'https://b.com/cycles') {
        return Promise.resolve(
          new Response(JSON.stringify([{ billingCycle: '08012026' }, { billingCycle: '08022026' }]), { status: 200 }),
        )
      }
      const closing = (init?.headers as Record<string, string>)?.closingdate
      if (closing) requestedCycles.push(closing)
      const items =
        closing === '08012026'
          ? [{ id: 't1', date: '2026-01-15T00:00:00Z', amount: 100, desc: 'a' }]
          : [{ id: 't2', date: '2026-02-10T00:00:00Z', amount: 50, desc: 'b' }]
      return Promise.resolve(new Response(JSON.stringify(items), { status: 200 }))
    }) as typeof fetch

    const r = await runRecipe({ recipe, fetch: fetchFn })
    expect(r).toHaveLength(1)
    expect(r[0]?.account.id).toBe('cc')
    expect(requestedCycles.sort()).toEqual(['08012026', '08022026'])
    const txs = r[0]?.transactions ?? []
    expect(txs.map((t) => t.fitId).sort()).toEqual(['cc-08012026-t1', 'cc-08022026-t2'])
  })

  it('iterate filter + mapValues: pula "futura" e mapeia aberta→OPEN, fechada→CLOSED', async () => {
    const recipe = parseRecipe({
      $schema: RECIPE_SCHEMA,
      site: 'b.com',
      label: 'B',
      version: 1,
      matchHosts: ['b.com'],
      accounts: [
        {
          kind: 'single',
          id: 'cc',
          name: 'Cartão',
          type: 'credit_card',
          currency: 'BRL',
          extract: {
            iterate: {
              source: { type: 'rest-json', url: 'https://b.com/cycles' },
              list: '[*]',
              filter: { path: 'typeInvoice', notEquals: 'futura' },
              fields: {
                'cycle.id': 'billingCycle',
                'cycle.type': { path: 'typeInvoice', mapValues: { aberta: 'OPEN', fechada: 'CLOSED' } },
              },
              delayMs: 0,
            },
            source: { type: 'rest-json', url: 'https://b.com/invoices/{cycle.type}/{cycle.id}' },
            list: '[*]',
            fields: {
              id: { path: 'id' },
              postedAt: { path: 'date' },
              amount: { path: 'amount' },
              description: { path: 'desc' },
              type: { creditWhenSign: 'positive' },
            },
            delayMs: 0,
          },
        },
      ],
    })

    const urls: string[] = []
    const fetchFn = ((url: RequestInfo | URL) => {
      const u = String(url)
      urls.push(u)
      if (u === 'https://b.com/cycles') {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { billingCycle: 'C1', typeInvoice: 'fechada' },
              { billingCycle: 'C2', typeInvoice: 'aberta' },
              { billingCycle: 'C3', typeInvoice: 'futura' },
            ]),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify([{ id: `tx-${u.slice(-2)}`, date: '2026-05-01T00:00:00Z', amount: 1, desc: 'x' }]),
          {
            status: 200,
          },
        ),
      )
    }) as typeof fetch

    const r = await runRecipe({ recipe, fetch: fetchFn })
    const detailUrls = urls.filter((u) => u !== 'https://b.com/cycles').sort()
    expect(detailUrls).toEqual(['https://b.com/invoices/CLOSED/C1', 'https://b.com/invoices/OPEN/C2'])
    expect(r[0]?.transactions ?? []).toHaveLength(2)
  })

  it('parseRecipe rejeita iterate + windowedHistory no mesmo extract', () => {
    expect(() =>
      parseRecipe({
        $schema: RECIPE_SCHEMA,
        site: 'b.com',
        label: 'B',
        version: 1,
        matchHosts: ['b.com'],
        accounts: [
          {
            kind: 'single',
            id: 'a',
            name: 'A',
            type: 'checking',
            currency: 'BRL',
            extract: {
              source: { type: 'rest-json', url: 'https://b.com/x' },
              iterate: {
                source: { type: 'rest-json', url: 'https://b.com/cycles' },
                list: '[*]',
                fields: { 'cycle.id': 'id' },
              },
              windowedHistory: { windowDays: 30, maxYears: 1 },
              list: 'items',
              fields: {
                id: { path: 'id' },
                postedAt: { path: 'date' },
                amount: { path: 'amount' },
                description: { path: 'desc' },
                type: { creditWhenSign: 'positive' },
              },
            },
          },
        ],
      }),
    ).toThrow(/mutuamente exclusivos/)
  })
})
