# Extratus Recipe Spec — `afino-extratus-recipe/v1`

Especificação do formato JSON declarativo que o Extratus consome para extrair extratos. Esta é a referência canônica para escrever uma recipe — built-in (`src/recipes/<dominio>.json`) ou custom (colada no popup, persistida em `chrome.storage.local`).

| Campo | Valor |
|---|---|
| **Spec version** | `afino-extratus-recipe/v1` |
| **Implementação de referência** | [src/recipes/_schema.ts](../src/recipes/_schema.ts) (parser + tipos) e [src/engine/recipe-engine.ts](../src/engine/recipe-engine.ts) (motor) |
| **Exemplos canônicos** | [inter.co.json](../src/recipes/inter.co.json), [mercadopago.com.br.json](../src/recipes/mercadopago.com.br.json), [rico.com.vc.json](../src/recipes/rico.com.vc.json) |
| **Status** | Estável. Mudanças retro-compatíveis bumpam minor; quebra bumpa para `v2` |

---

## 1. Estrutura geral

```jsonc
{
  "$schema": "afino-extratus-recipe/v1",      // string fixa, valida o formato
  "site": "banco.com.br",                     // identificador único da recipe
  "version": 1,                               // bump em mudanças não retro-compatíveis da recipe
  "label": "Banco X",                         // texto exibido no popup
  "matchHosts": ["*.banco.com.br"],           // hosts onde a recipe aplica (current-tab detection + fetch allowlist)
  "bank": {                                    // metadados para o gerador OFX (opcional)
    "id": "00000000",                         // ISPB de 8 dígitos → <BANKID>/<FID>
    "org": "Banco X",                         // → <FI><ORG>
    "branchId": "0001"                        // → <BRANCHID>
  },
  "accounts": [ /* AccountSpec[] */ ]         // pelo menos uma conta
}
```

**Invariantes:**
- `$schema` deve ser literalmente `"afino-extratus-recipe/v1"`.
- `accounts` não pode ser vazio.
- `matchHosts` aceita glob com `*` em subdomínio (ex.: `*.banco.com.br`). Bare host = match exato. **Toda chamada `fetch` é restringida a esses hosts pelo motor** — uma recipe não consegue tocar fora do allowlist.
- Cada arquivo é parseado em load via `parseRecipe()`. Erros de schema fazem a extensão falhar rápido (built-in) ou rejeitar a importação (custom).

---

## 2. AccountSpec

Duas variantes — discriminadas pelo campo `kind`.

### 2.1 `single` — uma conta fixa

```jsonc
{
  "kind": "single",                  // pode ser omitido; é o default
  "id": "banco-checking",            // identificador estável (vai pro <ACCTID> default)
  "name": "Banco — Conta Corrente",  // exibido na UI e no nome do arquivo
  "type": "checking",                // checking | savings | credit_card | investment | pending
  "currency": "BRL",
  "extract": { /* ExtractSpec */ }   // ou "extracts": [ ExtractSpec, ExtractSpec, ... ]
}
```

Use `extracts: []` quando uma mesma conta precisa de **múltiplas chamadas mescladas** (Inter usa `/home` para os ~70 dias recentes + paginação `/transactions` para histórico). Dedup por `fitId` garante que cada transação aparece uma única vez.

### 2.2 `discovered` — descobre N sub-contas em runtime

```jsonc
{
  "kind": "discovered",
  "idPrefix": "mp-pot",                          // id final: "{idPrefix}-{discovered.id}"
  "type": "savings",
  "currency": "BRL",
  "discover": {
    "source": { /* Source */ },                  // chamada que retorna a lista
    "list": "appProps.pageProps.hub.result.pots",// path para o array de sub-contas
    "fields": {
      "id": "id",                                // path obrigatório
      "name": "name",                            // path obrigatório
      "product": "productCode"                   // extras viram {discovered.<key>}
    }
  },
  "extract": { /* ExtractSpec, pode usar {discovered.id}, {discovered.name}, etc. */ },
  "nameTemplate": "Mercado Pago — Cofrinho {discovered.name}"
}
```

Útil para cofrinhos, cartões adicionais, sub-contas de family-plan. Cada item descoberto vira uma conta independente no output.

---

## 3. ExtractSpec — uma chamada de extração

```jsonc
{
  "source": { /* Source */ },                   // como buscar uma página
  "pagination": { /* Pagination */ },           // opcional; default { type: "none" }
  "list": "data[*].transactions[*]",            // path no JSON parseado para o array de transações
  "fields": { /* FieldsSpec */ },               // como mapear cada item

  // opcionais avançados:
  "periodMap": { /* preset → vars */ },
  "dateFormat": { "periodStart": "iso-utc" },
  "windowedHistory": { /* WindowedHistory */ }, // mutuamente exclusivo com iterate
  "iterate": { /* IterateSpec */ },             // mutuamente exclusivo com windowedHistory
  "inheritFromParent": ["day"],                 // copia campos do nó-pai para cada folha
  "delayMs": 250,                               // entre páginas
  "runOnlyForPresets": ["all"]                  // só roda este extract quando o preset bate
}
```

---

## 4. Source — como buscar uma página

Discriminated union por `type`:

### 4.1 `ssr-nordic`

Páginas Nordic-rendered (Mercado Livre / Mercado Pago). O motor extrai o `__NORDIC_RENDERING_CTX__` do HTML inicial e parseia.

```jsonc
{ "type": "ssr-nordic", "url": "https://site.com/path?page={page}[&period={period}]" }
```

### 4.2 `ssr-next`

Páginas Next.js. O motor extrai `__NEXT_DATA__` do HTML.

```jsonc
{ "type": "ssr-next", "url": "https://site.com/path" }
```

### 4.3 `rest-json`

API JSON pura. Suporta `GET`/`POST`, headers e body com templates.

```jsonc
{
  "type": "rest-json",
  "url": "https://api.banco.com/v1/extrato?startDate={periodStart}&page={page}",
  "method": "GET",                              // ou "POST"
  "headers": {
    "Authorization": "{capturedHeader:authorization}",
    "X-Custom": "{sessionStorage:token}"
  },
  "body": { "filter": { "since": "{periodStart}" } }
}
```

**Resolução de tokens em headers/body:**
- `{capturedHeader:NAME}` — header recente que a SPA do banco enviou (capturado pelo content script, vive em memória, típico Itaú/Inter).
- `{sessionStorage:KEY}` / `{localStorage:KEY}` — lê do storage da aba ativa. Se a chave não existir, o motor lança `LoginRequiredError`.

### 4.4 Importação de arquivo OFX (sem `Source`)

Independente do sistema de recipes, o popup expõe **"Importar arquivo OFX"** que aceita qualquer `.ofx`/`.qfx`/`.qbo` (o que o app/site do banco já entrega) e re-normaliza com a mesma pipeline de saída — FITID estável, encoding correto, dedup, OFX 1.0.2 SGML padronizado. Útil quando:

- O banco não tem web (Nubank PF desde set/2024).
- O OFX nativo vem mal-formado (Itaú/BB/Caixa cospem SGML sem fechamento, charset `windows-1252`).
- Você quer um único arquivo no padrão Extratus em vez de N flavors por banco.

Implementação em [src/parsers/ofx/](../src/parsers/ofx/) — não precisa de recipe nem de `Source` no JSON; é uma feature do motor.

---

## 5. Pagination

### 5.1 `none` (default)

Uma única chamada.

### 5.2 `page-count`

Loop `?page=N` até atingir total ou condição de parada.

```jsonc
{
  "type": "page-count",
  "totalPath": "appProps.pageProps.initialState.list.result.pages",  // opcional
  "stopWhen": { "path": "metadata.noContent", "equals": "true" },     // opcional
  "startPage": 1,                                                     // default 1
  "max": 100                                                          // default 100
}
```

Quando `totalPath` está ausente, roda até `stopWhen` casar, lista vir vazia, ou bater `max`.

### 5.3 `cursor`

Loop seguindo `?cursor=X` até `nextPath` vir vazio.

```jsonc
{ "type": "cursor", "nextPath": "pagination.next", "max": 100 }
```

### 5.4 `page-until-empty`

Para APIs que não expõem total — itera até receber menos itens que `pageSize`.

```jsonc
{ "type": "page-until-empty", "pageSize": 20, "startPage": 1, "max": 500 }
```

---

## 6. FieldsSpec — mapeamento de uma transação

```jsonc
{
  "id":          { /* IdField */ },
  "postedAt":    { /* DateField */ },
  "amount":      { /* AmountField */ },
  "description": { /* DescriptionField */ },
  "type":        { /* TypeField */ },
  "currency":    { /* CurrencyField, opcional */ }
}
```

### 6.1 IdField

| Forma | JSON | Quando |
|---|---|---|
| Path único | `{ "path": "id" }` | Banco tem id estável exposto |
| Composto | `{ "paths": ["accountId", "txId"], "join": "-" }` | Estável só em combinação |
| Template sintético | `{ "template": "ccid-{cycle.billingCycle}-{date}-{amount}-{description}" }` | Sem id estável (ex.: cartão aberto) — produz mesma string em re-imports do mesmo período |

### 6.2 DateField

```jsonc
{ "path": "ledger_datetime", "format": "iso" }
{ "paths": ["data.transactionDate", "data.purchaseDate", "day"], "format": "br-date" }
```

`format`: `iso` | `iso-utc` | `iso-date` | `br-date` | `unix-ms` | `unix-s`.

`paths[]` testa em ordem; o primeiro que parseia vence. Útil quando o banco usa campos diferentes por tipo de transação (Inter: `data.transactionDate` para Pix, `data.aboutTransaction.purchaseDate` para débito).

`br-date` aceita formatos PT-BR comuns: `DD/MM/YYYY`, `Sábado, 23/08/2025`, `Sexta, 13 fev. 2026`.

### 6.3 AmountField

| Forma | JSON | Quando |
|---|---|---|
| Numérico raw | `{ "path": "amount" }` | Float ou string `"123.45"` |
| Numérico + escala | `{ "path": "cents", "scale": 0.01 }` | Inteiro em centavos |
| Formato BR | `{ "path": "valor", "format": "br" }` | String `"1.234,56"` |
| Bitácora (Nordic) | `{ "fractionPath": "amount.fraction", "centsPath": "amount.cents" }` | `{fraction: "1234", cents: "56"}` |

Sempre normalizado para valor absoluto; sinal vem do `type`.

### 6.4 DescriptionField

```jsonc
{ "path": "description" }

{
  "template": "{title}[ — {description}]",
  "prefixes": [
    { "when": { "path": "metadata.kind", "equals": "pix" }, "value": "Pix · " }
  ]
}
```

**Sintaxe de template:**
- `{path}` — resolve um path no item (ou variável upstream como `{discovered.id}`, `{cycle.billingCycle}`).
- `[grupo]` — grupo opcional: aparece só se TODOS os `{path}` dentro resolvem para valor não-vazio. Permite `"{title}[ — {description}]"` com o conector sumindo quando description está ausente.

### 6.5 TypeField

| Forma | JSON | Comportamento |
|---|---|---|
| Por sinal | `{ "creditWhenSign": ">=0" }` | `>=0` \| `>0` \| `positive` \| `non-negative` |
| Por condição | `{ "creditWhen": { "path": "operationType", "equals": "C" } }` | Casou → credit, senão debit |
| Por condição (inverso) | `{ "debitWhen": { "path": "type", "equals": "out" } }` | Casou → debit, senão credit |
| Fixo | `{ "fixed": "credit" }` | Toda tx desta extract é credit (ou debit) |

### 6.6 CurrencyField (opcional)

```jsonc
{ "path": "amount.currency_id" }    // pull do JSON
{ "const": "BRL" }                   // literal
```

Quando ausente, o motor usa o `currency` da conta.

### 6.7 PathCondition (usado em `creditWhen`/`debitWhen`/`stopWhen`/`prefixes[].when`)

```jsonc
{ "path": "metadata.type", "equals": "out" }
{ "path": "type", "notEquals": "CREDIT" }
{ "path": "metadata.id", "exists": true }
```

---

## 7. PeriodMap e templates de URL

```jsonc
{
  "periodMap": {
    "today":  { "periodStart": "now", "periodEnd": "now" },
    "month":  { "periodStart": "-30d", "periodEnd": "now" },
    "all":    { "periodStart": "-365d", "periodEnd": "now" }
  },
  "dateFormat": { "periodStart": "iso-utc", "periodEnd": "iso-utc" }
}
```

**Formato simples** (legado, uma var):
```jsonc
{ "periodMap": { "month": "30d" } }   // injeta {period}
```

**Formato multi-var** (recomendado):
- Cada chave (`periodStart`, `periodEnd`, ...) vira `{periodStart}` no template da URL/body.
- Valores aceitos: `"now"`, `"today"`, `"-7d"`, `"+1m"`, `"+3h"`, ISO 8601.
- `dateFormat` mapeia cada var para o formato de saída.

**Presets disponíveis:** `today` | `yesterday` | `last_week` | `last_two_weeks` | `month` | `all`.

---

## 8. WindowedHistory

Para APIs que limitam histórico por chamada (Inter: ~2 anos). Itera em janelas fixas voltando no tempo, parando quando uma janela vem vazia.

```jsonc
{
  "windowedHistory": {
    "windowDays": 730,           // largura da janela
    "maxYears": 50,              // teto absoluto de busca
    "startVar": "windowStart",   // nome da var no template (default: windowStart)
    "endVar": "windowEnd",
    "format": "iso-date",
    "delayMs": 500
  }
}
```

Quando o usuário escolhe um preset curto (`last_week`, `month`, ...), o motor pula a iteração e dispara uma única janela do tamanho do preset. Só `all` triggera o walk multi-janela.

Combine com `runOnlyForPresets: ["all"]` quando o extract de janelas só faz sentido para histórico longo.

---

## 9. IterateSpec

Para endpoints estruturados como "lista de ciclos → transações por ciclo" (faturas de cartão).

```jsonc
{
  "iterate": {
    "source": { /* fetch da lista de ciclos */ },
    "list": "[*]",
    "filter": { "path": "typeInvoice", "notEquals": "futura" },
    "fields": {
      "cycle.billingCycle": "billingCycle",
      "cycle.type": { "path": "typeInvoice", "mapValues": { "aberta": "OPEN", "fechada": "CLOSED" } }
    },
    "delayMs": 250,
    "max": 500
  },
  "source": { /* extract por ciclo, pode usar {cycle.billingCycle}, {cycle.type} */ },
  "list": "[*]",
  "fields": { /* ... */ }
}
```

**`fields` em iterate:**
- `string` — atalho para `{ "path": "..." }`.
- `{ "path": "...", "mapValues": { "from": "to" } }` — translate values; valor desconhecido passa direto.
- `{ "const": "..." }` — literal (útil para split).

Cada item iterado dispara o extract principal com as vars injetadas. Resultados mesclam na mesma conta; dedup por `fitId`.

---

## 10. Path language

Usada em `list`, `path`, `paths`, `template`, `PathCondition`.

| Sintaxe | Significado |
|---|---|
| `a.b.c` | Acesso aninhado |
| `a[0]` | Índice de array |
| `a[*]` | **Flatten** — em `list` expande para múltiplos itens |
| `a.b[*].c` | Walk + flatten — equivale a `a.b.flatMap(x => x.c)` |

**`inheritFromParent`** copia campos do objeto-pai imediato para cada folha. Útil quando a folha não tem o dado mas o pai tem (Inter: `transactions[]` sem data, mas `bankStatements[]` pai tem `day`).

---

## 11. Invariantes não-negociáveis

1. **Decimal sempre, float nunca** em qualquer caminho monetário. O motor usa `decimal.js`.
2. **Datas em `Date` (timezone-aware)**. Formatos brasileiros parseados via `parseBrDate` e os formats `br-date`/`iso`/`iso-date`/`iso-utc`/`unix-*`.
3. **`fitId` estável**. Duas exportações do mesmo período produzem os mesmos `fitId`s. Use o id interno do site se exposto; se não, derive via `template` determinístico em campos imutáveis.
4. **Sem efeitos colaterais**. Recipe não muta estado da conta. Só lê.
5. **Allowlist de hosts**. O motor restringe `fetch` aos `matchHosts` antes de chamar. URL fora dispara erro.
6. **Idempotência**. Re-importar o mesmo período no mesmo importador não duplica transações.

---

## 12. Como testar uma recipe

### Custom (rápido)

1. Cole o JSON em **"Importar recipe customizada"** no popup.
2. Volte à aba do banco logado.
3. Clique **Exportar OFX**.
4. Importe o arquivo num PFM (Afino, GnuCash, YNAB).
5. Confira: contagem total bate, soma credit/debit bate com saldo do período, datas estão no fuso correto, `fitId`s não duplicam em re-importação.

### Built-in (PR)

1. Salve em `src/recipes/<dominio>.json`.
2. Adicione `import` em `src/recipes/_registry.ts` na lista `builtInRecipes`.
3. Adicione hosts em `host_permissions` em `src/manifest.json` se ainda não cobertos.
4. `npm test && npm run build && npm run lint`.
5. Carregue `dist/` no Chrome em modo dev e teste como built-in.

---

## 13. Roadmap (não estável, não use ainda)

Itens já mapeados como necessários para virar hub multi-fonte. Aceitarão proposals via issue antes de virar parte da v1 ou bumparem para v2.

| Item | Categoria | Origem |
|---|---|---|
| ~~OFX upload~~ | ✅ Implementado — ver §4.4 | ofx-js |
| `Source: 'pdf-upload'` (faturas Nubank/Itaú/Bradesco/Inter/C6/Porto) | Hub de import | banksheet |
| `Source: 'csv-upload'` / `xlsx-upload` | Hub de import | csv2ofx, Mercado Pago |
| `Source: 'download-intercept'` (captura download nativo) | Hub de import | Itaú/Inter já entregam OFX/CSV via botão |
| `FieldsSpec.payee` separado de `description` | Fidelidade OFX | csv2ofx |
| `FieldsSpec.checkNum`, `balance`, `installment`, `fxOriginal` | Fidelidade OFX | csv2ofx, banksheet |
| `FieldsSpec.filterOut: PathCondition` | Descarte por linha | csv2ofx |
| `AmountField.paths[]` e `addPaths[]` | Multi-coluna | csv2ofx (Debit+Credit pareados) |
| `DescriptionField.paths[]` com join | Concatenação | csv2ofx (gls 14 colunas) |
| `BankInfo.ofxFlavor: 'standard' \| 'ms-money'` | Compatibilidade PFM | csv2ofx |
| `BankInfo.creditCardAs: 'CCSTMT' \| 'BANKMSGSRSV1'` | Compatibilidade PFM BR | itaucard-ofx |
| Output multi-formato zipado (OFX+CSV+QIF+JSON) | UX | OBIS |
| `Source.headersFrom: { dom: '#siteConfig@value' }` | Captura headers da DOM | OBIS |

---

## 14. Versionamento

- **Mudanças retro-compatíveis** (novos campos opcionais, novos `Source.type`, novos `format`): permanecem em `afino-extratus-recipe/v1`. Recipes antigas continuam válidas.
- **Mudanças incompatíveis** (renomear/remover campos obrigatórios, mudar semântica de campo existente): bumpa para `afino-extratus-recipe/v2`. O motor passa a aceitar ambos os schemas durante uma janela de transição.
- Cada recipe carrega seu próprio `version: number` separado do `$schema` — bumpe quando uma mudança quebra compatibilidade com versões antigas dela mesma (ex.: dedup chave muda, descontinuação de campo).

---

## Apêndice — relação com o código

| Conceito desta spec | Implementação |
|---|---|
| `parseRecipe()` validador | [src/recipes/_schema.ts](../src/recipes/_schema.ts) |
| Motor de execução | [src/engine/recipe-engine.ts](../src/engine/recipe-engine.ts) |
| SSR Nordic / Next extractors | [src/engine/nordic-ssr.ts](../src/engine/nordic-ssr.ts) |
| `parseBrDate`, `parseBrAmount` | [src/engine/normalize.ts](../src/engine/normalize.ts) |
| Gerador OFX 1.0.2 | [src/engine/ofx-generator.ts](../src/engine/ofx-generator.ts) |
| Gerador CSV | [src/engine/csv-generator.ts](../src/engine/csv-generator.ts) |
| Tipos de transação | [src/types/transaction.ts](../src/types/transaction.ts) |
