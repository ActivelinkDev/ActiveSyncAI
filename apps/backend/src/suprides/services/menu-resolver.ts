import { loadPublicMenu, loadShopifyCollectionMapping } from '../repositories/store';
import { sql } from 'kysely';
import { getMssql } from '../../db/mssql';
import type { MenuNode } from '../types';

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

let pendingIndex: Promise<NodeIndex> | null = null;

async function buildIndex(): Promise<NodeIndex> {
  const [menu, mapping] = await Promise.all([loadPublicMenu(), loadShopifyCollectionMapping()]);

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

function getIndex(): Promise<NodeIndex> {
  if (!pendingIndex) {
    const request = buildIndex().finally(() => { if (pendingIndex === request) pendingIndex = null; });
    pendingIndex = request;
  }
  return pendingIndex;
}

/** Invalida o cache do índice — chamar após recarregar o menu ou o mapping */
export function invalidateMenuIndex(): void {
  pendingIndex = null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Devolve a árvore flat de nós do menu público.
 */
export async function getAllNodes(): Promise<FlatMenuNode[]> {
  return (await getIndex()).flat;
}

/**
 * Resolve o nó de menu mais específico para um produto.
 * Prioridade: L3 (via family) > L2 (via product_line) > L1 (via product_line).
 * Devolve null se não houver mapeamento.
 */
function resolveNode(idx: NodeIndex, product_line: string | undefined, family: string | undefined): string | null {
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
export async function getAncestors(shopifyId: string): Promise<string[]> {
  const idx = await getIndex();
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
export async function getDescendants(shopifyId: string): Promise<string[]> {
  const idx = await getIndex();
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

export async function getProductsForMenuNode(shopifyId: string, directOnly: boolean): Promise<{ sku: string; name: string | null }[]> {
  const ids = directOnly ? [shopifyId] : await getDescendants(shopifyId);
  const { rows } = await sql<{ sku: string; name: string | null }>`
    SELECT sku, name FROM products WHERE shopify_node_id IN
      (SELECT value FROM OPENJSON(${JSON.stringify(ids)})) ORDER BY name, sku`.execute(getMssql());
  return rows;
}

/** Conta numa única passagem pela BD, incluindo os produtos dos descendentes. */
export async function getMenuWithProductCounts() {
  const [nodes, counts] = await Promise.all([
    getAllNodes(),
    getMssql().selectFrom("products")
      .where("shopify_node_id", "is not", null).groupBy("shopify_node_id")
      .select(["shopify_node_id", sql<number>`COUNT(*)`.as("n")]).execute(),
  ]);
  const direct = new Map(counts.map(row => [row.shopify_node_id, row.n]));
  const total = new Map(direct);
  // Os pais precedem sempre os filhos na travessia do menu.
  for (const node of [...nodes].reverse()) {
    if (node.parentId) {
      total.set(node.parentId, (total.get(node.parentId) ?? 0) + (total.get(node.shopifyId) ?? 0));
    }
  }
  return nodes.map(node => ({
    ...node, directProductCount: direct.get(node.shopifyId) ?? 0, productCount: total.get(node.shopifyId) ?? 0,
  }));
}

export async function rebuildProductNodeIds(): Promise<{ updated: number }> {
  const index = await getIndex();
  return getMssql().transaction().setIsolationLevel("serializable").execute(async trx => {
    const products = await trx.selectFrom("products")
      .select(["id", "product_line", "family", "shopify_node_id"]).execute();
    let updated = 0;
    const changed: { id: number; node: string | null }[] = [];
    for (const p of products) {
      const node = resolveNode(index, p.product_line, p.family);
      if (node) updated++;
      if (node !== p.shopify_node_id) changed.push({ id: p.id, node });
    }
    for (let i = 0; i < changed.length; i += 1000) {
      await sql`UPDATE p SET shopify_node_id = changes.node FROM products p
        JOIN OPENJSON(${JSON.stringify(changed.slice(i, i + 1000))})
          WITH (id int, node nvarchar(100)) changes ON changes.id = p.id
        `.execute(trx);
    }
    return { updated };
  });
}
