# Discovery: recipe Nu Empresas (Nubank PJ)

Guia para preencher os endpoints reais do Nu Empresas e validar a recipe antes de virar built-in.

## Por que este doc existe

Em maio/2026, o Nubank tem dois fluxos para extrato:

| Conta | Web logada | App | Recomendado |
|---|---|---|---|
| **PF** | Descontinuada em set/2024 | Exporta PDF, OFX e CSV pro email | Aguardar `Source: 'pdf-upload'` / `'ofx-upload'` |
| **PJ (Nu Empresas)** | Ativa em [app.nubank.com.br](https://app.nubank.com.br) | Idem | **Recipe REST/SSR — esta é a recipe deste doc** |

Para PF, a melhor estratégia é **receber o OFX que o app já manda** e re-normalizar (item #2 do roadmap em [recipe-spec-v1.md](../recipe-spec-v1.md)). Esta recipe cobre só o fluxo PJ web.

## Pré-requisitos

- Conta Nu Empresas ativa (PJ).
- Extratus em modo desenvolvedor (`npm run build`, carrega `dist/` em `chrome://extensions`).
- Chrome com DevTools.

## Roteiro de descoberta (5 minutos)

1. Faça login em [app.nubank.com.br](https://app.nubank.com.br).
2. Navegue até **Extrato** (ou equivalente — feed de movimentações).
3. Abra o DevTools → aba **Network** → filtro `Fetch/XHR`.
4. Recarregue a página ou aplique um filtro de data — observe as chamadas que retornam **JSON** (não HTML).
5. Identifique:

| Pergunta | Onde achar | Exemplo do que procurar |
|---|---|---|
| **Host da API** | Coluna "Domain" do Network | `prod-s0-webapp-proxy.nubank.com.br` ou `app.nubank.com.br/api/...` |
| **Path do extrato** | Path da request que retorna a lista | `/api/feed`, `/api/proxy/account/...`, `/feed/v1/movements` |
| **Auth header** | Headers da request → `Authorization: Bearer ...` | Já é capturado automático pelo Extratus se o site enviar `Authorization` |
| **Headers extras** | Procure `x-*` na request | Nubank costuma usar `x-correlation-id`, talvez `client-id` ou similar |
| **Filtro de data** | Se a URL tem `?startDate=...&endDate=...`, ou se a paginação é por cursor | Pode ser `?cursor=...`, `?since=...&until=...`, ou paginação por `?page=` |
| **Schema do response** | Aba "Preview" do Network → JSON tree | Localize o array de transações: pode ser `data.feed[]`, `movements[]`, `feed.items[]`. **Anote o path completo até o array.** |
| **Campos da transação** | Itens do array | Anote: id, data, valor, descrição, tipo (in/out), moeda |

6. Para o cartão (se PJ tiver cartão de crédito Nu): repita em **Cartão → Fatura**, identificando endpoint diferente.

## Esqueleto da recipe

Cole isto no popup em **"Importar recipe customizada (JSON)"** depois de preencher os `TODO_*`. Hosts já estão liberados no `manifest.json`.

```jsonc
{
  "$schema": "afino-extratus-recipe/v1",
  "site": "nubank.com.br",
  "version": 1,
  "label": "Nu Empresas",
  "matchHosts": [
    "app.nubank.com.br",
    "*.nubank.com.br"
  ],
  "bank": {
    "id": "18236120",
    "org": "Nu Pagamentos S.A.",
    "branchId": "0001"
  },
  "accounts": [
    {
      "kind": "single",
      "id": "nu-pj-checking",
      "name": "Nu Empresas — Conta",
      "type": "checking",
      "currency": "BRL",
      "extract": {
        "source": {
          "type": "rest-json",
          "url": "https://TODO_HOST.nubank.com.br/TODO_PATH?startDate={periodStart}&endDate={periodEnd}",
          "method": "GET",
          "headers": {
            "Authorization": "{capturedHeader:authorization}"
          }
        },
        "pagination": {
          "type": "cursor",
          "nextPath": "TODO_PATH_TO_NEXT_CURSOR",
          "max": 100
        },
        "periodMap": {
          "today":          { "periodStart": "now",   "periodEnd": "now" },
          "yesterday":      { "periodStart": "-1d",   "periodEnd": "now" },
          "last_week":      { "periodStart": "-7d",   "periodEnd": "now" },
          "last_two_weeks": { "periodStart": "-14d",  "periodEnd": "now" },
          "month":          { "periodStart": "-30d",  "periodEnd": "now" },
          "all":            { "periodStart": "-365d", "periodEnd": "now" }
        },
        "dateFormat": {
          "periodStart": "iso-utc",
          "periodEnd":   "iso-utc"
        },
        "list": "TODO_PATH_TO_TRANSACTION_ARRAY",
        "fields": {
          "id":          { "path": "TODO_FIELD_ID" },
          "postedAt":    { "path": "TODO_FIELD_DATE", "format": "iso" },
          "amount":      { "path": "TODO_FIELD_AMOUNT" },
          "description": { "path": "TODO_FIELD_DESCRIPTION" },
          "type":        { "creditWhen": { "path": "TODO_FIELD_DIRECTION", "equals": "TODO_VALUE_FOR_CREDIT" } }
        },
        "delayMs": 250
      }
    }
  ]
}
```

## Como mapear cada `TODO_*`

| Placeholder | O que preencher | Exemplo (chute, **não confiar**) |
|---|---|---|
| `TODO_HOST` | Host da request (Network → Domain) | `prod-s0-webapp-proxy` |
| `TODO_PATH` | Path do endpoint do extrato | `/api/proxy/feed/v1/account/transactions` |
| `TODO_PATH_TO_NEXT_CURSOR` | Path no JSON do response até o cursor da próxima página. Se a API NÃO usa cursor (usa `?page=N` com total no response), troque o bloco `pagination` por `{ "type": "page-count", "totalPath": "..." }`. Se devolve até esgotar, use `{ "type": "page-until-empty", "pageSize": N }`. | `pagination.next` |
| `TODO_PATH_TO_TRANSACTION_ARRAY` | Path no JSON até o array de transações. Use `[*]` para flatten | `feed[*]` ou `data.movements[*]` |
| `TODO_FIELD_ID` | Campo do item que tem id estável | `id` |
| `TODO_FIELD_DATE` | Campo de data postada (server-side) | `postedAt` ou `time` |
| `TODO_FIELD_AMOUNT` | Campo numérico do valor. Se vier em centavos como inteiro, troque para `{ "path": "...", "scale": 0.01 }`. Se vier em string `"1.234,56"`, troque para `{ "path": "...", "format": "br" }` | `amount` |
| `TODO_FIELD_DESCRIPTION` | Descrição user-facing | `title` ou `description` |
| `TODO_FIELD_DIRECTION` + `TODO_VALUE_FOR_CREDIT` | Como o JSON marca crédito vs débito. Se for por sinal do amount, troque para `{ "creditWhenSign": ">=0" }` | `type` + `"DEPOSIT"`, ou `direction` + `"IN"` |

## Validação

1. Cole o JSON preenchido em **"Importar recipe customizada"** no popup.
2. Volte à aba do Nu Empresas logado.
3. Selecione **"Esta página"** → **"Exportar OFX"** (período: comece com **last_week** para iterar rápido).
4. Confira no OFX gerado:
   - Contagem de transações bate com o que aparece na tela.
   - Soma de créditos − débitos bate com a movimentação líquida do período.
   - `<DTPOSTED>` está no fuso correto (BRT).
   - Re-importar o mesmo período não duplica `<FITID>`.
5. Se quebrar com `LoginRequiredError`: confirme que está logado, e que o site enviou `Authorization` recente (a captura espera os últimos minutos).
6. Se vier vazio: re-confira o `list:` path no Network → Preview.

## Promover a built-in

Quando estável (3+ exportações sem regressão):

1. Salve em [src/recipes/nubank.com.br.json](../../src/recipes/nubank.com.br.json) (nome do arquivo == `site`).
2. Adicione o `import` em [src/recipes/_registry.ts](../../src/recipes/_registry.ts) na lista `builtInRecipes`.
3. Os hosts em `manifest.json` já estão liberados.
4. `npm test && npm run build && npm run lint`.
5. Abra PR.

## O que ainda fica de fora desta recipe

- **Cartão de crédito Nu Empresas** — endpoint diferente; replicar o esqueleto como segunda `account` `kind: 'single'` (ou `'discovered'` se houver vários cartões), apontando para o endpoint da fatura.
- **Histórico longo (> 365 dias)** — se o Nu Empresas limitar histórico por chamada, adicionar `windowedHistory: { windowDays: 90, maxYears: 5, ... }` ao extract; ver exemplo em [inter.co.json](../../src/recipes/inter.co.json).
- **PF** — fora de escopo desta recipe. Aguarda `Source: 'ofx-upload'` (re-normalizar o OFX que o app envia) e `Source: 'pdf-upload'` (fatura aberta de cartão).
