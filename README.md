# Extratus

Extensão de navegador que exporta extratos em **OFX** e **CSV** de bancos e fintechs brasileiros — incluindo casos não cobertos por Open Finance / Pluggy (Mercado Pago "porquinho", carteiras de cripto, contas legacy, fintechs menores).

> **Status:** alpha. Arquitetura no lugar; primeira recipe (Mercado Pago) em descoberta.

## Princípios

- **Sem credencial armazenada.** A extensão roda no navegador do dono da conta, lendo o DOM da página enquanto o usuário está logado normalmente. Nada de senha viaja pra fora.
- **Sem backend.** A extração e a geração do arquivo acontecem inteiramente na máquina do usuário. Nenhuma telemetria, nenhum servidor.
- **Recipes versionadas.** Cada site suportado é um arquivo TypeScript em [`src/recipes/`](src/recipes/). Comunidade contribui via PR.
- **Output padrão.** OFX 1.0.2 SGML (o dialeto que importadores BR aceitam) e CSV. O arquivo cai na sua pasta de Downloads — você importa onde quiser (Afino, GnuCash, Excel, YNAB).

## Como funciona

1. Usuário navega no site do banco e fica logado normalmente
2. Extensão detecta o site e mostra "Mercado Pago detectado" no popup
3. Usuário clica "Exportar OFX" → recipe lê o DOM, motor normaliza datas (BRT) e valores (Decimal), gerador monta SGML
4. Download dispara — usuário importa onde quiser

## Desenvolvimento

```bash
npm install
npm run build           # gera dist/
```

No Chrome:

1. Abrir `chrome://extensions/`
2. Ligar **modo desenvolvedor** (toggle no canto superior direito)
3. Clicar **carregar sem compactação** e selecionar `dist/`

```bash
npm run dev             # rebuild + HMR (recarregue a extensão após cada mudança)
npm test                # vitest (gerador OFX, normalização)
npm run lint            # biome
```

## Arquitetura

```
src/
├── manifest.json              # MV3 manifest
├── background/
│   └── service-worker.ts      # recebe mensagens, chama gerador, dispara download
├── content/
│   └── content-script.ts      # roda na página do banco, executa recipes
├── popup/
│   ├── popup.html             # UI mínima
│   └── popup.ts               # detecta recipe da aba ativa, dispara export
├── engine/
│   ├── recipe-runner.ts       # orquestra detectAccount + extract de uma recipe
│   ├── normalize.ts           # parseBrDate, parseBrAmount, formatOfxDateTime, ser/des
│   ├── ofx-generator.ts       # OFX 1.0.2 SGML (bank + credit card)
│   └── csv-generator.ts       # CSV simples com header BR
├── recipes/
│   ├── _schema.ts             # interface Recipe
│   ├── _registry.ts           # auto-registro
│   └── mercadopago.com.br.ts  # primeira recipe (em descoberta)
└── types/
    └── transaction.ts         # NormalizedTransaction, ExtractionResult
```

Toda recipe recebe `{ document, window }` e retorna `NormalizedTransaction[]`. Datas em `Date` (UTC) e valores em `Decimal` (decimal.js) — float está banido em qualquer caminho monetário.

## Contribuindo com uma recipe

Detalhes em [docs/recipe-format.md](docs/recipe-format.md). TL;DR:

1. Crie `src/recipes/<dominio>.ts` exportando um `Recipe`
2. Registre em [`src/recipes/_registry.ts`](src/recipes/_registry.ts)
3. Adicione o domínio em `host_permissions` e em um bloco `content_scripts.matches` no [`src/manifest.json`](src/manifest.json)
4. Teste exportando e importando o arquivo gerado

## Importar arquivo OFX

Tem um OFX que o próprio app/site do banco já mandou (Nubank PF, Itaú, BB, Caixa)? Solte no popup em **"Importar arquivo OFX"** — o Extratus parseia o SGML mesmo mal-formado, decodifica `windows-1252` corretamente, gera FITID estável quando o original veio sem, e devolve um OFX 1.0.2 padronizado que qualquer importador aceita. Sem precisar de recipe.

Implementação em [src/parsers/ofx/](src/parsers/ofx/). Detalhes da spec em [docs/recipe-spec-v1.md §4.4](docs/recipe-spec-v1.md).

## Roadmap próximo

- Mercado Pago — atividade + porquinho/rendimento (em descoberta)
- `Source: 'pdf-upload'` — fatura de cartão (Nubank, Itaú, Bradesco, Inter, C6, Porto) via porte do [banksheet](https://github.com/tio-ze-rj/banksheet)
- Nubank PJ (Nu Empresas) — recipe REST/SSR; ver [docs/recipes/nubank-discovery.md](docs/recipes/nubank-discovery.md)
- Inter, C6, BTG Pactual conta corrente
- AI fallback opcional para descoberta automática de selectors quando recipe não existe (v2)

## Licença

MIT — veja [LICENSE](LICENSE).
