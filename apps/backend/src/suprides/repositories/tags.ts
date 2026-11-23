import { sql } from "kysely";
import { getMssql } from "../../db/mssql";
import { getAncestors } from "../services/menu-resolver";

export interface SpTagGroup {
  id: number;
  nome: string;
  descricao: string | null;
  unidade: string | null;
  created_at: Date;
}

// A API mantém nome/descricao/unidade; na base de dados as colunas são name/description/unit.
function tagGroups() {
  return getMssql().selectFrom("tag_groups")
    .select(["id", "name as nome", "description as descricao", "unit as unidade", "created_at"]);
}

export function getTagGroups(): Promise<SpTagGroup[]> {
  return tagGroups().orderBy("name").$castTo<SpTagGroup>().execute();
}

export async function getTagGroupById(id: number): Promise<SpTagGroup | null> {
  return await tagGroups().where("id", "=", id).$castTo<SpTagGroup>().executeTakeFirst() ?? null;
}

export async function createTagGroup(nome: string, descricao?: string, unidade?: string): Promise<number> {
  const row = await getMssql().insertInto("tag_groups").values({ name: nome, description: descricao ?? null, unit: unidade ?? null })
    .output("inserted.id as id").executeTakeFirstOrThrow();
  return Number(row.id);
}

export async function updateTagGroup(id: number, nome: string, descricao?: string, unidade?: string): Promise<void> {
  await getMssql().updateTable("tag_groups").set({ name: nome, description: descricao ?? null, unit: unidade ?? null }).where("id", "=", id).execute();
}

export async function deleteTagGroup(id: number): Promise<void> {
  await getMssql().deleteFrom("tag_groups").where("id", "=", id).execute();
}

export interface SpTagValue {
  id: number;
  tag_group_id: number;
  value: string;
}

export function getTagValues(tagGroupId: number): Promise<SpTagValue[]> {
  return getMssql().selectFrom("tag_values").selectAll().where("tag_group_id", "=", tagGroupId).orderBy("value")
    .$castTo<SpTagValue>().execute();
}

export async function addTagValue(tagGroupId: number, value: string): Promise<number> {
  const { rows } = await sql<{ id: number }>`
    INSERT INTO tag_values (tag_group_id, value) OUTPUT inserted.id
    SELECT ${tagGroupId}, ${value} WHERE NOT EXISTS (
      SELECT 1 FROM tag_values WITH (UPDLOCK, HOLDLOCK) WHERE tag_group_id = ${tagGroupId} AND value = ${value}
    )`.execute(getMssql());
  return rows[0]?.id ?? 0;
}

export async function deleteTagValue(id: number): Promise<void> {
  await getMssql().deleteFrom("tag_values").where("id", "=", id).execute();
}

export async function getMenuNodeTagGroupIds(shopifyId: string): Promise<number[]> {
  const rows = await getMssql().selectFrom("menu_tag_groups").select("tag_group_id")
    .where("shopify_id", "=", shopifyId).orderBy("tag_group_id").execute();
  return rows.map(row => row.tag_group_id);
}

export async function setMenuNodeTagGroups(shopifyId: string, tagGroupIds: number[]): Promise<void> {
  await getMssql().transaction().setIsolationLevel("serializable").execute(async trx => {
    await trx.deleteFrom("menu_tag_groups").where("shopify_id", "=", shopifyId).execute();
    await sql`INSERT INTO menu_tag_groups (shopify_id, tag_group_id)
      SELECT ${shopifyId}, id FROM tag_groups
      WHERE id IN (SELECT value FROM OPENJSON(${JSON.stringify(tagGroupIds)}))`.execute(trx);
  });
}

export async function resolveTagGroupsForNode(
  shopifyNodeId: string | null,
  ancestorIds?: string[],
): Promise<number[]> {
  if (!shopifyNodeId) return [];
  const chain = ancestorIds ?? await getAncestors(shopifyNodeId);
  const { rows } = await sql<{ tag_group_id: number }>`
    WITH inherited AS (
      SELECT m.tag_group_id, DENSE_RANK() OVER (ORDER BY CONVERT(int, a.[key]) DESC) AS priority
      FROM OPENJSON(${JSON.stringify(chain)}) a JOIN menu_tag_groups m ON m.shopify_id = a.value
    )
    SELECT tag_group_id FROM inherited WHERE priority = 1 ORDER BY tag_group_id`.execute(getMssql());
  return rows.map(row => row.tag_group_id);
}

export interface SpProductTagValue {
  sku: string;
  tag_group_id: number;
  value: string;
  updated_at: Date;
}

export function getProductTagValues(sku: string): Promise<SpProductTagValue[]> {
  return getMssql().selectFrom("product_tags as t").innerJoin("products as p", "p.sku", "t.sku")
    .selectAll("t").where("t.sku", "=", sku).$castTo<SpProductTagValue>().execute();
}

export async function upsertProductTagValue(sku: string, tagGroupId: number, value: string): Promise<boolean> {
  const result = await sql`MERGE product_tags WITH (HOLDLOCK) AS target
    USING (SELECT sku, ${tagGroupId} AS tag_group_id, ${value} AS value FROM products WHERE sku = ${sku}) AS src
    ON target.sku = src.sku AND target.tag_group_id = src.tag_group_id
    WHEN MATCHED THEN UPDATE SET value = src.value, updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (sku, tag_group_id, value) VALUES (src.sku, src.tag_group_id, src.value);`.execute(getMssql());
  return (result.numAffectedRows ?? 0n) > 0n;
}

export async function deleteProductTagValue(sku: string, tagGroupId: number): Promise<void> {
  const db = getMssql();
  await db.deleteFrom("product_tags").where("sku", "=", sku).where("tag_group_id", "=", tagGroupId)
    .where("sku", "in", db.selectFrom("products").select("sku")).execute();
}

export async function clearAllProductTagValues(): Promise<number> {
  const db = getMssql();
  const result = await db.deleteFrom("product_tags").where("sku", "in", db.selectFrom("products").select("sku")).executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** Mantém edições manuais e só marca o produto como processado depois de gravar todas as sugestões. */
export async function saveAiProductTags(sku: string, values: { tag_group_id: number; value: string }[]) {
  return getMssql().transaction().execute(async trx => {
    const { rows: existing } = await sql<{ tag_group_id: number; value: string }>`
      SELECT tag_group_id, value FROM product_tags WITH (UPDLOCK, HOLDLOCK) WHERE sku = ${sku}`.execute(trx);
    const existingIds = new Set(existing.map(row => row.tag_group_id));
    const additions = new Map<number, string>();
    for (const tag of values) {
      if (tag.value.trim() && !existingIds.has(tag.tag_group_id)) additions.set(tag.tag_group_id, tag.value);
    }
    const payload = Array.from(additions, ([tag_group_id, value]) => ({ tag_group_id, value }));
    await sql`
      INSERT INTO product_tags (sku, tag_group_id, value)
      SELECT ${sku}, tag_group_id, value FROM OPENJSON(${JSON.stringify(payload)})
        WITH (tag_group_id int, value nvarchar(max));
      INSERT INTO ai_tagged_products (sku) SELECT ${sku} WHERE NOT EXISTS (
        SELECT 1 FROM ai_tagged_products WITH (UPDLOCK, HOLDLOCK) WHERE sku = ${sku}
      );`.execute(trx);
    return existing;
  });
}

export async function clearPopulateDone(): Promise<number> {
  const db = getMssql();
  const result = await db.deleteFrom("ai_tagged_products").where("sku", "in", db.selectFrom("products").select("sku")).executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function countProductsWithTags(): Promise<number> {
  const row = await getMssql().selectFrom("product_tags as t").innerJoin("products as p", "p.sku", "t.sku")
    .select(sql<number>`COUNT(DISTINCT t.sku)`.as("n")).executeTakeFirstOrThrow();
  return row.n;
}

export async function countProductsMapped(): Promise<number> {
  const row = await getMssql().selectFrom("ai_tagged_products as t").innerJoin("products as p", "p.sku", "t.sku")
    .select(sql<number>`COUNT(*)`.as("n")).executeTakeFirstOrThrow();
  return row.n;
}
