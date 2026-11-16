import fs from "fs";
import path from "path";
import { ensureEsprinetTable } from "../db/migrate-esprinet";
import { clearAllProducts, countProducts, upsertProductsBatch, type EsprinetProduct } from "../repositories/esprinet-cache";
import { closeSqlite } from "../db/sqlite";

type EsprinetCatalogueItem = Record<string, unknown>;

const BATCH_SIZE = 1000;

function text(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s || null;
}

function numberValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function intValue(value: unknown): number | null {
  const n = numberValue(value);
  return n == null ? null : Math.trunc(n);
}

function normalizeEan(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return [8, 12, 13, 14].includes(digits.length) ? digits : null;
}

function resolveCataloguePath(): string {
  const arg = process.argv[2];
  const candidates = arg
    ? [arg]
    : [
        path.resolve(process.cwd(), "Catalogue.json"),
        path.resolve(process.cwd(), "..", "..", "Catalogue.json"),
        path.resolve(process.cwd(), "..", "..", "..", "Catalogue.json"),
      ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  throw new Error(`Catalogue.json nao encontrado. Usa: npm run import:esprinet -- <caminho>`);
}

function mapProduct(item: EsprinetCatalogueItem): EsprinetProduct | null {
  const sku = text(item.SKU);
  const ean = normalizeEan(item.EAN);
  if (!sku || !ean) return null;

  return {
    sku,
    ean,
    part_number: text(item.PartNumber),
    brand: text(item.BrandDescription),
    product_line: text(item.CategoryDescription),
    family: text(item.FamilyDescription),
    sub_family: null,
    name: text(item.Description),
    price: numberValue(item.StandardDealerPrice),
    pvpr: numberValue(item.ListPrice),
    stock: intValue(item.StockQty),
    stock_status: null,
    images: null,
    weight: numberValue(item.GrossWeight),
    cor: null,
    description: text(item.ExtendedDescription),
    manufacturer: text(item.VendorName),
    short_description: text(item.Description),
  };
}

function main(): void {
  const file = resolveCataloguePath();
  console.log(`[esprinet] A ler ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) throw new Error("Catalogue.json deve ser um array de produtos");

  ensureEsprinetTable();
  const deleted = clearAllProducts();
  console.log(`[esprinet] Produtos anteriores removidos: ${deleted}`);

  let imported = 0;
  let skipped = 0;
  let batch: EsprinetProduct[] = [];

  for (const item of data as EsprinetCatalogueItem[]) {
    const product = mapProduct(item);
    if (!product) {
      skipped++;
      continue;
    }
    batch.push(product);
    if (batch.length >= BATCH_SIZE) {
      imported += upsertProductsBatch(batch);
      batch = [];
      console.log(`[esprinet] Importados ${imported}/${data.length}`);
    }
  }
  if (batch.length) imported += upsertProductsBatch(batch);

  const total = countProducts();
  console.log(`[esprinet] Concluido. Importados=${imported}; ignorados=${skipped}; total_bd=${total}`);
  closeSqlite();
}

try {
  main();
} catch (err: any) {
  console.error(`[esprinet] Erro: ${err?.message ?? err}`);
  closeSqlite();
  process.exit(1);
}
