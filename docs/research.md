# Pesquisa: ecossistema de extratores BR

Levantamento (maio/2026) dos projetos open-source que extraem ou convertem extratos bancários brasileiros, com análise dos mais relevantes e mapa do que vale ser portado para o Extratus.

## Mapa por categoria

### A. Scrapers de banco BR (login + dados)

| Tipo | Projeto | Estado |
|---|---|---|
| API mobile reversa | [andreroggeri/pynubank](https://github.com/andreroggeri/pynubank), [fmsouza/nubank-api](https://github.com/fmsouza/nubank-api), [thiagormagalhaes/nubank-nodejs](https://github.com/thiagormagalhaes/nubank-nodejs) | Quebrado desde 2023 (Nubank exigiu face ID) |
| Scraper headless | [henriquebastos/itauscraper](https://github.com/henriquebastos/itauscraper) (mobile site), [victorl2/itauscraper](https://github.com/victorl2/itauscraper) (Selenium), [viniciusgava/itauscraper](https://github.com/viniciusgava/itauscraper) (Puppeteer) | Inativos / instáveis |
| Userscript no DOM | [marlonanjos/itaucard-ofx](https://github.com/marlonanjos/itaucard-ofx) | Funcional, MV2; modelo direto do Extratus |
| Scraper headless | [andreroggeri/pybradesco](https://github.com/andreroggeri/pybradesco) (Playwright), [anderson89marques/bbscraper](https://github.com/anderson89marques/bbscraper) | Funcionais |
| API home broker | [mygs/btg-hb-api](https://github.com/mygs/btg-hb-api), [PythonicCafe/mercados](https://github.com/PythonicCafe/mercados) | Foco trading / dados de mercado |

### B. Parsers de PDF de extrato

| Projeto | Bancos | Notas |
|---|---|---|
| [tio-ze-rj/banksheet](https://github.com/tio-ze-rj/banksheet) | Nubank, Itaú, Bradesco, Inter, C6, Porto | TS + plugin estático, regex puro |
| [turicas/nubank-to-csv](https://github.com/turicas/nubank-to-csv) | Nubank fatura | Python/regex |
| [wendersoon/pdf_para_ofx_mercado_pago](https://github.com/wendersoon/pdf_para_ofx_mercado_pago) | Mercado Pago | Flask |
| [charllyslima/C6-bank-automation](https://github.com/charllyslima/C6-bank-automation) | C6 | Python + MySQL |
| [electrovir/statement-parser](https://github.com/electrovir/statement-parser) | USAA, Chase, Citi, PayPal | TS + plugin |

### C. Conversores CSV/XLSX/PDF → OFX/QIF

| Projeto | Direção | Notas |
|---|---|---|
| [reubano/csv2ofx](https://github.com/reubano/csv2ofx) | CSV → OFX/QIF | 30 mappings; referência canônica |
| [weckx/csv2ofx-original](https://github.com/weckx/csv2ofx-original) | Banco Original | Mapping específico |
| [eholic/ofxer](https://github.com/eholic/ofxer) | CSV → OFX | Outra implementação |

### D. Parsers OFX (utilitários)

| Projeto | Linguagem |
|---|---|
| [bradenmacdonald/ofx-js](https://github.com/bradenmacdonald/ofx-js) | JS puro, browser+node, 200 linhas, zero deps |
| [Fabiopf02/ofx-data-extractor](https://github.com/Fabiopf02/ofx-data-extractor) | TS, modos strict/lenient |
| [hublawbr/ofx-parser](https://github.com/hublawbr/ofx-parser) | TS leve |
| [chilts/node-ofx](https://github.com/chilts/node-ofx) | Node CommonJS |

### E. Bibliotecas de PDF/XLSX no navegador

- [Mozilla pdf.js](https://mozilla.github.io/pdf.js/) + [pdf.js-extract](https://www.npmjs.com/package/pdf.js-extract)
- [unjs/unpdf](https://github.com/unjs/unpdf)
- [pdf2json](https://www.npmjs.com/package/pdf2json) — preserva coordenadas
- [SheetJS/xlsx](https://github.com/SheetJS/sheetjs)

### F. Frameworks / hubs

- [shuckster/OBIS](https://github.com/shuckster/OBIS) — framework JS para HSBC UK
- [jbms/finance-dl](https://github.com/jbms/finance-dl) + [jbms/beancount-import](https://github.com/jbms/beancount-import)
- [moacyrricardo/bank-importer](https://github.com/moacyrricardo/bank-importer) — Nubank+Itaú reader
- [useVenice/venice](https://github.com/useVenice/venice) — conectores estilo Plaid

### G. Open Finance regulado (não cobre o nicho do Extratus)

- [Pluggy](https://www.pluggy.ai/) e [Belvo](https://belvo.com/) — agregadores comerciais. Não cobrem MP "porquinho", contas legacy, cripto, PJ small, cooperativas.

---

## Análise dos 6 repos clonados

Repositórios baixados em `/tmp/extratus-research/` para inspeção profunda.

### banksheet (PDF plugin BR)

- **Cobertura:** apenas **cartão de crédito** dos 6 bancos BR.
- **Arquitetura:** plugin estático (`packages/core/src/plugins/index.ts`), cada banco é uma pasta com `detect(text): boolean` e `parse(text): Transaction[]`. Pipeline: `pdfjs-dist/legacy` extrai texto sem coordenadas, separa páginas com sentinela `\n--- PAGE BREAK ---\n`, plugin recorta seção por marcador textual e itera linha-a-linha com regex.
- **Schema interno:** `{date: string YYYY-MM-DD, description, amount: number, currency, type}` — **sem id estável** (re-imports duplicam).
- **Edge cases tratados:** parcelamento `NN/NN`, IOF como linha sintética (Itaú), internacional via lookahead de 5 linhas, dedup "próximas faturas", inferência cross-year via mês de fechamento (C6/Porto).
- **Limitações:** sem cobertura de conta-corrente, sem multi-moeda real (tudo BRL), sem OFX, regex frágeis (Bradesco depende de allowlist hard-coded de 50 cidades), Itaú usa `getFullYear()` (quebra em faturas antigas).
- **Portável:** regex de parcela (`itau-cartao/index.ts:21`), helper `parseBRAmount` (`BR/utils.ts:9-11`), dicionário `PT_MONTHS`, inferência de ano por mês de fechamento (`c6-cartao/index.ts:65-72`), pattern de lookahead para internacionais.

### itaucard-ofx (DOM → OFX)

- **Tipo:** extensão Chrome MV2 que roda na página de impressão da fatura Itaucard (`#idImpressaoOuPDF`).
- **Estratégia DOM:** discrimina blocos de transação pelo atributo `summary` da `<table>` (string PT-BR de acessibilidade); cada bloco usa layout de colunas próprio.
- **Bugs conhecidos no original:** `mes.toString.length` (deveria ser `mes.toString().length`), `chargeDetails[N].textContent.trim` (sem `()`), `replace('.', '')` quebra acima de R$ 999.999,99, FITID sequencial (causa duplicação em re-import), `MEMO` sem escape XML, `getFullYear()` hard-coded.
- **Geração OFX:** SGML 1.0.2; trata cartão como `BANKMSGSRSV1`+`ACCTTYPE=CHECKING` (compatibilidade BR clássica) com `BANKID=0341` hard-coded.
- **Portável:** mapa `summary → kind` (eng. social PT-BR), seletor de identificação do cartão (`caption > strong`), regex de parcela `/(\d{2})\/(\d{2})/`, normalização BR (corrigir bugs).

### csv2ofx (mappings Python)

- **Schema de mapping:** ~25 chaves consumidas por `Content.get(name, trxn)`. Aceita string ou callable indistintamente.
- **Mappings prontos (30):** default, custom, mint (3 variantes), mintapi, amazon, n26, ingesp, ingdirect, boursorama, gls, rabobank, abnamro, capitalone, eqbank, creditunion, exim, mdb, outbank, payoneer, pcmastercard, schwabchecking, starling, stripe, ubs, ubs-ch-fr, xero, yodlee.
- **Estratégias de tipo (credit/debit):** sinal do amount, coluna direta, existência de coluna ("Debit"/"Credit" pareadas), substring na descrição, tipo fixo, fallback por sinal.
- **Geração OFX:** SGML 1.0.2; agrupa transações por conta (`gen_groups` em `ofx.py:737-743`); múltiplas contas no mesmo arquivo com `<STMTRS>` consecutivos; `<FITID>` default = `md5(date+amount+payee+memo)`; modo `--ms-money` adiciona preâmbulo `OFXHEADER:100/VERSION:102/CHARSET:1252`.
- **Investimentos:** `<INVSTMT>`/`<INVTRAN>` com `shares`/`symbol`/`price`/`category` derivando `Buy/Div/Int/Sell/ReinvDiv`.
- **Lacunas no `_schema.ts` do Extratus:** writer OFX, `payee` separado de `description`/`memo`, `checkNum`, `balance` por-tx, modo split/double-entry, `filter` por linha (filterOut), preâmbulo MS Money, suporte a investimento.
- **Pontos fortes do Extratus:** toda a camada de extração (Source/Pagination/Iterate/WindowedHistory), schema declarativo serializável em JSON, path language (`path`/`paths`/`template`/`[*]`), `DiscoveredAccountSpec`.

### ofx-js (parser SGML/XML)

- **API:** uma função `parse(data: string): Promise<object>`.
- **SGML+XML:** tenta XML estrito, falha → aplica `sgml2Xml` (regex que fecha tags faltantes) e tenta de novo.
- **Robustez para OFX BR:** trata `<TAG>valor` sem fechamento (caso clássico do Itaú/BB/Caixa), mas **não trata** `&` não escapado, charset `windows-1252`, entidades numéricas (`&#231;`) ou tags compostas com ponto.
- **Tamanho:** 5,7 KB, zero deps, ESM/CJS único arquivo, MIT.
- **Recomendação:** **portar internamente** para `src/parsers/ofx/` (200 linhas, fork sem fricção). Estender `sgml2Xml` para charset/entidades BR.

### OBIS (framework HSBC UK)

- **Modelo:** dual bookmarklet/extensão; banco = pasta `src/plugins/<name>/` com `plugin.json` (metadados) + `plugin.js` (código com state-chart Statebot) + `api/{accounts,statements,transactions}.js` (JMESPath para parsear JSON).
- **Paginação:** **ausente como abstração**. Quebra histórico em janelas anuais hard-coded e dispara em paralelo via `makePromisePool(3)`.
- **Output:** OFX 1.0.2 + QIF + CSV (RFC4180) + JSON + MIDATA + HSBC-CSV, todos zipados via `fflate`.
- **FITID:** `md5(date+account+payee+memo+amount)` — frágil para duplicatas idênticas no mesmo dia.
- **Ideias roubáveis:** (1) saída multi-formato zipada, (2) `buildHeadersFromSiteConfig()` lê headers da DOM via seletor declarativo, (3) `makePromisePool(limit)` para paralelizar windowedHistory respeitando rate-limit, (4) state-chart explícito do pipeline para UX de progresso.
- **Veredicto:** inspiração pontual; arquitetura do Extratus já é mais avançada (JSON declarativo vs imperativo, paginação tipada).

### itauscraper (BFF Itaú)

- **Realidade:** **não é BFF JSON** — é HTML scraping puro do site mobile legado `ww70.itau.com.br/M/*` (ASP.NET WebForms) com User-Agent forjado.
- **Auth:** `requests.Session` mantém cookies ASP.NET; login via POST de form com `__VIEWSTATE`/`__EVENTVALIDATION`/CPF/agência/conta/senha em texto puro.
- **Cobertura:** conta corrente (90 dias máximo) + cartão de crédito (resumo + lançamentos). Sem poupança, investimento, PJ.
- **Atualidade:** **morto desde 2017** (último commit `eed27f3 2017-09-18`). Issue #11 confirma quebra; PRs abertos só Dependabot.
- **Conclusão para o Extratus:** o repositório **não serve** como mapa de endpoints da BFF moderna. Para escrever a recipe Itaú real, precisa abrir o internet banking moderno logado, espionar o painel Network do DevTools, e copiar URLs/headers de fato. Esqueleto JSON proposto pelo agente está em `/tmp/extratus-research/itauscraper/` (placeholders `TODO.itau.com.br`).

---

## Padrões transversais úteis

1. **Conversor BR de valor** — `parseFloat(s.replace(/\./g,'').replace(',','.'))` aparece em todos. O `parseBrAmount` do Extratus já cobre.
2. **Inferência de ano por mês de fechamento** — `txnYear = txnMonth > closingMonth ? statementYear-1 : statementYear`. Resolve fatura de janeiro com compra de dezembro.
3. **FITID via hash** — csv2ofx e OBIS usam `md5(date+amount+payee+memo)` como fallback. Vale o Extratus cair nisso quando `IdField.template` não produz id.
4. **Múltiplas fontes para o mesmo campo** — `DateField.paths[]` já existe; estender para `AmountField` e `DescriptionField`.
5. **Detecção por CNPJ** — banksheet usa `CNPJ\s*\d{2}\.\d{3}\.\d{3}` como sinal mais robusto que nome comercial. Útil para `pdf-upload` detect().

---

## Recomendação por categoria

| Necessidade | Solução |
|---|---|
| Re-normalizar OFX que o banco já cospe quebrado | Portar `ofx-js` interno para `src/parsers/ofx/` + novo `Source: 'ofx-upload'` |
| Suportar PDF de fatura de cartão BR | Setup `pdfjs-dist` + novo `Source: 'pdf-upload'` + porte das regex do banksheet (1 plugin por vez) |
| Suportar XLSX (Mercado Pago entrega XLSX) | SheetJS + `Source: 'xlsx-upload'` com mapping coluna→field estilo csv2ofx |
| Capturar OFX/CSV nativo do Itaú/Inter quando o site oferece | `Source: 'download-intercept'` via `chrome.webRequest` |
| Schema de mapping de upload | Inspirado em csv2ofx, mas declarativo JSON (não Python callable) |
| Writer OFX completo | Comparar geração atual com `csv2ofx/ofx.py`; adicionar `payee/checkNum/balance`, modo split, MS Money preamble, CCSTMT vs BANKMSGSRSV1 |
| Multi-formato de saída | OBIS pattern: gerar OFX+CSV+QIF+JSON, oferecer download zipado |

---

## Itens fora do escopo

- **Login automation / API mobile reversa** (pynubank, itauscraper). Quebra com 2FA/biometria e queima a confiança do produto. O posicionamento "sem credencial" é o moat.
- **Backend de agregação tipo Pluggy/Belvo**. Já existe, regulado, tem rede comercial. Brigar nesse mercado destrói o "sem servidor".
