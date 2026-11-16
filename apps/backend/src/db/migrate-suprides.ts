import { getSqlite } from "./sqlite";

export function ensureSupridesTable(): void {
  const db = getSqlite();

  db.exec(`
    CREATE TABLE IF NOT EXISTS suprides_products (
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

    CREATE INDEX IF NOT EXISTS idx_sp_sku        ON suprides_products (sku);
    CREATE INDEX IF NOT EXISTS idx_sp_brand      ON suprides_products (brand);
    CREATE INDEX IF NOT EXISTS idx_sp_family     ON suprides_products (family);
    CREATE INDEX IF NOT EXISTS idx_sp_prod_line  ON suprides_products (product_line);
  `);

  // Adiciona coluna shopify_node_id se a tabela já existia sem ela (migration segura)
  try {
    db.exec(`ALTER TABLE suprides_products ADD COLUMN shopify_node_id TEXT`);
  } catch {
    // Coluna já existe — ignorar
  }
  // Estado semântico do stock ('disponivel' | 'brevemente' | 'sob_encomenda' | 'sem_stock')
  try {
    db.exec(`ALTER TABLE suprides_products ADD COLUMN stock_status TEXT`);
  } catch {
    // Coluna já existe — ignorar
  }
  // Data em que o SKU deixou de vir na API Suprides (NULL = ativo no fornecedor).
  // Produtos retirados nunca são apagados: ficam sem stock e passam a draft na Shopify.
  try {
    db.exec(`ALTER TABLE suprides_products ADD COLUMN removed_at TEXT`);
  } catch {
    // Coluna já existe — ignorar
  }
  // Quando o sync completo enviou este SKU pela última vez (para retomar uma execução interrompida).
  try {
    db.exec(`ALTER TABLE suprides_products ADD COLUMN shopify_synced_at TEXT`);
  } catch {
    // Coluna já existe — ignorar
  }
  // Índice sempre criado depois de garantir que a coluna existe
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sp_node ON suprides_products (shopify_node_id)`);

  console.log("[sqlite] suprides_products ok");
}

export function ensureSupridesTagTables(): void {
  const db = getSqlite();

  // Catálogo de grupos de tags (ex: "Cor", "Marca", "Tipo")
  db.exec(`
    CREATE TABLE IF NOT EXISTS sp_tag_groups (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier    TEXT    NOT NULL DEFAULT 'suprides',
      nome        TEXT    NOT NULL,
      descricao   TEXT,
      unidade     TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(supplier, nome)
    )
  `);

  const tagGroupsSql = (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sp_tag_groups'
  `).get() as { sql?: string } | undefined)?.sql ?? "";
  if (!/\bsupplier\b/i.test(tagGroupsSql) || !/UNIQUE\s*\(\s*supplier\s*,\s*nome\s*\)/i.test(tagGroupsSql)) {
    db.pragma("foreign_keys = OFF");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sp_tag_groups_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier    TEXT    NOT NULL DEFAULT 'suprides',
          nome        TEXT    NOT NULL,
          descricao   TEXT,
          unidade     TEXT,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          UNIQUE(supplier, nome)
        );
        INSERT OR IGNORE INTO sp_tag_groups_new (id, supplier, nome, descricao, unidade, created_at)
          SELECT id, 'suprides', nome, descricao, unidade, created_at FROM sp_tag_groups;
        DROP TABLE sp_tag_groups;
        ALTER TABLE sp_tag_groups_new RENAME TO sp_tag_groups;
      `);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }

  // Valores permitidos para cada grupo (ex: grupo "Cor" → "Azul", "Vermelho")
  db.exec(`
    CREATE TABLE IF NOT EXISTS sp_tag_values (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_group_id INTEGER NOT NULL REFERENCES sp_tag_groups(id) ON DELETE CASCADE,
      value        TEXT    NOT NULL,
      UNIQUE (tag_group_id, value)
    );
    CREATE INDEX IF NOT EXISTS idx_sp_tv_group ON sp_tag_values (tag_group_id);
  `);

  // Tags atribuídas a cada produto (resultado da IA)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sp_product_tag_values (
      sku          TEXT    NOT NULL,
      tag_group_id INTEGER NOT NULL REFERENCES sp_tag_groups(id) ON DELETE CASCADE,
      value        TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sku, tag_group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sp_ptv_sku   ON sp_product_tag_values (sku);
    CREATE INDEX IF NOT EXISTS idx_sp_ptv_group ON sp_product_tag_values (tag_group_id);
  `);

  // Tag groups por nó do menu Shopify (substitui as 3 tabelas de taxonomia antigas)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sp_menu_tag_groups (
      shopify_id   TEXT    NOT NULL,
      tag_group_id INTEGER NOT NULL REFERENCES sp_tag_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (shopify_id, tag_group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sp_mtg_node ON sp_menu_tag_groups (shopify_id);
  `);

  // Tracking de produtos já processados pela IA
  db.exec(`
    CREATE TABLE IF NOT EXISTS sp_populate_tags_done (
      supplier     TEXT NOT NULL DEFAULT 'suprides',
      sku          TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (supplier, sku)
    )
  `);

  const populateCols = db.prepare(`PRAGMA table_info(sp_populate_tags_done)`).all() as { name: string }[];
  if (!populateCols.some(c => c.name === "supplier")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sp_populate_tags_done_new (
        supplier     TEXT NOT NULL DEFAULT 'suprides',
        sku          TEXT NOT NULL,
        processed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (supplier, sku)
      );
      INSERT OR IGNORE INTO sp_populate_tags_done_new (supplier, sku, processed_at)
        SELECT 'suprides', sku, processed_at FROM sp_populate_tags_done;
      DROP TABLE sp_populate_tags_done;
      ALTER TABLE sp_populate_tags_done_new RENAME TO sp_populate_tags_done;
    `);
  }

  // Valores normalizados por produto (resultado do script de normalização)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sp_product_tag_values_normalized (
      product_ref  TEXT    NOT NULL,
      tag_group_id INTEGER NOT NULL REFERENCES sp_tag_groups(id) ON DELETE CASCADE,
      normalized_value TEXT NOT NULL,
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (product_ref, tag_group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sp_ptvn_ref   ON sp_product_tag_values_normalized (product_ref);
    CREATE INDEX IF NOT EXISTS idx_sp_ptvn_group ON sp_product_tag_values_normalized (tag_group_id);
  `);

  // Remover tabelas antigas de taxonomia Suprides se existirem
  db.exec(`
    DROP TABLE IF EXISTS sp_subfamily_tag_groups;
    DROP TABLE IF EXISTS sp_family_tag_groups;
    DROP TABLE IF EXISTS sp_product_line_tag_groups;
  `);

  // Adicionar colunas de cache Shopify se não existirem (migrations seguras)
  try {
    db.exec(`ALTER TABLE suprides_products ADD COLUMN shopify_product_id INTEGER`);
  } catch { /* coluna já existe */ }
  try {
    db.exec(`ALTER TABLE suprides_products ADD COLUMN shopify_variant_id INTEGER`);
  } catch { /* coluna já existe */ }
  try {
    db.exec(`ALTER TABLE suprides_products ADD COLUMN shopify_inventory_item_id INTEGER`);
  } catch { /* coluna já existe */ }
  try {
    db.exec(`ALTER TABLE suprides_products ADD COLUMN images_synced INTEGER NOT NULL DEFAULT 0`);
  } catch { /* coluna já existe */ }

  console.log("[sqlite] sp_tag_* tables ok");
}
