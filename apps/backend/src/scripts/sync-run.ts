/**
 * Sync completo fora da app (consola), com cópia antes/depois e verificação.
 *
 *   npm run sync:run -- --dry-run          simulação; grava o plano em data/plans/
 *   npm run sync:run -- --dry-run --snapshot <ficheiro>   simulação com uma cópia local da loja
 *   npm run sync:run                       sync real → cópia da loja depois → sync:verify com o último plano
 *   npm run sync:run -- --resume           retoma uma execução interrompida (salta os SKUs já enviados)
 *   --no-images                            não envia imagens (ficam por enviar para um envio à parte)
 *
 * Não correr ao mesmo tempo que um sync lançado pela app.
 */
import "dotenv/config";
import { withConnectionSettings } from "../suprides/repositories/store";
import fs from "fs";
import path from "path";
import { closeMssql } from "../db/mssql";
import { runFullShopifySync } from "../suprides/routes/sync";
import { loadSnapshot, takeSnapshot } from "../services/shopify-snapshot";
import { verifyPlan } from "../services/sync-verify";
import { sendAlert } from "../services/alerts";
import { dataPath } from "../utils/data-dir";

const ts = () => new Date().toLocaleString("pt-PT");
const stamp = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function latestPlan(): string | null {
  const dir = dataPath("plans");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter(n => /^plan-\d{8}-\d{6}\.json$/.test(n)).sort().pop();
  return f ? path.join(dir, f) : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const resume = process.argv.includes("--resume");
  const skipImages = process.argv.includes("--no-images");
  const snapshotIndex = process.argv.indexOf("--snapshot");
  const snapshotFile = snapshotIndex >= 0 ? process.argv[snapshotIndex + 1] : undefined;
  if (snapshotIndex >= 0 && (!dryRun || !snapshotFile || snapshotFile.startsWith("--"))) {
    throw new Error("--snapshot exige --dry-run e o nome do ficheiro da cópia da loja.");
  }

  console.log(`${ts()} — início (${dryRun ? "simulação" : resume ? "retomar" : "sync real"})`);
  const r: any = await runFullShopifySync({ dryRun, resume, skipImages,
    readShop: snapshotFile ? async () => loadSnapshot(snapshotFile).products : undefined,
  });

  if (dryRun) {
    const dir = dataPath("plans");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `plan-${stamp()}.json`);
    fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), ...r }, null, 1));
    const { plan, ...rest } = r;
    console.log(JSON.stringify({ ...rest, errors: rest.errors?.length ?? 0 }, null, 1));
    console.log(`${ts()} — plano gravado: ${file}`);
    return;
  }

  const { errors, ...rest } = r;
  console.log(JSON.stringify({ ...rest, errors: errors?.length ?? 0, noCost: undefined, draftedUnmapped: rest.draftedUnmapped?.length }, null, 1));
  if (errors?.length) {
    const errFile = dataPath("plans", `sync-errors-${stamp()}.json`);
    fs.mkdirSync(path.dirname(errFile), { recursive: true });
    fs.writeFileSync(errFile, JSON.stringify(errors, null, 1));
    console.log(`Erros gravados em ${errFile}`);
    await sendAlert("sync-errors", `Sync manual com ${errors.length} erro(s)`,
      `O sync terminou, mas ${errors.length} produto(s) falharam.

Primeiros erros:
` +
      errors.slice(0, 10).map((e: any) => `- ${e?.sku ?? "?"}: ${String(e?.error ?? e?.message ?? e).slice(0, 200)}`).join("\n"));
  }
  if (r.cancelled) { console.log(`${ts()} — cancelado; retomar com --resume`); return; }

  console.log(`${ts()} — a tirar cópia da loja depois do sync…`);
  const after = await takeSnapshot({ reason: "depois do sync" });
  console.log(`${ts()} — cópia: ${path.basename(after.file)}`);
  // O histórico de preços já foi gravado pelo próprio runFullShopifySync.

  const planFile = latestPlan();
  if (!planFile) { console.log("Sem plano gravado — verificação saltada."); return; }
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8")).plan;
  const v = verifyPlan(plan, after.snapshot.products);
  const out = planFile.replace(/\.json$/, "") + "-verify.json";
  fs.writeFileSync(out, JSON.stringify({ snapshot: path.basename(after.file), ...v }, null, 1));
  console.log(`Verificação (${path.basename(planFile)}): ${v.ok}/${v.checked} sem diferenças; por campo:`, v.mismatchesByField);
  if (v.checked - v.ok > 0) {
    await sendAlert("verify-mismatch", `Verificação: ${v.checked - v.ok} produto(s) diferentes do plano`,
      `Depois do sync, ${v.checked - v.ok} de ${v.checked} produtos não ficaram como planeado.

Por campo: ${JSON.stringify(v.mismatchesByField)}

Relatório no servidor: ${path.basename(out)}`);
  }
  console.log(`${ts()} — fim. Relatório: ${out}`);
}

withConnectionSettings(main).catch(async e => {
  console.error(`${ts()} — ERRO:`, e?.response?.data ?? e?.message ?? e);
  if (!process.argv.includes("--dry-run")) await sendAlert("sync-failed", "Sync manual FALHOU", `O sync parou com erro: ${e?.message ?? e}

Retomar com --resume.`);
  process.exitCode = 1;
}).finally(closeMssql);
