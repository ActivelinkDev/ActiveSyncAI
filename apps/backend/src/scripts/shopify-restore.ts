/**
 * Repõe a loja a partir de uma cópia de segurança.
 *
 *   npm run shopify:restore -- <snapshot> [--sku A,B] [--apply]
 *
 * <snapshot>: caminho do ficheiro, ou só o nome dentro de <DATA_DIR>/snapshots/.
 * Sem --apply só mostra as diferenças (nada é escrito).
 * Com --apply repõe estado, título, descrição, preço, preço riscado, EAN, custo, peso e
 * custom.stock_status, e retira coleções acrescentadas depois da cópia.
 * Nunca apaga produtos nem volta a acrescentar coleções.
 */
import "dotenv/config";
import { withConnectionSettings } from "../suprides/repositories/store";
import { closeMssql } from "../db/mssql";
import { loadSnapshot } from "../services/shopify-snapshot";
import { diffSnapshot, applyRestore } from "../services/shopify-restore";
import { readAllProducts } from "../suprides/api/shopify-read";

function parseArgs(argv: string[]) {
  const args = { snapshot: "", skus: undefined as string[] | undefined, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--sku") args.skus = (argv[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
    else if (a.startsWith("--sku=")) args.skus = a.slice(6).split(",").map(s => s.trim()).filter(Boolean);
    else if (!args.snapshot) args.snapshot = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.snapshot) {
    console.error("Uso: npm run shopify:restore -- <snapshot> [--sku A,B] [--apply]");
    process.exit(2);
  }

  const snap = loadSnapshot(args.snapshot);
  console.log(`Cópia: ${args.snapshot} (${snap.takenAt}, ${snap.products.length} produtos)`);

  const search = args.skus?.length ? args.skus.map(s => `sku:"${s.replace(/"/g, '\\"')}"`).join(" OR ") : undefined;
  const current = await readAllProducts(n => process.stdout.write(`\rA ler a loja… ${n}`), search);
  process.stdout.write("\n");

  const diff = diffSnapshot(snap.products, current, { skus: args.skus ? new Set(args.skus) : undefined });

  const byField: Record<string, number> = {};
  let collRemovals = 0, uncertain = 0;
  for (const d of diff.products) {
    for (const c of d.changes) byField[c.field] = (byField[c.field] || 0) + 1;
    collRemovals += d.removeCollections.length;
    if (d.collectionsUncertain) uncertain++;
  }
  console.log(`\nProdutos com diferenças: ${diff.products.length}`);
  for (const [f, n] of Object.entries(byField).sort((a, b) => b[1] - a[1])) console.log(`  ${f.padEnd(16)} ${n}`);
  console.log(`  coleções a retirar: ${collRemovals}${uncertain ? ` (${uncertain} produtos com coleções não verificáveis)` : ""}`);
  console.log(`Na cópia mas já não na loja (não se recriam): ${diff.goneFromShop.length}`);
  console.log(`Na loja mas não na cópia (não se apagam):     ${diff.newInShop.length}`);

  const sample = args.skus ? diff.products : diff.products.slice(0, 10);
  for (const d of sample) {
    console.log(`\n${d.sku ?? "(sem SKU)"} — ${d.title}`);
    for (const c of d.changes) console.log(`  ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
    if (d.removeCollections.length) console.log(`  retirar coleções: ${d.removeCollections.join(", ")}`);
    if (d.missingCollections.length) console.log(`  (coleções em falta, não repostas: ${d.missingCollections.join(", ")})`);
  }

  if (!args.apply) {
    console.log("\nNada foi escrito. Repetir com --apply para repor.");
    return;
  }
  if (!diff.products.length) { console.log("\nNada a repor."); return; }

  console.log(`\nA repor ${diff.products.length} produtos…`);
  const r = await applyRestore(diff, snap.products, (d, t) => process.stdout.write(`\r${d}/${t}`));
  console.log(`\nRepostos: ${r.productsUpdated}; coleções retiradas: ${r.collectionRemovals}; erros: ${r.errors.length}`);
  for (const e of r.errors.slice(0, 20)) console.log(`  ${e.productId}: ${e.error}`);
  if (r.errors.length) process.exit(1);
}

withConnectionSettings(main).catch(e => { console.error("\nERRO:", e?.response?.data ?? e?.message ?? e); process.exitCode = 1; }).finally(closeMssql);
