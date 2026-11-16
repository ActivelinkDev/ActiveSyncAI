import { loadPublicMenu, loadShopifyCollectionMapping } from '../repositories/store';
import { getSqlite } from '../../db/sqlite';
import type { MenuNode, ShopifyCollectionMapping } from '../types';

export interface FlatMenuNode {
  shopifyId: string;
  title: string;
  level: 1 | 2 | 3;
  parentId: string | null;
  grandParentId: string | null;
}

// ── Internal index types ────────────────────────────────────────────────────

// shopifyId → product_lines[]  (from mapping.menu + mapping.familia)
// shopifyId → families[]       (from mapping.familia + mapping.subfamilia)
interface NodeIndex {
  flat: FlatMenuNode[];
  byId: Map<string, FlatMenuNode>;
  // L3 nodes keyed by shopifyId → Set<family>
  l3ByFamily: Map<string, Set<string>>;
  // L2+L1 nodes keyed by shopifyId → Set<product_line>
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
      if (node.children?.length) {
        const nextLevel = Math.min(level + 1, 3) as 1 | 2 | 3;
        walk(node.children, nextLevel, node.shopifyId, parentId);
      }
    }
  }

  walk(menu.nodes || [], 1, null, null);

  // L3 nodes → families (from mapping.subfamilia which maps L3 shopifyId → product_lines[])
  // Per the architecture: L3 SHOPIFY → L2 SUPRIDES (family)
  const l3ByFamily = new Map<string, Set<string>>();
  for (const [shopifyId, lines] of Object.entries(mapping.subfamilia || {})) {
    if (!byId.has(shopifyId)) continue;
    const set = new Set<string>(lines.map(s => s.trim()).filter(Boolean));
    l3ByFamily.set(shopifyId, set);
  }

  // L2+L1 nodes → product_lines (from mapping.familia + mapping.menu)
  const l2l1ByLine = new Map<string, Set<string>>();
  for (const [shopifyId, lines] of Object.entries(mapping.familia || {})) {
    if (!byId.has(shopifyId)) continue;
    const set = new Set<string>(lines.map(s => s.trim()).filter(Boolean));
    l2l1ByLine.set(shopifyId, set);
  }
  for (const [shopifyId, lines] of Object.entries(mapping.menu || {})) {
    if (!byId.has(shopifyId)) continue;
    const existing = l2l1ByLine.get(shopifyId) ?? new Set<string>();
    for (const l of lines) { const t = l.trim(); if (t) existing.add(t); }
    l2l1ByLine.set(shopifyId, existing);
  }

  return { flat, byId, l3ByFamily, l2l1ByLine };
}

function getIndex(): NodeIndex {
  if (!_index) _index = buildIndex();
  return _index;
}

/** Invalida o cache do índice — chamar após recarregar o menu ou o mapping */
export function invalidateMenuIndex(): void {
  _index = null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Devolve a árvore flat de nós do menu público.
 */
export function getAllNodes(): FlatMenuNode[] {
  return getIndex().flat;
}

/**
 * Resolve o nó de menu mais específico para um produto.
 * Prioridade: L3 (via family) > L2 (via product_line) > L1 (via product_line).
 * Devolve null se não houver mapeamento.
 */
export function resolveNodeForProduct(product_line: string | undefined, family: string | undefined): string | null {
  const idx = getIndex();
  const pl = (product_line ?? '').trim();
  const fam = (family ?? '').trim();

  if (!pl && !fam) return null;

  // Tentar L3 via family
  if (fam) {
    for (const [shopifyId, families] of idx.l3ByFamily) {
      if (families.has(fam)) return shopifyId;
    }
  }

  // Tentar L2 ou L1 via product_line, preferindo o nó de nível mais baixo (mais específico)
  if (pl) {
    let bestNode: FlatMenuNode | null = null;
    for (const [shopifyId, lines] of idx.l2l1ByLine) {
      if (!lines.has(pl)) continue;
      const node = idx.byId.get(shopifyId);
      if (!node) continue;
      if (!bestNode || node.level > bestNode.level) {
        bestNode = node;
      }
    }
    if (bestNode) return bestNode.shopifyId;
  }

  return null;
}

/**
 * Devolve os ancestrais de um nó do mais geral para o mais específico,
 * incluindo o próprio nó no final: [L1, L2?, L3?]
 */
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

/**
 * Devolve todos os descendentes de um nó (filhos, netos), incluindo o próprio.
 */
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

/**
 * Conta quantos produtos na BD estão mapeados a um nó de menu específico
 * (inclui descendentes).
 */
export function getProductCount(shopifyId: string): number {
  const ids = getDescendants(shopifyId);
  if (!ids.length) return 0;

  const db = getSqlite();
  const placeholders = ids.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM suprides_products WHERE shopify_node_id IN (${placeholders})`
  ).get(...ids) as { cnt: number };

  return row?.cnt ?? 0;
}

/**
 * Conta apenas os produtos directamente mapeados a este nó (sem descendentes).
 */
export function getDirectProductCount(shopifyId: string): number {
  const db = getSqlite();
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM suprides_products WHERE shopify_node_id = ?`
  ).get(shopifyId) as { cnt: number };
  return row?.cnt ?? 0;
}

/**
 * Reconstrói o shopify_node_id de todos os produtos na BD.
 * Deve ser chamado após sync de produtos ou alteração do mapping.
 */
export function rebuildProductNodeIds(): { updated: number } {
  const db = getSqlite();
  invalidateMenuIndex();

  const products = db.prepare(
    `SELECT sku, product_line, family FROM suprides_products`
  ).all() as { sku: string; product_line: string | null; family: string | null }[];

  const stmt = db.prepare(`UPDATE suprides_products SET shopify_node_id = ? WHERE sku = ?`);

  const update = db.transaction(() => {
    let updated = 0;
    for (const p of products) {
      const nodeId = resolveNodeForProduct(p.product_line ?? undefined, p.family ?? undefined);
      stmt.run(nodeId, p.sku);
      if (nodeId) updated++;
    }
    return updated;
  });

  const updated = update();
  return { updated };
}
