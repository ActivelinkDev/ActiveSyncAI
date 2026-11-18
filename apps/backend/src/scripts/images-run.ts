/**
 * Envia as imagens em falta para a Shopify (duas fases: enviar e confirmar).
 *
 *   npm run images:run -- --dry-run           só conta o que falta
 *   npm run images:run -- --active --limit 20 só produtos ativos, no máximo 20
 *   npm run images:run                        todos os produtos com imagens por confirmar
 *
 * Os ativos vão sempre primeiro. Não correr ao mesmo tempo que um sync.
 */
import "dotenv/config";
import { ensureSupridesTable } from "../db/migrate-suprides";
import { getSqlite } from "../db/sqlite";
import { readAllProducts } from "../suprides/api/shopify-read";
import { runImagesSync, type ImageTarget } from "../services/images-sync";

const ts = () => new Date().toLocaleTimeString("pt-PT");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const onlyActive = process.argv.includes("--active");
  const limit = Number(arg("--limit") || 0);
  ensureSupridesTable();

  console.log(`${ts()} — a ler a loja…`);
  const status = new Map((await readAllProducts()).map(p => [p.productId, p.status]));
  const rows = getSqlite().prepare(
    `SELECT sku, shopify_product_id AS id, images FROM suprides_products
     WHERE shopify_product_id IS NOT NULL AND images_synced = 0 AND images IS NOT NULL`
  ).all() as { sku: string; id: number; images: string }[];

  let targets: (ImageTarget & { active: boolean })[] = rows
    .filter(r => status.has(r.id))
    .map(r => ({ sku: r.sku, productId: r.id, urls: JSON.parse(r.images) as string[], active: status.get(r.id) === "ACTIVE" }))
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

main().catch(e => { console.error("ERRO:", e?.message ?? e); process.exit(1); });
