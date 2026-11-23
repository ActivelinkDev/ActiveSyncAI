import { AsyncLocalStorage } from 'node:async_hooks';
import type { Kysely } from 'kysely';
import { getMssql } from '../../db/mssql';
import { loadAppState, saveAppState } from '../../db/app-state';
import { encryptFields, decryptFields } from '../../security/secret-box';
import type {
  Mappings, AdminSettings, ConnectionSettings, SyncStats, ShopifyCollectionMapping,
  MenuNode, CollectionMargins, PublicMenuFile, PublicMenuStats,
} from '../types';

const levels = ['menu', 'familia', 'subfamilia'] as const;
type Db = Kysely<any>;
type Row = Record<string, any>;

function transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return getMssql().transaction().setIsolationLevel('serializable').execute(fn);
}

async function insertRows(db: Db, table: string, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const batchSize = Math.min(1000, Math.floor(2000 / Object.keys(rows[0]).length));
  for (let i = 0; i < rows.length; i += batchSize) {
    await db.insertInto(table).values(rows.slice(i, i + batchSize)).execute();
  }
}

export async function loadCollectionMargins(): Promise<CollectionMargins> {
  const rows = await getMssql().selectFrom('collection_margins').selectAll().orderBy('position').orderBy('collection_id').execute();
  return { rules: Object.fromEntries(rows.map(r => [r.collection_id, {
    mode: r.mode, marginValue: r.margin_value, ...(r.title == null ? {} : { _title: r.title }),
  }])) };
}

export async function saveCollectionMargins(data: CollectionMargins): Promise<void> {
  await transaction(async db => {
    await db.deleteFrom('collection_margins').execute();
    await insertRows(db, 'collection_margins', Object.entries(data.rules).map(([id, r], position) => ({
      collection_id: id, mode: r.mode, margin_value: r.marginValue, title: r._title ?? null, position,
    })));
  });
}

export async function loadMappings(): Promise<Mappings> {
  return transaction(async db => {
    const lines = await db.selectFrom('line_mappings').selectAll().orderBy('position').execute();
    const targets = await db.selectFrom('line_to_menu').selectAll().orderBy('position').orderBy('product_line').execute();
    const families = await db.selectFrom('family_mappings').selectAll().orderBy('position').execute();
    return {
      suprides: lines.map(r => ({ product_line: r.product_line, active: !!r.active,
        ...(r.menu_item == null ? {} : { menuItem: r.menu_item }) })),
      lineToMenu: Object.fromEntries(targets.map(r => [r.product_line, r.menu_target])),
      familyMappings: families.map(r => ({ product_line: r.product_line, family: r.family, active: !!r.active,
        ...(r.shopify_level2 == null ? {} : { shopifyLevel2: r.shopify_level2 }),
        ...(r.shopify_level3 == null ? {} : { shopifyLevel3: r.shopify_level3 }) })),
    };
  });
}

export async function saveMappings(data: Mappings): Promise<void> {
  await transaction(async db => {
    for (const table of ['line_mappings', 'line_to_menu', 'family_mappings']) {
      await db.deleteFrom(table).execute();
    }
    await insertRows(db, 'line_mappings', (data.suprides ?? []).map((l, position) => ({
      position, product_line: l.product_line, active: Number(l.active !== false), menu_item: l.menuItem ?? null,
    })));
    await insertRows(db, 'line_to_menu', Object.entries(data.lineToMenu ?? {}).map(([line, target], position) => ({
      product_line: line, menu_target: target, position,
    })));
    await insertRows(db, 'family_mappings', (data.familyMappings ?? []).map((f, position) => ({
      position, product_line: f.product_line, family: f.family, active: Number(f.active !== false),
      shopify_level2: f.shopifyLevel2 ?? null, shopify_level3: f.shopifyLevel3 ?? null,
    })));
  });
}

export async function loadAdminSettings(): Promise<AdminSettings> {
  const row = await getMssql().selectFrom('admin_settings').selectAll().where('id', '=', 1).executeTakeFirst();
  if (!row) return { ivaRate: 23, rounding: { aboveUnitTo999: true, belowUnitTo499: true } };
  return {
    ivaRate: row.iva_rate,
    rounding: { aboveUnitTo999: !!row.rounding_above_unit_to_999, belowUnitTo499: !!row.rounding_below_unit_to_499 },
    ...(row.auto_publish_public_menu == null ? {} : { autoPublishPublicMenu: !!row.auto_publish_public_menu }),
    ...(row.create_new_products == null ? {} : { createNewProducts: !!row.create_new_products }),
    ...(row.public_menu_handle == null ? {} : { publicMenuHandle: row.public_menu_handle }),
    ...(row.public_menu_title == null ? {} : { publicMenuTitle: row.public_menu_title }),
  };
}

export async function saveAdminSettings(data: AdminSettings): Promise<void> {
  await transaction(async db => {
    await db.deleteFrom('admin_settings').where('id', '=', 1).execute();
    await db.insertInto('admin_settings').values({
      id: 1, iva_rate: data.ivaRate, rounding_above_unit_to_999: Number(data.rounding.aboveUnitTo999),
      rounding_below_unit_to_499: Number(data.rounding.belowUnitTo499),
      auto_publish_public_menu: data.autoPublishPublicMenu == null ? null : Number(data.autoPublishPublicMenu),
      create_new_products: data.createNewProducts == null ? null : Number(data.createNewProducts),
      public_menu_handle: data.publicMenuHandle ?? null, public_menu_title: data.publicMenuTitle ?? null,
    }).execute();
  });
}

const connections = new AsyncLocalStorage<{ pending?: Promise<ConnectionSettings> }>();

export function withConnectionSettings<T>(work: () => T): T {
  return connections.run({}, work);
}

async function readConnectionSettings(): Promise<ConnectionSettings> {
  const rows = await getMssql().selectFrom('connection_settings').select(['name', 'value']).execute();
  return decryptFields(Object.fromEntries(rows.map(r => [r.name, r.value])));
}

export function loadConnectionSettings(): Promise<ConnectionSettings> {
  const scope = connections.getStore();
  if (!scope) return readConnectionSettings();
  if (!scope.pending) {
    const request = readConnectionSettings().catch(error => {
      if (scope.pending === request) delete scope.pending;
      throw error;
    });
    scope.pending = request;
  }
  return scope.pending;
}

export async function saveConnectionSettings(data: ConnectionSettings): Promise<void> {
  const encrypted = Object.entries(encryptFields(data));
  await transaction(async db => {
    await db.deleteFrom('connection_settings').execute();
    await insertRows(db, 'connection_settings', encrypted.map(([name, value]) => ({ name, value })));
  });
  const scope = connections.getStore();
  if (scope) delete scope.pending;
}

export async function loadCustomPrompt(): Promise<string> {
  const row = await getMssql().selectFrom('ai_prompts').select('text').where('name', '=', 'suprides_instructions').executeTakeFirst();
  return row?.text ?? '';
}

export async function saveCustomPrompt(instructions: string): Promise<void> {
  await transaction(async db => {
    await db.deleteFrom('ai_prompts').where('name', '=', 'suprides_instructions').execute();
    await db.insertInto('ai_prompts').values({ name: 'suprides_instructions', text: instructions }).execute();
  });
}

export async function loadShopifyCollectionMapping(): Promise<ShopifyCollectionMapping> {
  return transaction(async db => {
    const rows = await db.selectFrom('collection_mapping').selectAll()
      .orderBy('level').orderBy('source_position').orderBy('source_key').orderBy('position').execute();
    const hidden = await db.selectFrom('collection_mapping_hidden').select('hidden_key').execute();
    const map: ShopifyCollectionMapping = { menu: {}, familia: {}, subfamilia: {} };
    for (const level of levels) {
      const section = new Map<string, string[]>();
      for (const row of rows) {
        if (row.level !== level) continue;
        const values = section.get(row.source_key) ?? [];
        values.push(row.collection_id);
        section.set(row.source_key, values);
      }
      map[level] = Object.fromEntries(section);
    }
    if (hidden.length) map.hidden = Object.fromEntries(hidden.map(r => [r.hidden_key, true]));
    return map;
  });
}

export async function saveShopifyCollectionMapping(data: ShopifyCollectionMapping): Promise<void> {
  await transaction(async db => {
    await db.deleteFrom('collection_mapping').execute();
    await db.deleteFrom('collection_mapping_hidden').execute();
    const rows: Row[] = [];
    for (const level of levels) {
      Object.entries(data[level]).forEach(([key, values], sourcePosition) => {
        [...new Set(values)].forEach((value, position) => rows.push({
          level, source_key: key, source_position: sourcePosition, collection_id: value, position,
        }));
      });
    }
    await insertRows(db, 'collection_mapping', rows);
    await insertRows(db, 'collection_mapping_hidden', Object.entries(data.hidden ?? {})
      .filter(([, hidden]) => hidden).map(([hidden_key]) => ({ hidden_key })));
  });
}

function normalizeMenuNodes(nodes: MenuNode[]): MenuNode[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map(node => ({
    title: String(node?.title || '').trim(),
    ...(node?.shopifyId ? { shopifyId: String(node.shopifyId) } : {}),
    children: normalizeMenuNodes(node?.children ?? []),
  })).filter(node => node.title.length > 0);
}

type Menu = 'main' | 'public';

async function readMenu(db: Db, menu: Menu): Promise<MenuNode[]> {
  const rows = await db.selectFrom('menu_nodes').selectAll().where('menu', '=', menu)
    .orderBy('parent_id').orderBy('position').orderBy('id').execute();
  const byId = new Map<number, MenuNode>();
  const roots: MenuNode[] = [];
  for (const row of rows) {
    byId.set(row.id, { title: row.title, ...(row.shopify_id == null ? {} : { shopifyId: row.shopify_id }), children: [] });
  }
  for (const row of rows) {
    const siblings = row.parent_id == null ? roots : byId.get(row.parent_id)!.children;
    siblings.push(byId.get(row.id)!);
  }
  return roots;
}

async function writeMenu(db: Db, menu: Menu, nodes: MenuNode[]): Promise<void> {
  await db.deleteFrom('menu_nodes').where('menu', '=', menu).execute();
  let level = nodes.map((node, position) => ({ node, position, parent_id: null as number | null }));
  while (level.length) {
    const next: typeof level = [];
    // 400 nós × 5 campos, dentro do limite de parâmetros do SQL Server.
    for (let i = 0; i < level.length; i += 400) {
      const batch = level.slice(i, i + 400);
      const parents = await db.insertInto('menu_nodes').values(batch.map(({ node, parent_id, position }) => ({
        menu, parent_id, position, title: node.title, shopify_id: node.shopifyId ?? null,
      }))).output(['inserted.id', 'inserted.parent_id', 'inserted.position']).execute();
      // OUTPUT não garante a ordem dos registos inseridos.
      const ids = new Map(parents.map(row => [`${row.parent_id}/${row.position}`, row.id]));
      for (const { node, parent_id, position } of batch) {
        const id = ids.get(`${parent_id}/${position}`)!;
        node.children.forEach((child, pos) => next.push({ node: child, position: pos, parent_id: id }));
      }
    }
    level = next;
  }
}

export async function loadMenuItems(): Promise<MenuNode[]> {
  return normalizeMenuNodes(await readMenu(getMssql(), 'main'));
}

export async function saveMenuItems(nodes: MenuNode[]): Promise<MenuNode[]> {
  const normalized = normalizeMenuNodes(nodes);
  await transaction(db => writeMenu(db, 'main', normalized));
  return normalized;
}

export function loadPublicMenu(): Promise<PublicMenuFile> {
  return transaction(async db => ({
    nodes: await readMenu(db, 'public'),
    stats: await loadAppState<PublicMenuStats>('public_menu_stats',
      { generatedAt: '', sourceNodes: 0, publicNodes: 0, hiddenNodes: 0, activeCollectionIds: [] }, db),
  }));
}

export function savePublicMenu(data: PublicMenuFile): Promise<void> {
  return transaction(async db => {
    await writeMenu(db, 'public', data.nodes);
    await saveAppState('public_menu_stats', data.stats, db);
  });
}

const defaultStats: SyncStats = {
  api: 'suprides', lastSyncAt: null, totals: { requested: 0, synced: 0, created: 0, updated: 0, errors: 0 },
  history: [], latestProducts: [],
};

export async function loadStats(): Promise<SyncStats> {
  return transaction(async db => {
    const state = await loadAppState('sync_stats', defaultStats, db);
    const history = await db.selectFrom('sync_history').selectAll().orderBy('id').execute();
    const latest = await db.selectFrom('sync_latest_products').selectAll().orderBy('position').execute();
    return {
      ...state,
      history: history.map(r => ({
        timestamp: r.ran_at.toISOString(), requested: r.requested, synced: r.synced,
        created: r.created, updated: r.updated, errors: r.errors,
      })),
      latestProducts: latest.map(r => ({ sku: r.sku, title: r.title, action: r.action, syncedAt: r.synced_at?.toISOString() })),
    };
  });
}

export function saveStats(data: SyncStats): Promise<void> {
  return transaction(async db => {
    await saveAppState('sync_stats', { api: data.api, lastSyncAt: data.lastSyncAt, totals: data.totals }, db);
    await db.deleteFrom('sync_history').execute();
    await db.deleteFrom('sync_latest_products').execute();
    await insertRows(db, 'sync_history', data.history.map(h => ({
      ran_at: h.timestamp, requested: h.requested, synced: h.synced, created: h.created, updated: h.updated, errors: h.errors,
    })));
    await insertRows(db, 'sync_latest_products', data.latestProducts.map((p, position) => ({
      position, sku: p.sku, title: p.title, action: p.action, synced_at: p.syncedAt,
    })));
  });
}

export async function resetStats(): Promise<SyncStats> {
  await saveStats(defaultStats);
  return structuredClone(defaultStats);
}
