import { loadPublicMenu, loadShopifyCollectionMapping } from '../repositories/store';
import { getSqlite } from '../../db/sqlite';
import type { MenuNode, ShopifyCollectionMapping } from '../../suprides/types';

export interface FlatMenuNode {
  shopifyId: string;
  title: string;
  level: 1 | 2 | 3;
  parentId: string | null;
  grandParentId: string | null;
}

interface NodeIndex {
  flat: FlatMenuNode[];
  byId: Map<string, FlatMenuNode>;
  l3ByFamily: Map<string, Set<string>>;
  l2l1ByLine: Map<string, Set<string>>;
}

let _index: NodeIndex | null = null;

function buildIndex(): NodeIndex {
  const menu = loadPublicMenu();
  const mapping: ShopifyCollectionMapping = loadShopifyCollectionMapping();
  const flat: FlatMenuNode[] = [];
  const byId = new Map<string, FlatMenuNode>();

  function walk(nodes: MenuNode[], level: 1 | 2 | 3, parentId: string | null, grandParentId: string | null) {
    for (const node of nodes) {
      if (!node.shopifyId) continue;
      const n: FlatMenuNode = { shopifyId: node.shopifyId, title: node.title, level, parentId, grandParentId };
      flat.push(n);
      byId.set(node.shopifyId, n);
      if (node.children?.length) walk(node.children, Math.min(level + 1, 3) as 1 | 2 | 3, node.shopifyId, parentId);
    }
  }

  walk(menu.nodes || [], 1, null, null);

  const l3ByFamily = new Map<string, Set<string>>();
  for (const [shopifyId, families] of Object.entries(mapping.subfamilia || {})) {
    if (!byId.has(shopifyId)) continue;
    l3ByFamily.set(shopifyId, new Set(families.map(s => s.trim()).filter(Boolean)));
  }

  const l2l1ByLine = new Map<string, Set<string>>();
  for (const [shopifyId, lines] of Object.entries(mapping.familia || {})) {
    if (!byId.has(shopifyId)) continue;
    l2l1ByLine.set(shopifyId, new Set(lines.map(s => s.trim()).filter(Boolean)));
  }
  for (const [shopifyId, lines] of Object.entries(mapping.menu || {})) {
    if (!byId.has(shopifyId)) continue;
    const existing = l2l1ByLine.get(shopifyId) ?? new Set<string>();
    for (const line of lines) {
      const t = line.trim();
      if (t) existing.add(t);
    }
    l2l1ByLine.set(shopifyId, existing);
  }

  return { flat, byId, l3ByFamily, l2l1ByLine };
}

function getIndex(): NodeIndex {
  if (!_index) _index = buildIndex();
  return _index;
}

export function invalidateMenuIndex(): void {
  _index = null;
}

export function getAllNodes(): FlatMenuNode[] {
  return getIndex().flat;
}

export function resolveNodeForProduct(product_line: string | undefined, family: string | undefined): string | null {
  const idx = getIndex();
  const pl = (product_line ?? '').trim();
  const fam = (family ?? '').trim();

  if (fam) {
    for (const [shopifyId, families] of idx.l3ByFamily) {
      if (families.has(fam)) return shopifyId;
    }
  }

  if (pl) {
    let bestNode: FlatMenuNode | null = null;
    for (const [shopifyId, lines] of idx.l2l1ByLine) {
      if (!lines.has(pl)) continue;
      const node = idx.byId.get(shopifyId);
      if (node && (!bestNode || node.level > bestNode.level)) bestNode = node;
    }
    if (bestNode) return bestNode.shopifyId;
  }

  return null;
}

export function getAncestors(shopifyId: string): string[] {
  const idx = getIndex();
  const node = idx.byId.get(shopifyId);
  if (!node) return [];
  const chain: string[] = [];
  if (node.grandParentId) chain.push(node.grandParentId);
  if (node.parentId) chain.push(node.parentId);
  chain.push(shopifyId);
  return chain;
}

export function getDescendants(shopifyId: string): string[] {
  const idx = getIndex();
  const result: string[] = [];
  function collect(id: string) {
    result.push(id);
    for (const n of idx.flat) {
      if (n.parentId === id) collect(n.shopifyId);
    }
  }
  collect(shopifyId);
  return result;
}

export function getProductCount(shopifyId: string): number {
  const ids = getDescendants(shopifyId);
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const row = getSqlite().prepare(
    `SELECT COUNT(*) as cnt FROM esprinet_products WHERE shopify_node_id IN (${placeholders})`
  ).get(...ids) as { cnt: number };
  return row?.cnt ?? 0;
}

export function getDirectProductCount(shopifyId: string): number {
  const row = getSqlite().prepare(
    `SELECT COUNT(*) as cnt FROM esprinet_products WHERE shopify_node_id = ?`
  ).get(shopifyId) as { cnt: number };
  return row?.cnt ?? 0;
}

export function rebuildProductNodeIds(): { updated: number } {
  const db = getSqlite();
  invalidateMenuIndex();
  const products = db.prepare(
    `SELECT sku, product_line, family FROM esprinet_products`
  ).all() as { sku: string; product_line: string | null; family: string | null }[];
  const stmt = db.prepare(`UPDATE esprinet_products SET shopify_node_id = ? WHERE sku = ?`);

  const updated = db.transaction(() => {
    let count = 0;
    for (const p of products) {
      const nodeId = resolveNodeForProduct(p.product_line ?? undefined, p.family ?? undefined);
      stmt.run(nodeId, p.sku);
      if (nodeId) count++;
    }
    return count;
  })();

  return { updated };
}
