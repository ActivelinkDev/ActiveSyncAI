import { getSqlite } from "../db/sqlite";

export interface SupridesProduct {
  id?: number;
  sku: string;
  ean?: string | null;
  part_number?: string | null;
  brand?: string | null;
  product_line?: string | null;
  family?: string | null;
  sub_family?: string | null;
  name?: string | null;
  price?: number | null;
  pvpr?: number | null;
  stock?: number | null;
  stock_status?: string | null;
  images?: string | null;      // JSON array serializado
  weight?: number | null;
  cor?: string | null;
  description?: string | null;
  manufacturer?: string | null;
  short_description?: string | null;
  imported_at?: string;
  updated_at?: string;
  shopify_product_id?: number | null;
  shopify_variant_id?: number | null;
  shopify_inventory_item_id?: number | null;
}

// ── Leitura ──────────────────────────────────────────────────────────────────

export function getAllProducts(limit = 5000, offset = 0): SupridesProduct[] {
  const db = getSqlite();
  return db
    .prepare("SELECT * FROM suprides_products ORDER BY id LIMIT ? OFFSET ?")
    .all(limit, offset) as SupridesProduct[];
}

export function getProductBySku(sku: string): SupridesProduct | null {
  const db = getSqlite();
  return (
    (db
      .prepare("SELECT * FROM suprides_products WHERE sku = ?")
      .get(sku) as SupridesProduct) ?? null
  );
}

export function countProducts(): number {
  const db = getSqlite();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM suprides_products")
    .get() as { n: number };
  return row.n;
}

export function getProductsByFamily(family: string): SupridesProduct[] {
  const db = getSqlite();
  return db
    .prepare("SELECT * FROM suprides_products WHERE family = ? ORDER BY sku")
    .all(family) as SupridesProduct[];
}

// ── Escrita ───────────────────────────────────────────────────────────────────

export function upsertProduct(p: SupridesProduct): void {
  const db = getSqlite();
  const images =
    p.images && typeof p.images !== "string"
      ? JSON.stringify(p.images)
      : (p.images ?? null);

  db.prepare(`
    INSERT INTO suprides_products
      (sku, ean, part_number, brand, product_line, family, sub_family,
       name, price, pvpr, stock, stock_status, images, weight, cor,
       description, manufacturer, short_description, updated_at)
    VALUES
      (@sku, @ean, @part_number, @brand, @product_line, @family, @sub_family,
       @name, @price, @pvpr, @stock, @stock_status, @images, @weight, @cor,
       @description, @manufacturer, @short_description, datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET
      ean              = excluded.ean,
      part_number      = excluded.part_number,
      brand            = excluded.brand,
      product_line     = excluded.product_line,
      family           = excluded.family,
      sub_family       = excluded.sub_family,
      name             = excluded.name,
      price            = excluded.price,
      pvpr             = excluded.pvpr,
      stock            = excluded.stock,
      stock_status     = excluded.stock_status,
      images           = excluded.images,
      images_synced    = CASE WHEN excluded.images IS NOT images THEN 0 ELSE images_synced END,
      weight           = excluded.weight,
      cor              = excluded.cor,
      description      = excluded.description,
      manufacturer     = excluded.manufacturer,
      short_description = excluded.short_description,
      removed_at       = NULL,
      updated_at       = datetime('now')
  `).run({ stock_status: null, ...p, images });
}

export function upsertProductsBatch(products: SupridesProduct[]): number {
  const db = getSqlite();

  const upsert = db.prepare(`
    INSERT INTO suprides_products
      (sku, ean, part_number, brand, product_line, family, sub_family,
       name, price, pvpr, stock, stock_status, images, weight, cor,
       description, manufacturer, short_description, updated_at)
    VALUES
      (@sku, @ean, @part_number, @brand, @product_line, @family, @sub_family,
       @name, @price, @pvpr, @stock, @stock_status, @images, @weight, @cor,
       @description, @manufacturer, @short_description, datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET
      ean              = excluded.ean,
      part_number      = excluded.part_number,
      brand            = excluded.brand,
      product_line     = excluded.product_line,
      family           = excluded.family,
      sub_family       = excluded.sub_family,
      name             = excluded.name,
      price            = excluded.price,
      pvpr             = excluded.pvpr,
      stock            = excluded.stock,
      stock_status     = excluded.stock_status,
      images           = excluded.images,
      images_synced    = CASE WHEN excluded.images IS NOT images THEN 0 ELSE images_synced END,
      weight           = excluded.weight,
      cor              = excluded.cor,
      description      = excluded.description,
      manufacturer     = excluded.manufacturer,
      short_description = excluded.short_description,
      removed_at       = NULL,
      updated_at       = datetime('now')
  `);

  const insertMany = db.transaction((rows: SupridesProduct[]) => {
    for (const p of rows) {
      const images =
        p.images && typeof p.images !== "string"
          ? JSON.stringify(p.images)
          : (p.images ?? null);
      upsert.run({ stock_status: null, ...p, images });
    }
  });

  insertMany(products);
  return products.length;
}

/**
 * Marca como retirados do fornecedor os SKUs ativos que não vieram na importação.
 * Não apaga: mantém os IDs Shopify para o sync os passar a draft.
 * Devolve quantos foram marcados agora.
 */
export function markMissingAsRemoved(seenSkus: Set<string>): number {
  const db = getSqlite();
  const active = (db
    .prepare("SELECT sku FROM suprides_products WHERE removed_at IS NULL")
    .all() as { sku: string }[]).map(r => r.sku);
  const missing = active.filter(sku => !seenSkus.has(sku));
  if (missing.length === 0) return 0;

  const mark = db.prepare(
    `UPDATE suprides_products
        SET removed_at = datetime('now'), stock = 0, stock_status = 'sem_stock'
      WHERE sku = ? AND removed_at IS NULL`
  );
  db.transaction((skus: string[]) => { for (const s of skus) mark.run(s); })(missing);
  return missing.length;
}

export function countActiveProducts(): number {
  const db = getSqlite();
  return (db
    .prepare("SELECT COUNT(*) as n FROM suprides_products WHERE removed_at IS NULL")
    .get() as { n: number }).n;
}

export function deleteProductBySku(sku: string): boolean {
  const db = getSqlite();
  const result = db
    .prepare("DELETE FROM suprides_products WHERE sku = ?")
    .run(sku);
  return result.changes > 0;
}

export function clearAllProducts(): number {
  const db = getSqlite();
  const result = db.prepare("DELETE FROM suprides_products").run();
  return result.changes;
}
