import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import bodyParser from "body-parser";
import logsRouter from "./routes/logs";
import dashboardRoutes from "./routes/dashboard";
import systemStatsRouter, { systemInfoRouter } from "./routes/system-stats";
import supridesRouter from "./suprides/index";
import esprinetRouter from "./esprinet/index";
import { ensureSupridesTable, ensureSupridesTagTables } from "./db/migrate-suprides";
import { ensureEsprinetTable } from "./db/migrate-esprinet";
import { schedulerRouter, startScheduler } from "./services/scheduler";
import { DATA_ROOT } from "./utils/data-dir";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));
app.use(bodyParser.json());

app.set('trust proxy', true);

/* ── Bloqueio global: só Electron / localhost / LAN ── */
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();

  const origin = req.headers.origin || "";
  const ua = String(req.headers["user-agent"] || "");

  const cfIp  = String(req.headers["cf-connecting-ip"] || "").trim();
  const xff   = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const hasProxyClientIp = !!(cfIp || xff);

  const remote = req.socket?.remoteAddress || "";
  const isRawLoopback =
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote.endsWith("::ffff:127.0.0.1");

  const isElectron = /Electron/i.test(ua);
  const allowedOrigins = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
    "http://localhost",
    "http://192.168.",
    "file://",
    "app://.",
  ];

  const isInternal =
    isElectron ||
    allowedOrigins.some(o => origin.startsWith(o)) ||
    (isRawLoopback && !hasProxyClientIp);

  if (isInternal) return next();
  return res.status(403).json({ error: "Acesso proibido" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/logs",         logsRouter);
app.use("/api/dashboard",    dashboardRoutes);
app.use("/api/system/stats", systemStatsRouter);
app.use("/api/system/info",  systemInfoRouter);
app.use("/api/suprides",     supridesRouter);
app.use("/api/esprinet",     esprinetRouter);
app.use("/api/scheduler",    schedulerRouter);

const PORT = Number(process.env.PORT || 3004);

app.listen(PORT, () => {
  console.log(`Backend ON : http://localhost:${PORT}`);
  console.log(`Dados em   : ${DATA_ROOT}`);

  try {
    ensureSupridesTable();
    ensureEsprinetTable();
    ensureSupridesTagTables();
    console.log("[sqlite] supplier tables ok");
  } catch (err) {
    console.error("[sqlite] Failed to ensure supplier tables:", err);
    process.exit(1);
  }

  startScheduler();
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});
