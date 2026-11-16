import { getSqlite } from "../db/sqlite";
import type { SupridesProduct } from "./suprides-cache";

export type EsprinetProduct = SupridesProduct;

export function getAllProducts(limit = 5000, offset = 0): EsprinetProduct[] {
  const db = getSqlite();
  return db
    .prepare("SELECT * FROM esprinet_products ORDER BY id LIMIT ? OFFSET ?")
    .all(limit, offset) as EsprinetProduct[];
}

export function getProductBySku(sku: string): EsprinetProduct | null {
  const db = getSqlite();
  return (
    (db
      .prepare("SELECT * FROM esprinet_products WHERE sku = ?")
      .get(sku) as EsprinetProduct) ?? null
  );
}

export function countProducts(): number {
  const db = getSqlite();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM esprinet_products")
    .get() as { n: number };
  return row.n;
}

export function getProductsByFamily(family: string): EsprinetProduct[] {
  const db = getSqlite();
  return db
    .prepare("SELECT * FROM esprinet_products WHERE family = ? ORDER BY sku")
    .all(family) as EsprinetProduct[];
}

export function upsertProductsBatch(products: EsprinetProduct[]): number {
  const db = getSqlite();

  const upsert = db.prepare(`
    INSERT INTO esprinet_products
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
      updated_at       = datetime('now')
  `);

  const insertMany = db.transaction((rows: EsprinetProduct[]) => {
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

export function clearAllProducts(): number {
  const db = getSqlite();
  const result = db.prepare("DELETE FROM esprinet_products").run();
  return result.changes;
}
