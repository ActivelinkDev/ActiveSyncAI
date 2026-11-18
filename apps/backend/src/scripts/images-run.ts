/**
 * Envia as imagens em falta para a Shopify (duas fases: enviar e confirmar).
 *
 *   npm run images:run -- --dry-run           só conta o que falta
 *   npm run images:run -- --active --limit 20 só produtos ativos, no máximo 20
 *   npm run images:run                        todos os produtos com imagens por confirmar
 *   npm run images:run -- --recheck           revê também os já marcados (ex.: ícones genéricos da Suprides)
 *
 * Os ativos vão sempre primeiro. Não correr ao mesmo tempo que um sync.
 */
import "dotenv/config";
import { withConnectionSettings } from "../suprides/repositories/store";
import { closeMssql } from "../db/mssql";
import { readAllProducts } from "../suprides/api/shopify-read";
import { runImagesSync, loadImageRows, type ImageTarget } from "../services/images-sync";

const ts = () => new Date().toLocaleTimeString("pt-PT");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const onlyActive = process.argv.includes("--active");
  const limit = Number(arg("--limit") || 0);
  const recheck = process.argv.includes("--recheck");

  console.log(`${ts()} — a ler a loja…`);
  const status = new Map((await readAllProducts()).map(p => [p.productId, p.status]));
  const rows = (await loadImageRows()).filter(r => r.images && (recheck || r.images_synced === 0));

  let targets: (ImageTarget & { active: boolean })[] = rows
    .filter(r => status.has(r.shopify_product_id!))
    .map(r => ({ sku: r.sku, productId: r.shopify_product_id!, urls: JSON.parse(r.images!) as string[], active: status.get(r.shopify_product_id!) === "ACTIVE" }))
    .filter(t => t.urls.length > 0)
    .sort((a, b) => Number(b.active) - Number(a.active));
  if (onlyActive) targets = targets.filter(t => t.active);
  if (limit > 0) targets = targets.slice(0, limit);

  console.log(`${ts()} — ${targets.length} produtos a verificar (${targets.filter(t => t.active).length} ativos)${dryRun ? " — simulação" : ""}`);
  const r = await runImagesSync(targets, { dryRun, log: m => console.log(`${ts()} — ${m}`) });
  console.log(JSON.stringify({ ...r, errors: r.errors.length }, null, 1));
  for (const e of r.errors.slice(0, 10)) console.log(`  erro ${e.sku}: ${e.error.slice(0, 200)}`);
  console.log(`${ts()} — fim`);
}

withConnectionSettings(main).catch(e => { console.error("ERRO:", e?.message ?? e); process.exitCode = 1; }).finally(closeMssql);
