/**
 * Logótipos das marcas a partir de uma pasta no PC.
 *
 *   npm run brands:logos -- "C:\caminho\logos"             simulação: mostra o que ligaria
 *   npm run brands:logos -- "C:\caminho\logos" --apply     carrega para Conteúdo → Ficheiros e liga às marcas
 *   ... --force                                            substitui logótipos que já existem
 *
 * O nome do ficheiro é o nome da marca, em qualquer grafia: Apple.png, daan-tech.svg, "Daan Tech.png".
 * Formatos: png, jpg, jpeg, webp, gif, svg. Com --apply, as marcas são primeiro criadas/atualizadas
 * (como no sync), para existirem antes de ligar os logótipos.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { withConnectionSettings } from "../suprides/repositories/store";
import { readAllProducts } from "../suprides/api/shopify-read";
import {
  syncBrands, readBrandsForLogos, planLogoLinks, uploadBrandLogo, LOGO_MIME, type ShopBrand,
} from "../services/brands-sync";
import { closeMssql } from "../db/mssql";

const MAX_BYTES = 20 * 1024 * 1024;

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith("--"));
  const apply = args.includes("--apply");
  const force = args.includes("--force");
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('Uso: npm run brands:logos -- "C:\\caminho\\logos" [--apply] [--force]');
    process.exitCode = 2;
    return;
  }

  const files = fs.readdirSync(dir)
    .filter(f => fs.statSync(path.join(dir, f)).isFile())
    .map(f => ({ file: f, name: path.parse(f).name, ext: path.extname(f) }));
  const ignored = files.filter(f => !LOGO_MIME[f.ext.toLowerCase()]);
  console.log(`Pasta: ${dir} — ${files.length - ignored.length} imagem(ns)` + (ignored.length ? `, ${ignored.length} ficheiro(s) ignorado(s) (${ignored.slice(0, 5).map(f => f.file).join(", ")})` : ""));

  // Marcas: as da loja (com logótipo) + as que têm produtos à venda e ainda não existem.
  const products = await readAllProducts(n => process.stdout.write(`\rA ler a loja… ${n}`));
  process.stdout.write("\n");
  const synced = await syncBrands(products, apply);
  const shop = await readBrandsForLogos().catch(() => [] as ShopBrand[]);
  const known = new Set(shop.map(b => b.handle));
  const brands: ShopBrand[] = [
    ...shop,
    ...synced.active.filter(a => !known.has(a.handle)).map(a => ({ handle: a.handle, name: a.name, products: a.products, visible: true, logo: null })),
  ];

  const plan = planLogoLinks(files, brands, force);
  const link = plan.filter(p => p.kind === "link");
  console.log(`\nA ligar: ${link.length}`);
  let done = 0, failed = 0;
  for (const p of plan) {
    if (p.kind === "link") {
      const full = path.join(dir, p.file);
      const size = fs.statSync(full).size;
      if (size > MAX_BYTES) { console.log(`  ✖ ${p.file}: maior que 20 MB`); failed++; continue; }
      if (!apply) { console.log(`  ${p.replace ? "substituir" : "ligar     "} ${p.file} → ${p.brand}`); continue; }
      try {
        await uploadBrandLogo(p.handle, p.brand, p.file, fs.readFileSync(full), path.extname(p.file));
        console.log(`  ✔ ${p.file} → ${p.brand}`);
        done++;
      } catch (e: any) {
        console.log(`  ✖ ${p.file} → ${p.brand}: ${e?.message ?? e}`);
        failed++;
      }
    }
  }
  const skip = plan.filter(p => p.kind === "skip-has-logo");
  if (skip.length) console.log(`\nJá têm logótipo (usar --force para substituir): ${skip.map(p => p.kind === "skip-has-logo" ? p.brand : "").join(", ")}`);
  const noBrand = plan.filter(p => p.kind === "no-brand");
  if (noBrand.length) console.log(`\nSem marca com esse nome (ver a lista abaixo): ${noBrand.map(p => p.file).join(", ")}`);
  const dup = plan.filter(p => p.kind === "duplicate");
  if (dup.length) console.log(`\nRepetidos (usado o 1.º): ${dup.map(p => p.file).join(", ")}`);

  const linked = new Set(plan.filter(p => p.kind === "link" || p.kind === "skip-has-logo").map(p => (p as any).handle));
  const missing = synced.active.filter(a => !linked.has(a.handle) && !brands.find(b => b.handle === a.handle)?.logo);
  console.log(`\nMarcas à venda: ${synced.active.length}. Sem logótipo${apply ? "" : " depois disto"}: ${missing.length}`);
  for (const a of missing) console.log(`  ${a.name.padEnd(24)} → ficheiro "${a.handle}.png" (ou .svg, .jpg…)`);
  if (apply) console.log(`\nLigados: ${done}${failed ? `, falharam: ${failed}` : ""}.`);
  else console.log("\nNada foi escrito. Repetir com --apply para carregar e ligar.");
  if (failed) process.exitCode = 1;
}

withConnectionSettings(main).catch(e => { console.error("FALHOU:", e?.message ?? e); process.exitCode = 1; })
  .finally(() => closeMssql());
