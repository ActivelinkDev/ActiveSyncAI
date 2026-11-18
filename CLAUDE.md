# CLAUDE.md

Orientações para o Claude Code neste repositório.

## O que é

Middleware que importa o catálogo de fornecedores (**Suprides**; a Esprinet foi retirada em 18/11) para **SQLite** local, calcula preços (margem por coleção + IVA + arredondamento), gera tags por IA (OpenAI) e publica na **Shopify** (produtos, preço, stock, imagens, coleções, menu).
Já não usa MSSQL/ERP, Haeger nem Macorlux — se encontrares referências a isso, são restos do projeto de origem.

## Comandos

```bash
# Backend (apps/backend) — porta 3004
npm run dev                # ts-node-dev com hot reload
npm run build && npm start # compilar e arrancar dist/
npx tsc --noEmit           # verificação de tipos
npm run shopify:snapshot   # estado atual da loja → JSON
npm run auth:set-password  # criar/repor a conta (no servidor, consola interativa)
npm run secrets:init       # gera SECRETS_KEY no .env e cifra credenciais em data/
npm test                   # testes (node:test)
npm run alert:test         # email de teste dos alertas (SMTP_* e ALERT_* no .env)

# Frontend (apps/frontend) — porta 4200 (proxy /api → 127.0.0.1:3004)
npm start
npm run build -- --configuration production

# Electron (apps/electron) — opcional
npm run dev
```

Cada app tem o seu `node_modules` (não há workspace npm).

## Arquitetura

```
apps/backend/src/
  index.ts                 monta routers, middleware de acesso, migrations SQLite, agendamento
  db/sqlite.ts             getSqlite() — singleton (WAL). Usar sempre este.
  db/migrate-*.ts          criação/migração de tabelas no arranque
  utils/data-dir.ts        DATA_ROOT / dataPath() — todos os caminhos de dados passam por aqui
  utils/logger.ts          logLine() → SSE /api/logs/stream (aparece no painel da interface)
  services/scheduler.ts    sync diário (importação + sync Shopify), lock partilhado
  scripts/                 comandos npm (snapshot, restauro, sync, imagens, conta, credenciais)
  suprides/                núcleo: api/ (clientes Suprides e Shopify), routes/, services/, repositories/
apps/frontend/src/app/
  ui/windows-shell/        shell: barra de título, painel de logs, barra de estado
  pages/                   funcionalidades em MatDialog (Mapeamento, Margens, Tags, Preferências…)
apps/electron/             janela frameless que carrega o frontend
```

Rotas Angular: só `/dashboard` e `/erros`; o resto são diálogos.

### Fluxos principais
| Fluxo | Endpoint |
|---|---|
| Importação Suprides → SQLite | `GET /api/suprides/cache/sync` (SSE) |
| Sync completo → Shopify | `POST /api/suprides/sync-familias` (+ `/dry-run`) |
| Sync só de estado | `POST /api/suprides/sync-stock` |
| Tags por IA | `GET /api/suprides/tags/ai-populate-*` (SSE) |
| Agendamento | `GET /api/scheduler/status`, `POST /api/scheduler/run-now` |

### Regras de negócio que não se devem partir
- Produto **sem custo** → rascunho; nunca publicado com preço inventado.
- Produto **retirado pelo fornecedor** → rascunho, nunca apagado (travão a 85 % na importação).
- Importação, sync completo e sync de stock partilham um lock (409 se já houver um a correr).
- O agendamento está **desligado por omissão** (`AUTO_SYNC_ENABLED`); só o servidor de produção o liga.

## Segurança (Etapa 3)
- Todos os pedidos: filtro pelo IP real (`ALLOWED_SUBNETS`), sessão obrigatória em `/api` (exceto login), `Origin` da própria app nas escritas. Ver `src/security/`.
- HTTPS com `TLS_PFX` (certificado de `deploy/windows/create-cert.ps1`); sem TLS só escuta em 127.0.0.1.
- CSP só da própria origem: **não** usar scripts em linha, CDNs nem Google Fonts no frontend.
- Credenciais nunca saem inteiras da API (`connection-view.ts`).

## Dados e configuração
- Tudo em `DATA_DIR` (por omissão `apps/backend/data/`): SQLite + configs JSON editáveis pela interface (que têm prioridade sobre o `.env`).
- Variáveis de ambiente: ver `apps/backend/.env.example`.
- **Nunca versionar** `.env`, `data/`, snapshots, planos do dry-run, nem domínios, tokens ou IPs reais. Correr `node tools/check-secrets.mjs` antes de cada commit.

## Cuidados
- **Não correr** `sync-familias`, `sync-stock`, `run-now` nem escrever na loja real sem confirmação explícita. Para testar, usar o dry-run e um `DATA_DIR` com uma cópia dos dados.
- TypeScript em modo `strict` nas três apps.
- Queries SQLite sempre parametrizadas.
