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

  // Produtos e tags, centralizados (todos os fornecedores nas mesmas tabelas).
  // SKU único em toda a tabela (a Shopify também o exige); grupos de tags comuns a todos.
  // Campos 0/1 em tinyint (não bit) para o código continuar a comparar com números.
  '0002_products_and_tags': {
    async up(db: Kysely<any>) {
      await sql`CREATE TABLE products (
        id int IDENTITY(1,1) PRIMARY KEY,
        supplier nvarchar(20) NOT NULL DEFAULT 'suprides',
        sku nvarchar(64) NOT NULL CONSTRAINT uq_products_sku UNIQUE,
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
      for (const col of ['supplier', 'brand', 'family', 'product_line', 'shopify_node_id', 'shopify_product_id']) {
        await sql.raw(`CREATE INDEX ix_products_${col} ON products (${col})`).execute(db);
      }

      await sql`CREATE TABLE tag_groups (
        id int IDENTITY(1,1) PRIMARY KEY,
        nome nvarchar(200) NOT NULL CONSTRAINT uq_tag_groups_nome UNIQUE,
        descricao nvarchar(1000) NULL, unidade nvarchar(50) NULL,
        created_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(db);
      await sql`CREATE TABLE tag_values (
        id int IDENTITY(1,1) PRIMARY KEY,
        tag_group_id int NOT NULL REFERENCES tag_groups(id) ON DELETE CASCADE,
        value nvarchar(400) NOT NULL,
        CONSTRAINT uq_tag_values UNIQUE (tag_group_id, value)
      )`.execute(db);
      await sql`CREATE TABLE product_tags (
        sku nvarchar(64) NOT NULL,
        tag_group_id int NOT NULL REFERENCES tag_groups(id) ON DELETE CASCADE,
        value nvarchar(400) NOT NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_product_tags PRIMARY KEY (sku, tag_group_id)
      )`.execute(db);
      await sql`CREATE INDEX ix_product_tags_group ON product_tags (tag_group_id)`.execute(db);
      await sql`CREATE TABLE menu_tag_groups (
        shopify_id nvarchar(100) NOT NULL,
        tag_group_id int NOT NULL REFERENCES tag_groups(id) ON DELETE CASCADE,
        CONSTRAINT pk_menu_tag_groups PRIMARY KEY (shopify_id, tag_group_id)
      )`.execute(db);
      await sql`CREATE TABLE product_tags_normalized (
        product_ref nvarchar(64) NOT NULL,
        tag_group_id int NOT NULL REFERENCES tag_groups(id) ON DELETE CASCADE,
        normalized_value nvarchar(400) NOT NULL,
        updated_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_product_tags_normalized PRIMARY KEY (product_ref, tag_group_id)
      )`.execute(db);
      await sql`CREATE INDEX ix_product_tags_normalized_group ON product_tags_normalized (tag_group_id)`.execute(db);
      await sql`CREATE TABLE ai_tagged_products (
        sku nvarchar(64) NOT NULL PRIMARY KEY,
        processed_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
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
        supplier nvarchar(20) NOT NULL,
        product_line nvarchar(200) NOT NULL,
        active tinyint NOT NULL DEFAULT 1,
        menu_item nvarchar(200) NULL,
        position int NOT NULL DEFAULT 0,
        CONSTRAINT pk_line_mappings PRIMARY KEY (supplier, product_line)
      )`.execute(db);
      await sql`CREATE TABLE line_to_menu (
        supplier nvarchar(20) NOT NULL,
        product_line nvarchar(200) NOT NULL,
        menu_target nvarchar(400) NOT NULL,
        CONSTRAINT pk_line_to_menu PRIMARY KEY (supplier, product_line)
      )`.execute(db);
      await sql`CREATE TABLE family_mappings (
        supplier nvarchar(20) NOT NULL,
        product_line nvarchar(200) NOT NULL,
        family nvarchar(200) NOT NULL,
        active tinyint NOT NULL DEFAULT 1,
        shopify_level2 nvarchar(200) NULL,
        shopify_level3 nvarchar(200) NULL,
        position int NOT NULL DEFAULT 0,
        CONSTRAINT pk_family_mappings PRIMARY KEY (supplier, product_line, family)
      )`.execute(db);
      // shopify-collection-mapping.json: nível (menu|familia|subfamilia) + chave → coleções Shopify
      await sql`CREATE TABLE collection_mapping (
        supplier nvarchar(20) NOT NULL,
        level nvarchar(20) NOT NULL,
        source_key nvarchar(400) NOT NULL,
        collection_id nvarchar(100) NOT NULL,
        position int NOT NULL DEFAULT 0,
        CONSTRAINT pk_collection_mapping PRIMARY KEY (supplier, level, source_key, collection_id)
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
  '0005_config_import_details': {
    async up(db: Kysely<any>) {
      await sql`ALTER TABLE sync_history ALTER COLUMN ran_at datetime2(3) NOT NULL`.execute(db);
      await sql`ALTER TABLE sync_latest_products ALTER COLUMN synced_at datetime2(3) NULL`.execute(db);
      await sql`ALTER TABLE collection_mapping ADD source_position int NULL`.execute(db);
    },
  },
  '0006_sync_precision_and_order': {
    async up(db: Kysely<any>) {
      await sql`ALTER TABLE app_account ALTER COLUMN changed_at datetime2(3) NOT NULL`.execute(db);
      await sql`ALTER TABLE products ALTER COLUMN shopify_synced_at datetime2(3) NULL`.execute(db);
      await sql`IF COL_LENGTH('line_to_menu', 'position') IS NULL ALTER TABLE line_to_menu ADD position int NULL`.execute(db);
      await sql`IF COL_LENGTH('collection_margins', 'position') IS NULL ALTER TABLE collection_margins ADD position int NULL`.execute(db);
    },
  },

  // Um só fornecedor e nomes genéricos (19/11): sai a coluna supplier; price → cost,
  // pvpr → msrp, cor → color; tag_groups nome/descricao/unidade → name/description/unit;
  // product_tags_normalized.product_ref → sku.
  '0007_single_supplier_generic_names': {
    async up(db: Kysely<any>) {
      // Travão: não deitar fora dados de outro fornecedor (o histórico de preços só tem 'outro' deduzido do SKU).
      await sql`IF EXISTS (SELECT 1 FROM products WHERE supplier <> 'suprides')
          OR EXISTS (SELECT 1 FROM line_mappings WHERE supplier <> 'suprides')
          OR EXISTS (SELECT 1 FROM line_to_menu WHERE supplier <> 'suprides')
          OR EXISTS (SELECT 1 FROM family_mappings WHERE supplier <> 'suprides')
          OR EXISTS (SELECT 1 FROM collection_mapping WHERE supplier <> 'suprides')
        THROW 51001, 'Há dados de outro fornecedor: rever antes de passar a um só fornecedor.', 1;`.execute(db);

      // products: índice e valor por omissão da coluna supplier (nome gerado pelo SQL Server)
      await sql`DROP INDEX ix_products_supplier ON products`.execute(db);
      await sql`DECLARE @c sysname = (SELECT dc.name FROM sys.default_constraints dc
          JOIN sys.columns col ON col.object_id = dc.parent_object_id AND col.column_id = dc.parent_column_id
          WHERE dc.parent_object_id = OBJECT_ID('products') AND col.name = 'supplier');
        DECLARE @drop nvarchar(400) = N'ALTER TABLE products DROP CONSTRAINT ' + QUOTENAME(@c);
        IF @c IS NOT NULL EXEC sp_executesql @drop;`.execute(db);
      await sql`ALTER TABLE products DROP COLUMN supplier`.execute(db);
      await sql`EXEC sp_rename 'products.price', 'cost', 'COLUMN'`.execute(db);
      await sql`EXEC sp_rename 'products.pvpr', 'msrp', 'COLUMN'`.execute(db);
      await sql`EXEC sp_rename 'products.cor', 'color', 'COLUMN'`.execute(db);

      // Mapeamentos: supplier fazia parte da chave primária
      const keyed: [string, string, string][] = [
        ['line_mappings', 'pk_line_mappings', 'product_line'],
        ['line_to_menu', 'pk_line_to_menu', 'product_line'],
        ['family_mappings', 'pk_family_mappings', 'product_line, family'],
        ['collection_mapping', 'pk_collection_mapping', 'level, source_key, collection_id'],
      ];
      for (const [table, pk, cols] of keyed) {
        await sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT ${pk}`).execute(db);
        await sql.raw(`ALTER TABLE ${table} DROP COLUMN supplier`).execute(db);
        await sql.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${pk} PRIMARY KEY (${cols})`).execute(db);
      }
      await sql`ALTER TABLE price_current DROP COLUMN supplier`.execute(db);
      await sql`ALTER TABLE price_history DROP COLUMN supplier`.execute(db);

      // Tags
      await sql`EXEC sp_rename 'tag_groups.nome', 'name', 'COLUMN'`.execute(db);
      await sql`EXEC sp_rename 'tag_groups.descricao', 'description', 'COLUMN'`.execute(db);
      await sql`EXEC sp_rename 'tag_groups.unidade', 'unit', 'COLUMN'`.execute(db);
      await sql`EXEC sp_rename 'uq_tag_groups_nome', 'uq_tag_groups_name', 'OBJECT'`.execute(db);
      await sql`EXEC sp_rename 'product_tags_normalized.product_ref', 'sku', 'COLUMN'`.execute(db);
    },
  },

  // Preço base (fora de campanha) calculado pelo motor de preço e gravado em cada sync real:
  // é o preço que a loja tem sem promoção e o ponto de partida das campanhas (19/11).
  // NULL = o sync não gere o preço deste produto (sem custo, fora do mapeamento sem stock).
  '0008_products_base_price': {
    async up(db: Kysely<any>) {
      await sql`ALTER TABLE products ADD
        base_price decimal(12,2) NULL,
        base_margin_rule nvarchar(40) NULL,
        base_price_at datetime2(3) NULL`.execute(db);
    },
  },

  // Campanhas (promoções com a regra dos 30 dias). Datas em UTC.
  // Os valores de cada produto (base, referência, promocional, custo) ficam fixados no início.
  // applied_at / reverted_at: quando o preço promocional foi enviado para a loja e quando o
  // preço base foi reposto — o temporizador reconcilia por estas colunas (idempotente).
  '0009_campaigns': {
    async up(db: Kysely<any>) {
      await sql`CREATE TABLE campaigns (
        id int IDENTITY(1,1) CONSTRAINT pk_campaigns PRIMARY KEY,
        name nvarchar(200) NOT NULL,
        status nvarchar(20) NOT NULL CONSTRAINT df_campaigns_status DEFAULT 'RASCUNHO'
          CONSTRAINT ck_campaigns_status CHECK (status IN ('RASCUNHO','AGENDADA','ATIVA','TERMINADA','CANCELADA')),
        discount_type nvarchar(10) NOT NULL CONSTRAINT ck_campaigns_discount_type CHECK (discount_type IN ('PERCENT','AMOUNT')),
        discount_value decimal(12,2) NOT NULL CONSTRAINT ck_campaigns_discount_value CHECK (discount_value > 0),
        starts_at datetime2(0) NOT NULL,
        ends_at datetime2(0) NOT NULL,
        notes nvarchar(1000) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT df_campaigns_created DEFAULT SYSUTCDATETIME(),
        scheduled_at datetime2(0) NULL,
        started_at datetime2(0) NULL,
        ended_at datetime2(0) NULL,
        CONSTRAINT ck_campaigns_dates CHECK (ends_at > starts_at)
      )`.execute(db);
      await sql`CREATE INDEX ix_campaigns_status ON campaigns (status, starts_at, ends_at)`.execute(db);

      await sql`CREATE TABLE campaign_products (
        campaign_id int NOT NULL CONSTRAINT fk_campaign_products_campaign REFERENCES campaigns(id) ON DELETE CASCADE,
        sku nvarchar(64) NOT NULL,
        state nvarchar(20) NOT NULL CONSTRAINT df_campaign_products_state DEFAULT 'INCLUIDO'
          CONSTRAINT ck_campaign_products_state CHECK (state IN ('INCLUIDO','BLOQUEADO','RETIRADO')),
        block_reason nvarchar(20) NULL,
        warning nvarchar(20) NULL,
        override_type nvarchar(10) NULL CONSTRAINT ck_campaign_products_override CHECK (override_type IN ('PERCENT','AMOUNT')),
        override_value decimal(12,2) NULL,
        base_price decimal(12,2) NULL,
        reference_price decimal(12,2) NULL,
        promo_price decimal(12,2) NULL,
        cost_at_start decimal(14,4) NULL,
        applied_at datetime2(0) NULL,
        reverted_at datetime2(0) NULL,
        removed_at datetime2(0) NULL,
        removed_reason nvarchar(40) NULL,
        CONSTRAINT pk_campaign_products PRIMARY KEY (campaign_id, sku)
      )`.execute(db);
      await sql`CREATE INDEX ix_campaign_products_sku ON campaign_products (sku)`.execute(db);
      await sql`CREATE INDEX ix_price_history_campaign ON price_history (campaign_id)`.execute(db);
    },
  },
};

/**
 * Registo próprio (tabela schema_migrations), em vez do Migrator do Kysely: o bloqueio dele
 * (sp_getapplock com @DbPrincipal = 'dbo') exige db_owner, e o utilizador da app só tem
 * datareader/datawriter/ddladmin. O bloqueio em public serializa dois arranques na mesma BD.
 */
export async function migrateMssql(db: Kysely<any> = getMssql()): Promise<{ applied: string[] }> {
  return db.transaction().execute(async trx => {
    await sql`DECLARE @result int;
      EXEC @result = sys.sp_getapplock @Resource = N'ActiveSyncAI:schema_migrations',
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 60000, @DbPrincipal = 'public';
      IF @result < 0 THROW 51000, 'Não foi possível obter o bloqueio das migrações.', 1;`.execute(trx);
    await sql`IF OBJECT_ID('schema_migrations', 'U') IS NULL
      CREATE TABLE schema_migrations (
        name nvarchar(200) NOT NULL PRIMARY KEY,
        applied_at datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
      )`.execute(trx);
    const done = new Set((await trx.selectFrom('schema_migrations').select('name').execute()).map(r => r.name));
    const applied: string[] = [];
    for (const name of Object.keys(migrations).sort()) {
      if (done.has(name)) continue;
      await migrations[name].up(trx);
      await trx.insertInto('schema_migrations').values({ name }).execute();
      applied.push(name);
    }
    return { applied };
  });
}
