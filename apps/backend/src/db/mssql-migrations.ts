/**
 * Migrações do SQL Server (versionadas, aplicadas por ordem; tabela schema_migrations).
 *   npm run db:migrate   — e também no arranque do backend, se o SQL Server estiver configurado.
 * Nunca alterar uma migração já aplicada: acrescentar uma nova.
 */
import { Kysely, sql, type Migration } from 'kysely';
import { getMssql } from './mssql';

const money = sql`decimal(12,2)`;
const utc = sql`datetime2(0)`;

const migrations: Record<string, Migration> = {
  // Histórico de preços (regra dos 30 dias / Omnibus).
  '0001_price_history': {
    async up(db: Kysely<any>) {
      await db.schema.createTable('price_current')
        .addColumn('sku', sql`nvarchar(64)`, c => c.primaryKey())
        .addColumn('supplier', sql`nvarchar(20)`, c => c.notNull())
        .addColumn('shopify_product_id', 'bigint')
        .addColumn('price', money, c => c.notNull())
        .addColumn('compare_at_price', money)
        .addColumn('status', sql`nvarchar(20)`)
        .addColumn('updated_at', utc, c => c.notNull())
        .execute();

      await db.schema.createTable('price_history')
        .addColumn('id', 'bigint', c => c.primaryKey().identity())
        .addColumn('supplier', sql`nvarchar(20)`, c => c.notNull())
        .addColumn('sku', sql`nvarchar(64)`, c => c.notNull())
        .addColumn('shopify_product_id', 'bigint')
        .addColumn('old_price', money)
        .addColumn('new_price', money, c => c.notNull())
        .addColumn('old_compare_at_price', money)
        .addColumn('new_compare_at_price', money)
        .addColumn('status', sql`nvarchar(20)`)
        // INITIAL | SNAPSHOT (reconstruído) | SYNC | CAMPAIGN | CAMPAIGN_END
        .addColumn('source', sql`nvarchar(20)`, c => c.notNull())
        .addColumn('campaign_id', 'integer')
        .addColumn('changed_at', utc, c => c.notNull())
        .addColumn('recorded_at', utc, c => c.notNull().defaultTo(sql`SYSUTCDATETIME()`))
        .execute();

      await db.schema.createIndex('ix_price_history_sku_changed')
        .on('price_history').columns(['sku', 'changed_at']).execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('price_history').execute();
      await db.schema.dropTable('price_current').execute();
    },
  },

  // Produtos e tags (vindos do SQLite). Nomes de tabelas iguais aos do SQLite.
  // Campos 0/1 em tinyint (não bit) para o código continuar a comparar com números.
  '0002_products_and_tags': {
    async up(db: Kysely<any>) {
      await sql`CREATE TABLE suprides_products (
        id int IDENTITY(1,1) PRIMARY KEY,
        sku nvarchar(64) NOT NULL CONSTRAINT uq_suprides_products_sku UNIQUE,
        ean nvarchar(64) NULL, part_number nvarchar(128) NULL, brand nvarchar(200) NULL,
        product_line nvarchar(200) NULL, family nvarchar(200) NULL, sub_family nvarchar(200) NULL,
        name nvarchar(1000) NULL,
        price decimal(14,4) NULL, pvpr decimal(14,4) NULL, stock int NULL,
        images nvarchar(max) NULL, weight float NULL, cor nvarchar(200) NULL,
        description nvarchar(max) NULL, manufacturer nvarchar(200) NULL, short_description nvarchar(max) NULL,
        imported_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        shopify_node_id nvarchar(100) NULL,
        shopify_product_id bigint NULL, shopify_variant_id bigint NULL, shopify_inventory_item_id bigint NULL,
        images_synced tinyint NOT NULL DEFAULT 0,
        stock_status nvarchar(40) NULL,
        removed_at datetime2(0) NULL,
        shopify_synced_at datetime2(0) NULL,
        shopify_content_hash nvarchar(100) NULL
      )`.execute(db);
      for (const col of ['brand', 'family', 'product_line', 'shopify_node_id', 'shopify_product_id']) {
        await sql.raw(`CREATE INDEX ix_suprides_products_${col} ON suprides_products (${col})`).execute(db);
      }

      await sql`CREATE TABLE sp_tag_groups (
        id int IDENTITY(1,1) PRIMARY KEY,
        supplier nvarchar(20) NOT NULL DEFAULT 'suprides',
        nome nvarchar(200) NOT NULL, descricao nvarchar(1000) NULL, unidade nvarchar(50) NULL,
        created_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT uq_sp_tag_groups UNIQUE (supplier, nome)
      )`.execute(db);
      await sql`CREATE TABLE sp_tag_values (
        id int IDENTITY(1,1) PRIMARY KEY,
        tag_group_id int NOT NULL REFERENCES sp_tag_groups(id) ON DELETE CASCADE,
        value nvarchar(400) NOT NULL,
        CONSTRAINT uq_sp_tag_values UNIQUE (tag_group_id, value)
      )`.execute(db);
      await sql`CREATE TABLE sp_product_tag_values (
        sku nvarchar(64) NOT NULL,
        tag_group_id int NOT NULL REFERENCES sp_tag_groups(id) ON DELETE CASCADE,
        value nvarchar(400) NOT NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_sp_product_tag_values PRIMARY KEY (sku, tag_group_id)
      )`.execute(db);
      await sql`CREATE INDEX ix_sp_ptv_group ON sp_product_tag_values (tag_group_id)`.execute(db);
      await sql`CREATE TABLE sp_menu_tag_groups (
        shopify_id nvarchar(100) NOT NULL,
        tag_group_id int NOT NULL REFERENCES sp_tag_groups(id) ON DELETE CASCADE,
        CONSTRAINT pk_sp_menu_tag_groups PRIMARY KEY (shopify_id, tag_group_id)
      )`.execute(db);
      await sql`CREATE TABLE sp_product_tag_values_normalized (
        product_ref nvarchar(64) NOT NULL,
        tag_group_id int NOT NULL REFERENCES sp_tag_groups(id) ON DELETE CASCADE,
        normalized_value nvarchar(400) NOT NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_sp_ptvn PRIMARY KEY (product_ref, tag_group_id)
      )`.execute(db);
      await sql`CREATE INDEX ix_sp_ptvn_group ON sp_product_tag_values_normalized (tag_group_id)`.execute(db);
      await sql`CREATE TABLE sp_populate_tags_done (
        supplier nvarchar(20) NOT NULL DEFAULT 'suprides',
        sku nvarchar(64) NOT NULL,
        processed_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_sp_populate_tags_done PRIMARY KEY (supplier, sku)
      )`.execute(db);
    },
  },

  // Configuração que estava em ficheiros JSON (data/suprides/*.json).
  '0003_config': {
    async up(db: Kysely<any>) {
      // admin-settings.json — uma só linha
      await sql`CREATE TABLE admin_settings (
        id tinyint NOT NULL PRIMARY KEY CONSTRAINT ck_admin_settings_single CHECK (id = 1),
        iva_rate decimal(5,2) NOT NULL DEFAULT 23,
        rounding_above_unit_to_999 tinyint NOT NULL DEFAULT 0,
        rounding_below_unit_to_499 tinyint NOT NULL DEFAULT 0,
        auto_publish_public_menu tinyint NULL,
        create_new_products tinyint NULL,
        public_menu_handle nvarchar(200) NULL,
        public_menu_title nvarchar(200) NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(db);
      // connection-settings.json — credenciais cifradas (mesmo formato enc:v1)
      await sql`CREATE TABLE connection_settings (
        name nvarchar(100) NOT NULL PRIMARY KEY,
        value nvarchar(4000) NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(db);
      // custom-prompt.json
      await sql`CREATE TABLE ai_prompts (
        name nvarchar(100) NOT NULL PRIMARY KEY,
        text nvarchar(max) NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(db);
      // collection-margins.json
      await sql`CREATE TABLE collection_margins (
        collection_id nvarchar(100) NOT NULL PRIMARY KEY,
        mode nvarchar(20) NOT NULL,
        margin_value decimal(12,4) NOT NULL,
        title nvarchar(400) NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(db);
      // mappings.json
      await sql`CREATE TABLE line_mappings (
        product_line nvarchar(200) NOT NULL PRIMARY KEY,
        active tinyint NOT NULL DEFAULT 1,
        menu_item nvarchar(200) NULL,
        position int NOT NULL DEFAULT 0
      )`.execute(db);
      await sql`CREATE TABLE line_to_menu (
        product_line nvarchar(200) NOT NULL PRIMARY KEY,
        menu_target nvarchar(400) NOT NULL
      )`.execute(db);
      await sql`CREATE TABLE family_mappings (
        product_line nvarchar(200) NOT NULL,
        family nvarchar(200) NOT NULL,
        active tinyint NOT NULL DEFAULT 1,
        shopify_level2 nvarchar(200) NULL,
        shopify_level3 nvarchar(200) NULL,
        position int NOT NULL DEFAULT 0,
        CONSTRAINT pk_family_mappings PRIMARY KEY (product_line, family)
      )`.execute(db);
      // shopify-collection-mapping.json: nível (menu|familia|subfamilia) + chave → coleções Shopify
      await sql`CREATE TABLE collection_mapping (
        level nvarchar(20) NOT NULL,
        source_key nvarchar(400) NOT NULL,
        collection_id nvarchar(100) NOT NULL,
        position int NOT NULL DEFAULT 0,
        CONSTRAINT pk_collection_mapping PRIMARY KEY (level, source_key, collection_id)
      )`.execute(db);
      await sql`CREATE TABLE collection_mapping_hidden (
        hidden_key nvarchar(400) NOT NULL PRIMARY KEY
      )`.execute(db);
      // menu-items.json e public-menu-items.json (árvore)
      await sql`CREATE TABLE menu_nodes (
        id int IDENTITY(1,1) PRIMARY KEY,
        menu nvarchar(20) NOT NULL,            -- 'main' | 'public'
        parent_id int NULL REFERENCES menu_nodes(id),
        position int NOT NULL,
        title nvarchar(400) NOT NULL,
        shopify_id nvarchar(100) NULL
      )`.execute(db);
      await sql`CREATE INDEX ix_menu_nodes_menu_parent ON menu_nodes (menu, parent_id, position)`.execute(db);
      // sync-stats.json
      await sql`CREATE TABLE sync_history (
        id int IDENTITY(1,1) PRIMARY KEY,
        ran_at datetime2(0) NOT NULL,
        requested int NOT NULL DEFAULT 0, synced int NOT NULL DEFAULT 0, created int NOT NULL DEFAULT 0,
        updated int NOT NULL DEFAULT 0, errors int NOT NULL DEFAULT 0
      )`.execute(db);
      await sql`CREATE TABLE sync_latest_products (
        position int NOT NULL PRIMARY KEY,
        sku nvarchar(64) NOT NULL, title nvarchar(1000) NULL, action nvarchar(40) NULL, synced_at datetime2(0) NULL
      )`.execute(db);
      // Estados pequenos (totais do sync, sync-run, estatísticas do menu público, agendamento)
      await sql`CREATE TABLE app_state (
        name nvarchar(100) NOT NULL PRIMARY KEY,
        value nvarchar(max) NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(db);
    },
  },

  // Segurança: conta e registo (antes data/security/account.json e logs/security-audit.log).
  '0004_security': {
    async up(db: Kysely<any>) {
      await sql`CREATE TABLE app_account (
        username nvarchar(40) NOT NULL PRIMARY KEY,
        password_hash nvarchar(400) NOT NULL,
        changed_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(db);
      await sql`CREATE TABLE security_audit (
        id bigint IDENTITY(1,1) PRIMARY KEY,
        ts datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        event nvarchar(40) NOT NULL,
        ip nvarchar(64) NULL,
        username nvarchar(100) NULL,
        detail nvarchar(400) NULL
      )`.execute(db);
      await sql`CREATE INDEX ix_security_audit_ts ON security_audit (ts)`.execute(db);
    },
  },
};

/**
 * Registo próprio (tabela schema_migrations), em vez do Migrator do Kysely: o bloqueio dele
 * (sp_getapplock com @DbPrincipal = 'dbo') exige db_owner, e o utilizador da app só tem
 * datareader/datawriter/ddladmin. Cada migração corre numa transação.
 */
export async function migrateMssql(db: Kysely<any> = getMssql()): Promise<{ applied: string[] }> {
  await sql`IF OBJECT_ID('schema_migrations', 'U') IS NULL
    CREATE TABLE schema_migrations (
      name nvarchar(200) NOT NULL PRIMARY KEY,
      applied_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
    )`.execute(db);
  const done = new Set((await db.selectFrom('schema_migrations').select('name').execute()).map((r: any) => r.name));
  const applied: string[] = [];
  for (const name of Object.keys(migrations).sort()) {
    if (done.has(name)) continue;
    await db.transaction().execute(async trx => {
      await migrations[name].up(trx);
      await trx.insertInto('schema_migrations').values({ name }).execute();
    });
    applied.push(name);
  }
  return { applied };
}
