import fs from 'fs';
import path from 'path';
import type { Margins, Mappings, AdminSettings, ConnectionSettings, SyncStats, ShopifyCollectionMapping, MenuItemsFile, MenuNode, CollectionMargins, PublicMenuFile, PublicMenuStats } from '../types';
import { dataPath } from '../../utils/data-dir';

const DATA_DIR = dataPath('suprides');

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

// ----- Margins -----
export function loadMargins(): Margins {
  return read<Margins>('margins.json', { linePricingRules: [], familyPricingRules: [], pricingRules: [] });
}
export function saveMargins(data: Margins): void { write('margins.json', data); }

// ----- Collection Margins -----
export function loadCollectionMargins(): CollectionMargins {
  return read<CollectionMargins>('collection-margins.json', { rules: {} });
}
export function saveCollectionMargins(data: CollectionMargins): void { write('collection-margins.json', data); }

// ----- Mappings -----
export function loadMappings(): Mappings {
  return read<Mappings>('mappings.json', { suprides: [], lineToMenu: {}, familyMappings: [] });
}
export function saveMappings(data: Mappings): void { write('mappings.json', data); }

// ----- Admin Settings -----
export function loadAdminSettings(): AdminSettings {
  return read<AdminSettings>('admin-settings.json', {
    ivaRate: 23,
    rounding: { aboveUnitTo999: true, belowUnitTo499: true }
  });
}
export function saveAdminSettings(data: AdminSettings): void { write('admin-settings.json', data); }

// ----- Connection Settings -----
export function loadConnectionSettings(): ConnectionSettings {
  return read<ConnectionSettings>('connection-settings.json', {});
}
export function saveConnectionSettings(data: ConnectionSettings): void {
  write('connection-settings.json', data);
}

// ----- Shopify Collection Mapping -----
export function loadShopifyCollectionMapping(): ShopifyCollectionMapping {
  return read<ShopifyCollectionMapping>('shopify-collection-mapping.json', { menu: {}, familia: {}, subfamilia: {} });
}
export function saveShopifyCollectionMapping(data: ShopifyCollectionMapping): void {
  write('shopify-collection-mapping.json', data);
}

// ----- Menu Items -----
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

// ----- Public Menu -----
const DEFAULT_PUBLIC_MENU: PublicMenuFile = {
  nodes: [],
  stats: { generatedAt: '', sourceNodes: 0, publicNodes: 0, hiddenNodes: 0, activeCollectionIds: [] }
};

export function loadPublicMenu(): PublicMenuFile {
  return read<PublicMenuFile>('public-menu-items.json', DEFAULT_PUBLIC_MENU);
}

export function savePublicMenu(data: PublicMenuFile): void {
  write('public-menu-items.json', data);
}

// ----- Sync Stats -----
const DEFAULT_STATS: SyncStats = {
  api: 'suprides',
  lastSyncAt: null,
  totals: { requested: 0, synced: 0, created: 0, updated: 0, errors: 0 },
  history: [],
  latestProducts: []
};
export function loadStats(): SyncStats { return read<SyncStats>('sync-stats.json', DEFAULT_STATS); }
export function saveStats(data: SyncStats): void { write('sync-stats.json', data); }
export function resetStats(): SyncStats { saveStats(DEFAULT_STATS); return DEFAULT_STATS; }

// ----- Custom AI Prompt -----
export function loadCustomPrompt(): string {
  return read<{ instructions: string }>('custom-prompt.json', { instructions: '' }).instructions ?? '';
}
export function saveCustomPrompt(instructions: string): void {
  write('custom-prompt.json', { instructions });
}

// ----- Products Cache -----
interface CacheFile { cachedAt: number; products: any[] }
const CACHE_TTL = 60 * 60 * 1000;

let memCache: any[] | null = null;
let memCacheAt = 0;
let fetchingPromise: Promise<any[]> | null = null;

// Carregar do disco ao iniciar
(function () {
  const raw = read<CacheFile | null>('products-cache.json', null);
  if (raw && Array.isArray(raw.products) && (Date.now() - (raw.cachedAt || 0)) < CACHE_TTL) {
    memCache   = raw.products;
    memCacheAt = raw.cachedAt;
  }
})();

export function getCachedProducts(): { products: any[] | null; age: number } {
  return { products: memCache, age: Date.now() - memCacheAt };
}

export function isCacheValid(): boolean {
  return !!memCache && (Date.now() - memCacheAt) < CACHE_TTL;
}

export function setCache(products: any[]): void {
  memCache   = products;
  memCacheAt = Date.now();
  write('products-cache.json', { cachedAt: memCacheAt, products });
}

export function getFetchingPromise(): Promise<any[]> | null { return fetchingPromise; }
export function setFetchingPromise(p: Promise<any[]> | null): void { fetchingPromise = p; }
