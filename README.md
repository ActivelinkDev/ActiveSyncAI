# ActiveSyncAI

Middleware que importa o catálogo de fornecedores (Suprides) para uma base de dados SQL Server centralizada, calcula preços (margem por coleção + IVA + arredondamento), enriquece os produtos com tags geradas por IA e publica-os numa loja Shopify (produtos, preço, stock, imagens, coleções e menu).

## Stack

| App | Tecnologia |
|---|---|
| `apps/backend` | Node.js + Express 5 + TypeScript, SQL Server 2022 (Kysely e Tedious) |
| `apps/frontend` | Angular 20 (componentes standalone) + Angular Material |
| `apps/electron` | Electron 30 (janela desktop opcional) |

Integrações: Shopify Admin API, API Suprides, OpenAI.

## Instalação

Requisitos: Node.js LTS e npm. Cada app tem o seu `package.json`:

```bash
cd apps/backend  && npm install
cd ../frontend   && npm install
cd ../electron   && npm install   # só se for usar a janela desktop
```

Copiar `apps/backend/.env.example` para `apps/backend/.env` e preencher.

## Comandos

### Backend (`apps/backend`)
| Comando | Ação |
|---|---|
| `npm run dev` | Servidor em modo desenvolvimento (porta 3004) |
| `npm run build` / `npm start` | Compilar e arrancar a versão compilada |
| `npm run db:migrate` | Aplica as migrações SQL pendentes. O backend também as aplica antes de aceitar pedidos. |
| `npm run db:import-legacy` | Importação inicial de SQLite e JSON para uma base vazia. Requer Node 22.13+ com `node:sqlite`. |
| `npm run sync:run -- --dry-run --snapshot <ficheiro>` | Gera um plano com o catálogo SQL e uma cópia local da loja. |
| `npm run shopify:snapshot` | Cópia do estado atual da loja para JSON |

### Frontend (`apps/frontend`)
| Comando | Ação |
|---|---|
| `npm start` | `ng serve` (porta 4200) |
| `npm run build` | Build de produção |

### Electron (`apps/electron`)
| Comando | Ação |
|---|---|
| `npm run dev` | Janela a apontar para `localhost:4200` |
| `npm run build` | Instalador Windows (NSIS) |

## Variáveis de ambiente (`apps/backend/.env`)

| Variável | Para quê |
|---|---|
| `PORT` | Porta do backend (por omissão 3004) |
| `MSSQL_SERVER`, `MSSQL_DATABASE`, `MSSQL_USER`, `MSSQL_PASSWORD` | Ligação à base central. Definir `MSSQL_INSTANCE` ou `MSSQL_PORT` conforme a instalação. |
| `DATA_DIR` | Pasta dos snapshots, planos e relatórios. Por omissão, `apps/backend/data`. |
| `AUTO_SYNC_ENABLED`, `AUTO_SYNC_TIME` | Sincronização diária automática (desligada por omissão) |
| `OPENAI_API_KEY` | Tags por IA |
| `SUPRIDES_URL`, `SUPRIDES_USER`, `SUPRIDES_PASS`, `SUPRIDES_TOKEN` | API Suprides |
| `SHOPIFY_STORE`, `SHOPIFY_PASSWORD`, `SHOPIFY_LOCATION_ID` | Loja Shopify |

As credenciais também podem ser definidas na interface (Preferências), que têm prioridade sobre o `.env`. Nunca versionar o `.env` nem a pasta `data/`.
