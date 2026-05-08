# Formato de Recipe

Uma **Recipe** é o adapter que ensina o Extratus a ler um site específico. Cada Recipe é um arquivo TypeScript em `src/recipes/<dominio>.ts` que exporta um objeto implementando a interface `Recipe` definida em [`src/recipes/_schema.ts`](../src/recipes/_schema.ts).

## Interface mínima

```ts
export interface Recipe {
  site: string                              // 'mercadopago.com.br'
  version: number                           // bump em mudanças não retro-compatíveis
  label: string                             // texto exibido no popup ("Mercado Pago")
  match: (url: URL) => boolean              // true se a URL atual é deste site
  detectAccount: (ctx: RecipeContext) => AccountInfo | null
  extract: (ctx: RecipeContext) => Promise<NormalizedTransaction[]>
}
```

## Princípios não negociáveis

- **`Decimal` sempre, `parseFloat` nunca.** Use `parseBrAmount` de `@/engine/normalize`. Float quebra precisão e o Extratus tem invariante de precisão financeira.
- **Datas em São Paulo.** Use `parseBrDate` para strings tipo `"DD/MM/YYYY"`. Nunca `new Date('01/05/2026')` — JavaScript interpreta como mês/dia em algumas locales.
- **`fitId` estável.** Duas exportações do mesmo período devem produzir os **mesmos** `fitId`s. Use o ID interno do site se exposto. Se não houver, derive um hash determinístico de `(data + valor + descrição + ordem)`.
- **Sem efeitos colaterais.** Sua função `extract` lê o DOM, paginação faz `.click()` ou scroll. Nunca clique em botões que mudem estado da conta (transferir, pagar, confirmar).

## Paginação

`extract` é responsável por trazer **todas** as transações do período visível antes de retornar. Padrões:

- **Botão "carregar mais":** loop `while (button.isVisible) { button.click(); await wait() }`
- **Scroll infinito:** `window.scrollTo({ top: document.body.scrollHeight })` em loop, esperando novos elementos por hash de contagem
- **Date range:** preenche os inputs e dispara `change`/`input` events; aguarda re-render via `MutationObserver`

Em todos os casos, **rate-limit** entre iterações (200-500ms) para não disparar antibot.

## Tratamento de yield/rendimento ("porquinho")

Sites como Mercado Pago e Nubank mostram rendimento automático como linhas de transação. A recipe deve marcar essas linhas com `description` clara:

```ts
description: 'Rendimento porquinho — R$ 1,23'
```

Não tente classificar como "income" vs "interest" — isso é decisão do consumidor (Afino, planilha, etc.). Apenas garanta que o texto da descrição seja distinguível.

## Multi-conta

Se o site tem várias contas (corrente + cartão + investimento), a recipe atual exporta a **conta visível na URL**. Para cobrir as outras, navegue até a página correspondente e exporte de novo. (Multi-conta no mesmo arquivo OFX é v2.)

## Como testar

1. `npm run build` e carregue `dist/` no Chrome em modo dev
2. Abra a página alvo logado
3. Clique no ícone Extratus → "Exportar OFX"
4. Importe o arquivo num software de referência (Afino, GnuCash) e confira:
   - Contagem total de transações bate com a tela
   - Soma de créditos e débitos bate com saldo do período
   - Datas estão certas (atenção a 31/12 e 1º/01 — fronteira de timezone)
   - `fitId`s não duplicam em re-importação

## Exemplo skeleton

```ts
import type { Recipe } from './_schema'
import { parseBrAmount, parseBrDate } from '@/engine/normalize'

export const banco: Recipe = {
  site: 'banco.com.br',
  version: 1,
  label: 'Banco X',
  match: (url) => url.hostname.endsWith('banco.com.br'),

  detectAccount: ({ document }) => {
    const accountId = document.querySelector('[data-account-id]')?.textContent?.trim()
    if (!accountId) return null
    return { id: accountId, name: 'Banco X', type: 'checking', currency: 'BRL' }
  },

  extract: async ({ document }) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.transaction-row'))
    return rows.map((row) => ({
      fitId: row.dataset.id ?? '',
      postedAt: parseBrDate(row.querySelector('.date')?.textContent ?? ''),
      amount: parseBrAmount(row.querySelector('.amount')?.textContent ?? '0'),
      currency: 'BRL',
      description: row.querySelector('.description')?.textContent?.trim() ?? '',
      type: row.classList.contains('outflow') ? 'debit' : 'credit',
    }))
  },
}
```
