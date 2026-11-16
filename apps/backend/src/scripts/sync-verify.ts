/**
 * Verifica se a loja ficou como o plano do dry-run previa.
 *
 *   npm run sync:verify -- <plano> <snapshot-depois>
 *
 * <plano>: ficheiro gravado por POST /api/suprides/sync-familias/dry-run?save=1 (pasta data/plans/).
 * <snapshot-depois>: cópia tirada depois do sync (npm run shopify:snapshot); caminho ou nome em data/snapshots/.
 * Sai com código 1 se houver diferenças.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { loadSnapshot } from "../services/shopify-snapshot";
import { verifyPlan } from "../services/sync-verify";
import { dataPath } from "../utils/data-dir";

function main() {
  const [planArg, snapArg] = process.argv.slice(2);
  if (!planArg || !snapArg) {
    console.error("Uso: npm run sync:verify -- <plano> <snapshot-depois>");
    process.exit(2);
  }
  const planFile = fs.existsSync(planArg) ? planArg : path.join(dataPath("plans"), planArg);
  const planDoc = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const plan = planDoc.plan;
  if (!Array.isArray(plan)) throw new Error("O ficheiro não tem um plano (campo 'plan')");
  const snap = loadSnapshot(snapArg);

  console.log(`Plano: ${path.basename(planFile)} (${planDoc.createdAt ?? "?"}, ${plan.length} produtos)`);
  console.log(`Loja:  ${snapArg} (${snap.takenAt}, ${snap.products.length} produtos)`);
  if (planDoc.createdAt && snap.takenAt < planDoc.createdAt) {
    console.warn("Aviso: a cópia da loja é anterior ao plano — devia ser tirada depois do sync.");
  }

  const r = verifyPlan(plan, snap.products);
  console.log(`\nVerificados: ${r.checked}; sem diferenças: ${r.ok}; com diferenças: ${r.checked - r.ok}`);
  console.log("Por ação:", r.byAction);
  if (r.unverifiableCollections) console.log(`Coleções sem ID numérico (não verificadas): ${r.unverifiableCollections}`);

  if (!r.mismatches.length) { console.log("\nOK — a loja corresponde ao plano."); return; }

  console.log("\nDiferenças por campo:", r.mismatchesByField);
  const shown = new Map<string, number>();
  for (const m of r.mismatches) {
    const n = shown.get(m.field) ?? 0;
    if (n >= 10) continue;
    shown.set(m.field, n + 1);
    console.log(`  [${m.field}] ${m.sku} (${m.action}): esperado ${JSON.stringify(m.expected)} · loja ${JSON.stringify(m.actual)}`);
  }
  const out = planFile.replace(/\.json$/, "") + "-verify.json";
  fs.writeFileSync(out, JSON.stringify({ snapshot: snapArg, ...r }, null, 1));
  console.log(`\nRelatório completo: ${out}`);
  process.exit(1);
}

try { main(); } catch (e: any) { console.error("ERRO:", e?.message ?? e); process.exit(1); }
