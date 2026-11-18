import fs from "fs";
import { Router } from "express";
import { logLine } from "../utils/logger";
import { sendAlert } from "./alerts";
import { dataPath } from "../utils/data-dir";
import { runSupridesImport, isImportRunning } from "../suprides/services/import-suprides";
import { runFullShopifySync, isFullSyncRunning } from "../suprides/routes/sync";

/**
 * Sync automático diário Suprides → Shopify:
 *   1. importa o catálogo da API Suprides para o SQLite;
 *   2. se a importação correr bem, faz o sync completo para a Shopify.
 *
 * Configuração (.env):
 *   AUTO_SYNC_ENABLED=1     liga o agendamento (desligado por omissão — só o servidor o deve ter)
 *   AUTO_SYNC_TIME=03:00    hora local (HH:MM)
 */

const STATE_FILE = dataPath("scheduler-state.json");

interface RunRecord {
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  step?: "import" | "shopify";
  error?: string;
  import?: { saved: number; total: number; removed: number; removalSkipped: boolean };
  shopify?: { created: number; updated: number; errors: number; noCostHidden: number; noCostSkipped: number; cancelled?: boolean };
}

const enabled = /^(1|true|yes|sim)$/i.test(process.env.AUTO_SYNC_ENABLED ?? "");
const timeStr = (process.env.AUTO_SYNC_TIME || "03:00").trim();

let timer: NodeJS.Timeout | null = null;
let nextRunAt: Date | null = null;
let running = false;

function parseTime(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  const h = m ? Number(m[1]) : 3;
  const min = m ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return { h: 3, m: 0 };
  return { h, m: min };
}

function computeNextRun(from = new Date()): Date {
  const { h, m } = parseTime(timeStr);
  const next = new Date(from);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function loadState(): { lastRun?: RunRecord; history: RunRecord[] } {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { history: [] }; }
}

function saveRun(rec: RunRecord): void {
  const state = loadState();
  state.lastRun = rec;
  state.history = [...(state.history || []), rec].slice(-30);
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e: any) {
    logLine(`[Agendamento] Não foi possível gravar o estado: ${e?.message}`);
  }
}

export async function runDailySync(trigger: RunRecord["trigger"]): Promise<RunRecord> {
  const rec: RunRecord = { trigger, startedAt: new Date().toISOString(), ok: false };

  if (running || isImportRunning() || isFullSyncRunning()) {
    rec.error = "Já há uma importação ou sincronização em curso — execução ignorada";
    rec.finishedAt = rec.startedAt;
    logLine(`[Agendamento] ${rec.error}`);
    saveRun(rec);
    return rec;
  }

  running = true;
  logLine(`[Agendamento] Início (${trigger}): importação Suprides → sync Shopify`);
  try {
    rec.step = "import";
    const imp = await runSupridesImport();
    rec.import = imp;

    rec.step = "shopify";
    const r: any = await runFullShopifySync();
    rec.shopify = {
      created: r.created ?? 0,
      updated: r.updated ?? 0,
      errors: Array.isArray(r.errors) ? r.errors.length : 0,
      noCostHidden: r.noCost?.hidden?.length ?? 0,
      noCostSkipped: r.noCost?.skipped?.length ?? 0,
      cancelled: r.cancelled,
    };
    rec.ok = !r.cancelled;
    delete rec.step;
    logLine(
      `[Agendamento] Concluído: importados ${imp.saved}, retirados ${imp.removed}; ` +
      `Shopify ${rec.shopify.created} criados, ${rec.shopify.updated} atualizados, ${rec.shopify.errors} erros, ` +
      `${rec.shopify.noCostHidden} sem custo passados a draft`
    );
    if (r.cancelled) {
      await sendAlert("sync-cancelled", "Sync diário cancelado", `A sincronização (${trigger}) foi cancelada antes de terminar. Retomar com run-sync / --resume.`);
    } else if (rec.shopify.errors > 0) {
      const sample = (Array.isArray(r.errors) ? r.errors : []).slice(0, 10)
        .map((e: any) => `- ${e?.sku ?? "?"}: ${String(e?.error ?? e?.message ?? e).slice(0, 200)}`).join("\n");
      await sendAlert("sync-errors", `Sync diário com ${rec.shopify.errors} erro(s)`,
        `A sincronização terminou, mas ${rec.shopify.errors} produto(s) falharam.

Primeiros erros:
${sample}

Importados ${imp.saved}, retirados ${imp.removed}; atualizados ${rec.shopify.updated}.`);
    }
  } catch (err: any) {
    rec.error = err?.message ?? String(err);
    logLine(`[Agendamento] FALHOU no passo "${rec.step}": ${rec.error}`);
    await sendAlert("sync-failed", `Sync diário FALHOU (${rec.step === "import" ? "importação Suprides" : "envio para a Shopify"})`,
      `O sync (${trigger}) parou no passo "${rec.step}".

Erro: ${rec.error}

A loja não foi totalmente atualizada. Ver o registo no painel da app.`);
  } finally {
    rec.finishedAt = new Date().toISOString();
    running = false;
    saveRun(rec);
  }
  return rec;
}

function scheduleNext(): void {
  nextRunAt = computeNextRun();
  const delay = nextRunAt.getTime() - Date.now();
  timer = setTimeout(async () => {
    try { await runDailySync("schedule"); }
    finally { scheduleNext(); }
  }, delay);
  logLine(`[Agendamento] Próxima execução: ${nextRunAt.toLocaleString("pt-PT")}`);
}

export function startScheduler(): void {
  if (!enabled) {
    logLine("[Agendamento] Desligado (AUTO_SYNC_ENABLED não definido). Os syncs só correm à mão.");
    return;
  }
  if (timer) return;
  scheduleNext();
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;
}

export function getSchedulerConfig(): { enabled: boolean; time: string } {
  return { enabled, time: timeStr };
}

export const schedulerRouter = Router();

schedulerRouter.get("/status", (_req, res) => {
  const state = loadState();
  res.json({
    enabled,
    time: timeStr,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    running,
    importRunning: isImportRunning(),
    shopifySyncRunning: isFullSyncRunning(),
    lastRun: state.lastRun ?? null,
    history: (state.history || []).slice(-10),
  });
});

// Corre já o ciclo completo (importação + sync). Responde logo; o progresso vai para o log.
schedulerRouter.post("/run-now", (_req, res) => {
  if (running || isImportRunning() || isFullSyncRunning()) {
    res.status(409).json({ error: "Já há uma importação ou sincronização em curso" });
    return;
  }
  runDailySync("manual").catch(() => { /* registado em runDailySync */ });
  res.status(202).json({ ok: true, message: "Ciclo iniciado — acompanhar no log" });
});
