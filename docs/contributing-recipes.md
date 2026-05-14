# Contribuindo uma recipe com ajuda de um agente

A maneira mais rápida de adicionar suporte a um banco/fintech que ainda não está no Afino Extratus é delegar a descoberta para um agente com browser tools (Claude in Chrome, Computer Use, Claude Code com MCP `claude-in-chrome`).

## Pré-requisitos

- Você logado na sua conta do banco numa aba do Chrome.
- Um agente com acesso ao seu navegador. Recomendado: [Claude in Chrome](https://www.anthropic.com/news/claude-in-chrome).
- Esse repositório clonado.

## Por que isso funciona

A maioria dos bancos brasileiros usa um destes padrões para renderizar o extrato:

| Padrão | Como reconhecer | `source.type` |
|---|---|---|
| **Next.js SSR** | `<script id="__NEXT_DATA__">` no HTML inicial | `ssr-next` |
| **Nordic SSR** (Mercado Livre/Pago) | `<script id="__NORDIC_RENDERING_CTX__">` | `ssr-nordic` |
| **SPA + REST JSON** | Página vazia, lista populada via XHR/fetch JSON | `rest-json` |

Os SSR expõem o JSON completo no HTML inicial — basta um `fetch` na sessão logada e parsing. O REST puro é mais comum em apps mobile-first; o agente identifica o pattern via DevTools.

## O prompt

Está no popup da extensão (link "Não tem seu banco? Gere uma recipe com IA"). O agente devolve **JSON declarativo** no schema `afino-extratus-recipe/v1` — sem TypeScript, sem código a executar.

## O ciclo curto (testar local sem PR)

1. O agente devolve o JSON.
2. No popup, abra **"Importar recipe customizada (JSON)"**, cole e clique **Importar**.
3. Volte na aba do banco logado e clique **Exportar OFX**.
4. Itere com o agente se algo estiver fora (descrição quebrada, sinais invertidos, paginação parando cedo).

A recipe colada fica em `chrome.storage.local`, só pra você. O engine restringe os `fetch` aos hosts em `matchHosts` antes de chamar — uma recipe não consegue tocar host fora desse allowlist.

## O ciclo longo (contribuir built-in)

1. Quando a recipe estiver estável (rodou várias vezes sem regressão), salve em `src/recipes/<dominio>.json`.
2. Registre nada — o `_registry.ts` já carrega automaticamente quando você adicionar o `import` (Vite resolve `import recipe from './x.json'`).
3. Adicione o domínio em `host_permissions` no `src/manifest.json` se ainda não estiver coberto.
4. `npm test && npm run build`.
5. Carregue `dist/` no Chrome em modo dev e teste como built-in.
6. Importe o OFX no Afino, GnuCash ou YNAB — confira contagem, soma, saldo e bordas (31/12 ↔ 01/01).
7. Abra um PR. Cole o relatório markdown do agente na descrição.

## Recipes existentes como referência

- [Mercado Pago](../src/recipes/mercadopago.com.br.json) — exemplo de SSR Nordic, multi-account com discovery (conta + cofrinhos), prefixos condicionais ("Rendimento ·", "Cofrinho ·", "Pix ·") e amount no formato bitácora (`fractionPath` + `centsPath`).

## Mapa de campos rápido

| Caso | JSON |
|---|---|
| ID estável | `"id": { "path": "id" }` |
| ID composto | `"id": { "paths": ["accountId", "txId"], "join": "-" }` |
| Data ISO | `"postedAt": { "path": "date", "format": "iso" }` |
| Data DD/MM/YYYY | `"postedAt": { "path": "date", "format": "br-date" }` |
| Data unix | `"postedAt": { "path": "ts", "format": "unix-s" }` |
| Valor inteiro em centavos | `"amount": { "path": "cents", "scale": 0.01 }` |
| Valor "1.234,56" | `"amount": { "path": "valor", "format": "br" }` |
| Valor bitácora (Nordic) | `"amount": { "fractionPath": "amount.fraction", "centsPath": "amount.cents" }` |
| Crédito quando `type == "in"` | `"type": { "creditWhen": { "path": "type", "equals": "in" } }` |
| Crédito por sinal do amount | `"type": { "creditWhenSign": ">=0" }` |
| Descrição com conector opcional | `"description": { "template": "{title}[ — {description}]" }` |
| Descrição com prefixo condicional | `"description": { "template": "{title}", "prefixes": [{ "when": { "path": "kind", "equals": "pix" }, "value": "Pix · " }] }` |

## Paginação rápida

| Caso | JSON |
|---|---|
| Sem paginação | omitir `pagination` |
| Total de páginas no response | `"pagination": { "type": "page-count", "totalPath": "totalPages", "max": 100 }` |
| Cursor next | `"pagination": { "type": "cursor", "nextPath": "next", "max": 100 }` |
