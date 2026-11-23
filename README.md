# ActiveSyncAI

Middleware que importa o catálogo do fornecedor (Suprides) para uma base de dados SQL Server, calcula os preços de venda, enriquece os produtos com filtros gerados por IA e mantém uma loja Shopify sincronizada: produtos, preço, estado, imagens, coleções, menu, campanhas e marcas da homepage.

A interface web é servida pelo próprio backend (HTTPS, com login) e destina-se à rede interna.

## Stack

| App | Tecnologia |
|---|---|
| `apps/backend` | Node.js + Express 5 + TypeScript; SQL Server 2022 (Kysely + Tedious) |
| `apps/frontend` | Angular 20 (componentes standalone) + Angular Material |

Integrações: Shopify Admin API (só GraphQL, versão `2026-10`), API Suprides, OpenAI, SMTP (alertas).

## Como funciona

```
API Suprides ──► importação ──► SQL Server ──► preço + coleções + filtros ──► Shopify
                                    ▲                                          │
                       interface web (diálogos)         cópia da loja antes/depois + verificação
```

1. **Importação:** lê a API Suprides e atualiza a tabela `products`. Os produtos que deixam de vir ficam marcados como retirados e nunca são apagados. Há um travão: se vierem menos de 85 % dos ativos, nada é marcado.
2. **Sync para a Shopify:** lê a loja inteira, calcula o plano e envia **só o que mudou**. O sync atualiza os produtos que já existem e não cria novos, salvo se essa opção for ligada nas Preferências.
3. **Agendamento:** importação e sync uma vez por dia (desligado por omissão; ligado só no servidor).
4. **Campanhas:** preços promocionais com início e fim, a cumprir a regra dos 30 dias (Omnibus).

### Regras de preço
- `preço = arredondar(custo ÷ (1 − margem %) × (1 + IVA))` (ou custo + valor fixo, conforme a regra). A margem vem da coleção mais específica do produto; se essa coleção não tiver regra, herda a da coleção-mãe.
- O preço nunca fica abaixo de custo + IVA.
- Fora de campanha não há preço riscado. Toda a escrita de preço fica no histórico (`price_history`).
- Produto sem custo passa a rascunho; nunca é publicado com um preço inventado.

## Instalação

Requisitos: Node.js LTS, npm e acesso a uma base SQL Server 2022 com um login próprio. Cada app tem o seu `package.json` (não há workspace npm):

```bash
cd apps/backend  && npm install
cd ../frontend   && npm install && npm run build -- --configuration production
```

Configurar o backend:

1. Copiar `apps/backend/.env.example` para `apps/backend/.env` e preencher.
2. `npm run db:check`: testa a ligação ao SQL Server e o isolamento do login.
3. `npm run auth:set-password`: cria a conta da interface (numa consola interativa).
4. `npm run secrets:init`: gera a `SECRETS_KEY` e cifra as credenciais guardadas (no servidor).
5. HTTPS: `deploy/windows/create-cert.ps1` gera a CA interna e o certificado e preenche `TLS_PFX`. Instalar o `ca.cer` nos PCs que acedem.
6. `npm run build && npm start`. As migrações da base de dados aplicam-se no arranque.

Sem HTTPS configurado, o backend só escuta em `127.0.0.1` (desenvolvimento).

## Comandos

### Backend (`apps/backend`)
| Comando | Ação |
|---|---|
| `npm run dev` | Desenvolvimento com recarregamento (porta 3004) |
| `npm run build` / `npm start` | Compilar e arrancar |
| `npx tsc --noEmit` | Verificação de tipos |
| `npm test` | Testes (`node:test`); os de integração usam só uma base `*_Test` |
| `npm run db:check` / `npm run db:migrate` | Testar a ligação / aplicar migrações |
| `npm run auth:set-password` | Criar ou repor a conta da interface |
| `npm run secrets:init` | Gerar `SECRETS_KEY` e cifrar as credenciais |
| `npm run sync:run -- --dry-run` | Simulação do sync; grava o plano em `data/plans/` |
| `npm run sync:run` | Sync real: cópia da loja antes, envio, cópia depois e verificação contra o último plano (`--resume` retoma) |
| `npm run shopify:snapshot` | Cópia do estado da loja para `data/snapshots/` |
| `npm run shopify:restore -- <cópia> [--sku A,B] [--apply]` | Mostra ou repõe diferenças a partir de uma cópia |
| `npm run sync:verify -- <plano> <cópia>` | Compara um plano com o estado real da loja |
| `npm run images:run` / `npm run images:dedupe` | Enviar imagens em falta / apagar duplicadas |
| `npm run brands:sync` / `npm run brands:logos -- <pasta>` | Marcas da homepage / logótipos (`--apply` para escrever) |
| `npm run purchase-inventory:sync [-- --apply]` | Bloquear a compra de produtos "Brevemente" / "Sob encomenda" fora do sync |
| `npm run prices:seed` | Preencher o histórico inicial de preços |
| `npm run alert:test` | Email de teste dos alertas |

Os comandos que escrevem na loja (`sync:run` sem `--dry-run`, `shopify:restore --apply`, `images:*`, `brands:* --apply`, `purchase-inventory:sync --apply`) só correm com confirmação de quem opera.

### Frontend (`apps/frontend`)
| Comando | Ação |
|---|---|
| `npm start` | `ng serve` na porta 4200, com proxy `/api` → `127.0.0.1:3004` |
| `npm run build -- --configuration production` | Build para `dist/frontend/browser`, que o backend serve |

## Segurança

- Acesso só a partir de redes internas, pelo IP real do socket (`ALLOWED_SUBNETS` para restringir mais).
- Login com sessão em cookie `HttpOnly` / `Secure` / `SameSite=Strict` e limite de tentativas.
- Escritas só com o `Origin` da própria app. CSP sem scripts em linha nem recursos externos.
- As credenciais nunca saem inteiras da API e ficam cifradas em AES-256-GCM com `SECRETS_KEY`.
- Ações que escrevem na loja ficam no registo de segurança (`security_audit`).

## Variáveis de ambiente (`apps/backend/.env`)

O modelo completo, com comentários, está em `apps/backend/.env.example`.

| Variável | Para quê |
|---|---|
| `PORT`, `HOST` | Porta (3004) e interface onde escutar |
| `TLS_PFX`, `TLS_PFX_PASSPHRASE` | Certificado HTTPS |
| `ALLOWED_SUBNETS` | Sub-redes autorizadas (vazio = qualquer rede interna) |
| `SECRETS_KEY` | Chave das credenciais cifradas |
| `FRONTEND_DIST`, `DATA_DIR` | Pasta da interface compilada; pasta de cópias, planos e relatórios |
| `MSSQL_*` | Ligação ao SQL Server (`MSSQL_TRUST_CERT=0` com certificado válido na instância) |
| `AUTO_SYNC_ENABLED`, `AUTO_SYNC_TIME` | Sync diário (desligado por omissão) |
| `CAMPAIGN_TICKER_ENABLED` | Temporizador das campanhas (desligado por omissão) |
| `SUPRIDES_*`, `SHOPIFY_*`, `OPENAI_API_KEY` | Integrações |
| `SMTP_*`, `ALERT_FROM`, `ALERT_TO` | Alertas por email em falhas |

As credenciais definidas na interface (Preferências → Ligações) têm prioridade sobre o `.env`. Ligar `AUTO_SYNC_ENABLED` e `CAMPAIGN_TICKER_ENABLED` **só numa instância**: duas instâncias a escrever na mesma loja geram conflitos.

## Estrutura

```
apps/backend/src/
  index.ts            arranque: camadas de segurança, routers, migrações, agendamento
  security/           filtro IP, sessões, login, cifra, auditoria
  db/                 ligação e migrações SQL Server
  services/           agendamento, campanhas, cópias da loja, reposição, verificação, alertas, imagens, marcas
  suprides/           importação, motor de preço, sync Shopify, menu, tags (api/, routes/, services/, repositories/)
  scripts/            comandos npm
apps/frontend/src/app/
  ui/windows-shell/   barra lateral, painel de logs
  pages/              Dashboard, Erros e diálogos (Mapeamento, Margens, Tags, Campanhas, Preferências)
deploy/windows/       certificado HTTPS interno
tools/                check-secrets.mjs (corre antes de cada commit)
```

## Contribuir

- Nunca versionar `.env`, `data/`, cópias da loja, planos, nem tokens, IPs ou domínios reais. Correr `node tools/check-secrets.mjs` antes de cada commit.
- Testar alterações ao sync com `--dry-run` antes de qualquer escrita na loja.
