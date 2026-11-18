/**
 * Arranque do histórico de preços: percorre as cópias da loja (data/snapshots) por ordem de data
 * e regista as mudanças de preço. A primeira cópia conta como INITIAL; as seguintes como SNAPSHOT.
 * Pode correr mais do que uma vez: só grava o que mudou face ao último preço conhecido.
 *   npm run prices:seed
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { dataPath } from "../utils/data-dir";
import { loadSnapshot } from "../services/shopify-snapshot";
import { recordShopPrices, lastRecordedAt } from "../services/price-history";
import { closeMssql, mssqlConfigured } from "../db/mssql";

(async () => {
  if (!mssqlConfigured()) { console.error("SQL Server não configurado (MSSQL_* no .env)."); process.exit(1); }
  const dir = dataPath("snapshots");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^shopify-.*\.json$/.test(f)) : [];
  const snaps = files.map(f => ({ f, s: loadSnapshot(path.join(dir, f)) }))
    .sort((a, b) => a.s.takenAt.localeCompare(b.s.takenAt));
  let total = 0;
  try {
    const last = await lastRecordedAt();
    if (last) console.log(`Histórico já tem registos até ${last.toISOString()}; só entram cópias mais recentes.`);
    for (const { f, s } of snaps) {
      if (last && new Date(s.takenAt).getTime() <= last.getTime()) continue;
      const r = await recordShopPrices(s.products, new Date(s.takenAt), "SNAPSHOT");
      total += r.changes;
      console.log(`${f} (${s.takenAt}): ${s.products.length} produtos, ${r.changes} mudança(s) registada(s)`);
    }
    console.log(`Fim: ${total} registo(s) no histórico.`);
  } catch (e: any) { console.error("Falhou:", e?.message ?? e); process.exitCode = 1; }
  finally { await closeMssql(); }
})();
