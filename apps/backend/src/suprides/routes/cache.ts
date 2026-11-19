import { Router, Request, Response } from "express";
import { runSupridesImport, isImportRunning } from "../services/import-suprides";
import { getMssql } from "../../db/mssql";
import { sql } from "kysely";

const router = Router();

// GET /api/suprides/cache/sync  — API Suprides → SQL Server (SSE). Lógica em services/import-suprides.ts
router.get("/sync", (req: Request, res: Response) => {
  if (isImportRunning()) {
    res.status(409).json({ error: "Importação já em curso" });
    return;
  }

  // Se o cliente fechar a janela a importação continua; só deixa de enviar eventos.
  const send = (data: { type: string }) => {
    if (res.destroyed) return;
    if (!res.headersSent) {
      if (data.type === "error") return;
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders();
    }
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const allowLargeRemoval = req.query.allowLargeRemoval === "1";
  runSupridesImport(send, { allowLargeRemoval })
    .catch(err => {
      if (!res.headersSent && !res.destroyed) res.status(err?.code === "BUSY" ? 409 : 500).json({ error: err.message });
    })
    .finally(() => { if (!res.writableEnded) res.end(); });
});

// GET /api/suprides/cache/stats
router.get("/stats", async (_req: Request, res: Response) => {
  try {
    const { total, updated } = await getMssql().selectFrom("products")
      .select([sql<number>`COUNT(*)`.as("total"), sql<Date | null>`MAX(updated_at)`.as("updated")])
      .executeTakeFirstOrThrow();
    res.json({ total_in_db: total, cache_file_exists: false, cached_at: updated?.getTime() ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Erro interno" });
  }
});

export default router;
