import { getSqlite } from "./sqlite";

export function ensureEsprinetTable(): void {
  const db = getSqlite();

  db.exec(`
    CREATE TABLE IF NOT EXISTS esprinet_products (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      sku               TEXT    NOT NULL UNIQUE,
      ean               TEXT,
      part_number       TEXT,
      brand             TEXT,
      product_line      TEXT,
      family            TEXT,
      sub_family        TEXT,
      name              TEXT,
      price             REAL,
      pvpr              REAL,
      stock             INTEGER,
      images            TEXT,
      weight            REAL,
      cor               TEXT,
      description       TEXT,
      manufacturer      TEXT,
      short_description TEXT,
      imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ep_sku        ON esprinet_products (sku);
    CREATE INDEX IF NOT EXISTS idx_ep_brand      ON esprinet_products (brand);
    CREATE INDEX IF NOT EXISTS idx_ep_family     ON esprinet_products (family);
    CREATE INDEX IF NOT EXISTS idx_ep_prod_line  ON esprinet_products (product_line);
  `);

  try {
    db.exec(`ALTER TABLE esprinet_products ADD COLUMN shopify_node_id TEXT`);
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`ALTER TABLE esprinet_products ADD COLUMN stock_status TEXT`);
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`ALTER TABLE esprinet_products ADD COLUMN shopify_product_id INTEGER`);
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`ALTER TABLE esprinet_products ADD COLUMN shopify_variant_id INTEGER`);
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`ALTER TABLE esprinet_products ADD COLUMN shopify_inventory_item_id INTEGER`);
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`ALTER TABLE esprinet_products ADD COLUMN images_synced INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists.
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ep_node ON esprinet_products (shopify_node_id)`);

  console.log("[sqlite] esprinet_products ok");
}
