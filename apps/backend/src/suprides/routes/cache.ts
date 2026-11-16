import { Router, Request, Response } from "express";
import fs from "fs";
import { countProducts } from "../../repositories/suprides-cache";
import { runSupridesImport, isImportRunning } from "../services/import-suprides";
import { dataPath } from "../../utils/data-dir";

const router = Router();

// Ficheiro antigo de cache (só lido para mostrar a data em /stats).
const CACHE_PATH = dataPath("suprides", "products-cache.json");

// GET /api/suprides/cache/sync  — API Suprides → SQLite (SSE). Lógica em services/import-suprides.ts
router.get("/sync", (req: Request, res: Response) => {
  if (isImportRunning()) {
    res.status(409).json({ error: "Importação já em curso" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Se o cliente fechar a janela a importação continua; só deixa de enviar eventos.
  const send = (data: object) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const allowLargeRemoval = req.query.allowLargeRemoval === "1";
  runSupridesImport(send, { allowLargeRemoval })
    .catch(() => { /* o erro já foi enviado como evento "error" */ })
    .finally(() => { if (!res.writableEnded) res.end(); });
});

// GET /api/suprides/cache/stats
router.get("/stats", (_req: Request, res: Response) => {
  try {
    const total = countProducts();
    const exists = fs.existsSync(CACHE_PATH);
    const cachedAt = exists
      ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"))?.cachedAt ?? null
      : null;
    res.json({ total_in_db: total, cache_file_exists: exists, cached_at: cachedAt });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Erro interno" });
  }
});

export default router;
