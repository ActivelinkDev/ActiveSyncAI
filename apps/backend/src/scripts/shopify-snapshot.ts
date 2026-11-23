/**
 * Cópia de segurança (SÓ LEITURA) do estado atual dos produtos na Shopify:
 * estado, título, descrição, preço, preço riscado, custo, EAN, peso, coleções e
 * metafield custom.stock_status.
 *
 *   npm run shopify:snapshot
 *
 * Grava em <DATA_DIR>/snapshots/shopify-AAAAMMDD-HHMMSS.json (guarda as últimas 14).
 */
import "dotenv/config";
import { withConnectionSettings } from "../suprides/repositories/store";
import { closeMssql } from "../db/mssql";
import { takeSnapshot } from "../services/shopify-snapshot";

withConnectionSettings(() => takeSnapshot({ reason: "manual", onProgress: n => process.stdout.write(`\r${n} produtos lidos…`) }))
  .then(({ file, snapshot }) => console.log(`\nCópia guardada: ${file} (${snapshot.products.length} produtos)`))
  .catch(e => { console.error("\nERRO:", e?.response?.data ?? e?.message ?? e); process.exitCode = 1; }).finally(closeMssql);
