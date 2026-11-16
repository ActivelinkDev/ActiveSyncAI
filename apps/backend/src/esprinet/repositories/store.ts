import fs from 'fs';
import path from 'path';
import type { Margins, Mappings, AdminSettings, ConnectionSettings, SyncStats, ShopifyCollectionMapping, MenuItemsFile, MenuNode, CollectionMargins, PublicMenuFile } from '../../suprides/types';
import { dataPath } from '../../utils/data-dir';

const DATA_DIR = dataPath('esprinet');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function read<T>(file: string, def: T): T {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return def; }
}

function write(file: string, data: unknown): void {
  ensureDir();
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.tmp`;
  const backup = `${target}.bak`;
  if (fs.existsSync(target)) fs.copyFileSync(target, backup);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

export function loadMargins(): Margins {
  return read<Margins>('margins.json', { linePricingRules: [], familyPricingRules: [], pricingRules: [] });
}
export function saveMargins(data: Margins): void { write('margins.json', data); }

export function loadCollectionMargins(): CollectionMargins {
  return read<CollectionMargins>('collection-margins.json', { rules: {} });
}
export function saveCollectionMargins(data: CollectionMargins): void { write('collection-margins.json', data); }

export function loadMappings(): Mappings {
  return read<Mappings>('mappings.json', { suprides: [], lineToMenu: {}, familyMappings: [] });
}
export function saveMappings(data: Mappings): void { write('mappings.json', data); }

export function loadAdminSettings(): AdminSettings {
  return read<AdminSettings>('admin-settings.json', {
    ivaRate: 23,
    rounding: { aboveUnitTo999: true, belowUnitTo499: true }
  });
}
export function saveAdminSettings(data: AdminSettings): void { write('admin-settings.json', data); }

export function loadConnectionSettings(): ConnectionSettings {
  return read<ConnectionSettings>('connection-settings.json', {});
}
export function saveConnectionSettings(data: ConnectionSettings): void { write('connection-settings.json', data); }

export function loadShopifyCollectionMapping(): ShopifyCollectionMapping {
  return read<ShopifyCollectionMapping>('shopify-collection-mapping.json', { menu: {}, familia: {}, subfamilia: {} });
}
export function saveShopifyCollectionMapping(data: ShopifyCollectionMapping): void {
  write('shopify-collection-mapping.json', data);
}

function normalizeMenuNodes(nodes: MenuNode[]): MenuNode[] {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map(node => ({
      title: String(node?.title || '').trim(),
      shopifyId: node?.shopifyId ? String(node.shopifyId) : undefined,
      children: normalizeMenuNodes(node?.children || [])
    }))
    .filter(node => node.title.length > 0);
}

export function loadMenuItems(): MenuNode[] {
  const data = read<MenuItemsFile>('menu-items.json', { nodes: [] });
  return normalizeMenuNodes(data.nodes);
}

export function saveMenuItems(nodes: MenuNode[]): MenuNode[] {
  const normalized = normalizeMenuNodes(nodes);
  write('menu-items.json', { nodes: normalized });
  return normalized;
}

const DEFAULT_PUBLIC_MENU: PublicMenuFile = {
  nodes: [],
  stats: { generatedAt: '', sourceNodes: 0, publicNodes: 0, hiddenNodes: 0, activeCollectionIds: [] }
};

export function loadPublicMenu(): PublicMenuFile {
  const localNodes = loadMenuItems();
  if (localNodes.length) return { ...DEFAULT_PUBLIC_MENU, nodes: localNodes };
  return read<PublicMenuFile>('public-menu-items.json', DEFAULT_PUBLIC_MENU);
}

export function savePublicMenu(data: PublicMenuFile): void {
  write('public-menu-items.json', data);
}

const DEFAULT_STATS: SyncStats = {
  api: 'esprinet',
  lastSyncAt: null,
  totals: { requested: 0, synced: 0, created: 0, updated: 0, errors: 0 },
  history: [],
  latestProducts: []
};
export function loadStats(): SyncStats { return read<SyncStats>('sync-stats.json', DEFAULT_STATS); }
export function saveStats(data: SyncStats): void { write('sync-stats.json', data); }
export function resetStats(): SyncStats { saveStats(DEFAULT_STATS); return DEFAULT_STATS; }

export function loadCustomPrompt(): string {
  return read<{ instructions: string }>('custom-prompt.json', { instructions: '' }).instructions ?? '';
}
export function saveCustomPrompt(instructions: string): void {
  write('custom-prompt.json', { instructions });
}
