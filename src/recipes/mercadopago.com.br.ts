import type { Recipe } from './_schema'

/**
 * Mercado Pago — atividade da conta + porquinho.
 *
 * STATUS: descoberta. Esta recipe ainda não tem selectors mapeados.
 *
 * Próximos passos (faça com a aba MP aberta + DevTools):
 *  1. URL alvo provável: https://www.mercadopago.com.br/activities ou /atividade
 *  2. Identificar o seletor da lista de movimentações (provavelmente `[data-testid]` estável)
 *  3. Para cada item: data, valor, descrição, ID interno (usar como FITID)
 *  4. Paginação: existe botão "carregar mais"? Scroll infinito? Date picker?
 *  5. Porquinho/rendimento automático aparece como linha separada — marcar `description`
 *     com prefixo claro tipo "Rendimento" para o consumidor identificar
 *  6. Validar: exportar OFX e importar em ferramenta conhecida pra confirmar valores
 */
export const mercadopago: Recipe = {
  site: 'mercadopago.com.br',
  version: 0,
  label: 'Mercado Pago',

  match: (url) => /(^|\.)mercadopago\.com\.br$/.test(url.hostname),

  detectAccount: () => ({
    id: 'mercadopago',
    name: 'Mercado Pago',
    type: 'checking',
    currency: 'BRL',
  }),

  extract: async () => {
    throw new Error('Recipe do Mercado Pago em descoberta. Veja src/recipes/mercadopago.com.br.ts para o roteiro.')
  },
}
