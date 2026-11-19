/**
 * Marcas da homepage (metaobjects "marca" na Shopify), fora do sync.
 *
 *   npm run brands:sync              simulação: lê a loja e mostra o que mudaria
 *   npm run brands:sync -- --apply   escreve na Shopify (cria a definição "marca" na 1.ª vez)
 *
 * Só toca em nome, n.º de produtos e visibilidade; o logótipo, a ordem e "esconder sempre"
 * ficam como estiverem no admin.
 */
import "dotenv/config";
import { withConnectionSettings } from "../suprides/repositories/store";
import { readAllProducts } from "../suprides/api/shopify-read";
import { syncBrands } from "../services/brands-sync";
import { closeMssql } from "../db/mssql";

async function main() {
  const apply = process.argv.includes("--apply");
  const products = await readAllProducts(n => process.stdout.write(`\rA ler a loja… ${n}`));
  process.stdout.write("\n");
  const r = await syncBrands(products, apply);
  console.log(`Marcas com produtos à venda: ${r.active.length}`);
  for (const a of r.active) console.log(`  ${a.name.padEnd(24)} ${String(a.products).padStart(4)}  (${a.handle})`);
  if (r.definitionCreated) console.log('Definição "marca" criada na Shopify.');
  console.log(`\n${apply ? "Escritas" : "A escrever"}: ${r.writes.length}`);
  for (const w of r.writes) console.log(`  ${w.isNew ? "nova     " : "atualizar"} ${w.name} → ${w.visible ? `${w.products} produto(s)` : "escondida (sem produtos à venda)"}`);
  if (!apply) console.log("\nNada foi escrito. Repetir com --apply para escrever na Shopify.");
}

withConnectionSettings(main).catch(e => { console.error("FALHOU:", e?.message ?? e); process.exitCode = 1; })
  .finally(() => closeMssql());
