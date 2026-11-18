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
