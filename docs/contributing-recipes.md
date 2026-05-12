# Contribuindo uma recipe com ajuda de um agente

A maneira mais rápida de adicionar suporte a um banco/fintech que ainda não está no Extratus é delegar a descoberta para um agente com browser tools (Claude in Chrome, Computer Use, Claude Code com MCP `claude-in-chrome`).

## Pré-requisitos

- Você logado na sua conta do banco numa aba do Chrome.
- Um agente com acesso ao seu navegador. Recomendado: [Claude in Chrome](https://www.anthropic.com/news/claude-in-chrome).
- Esse repositório clonado.

## Por que isso funciona

A maioria dos bancos brasileiros usa um destes padrões para renderizar o extrato:

| Padrão | Como reconhecer |
|---|---|
| **Next.js SSR** | `<script id="__NEXT_DATA__">` no HTML inicial |
| **Nordic SSR** (Mercado Livre/Pago) | `<script id="__NORDIC_RENDERING_CTX__">` no HTML inicial |
| **Redux/Vuex hydration** | `window.__INITIAL_STATE__` / `window.__PRELOADED_STATE__` |
| **SPA puro com API** | Página vazia, lista populada via XHR/fetch JSON |

Os três primeiros expõem o JSON completo da lista no HTML inicial — basta um `fetch` na sessão logada e parsing. O quarto exige interceptar a request XHR. Um agente experiente identifica o padrão em poucos minutos.

## O prompt

Está no popup da extensão (botão "Não tem seu banco?" → página de ajuda) — também copiável daqui:

```
Você vai descobrir como o site do meu banco renderiza o extrato, e produzir uma recipe TypeScript para o projeto Extratus. Eu já estou logado na conta. NÃO clique em botões que mudem estado (transferir, pagar, confirmar) — você é READ-ONLY.

OBJETIVO
Mapear como obter, de forma programática, a lista completa de transações do extrato — incluindo paginação e filtros de data — e devolver um arquivo TypeScript no formato Recipe do Extratus.

PASSO A PASSO

1. Abra a página principal de extrato do banco e me diga a URL. Tire screenshot.

2. Antes de qualquer clique, inspecione o HTML inicial procurando dados embarcados (SSR):
   - `<script id="__NEXT_DATA__">` (Next.js)
   - `<script id="__NORDIC_RENDERING_CTX__">` (Mercado Libre)
   - `window.__INITIAL_STATE__`, `window.__PRELOADED_STATE__`, `window.__APP_DATA__`
   - Qualquer `<script>` cujo textContent contenha uma transação visível.
   Reporte: qual padrão SSR e o JSONPath até o array de transações.

3. Capture as requisições de rede (XHR/fetch) que populam a lista. Aplique um filtro de data ("últimos 30 dias") e role a página. Reporte:
   - URL exata, method, headers críticos (CSRF, X-Requested-With), cookies necessários.
   - Body POST quando houver.

4. Pegue UMA transação de exemplo e mostre o JSON cru completo do item. Identifique:
   - `id` ESTÁVEL (FITID, dedup); NUNCA use índice.
   - data ISO ou DD/MM/YYYY.
   - valor: centavos separados? sinal incluso? separador de milhares?
   - sinal: campo canônico (`type:"in"|"out"`) ou inferido?
   - moeda explícita ou implícita BRL?
   - descrição combinada de quais campos? Categoria do usuário?

5. Paginação. Itere até a última página. Como funciona? `?page=N` 1- ou 0-indexed? cursor? scroll infinito? Confirme total reportado vs iterado.

6. Lançamentos especiais com tag distinta:
   - Rendimento automático (cofrinho, savings)
   - Pix entrada/saída
   - Cartão parcelado
   - Cashback / estorno
   Marque a regra (ex: "metadata.kind=investment ⇒ Rendimento").

7. Multi-conta. O site tem corrente + cofrinhos + cartão? Liste cada uma com URL e endpoint.

ENTREGÁVEIS

A. Relatório markdown com os 7 itens preenchidos.

B. Arquivo TypeScript pronto para `src/recipes/<dominio>.ts`:

```ts
import type { Recipe } from './_schema'
import type { RecipeOutput } from '@/types/transaction'
import { fetchNordicCtx } from '@/engine/nordic-ssr'  // só se SSR Nordic
import { sleep } from '@/engine/recipe-helpers'
import Decimal from 'decimal.js'

export const bancoX: Recipe = {
  site: 'bancox.com.br',
  version: 1,
  label: 'Banco X',
  match: (url) => /(^|\.)bancox\.com\.br$/.test(url.hostname),
  extract: async ({ window }) => {
    // 1. fetch páginas (loop sobre `page` até o total reportado)
    // 2. dedup por id se houver overlap
    // 3. map para NormalizedTransaction
    // 4. retornar 1+ RecipeOutput (um por conta)
    return []
  },
}
```

REGRAS NÃO NEGOCIÁVEIS
- `amount` é Decimal. NUNCA parseFloat.
- `postedAt` é `Date` UTC. DD/MM/YYYY → parse em America/Sao_Paulo.
- `fitId` estável: duas exportações do mesmo período → mesmos fitIds.
- `extract` idempotente.
- `await sleep(250)` entre requests.

Comece pelo passo 1 e vá em sequência.
```

## Depois que o agente terminar

1. Salve o `.ts` em `src/recipes/<dominio>.ts`.
2. Registre em [src/recipes/_registry.ts](../src/recipes/_registry.ts).
3. Adicione o domínio em `host_permissions` e num `content_scripts.matches` no [src/manifest.json](../src/manifest.json).
4. `npm test && npm run build`.
5. Carregue `dist/` no Chrome em modo dev, vá na página do banco, clique o ícone Extratus → Exportar OFX.
6. Importe o OFX no seu software (Afino, GnuCash, YNAB) e confira: contagem, soma, saldo, datas em 31/12 ↔ 01/01.
7. Abra um PR com o relatório markdown na descrição.

## Recipes existentes como referência

- [Mercado Pago](../src/recipes/mercadopago.com.br.ts) — exemplo de SSR Nordic, multi-account (conta + cofrinhos), rendimento como linha distinta. Usa [nordic-ssr](../src/engine/nordic-ssr.ts) e [bitacora-mapper](../src/engine/bitacora-mapper.ts).
