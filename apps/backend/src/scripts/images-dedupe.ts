/**
 * Remove imagens duplicadas (a mesma foto várias vezes) dos produtos da loja,
 * mantendo a primeira cópia de cada foto. Os ficheiros duplicados são apagados.
 *
 *   npm run images:dedupe -- --dry-run     só conta
 *   npm run images:dedupe -- --active      só produtos ativos
 *   npm run images:dedupe                  todos (ativos primeiro)
 */
import "dotenv/config";
import { readAllProducts } from "../suprides/api/shopify-read";
import { getProductImages, findDuplicateImages, dedupeProductImages } from "../suprides/api/shopify-api";

const ts = () => new Date().toLocaleTimeString("pt-PT");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const onlyActive = process.argv.includes("--active");

  console.log(`${ts()} — a ler a loja…`);
  let products = (await readAllProducts()).sort((a, b) => Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE"));
  if (onlyActive) products = products.filter(p => p.status === "ACTIVE");
  console.log(`${ts()} — ${products.length} produtos a verificar${dryRun ? " (simulação)" : ""}`);

  const r = { checked: 0, withDuplicates: 0, removed: 0, errors: [] as { productId: number; error: string }[] };
  const queue = [...products];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const { duplicates } = findDuplicateImages(await getProductImages(p.productId));
        r.checked++;
        if (duplicates.length) {
          r.withDuplicates++;
          r.removed += dryRun ? duplicates.length : (await dedupeProductImages(p.productId)).removed;
        }
      } catch (e: any) {
        r.errors.push({ productId: p.productId, error: e?.message ?? String(e) });
      }
      if (r.checked % 250 === 0) console.log(`${ts()} — ${r.checked}/${products.length} verificados, ${r.removed} duplicadas ${dryRun ? "encontradas" : "apagadas"}`);
    }
  }));
  console.log(JSON.stringify({ ...r, errors: r.errors.length }, null, 1));
  for (const e of r.errors.slice(0, 10)) console.log(`  erro ${e.productId}: ${e.error.slice(0, 200)}`);
  console.log(`${ts()} — fim`);
}

main().catch(e => { console.error("ERRO:", e?.message ?? e); process.exit(1); });
