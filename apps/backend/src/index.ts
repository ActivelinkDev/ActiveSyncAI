import "dotenv/config";
import express from "express";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import logsRouter from "./routes/logs";
import dashboardRoutes from "./routes/dashboard";
import systemStatsRouter, { systemInfoRouter } from "./routes/system-stats";
import supridesRouter from "./suprides/index";
import campaignsRouter from "./routes/campaigns";
import { migrateMssql } from "./db/mssql-migrations";
import { startCampaignTicker } from "./services/campaign-ticker";
import { closeMssql } from "./db/mssql";
import { schedulerRouter, startScheduler } from "./services/scheduler";
import { DATA_ROOT } from "./utils/data-dir";
import { effectiveSubnets, ipFilter, isLoopback } from "./security/ip-filter";
import { audit } from "./security/audit";
import {
  configureSecurity, securityHeaders, requireSession, requireSameOrigin,
  auditDangerousActions, errorHandler,
} from "./security/middleware";
import { withConnectionSettings } from "./suprides/repositories/store";
import authRouter from "./security/auth-routes";
import { loadAccount } from "./security/password";
import { secretsKeyConfigured } from "./security/secret-box";
import { installCrashAlerts, alertsConfigured } from "./services/alerts";

installCrashAlerts();

/* ── Configuração de rede ──────────────────────────────────────────────
 * TLS_PFX (+ TLS_PFX_PASSPHRASE) ou TLS_CERT + TLS_KEY → HTTPS.
 * Sem TLS, só se aceita escutar no próprio PC (desenvolvimento).
 */
const PORT = Number(process.env.PORT || 3004);
const tls = (() => {
  const pfx = process.env.TLS_PFX, cert = process.env.TLS_CERT, key = process.env.TLS_KEY;
  if (pfx) return { pfx: fs.readFileSync(pfx), passphrase: process.env.TLS_PFX_PASSPHRASE || undefined };
  if (cert && key) return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  return null;
})();
const HOST = process.env.HOST || (tls ? "0.0.0.0" : "127.0.0.1");
if (!tls && !isLoopback(HOST) && HOST !== "localhost") {
  console.error(`[segurança] Sem HTTPS configurado (TLS_PFX ou TLS_CERT/TLS_KEY), o backend só pode escutar no próprio PC. HOST=${HOST} recusado.`);
  process.exit(1);
}
const { subnets, source: subnetSource } = effectiveSubnets(process.env.ALLOWED_SUBNETS);
configureSecurity({ secureCookies: !!tls });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false); // o IP do cliente é sempre o do socket
app.set("case sensitive routing", true); // /API/... não pode contornar as camadas de /api/...

// 1. Rede: só IPs das sub-redes permitidas (ou o próprio PC).
app.use(ipFilter(subnets, (ip, req) => audit("access.denied.ip", { ip, detail: `${req.method} ${req.path}` })));
// 2. Cabeçalhos de segurança.
app.use(securityHeaders());
app.use(morgan(":remote-addr :method :url :status :response-time ms"));
// 3. Tamanho máximo dos pedidos.
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// 4. Sessão obrigatória em /api (exceto login), origem obrigatória em escritas,
//    registo das ações sensíveis.
app.use(requireSameOrigin());
app.use(requireSession());
app.use(auditDangerousActions());
app.use("/api", (_req, _res, next) => withConnectionSettings(next));

app.use("/api/auth",         authRouter);
app.use("/api/logs",         logsRouter);
app.use("/api/dashboard",    dashboardRoutes);
app.use("/api/system/stats", systemStatsRouter);
app.use("/api/system/info",  systemInfoRouter);
app.use("/api/suprides",     supridesRouter);
app.use("/api/scheduler",    schedulerRouter);
app.use("/api/campanhas",    campaignsRouter);
app.use("/api", (_req, res) => { res.status(404).json({ error: "not_found" }); });

// 5. Interface (Angular) servida pelo próprio backend.
const FRONTEND_DIR = path.resolve(process.env.FRONTEND_DIST || path.join(__dirname, "../../frontend/dist/frontend/browser"));
const indexHtml = path.join(FRONTEND_DIR, "index.html");
if (fs.existsSync(indexHtml)) {
  app.use(express.static(FRONTEND_DIR, { index: false, dotfiles: "deny", maxAge: "1h" }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml);
  });
} else {
  console.warn(`[interface] não encontrada em ${FRONTEND_DIR} (compilar o frontend).`);
}

app.use(errorHandler());

const server = tls
  ? https.createServer({ ...tls, minVersion: "TLSv1.2" }, app)
  : http.createServer(app);
server.headersTimeout = 30_000;
server.requestTimeout = 0; // SSE de longa duração

async function start() {
  await migrateMssql();
  if (!await loadAccount()) console.warn("[segurança] Conta não configurada — correr: npm run auth:set-password");
  if (!secretsKeyConfigured()) console.warn("[segurança] SECRETS_KEY não definida: as credenciais ficam em claro na base de dados. No servidor, correr: npm run secrets:init");
  server.listen(PORT, HOST, () => {
    console.log(`Backend ON : ${tls ? "https" : "http"}://${HOST}:${PORT}`);
    console.log(`Dados em   : ${DATA_ROOT}`);
    console.log(`Acesso     : ${subnetSource === "config" ? `${subnets.length} sub-rede(s) configurada(s) + este PC` : "redes internas (10.x, 172.16-31.x, 192.168.x) + este PC"}`);
    console.log(`Alertas    : ${alertsConfigured() ? "email ativo" : "email não configurado (só no log)"}`);
    startScheduler();
    startCampaignTicker();
  });
}

start().catch(async err => {
  console.error("[arranque] Falhou a inicialização do SQL Server:", err.message);
  await closeMssql();
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});
