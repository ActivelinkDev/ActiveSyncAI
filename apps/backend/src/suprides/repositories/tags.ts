import { getSqlite } from "../../db/sqlite";
import { getAncestors } from "../services/menu-resolver";

export interface SpTagGroup {
  id: number;
  supplier: string;
  nome: string;
  descricao: string | null;
  unidade: string | null;
  created_at: string;
}

export function getTagGroups(supplier = "suprides"): SpTagGroup[] {
  return getSqlite()
    .prepare("SELECT * FROM sp_tag_groups WHERE supplier = ? ORDER BY nome")
    .all(supplier) as SpTagGroup[];
}

export function getTagGroupById(id: number): SpTagGroup | null {
  return (getSqlite()
    .prepare("SELECT * FROM sp_tag_groups WHERE id = ?")
    .get(id) as SpTagGroup) ?? null;
}

export function createTagGroup(nome: string, descricao?: string, unidade?: string, supplier = "suprides"): number {
  const result = getSqlite()
    .prepare("INSERT INTO sp_tag_groups (supplier, nome, descricao, unidade) VALUES (?, ?, ?, ?)")
    .run(supplier, nome, descricao ?? null, unidade ?? null);
  return result.lastInsertRowid as number;
}

export function updateTagGroup(id: number, nome: string, descricao?: string, unidade?: string): void {
  getSqlite()
    .prepare("UPDATE sp_tag_groups SET nome = ?, descricao = ?, unidade = ? WHERE id = ?")
    .run(nome, descricao ?? null, unidade ?? null, id);
}

export function deleteTagGroup(id: number): void {
  getSqlite().prepare("DELETE FROM sp_tag_groups WHERE id = ?").run(id);
}

export interface SpTagValue {
  id: number;
  tag_group_id: number;
  value: string;
}

export function getTagValues(tagGroupId: number): SpTagValue[] {
  return getSqlite()
    .prepare("SELECT * FROM sp_tag_values WHERE tag_group_id = ? ORDER BY value")
    .all(tagGroupId) as SpTagValue[];
}

export function addTagValue(tagGroupId: number, value: string): number {
  const result = getSqlite()
    .prepare("INSERT OR IGNORE INTO sp_tag_values (tag_group_id, value) VALUES (?, ?)")
    .run(tagGroupId, value);
  return result.lastInsertRowid as number;
}

export function deleteTagValue(id: number): void {
  getSqlite().prepare("DELETE FROM sp_tag_values WHERE id = ?").run(id);
}

export function getMenuNodeTagGroupIds(shopifyId: string, supplier = "suprides"): number[] {
  const rows = getSqlite()
    .prepare(`
      SELECT mtg.tag_group_id
      FROM sp_menu_tag_groups mtg
      JOIN sp_tag_groups tg ON tg.id = mtg.tag_group_id
      WHERE mtg.shopify_id = ? AND tg.supplier = ?
      ORDER BY mtg.tag_group_id
    `)
    .all(shopifyId, supplier) as { tag_group_id: number }[];
  return rows.map(r => r.tag_group_id);
}

export function setMenuNodeTagGroups(shopifyId: string, tagGroupIds: number[], supplier = "suprides"): void {
  const db = getSqlite();
  const del = db.prepare(`
    DELETE FROM sp_menu_tag_groups
    WHERE shopify_id = ?
      AND tag_group_id IN (SELECT id FROM sp_tag_groups WHERE supplier = ?)
  `);
  const ins = db.prepare(`
    INSERT OR IGNORE INTO sp_menu_tag_groups (shopify_id, tag_group_id)
    SELECT ?, id FROM sp_tag_groups WHERE id = ? AND supplier = ?
  `);
  db.transaction(() => {
    del.run(shopifyId, supplier);
    for (const id of tagGroupIds) ins.run(shopifyId, id, supplier);
  })();
}

export function resolveTagGroupsForNode(
  shopifyNodeId: string | null,
  supplier = "suprides",
  ancestorIds?: string[],
): number[] {
  if (!shopifyNodeId) return [];

  const ancestors = ancestorIds ?? getAncestors(shopifyNodeId);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ids = getMenuNodeTagGroupIds(ancestors[i], supplier);
    if (ids.length > 0) return ids;
  }
  return [];
}

export interface SpProductTagValue {
  sku: string;
  tag_group_id: number;
  value: string;
  updated_at: string;
}

export function getProductTagValues(sku: string): SpProductTagValue[] {
  return getSqlite()
    .prepare("SELECT * FROM sp_product_tag_values WHERE sku = ?")
    .all(sku) as SpProductTagValue[];
}

export function upsertProductTagValue(sku: string, tagGroupId: number, value: string): void {
  getSqlite().prepare(`
    INSERT INTO sp_product_tag_values (sku, tag_group_id, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(sku, tag_group_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(sku, tagGroupId, value);
}

export function deleteProductTagValue(sku: string, tagGroupId: number): void {
  getSqlite()
    .prepare("DELETE FROM sp_product_tag_values WHERE sku = ? AND tag_group_id = ?")
    .run(sku, tagGroupId);
}

export function clearAllProductTagValues(supplier = "suprides"): number {
  const result = getSqlite().prepare(`
    DELETE FROM sp_product_tag_values
    WHERE tag_group_id IN (SELECT id FROM sp_tag_groups WHERE supplier = ?)
  `).run(supplier);
  return result.changes;
}

export function isPopulateDone(sku: string, supplier = "suprides"): boolean {
  return !!getSqlite()
    .prepare("SELECT 1 FROM sp_populate_tags_done WHERE supplier = ? AND sku = ?")
    .get(supplier, sku);
}

export function markPopulateDone(sku: string, supplier = "suprides"): void {
  getSqlite()
    .prepare("INSERT OR IGNORE INTO sp_populate_tags_done (supplier, sku) VALUES (?, ?)")
    .run(supplier, sku);
}

export function clearPopulateDone(supplier = "suprides"): number {
  const result = getSqlite()
    .prepare("DELETE FROM sp_populate_tags_done WHERE supplier = ?")
    .run(supplier);
  return result.changes;
}

export function countProductsWithTags(supplier = "suprides"): number {
  const row = getSqlite()
    .prepare(`
      SELECT COUNT(DISTINCT ptv.sku) as n
      FROM sp_product_tag_values ptv
      JOIN sp_tag_groups tg ON tg.id = ptv.tag_group_id
      WHERE tg.supplier = ?
    `)
    .get(supplier) as { n: number };
  return row.n;
}

export function countProductsMapped(supplier = "suprides"): number {
  const row = getSqlite()
    .prepare("SELECT COUNT(*) as n FROM sp_populate_tags_done WHERE supplier = ?")
    .get(supplier) as { n: number };
  return row.n;
}
