/**
 * Compara a configuração lida pelo backend com os ficheiros legados sem expor os valores.
 * O modo explícito --restore-import-details requer a migração 0006 e recupera apenas
 * posições e frações de segundo perdidas pela primeira versão do importador.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { isDeepStrictEqual as same } from 'node:util';
import { sql, type Kysely } from 'kysely';
import { closeMssql, getMssql } from '../db/mssql';
import { loadAppState } from '../db/app-state';
import { dataPath } from '../utils/data-dir';
import { decryptFields } from '../security/secret-box';
import * as store from '../suprides/repositories/store';
import type { SyncStats, ShopifyCollectionMapping, CollectionMargins, Mappings } from '../suprides/types';

type Db = Kysely<any>;
type Row = Record<string, any>;
const levels = ['menu', 'familia', 'subfamilia'] as const;
const restore = process.argv.includes('--restore-import-details');
const errors: string[] = [];
let stage = 'ligação ao SQL Server';

function json<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const legacy = <T>(name: string, fallback: T) => json(dataPath('suprides', name + '.json'), fallback);

async function compare(label: string, expected: unknown, read: () => Promise<unknown>): Promise<void> {
  stage = label;
  const actual = await read();
  const ok = same(expected, actual);
  if (!ok) errors.push(label);
  console.log(`${ok ? 'OK' : 'DIFERENTE'}  ${label}`);
}

function roundedSecond(iso: string): string {
  return new Date(Math.round(Date.parse(iso) / 1000) * 1000).toISOString();
}

const emptyStats: SyncStats = {
  api: 'suprides', lastSyncAt: null, totals: { requested: 0, synced: 0, created: 0, updated: 0, errors: 0 },
  history: [], latestProducts: [],
};

async function restoreStats(db: Db, stats: SyncStats): Promise<void> {
  const { history, latestProducts, ...header } = stats;
  if (!same(await loadAppState('sync_stats', null, db), header)) return;
  const historyRows = await db.selectFrom('sync_history').selectAll().orderBy('id').execute();
  if (historyRows.length === history.length) {
    for (const [i, row] of historyRows.entries()) {
      const { id, ran_at, ...counts } = row;
      const { timestamp, ...originalCounts } = history[i];
      if (same(counts, originalCounts) && ran_at.toISOString() === roundedSecond(timestamp) && ran_at.toISOString() !== timestamp) {
        await db.updateTable('sync_history').set({ ran_at: timestamp }).where('id', '=', id).execute();
      }
    }
  }
  const latestRows = await db.selectFrom('sync_latest_products').selectAll().execute();
  for (const { position, synced_at, ...metadata } of latestRows) {
    const product = latestProducts[position];
    if (!product || !synced_at) continue;
    const { syncedAt, ...originalMetadata } = product;
    if (same(metadata, originalMetadata) && synced_at.toISOString() === roundedSecond(syncedAt) && synced_at.toISOString() !== syncedAt) {
      await db.updateTable('sync_latest_products').set({ synced_at: syncedAt }).where('position', '=', position).execute();
    }
  }
}

async function restoreOrder(db: Db, mapping: ShopifyCollectionMapping, margins: CollectionMargins, mappings: Mappings): Promise<void> {
  // Cada linha alterada contém ainda os valores do JSON e não tem uma posição atribuída.
  for (const level of levels) {
    for (const [position, [key, values]] of Object.entries(mapping[level]).entries()) {
      const query = db.selectFrom('collection_mapping').select(['collection_id', 'position', 'source_position'])
        .where('supplier', '=', 'suprides').where('level', '=', level).where('source_key', '=', key).orderBy('position');
      const rows = await query.execute();
      if (!rows.length || !rows.every(r => r.source_position == null) || !same(rows.map(r => r.collection_id), values)) continue;
      await db.updateTable('collection_mapping').set({ source_position: position }).where('supplier', '=', 'suprides')
        .where('level', '=', level).where('source_key', '=', key).where('source_position', 'is', null).execute();
    }
  }
  for (const [position, [line, target]] of Object.entries(mappings.lineToMenu ?? {}).entries()) {
    await db.updateTable('line_to_menu').set({ position }).where('supplier', '=', 'suprides')
      .where('product_line', '=', line).where('menu_target', '=', target).where('position', 'is', null).execute();
  }
  for (const [position, [id, rule]] of Object.entries(margins.rules).entries()) {
    await db.updateTable('collection_margins').set({ position }).where('collection_id', '=', id)
      .where('mode', '=', rule.mode).where('margin_value', '=', rule.marginValue).where('position', 'is', null)
      .where('title', rule._title == null ? 'is' : '=', rule._title ?? null).execute();
  }
}

async function restoreAccount(db: Db, account: Row | null): Promise<void> {
  if (!account?.changedAt) return;
  await db.updateTable('app_account').set({ changed_at: account.changedAt })
    .where('username', '=', account.username).where('password_hash', '=', account.passwordHash)
    .where('changed_at', '=', roundedSecond(account.changedAt)).where('changed_at', '!=', account.changedAt).execute();
}

async function productTimes(db: Db): Promise<number | null> {
  const file = dataPath('suprides', 'suprides.db');
  if (!fs.existsSync(file)) return null;
  // SQLite só é necessário nesta ferramenta de transição.
  const { DatabaseSync } = await import('node:sqlite');
  const lite = new DatabaseSync(file, { readOnly: true });
  let pending = 0;
  try {
    const rows = lite.prepare(`SELECT sku, shopify_synced_at AS stamp, shopify_content_hash AS hash,
      shopify_product_id AS product_id FROM suprides_products WHERE shopify_synced_at IS NOT NULL`).all();
    for (let i = 0; i < rows.length; i += 1000) {
      const from = sql`FROM products AS p JOIN OPENJSON(${JSON.stringify(rows.slice(i, i + 1000))})
        WITH (sku nvarchar(64), stamp nvarchar(40), hash nvarchar(100), product_id bigint) AS legacy
        ON p.supplier = 'suprides' AND p.sku = legacy.sku
        WHERE p.shopify_synced_at = CONVERT(datetime2(0), legacy.stamp)
          AND p.shopify_synced_at <> CONVERT(datetime2(3), legacy.stamp)
          AND (p.shopify_content_hash = legacy.hash OR (p.shopify_content_hash IS NULL AND legacy.hash IS NULL))
          AND (p.shopify_product_id = legacy.product_id OR (p.shopify_product_id IS NULL AND legacy.product_id IS NULL))`;
      if (restore) await sql`UPDATE p SET shopify_synced_at = CONVERT(datetime2(3), legacy.stamp) ${from}`.execute(db);
      else pending += (await sql<{ n: number }>`SELECT COUNT(*) AS n ${from}`.execute(db)).rows[0].n;
    }
  } finally { lite.close(); }
  return pending;
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--restore-import-details')) throw new Error('argumento');
  const db = getMssql();
  stage = 'verificação da migração 0006';
  if (!await db.selectFrom('schema_migrations').select('name').where('name', '=', '0006_sync_precision_and_order').executeTakeFirst()) {
    console.error('A migração 0006_sync_precision_and_order ainda está por aplicar.');
    process.exitCode = 1;
    return;
  }
  const margins = legacy<CollectionMargins>('collection-margins', { rules: {} });
  const mappings = legacy<Mappings>('mappings', { suprides: [], lineToMenu: {}, familyMappings: [] });
  const mapping = legacy<ShopifyCollectionMapping>('shopify-collection-mapping', { menu: {}, familia: {}, subfamilia: {} });
  const stats = legacy('sync-stats', emptyStats);
  const account = json<Row | null>(dataPath('security', 'account.json'), null);
  if (restore) {
    stage = 'reposição dos metadados da importação';
    await db.transaction().setIsolationLevel('serializable').execute(async trx => {
      await restoreOrder(trx, mapping, margins, mappings);
      await restoreStats(trx, stats);
      await restoreAccount(trx, account);
      await productTimes(trx);
    });
  }
  await compare('admin-settings', legacy('admin-settings', { ivaRate: 23, rounding: { aboveUnitTo999: true, belowUnitTo499: true } }), store.loadAdminSettings);
  await compare('connection-settings', decryptFields(legacy('connection-settings', {})), store.loadConnectionSettings);
  await compare('custom-prompt', legacy('custom-prompt', { instructions: '' }).instructions ?? '', store.loadCustomPrompt);
  await compare('collection-margins', Object.entries(margins.rules), async () => Object.entries((await store.loadCollectionMargins()).rules));
  await compare('mappings', mappings, store.loadMappings);
  await compare('ordem de lineToMenu', Object.keys(mappings.lineToMenu ?? {}), async () => Object.keys((await store.loadMappings()).lineToMenu ?? {}));
  await compare('shopify-collection-mapping', mapping, store.loadShopifyCollectionMapping);
  const order = (m: ShopifyCollectionMapping) => levels.map(level => Object.keys(m[level]));
  await compare('ordem das coleções', order(mapping), async () => order(await store.loadShopifyCollectionMapping()));
  await compare('menu-items', legacy('menu-items', { nodes: [] }).nodes, store.loadMenuItems);
  await compare('public-menu-items', legacy('public-menu-items', {
    nodes: [], stats: { generatedAt: '', sourceNodes: 0, publicNodes: 0, hiddenNodes: 0, activeCollectionIds: [] },
  }), store.loadPublicMenu);
  await compare('sync-stats', stats, store.loadStats);
  await compare('sync-run', legacy('sync-run', null), () => loadAppState('sync_run', null));
  await compare('scheduler-state', json(dataPath('scheduler-state.json'), null), () => loadAppState('scheduler_state', null));
  if (account) {
    await compare('conta', account, async () => {
      const row = await db.selectFrom('app_account').selectAll().where('username', '=', account.username).executeTakeFirst();
      return row && { username: row.username, passwordHash: row.password_hash, changedAt: row.changed_at.toISOString() };
    });
  }
  stage = 'marcas de sincronização dos produtos';
  if (!restore) {
    const count = await productTimes(db);
    if (count != null) await compare(stage, 0, async () => count);
  }
  if (errors.length) process.exitCode = 1;
}

main().catch(() => {
  console.error(`Falha durante ${stage}.`);
  process.exitCode = 1;
}).finally(closeMssql);
