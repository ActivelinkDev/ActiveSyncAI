import { sql } from "kysely";
import { getMssql } from "../db/mssql";

export interface SupridesProduct {
  id?: number;
  sku: string;
  ean?: string | null;
  part_number?: string | null;
  brand?: string | null;
  product_line?: string | null;
  family?: string | null;
  sub_family?: string | null;
  name?: string | null;
  cost?: number | null;          // preço de custo do fornecedor
  msrp?: number | null;          // PVP recomendado pelo fornecedor
  stock?: number | null;
  stock_status?: string | null;
  images?: string | null;      // JSON array serializado
  weight?: number | null;
  color?: string | null;
  description?: string | null;
  manufacturer?: string | null;
  short_description?: string | null;
  shopify_node_id?: string | null;
  imported_at?: string;
  updated_at?: string;
  shopify_product_id?: number | null;
  shopify_variant_id?: number | null;
  shopify_inventory_item_id?: number | null;
}

function products() {
  return getMssql().selectFrom("products");
}

export async function getAllProducts(limit = 5000, offset = 0): Promise<SupridesProduct[]> {
  if (!limit) return [];
  return products().selectAll().orderBy("id").offset(offset).fetch(limit)
    .$castTo<SupridesProduct>().execute();
}

export async function getProductBySku(sku: string): Promise<SupridesProduct | null> {
  return await products().selectAll().where("sku", "=", sku).$castTo<SupridesProduct>().executeTakeFirst() ?? null;
}

export async function countProducts(): Promise<number> {
  const row = await products().select(sql<number>`COUNT(*)`.as("n")).executeTakeFirstOrThrow();
  return row.n;
}

export async function getProductsByFamily(family: string): Promise<SupridesProduct[]> {
  return products().selectAll().where("family", "=", family).orderBy("sku").$castTo<SupridesProduct>().execute();
}

export async function upsertProduct(p: SupridesProduct): Promise<void> {
  await upsertProductsBatch([p]);
}

/** A importação, o sync completo e o de stock partilham o mesmo bloqueio entre processos. */
export function withCatalogueLock<T>(run: () => Promise<T>): Promise<T> {
  return getMssql().connection().execute(async connection => {
    const { rows } = await sql<{ status: number }>`
      DECLARE @result int;
      EXEC @result = sys.sp_getapplock @Resource = 'ActiveSyncAI.import.suprides',
        @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0, @DbPrincipal = 'public';
      SELECT @result AS status`.execute(connection);
    if (rows[0].status < 0) throw Object.assign(new Error("Já há uma importação ou sincronização em curso"), { code: "BUSY" });
    try {
      return await run();
    } finally {
      await sql`EXEC sys.sp_releaseapplock @Resource = 'ActiveSyncAI.import.suprides',
        @LockOwner = 'Session', @DbPrincipal = 'public'`.execute(connection);
    }
  });
}

/** Uma onda da API é gravada atomicamente; uma chave repetida usa a última ocorrência. */
export async function upsertProductsBatch(products: SupridesProduct[]): Promise<number> {
  if (!products.length) return 0;
  const payload = products.map(p => ({
    ...p, images: p.images && typeof p.images !== "string" ? JSON.stringify(p.images) : p.images,
  }));
  await sql`
    WITH incoming AS (
      SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.sku ORDER BY CONVERT(int, j.[key]) DESC) AS seq
      FROM OPENJSON(${JSON.stringify(payload)}) AS j
      CROSS APPLY OPENJSON(j.value) WITH (
        sku nvarchar(max), ean nvarchar(max), part_number nvarchar(max), brand nvarchar(max),
        product_line nvarchar(max), family nvarchar(max), sub_family nvarchar(max), name nvarchar(max),
        cost decimal(14,4), msrp decimal(14,4), stock int, stock_status nvarchar(max),
        images nvarchar(max), weight float, color nvarchar(max), description nvarchar(max),
        manufacturer nvarchar(max), short_description nvarchar(max)
      ) AS p
    )
    MERGE products WITH (HOLDLOCK) AS target
    USING (SELECT * FROM incoming WHERE seq = 1) AS src
      ON target.sku = src.sku
    WHEN MATCHED THEN UPDATE SET
      ean = src.ean, part_number = src.part_number, brand = src.brand,
      product_line = src.product_line, family = src.family, sub_family = src.sub_family,
      name = src.name, cost = src.cost, msrp = src.msrp, stock = src.stock, stock_status = src.stock_status,
      images_synced = CASE WHEN src.images COLLATE Latin1_General_100_BIN2 IS DISTINCT FROM target.images COLLATE Latin1_General_100_BIN2
                            THEN 0 ELSE target.images_synced END,
      images = src.images, weight = src.weight, color = src.color, description = src.description,
      manufacturer = src.manufacturer, short_description = src.short_description,
      removed_at = NULL, updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT
      (sku, ean, part_number, brand, product_line, family, sub_family, name,
       cost, msrp, stock, stock_status, images, weight, color, description, manufacturer, short_description)
    VALUES (src.sku, src.ean, src.part_number, src.brand, src.product_line, src.family, src.sub_family, src.name,
       src.cost, src.msrp, src.stock, src.stock_status, src.images, src.weight, src.color, src.description, src.manufacturer, src.short_description);
  `.execute(getMssql());
  return products.length;
}

export async function markMissingAsRemoved(seenSkus: Set<string>): Promise<number> {
  const result = await sql`
    UPDATE p SET removed_at = SYSUTCDATETIME(), stock = 0, stock_status = 'sem_stock'
    FROM products p
    WHERE p.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM OPENJSON(${JSON.stringify([...seenSkus])}) seen WHERE seen.value = p.sku)
  `.execute(getMssql());
  return Number(result.numAffectedRows ?? 0n);
}

export async function countActiveProducts(): Promise<number> {
  const row = await products().where("removed_at", "is", null).select(sql<number>`COUNT(*)`.as("n")).executeTakeFirstOrThrow();
  return row.n;
}

export async function deleteProductBySku(sku: string): Promise<boolean> {
  const result = await getMssql().deleteFrom("products").where("sku", "=", sku).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

export async function clearAllProducts(): Promise<number> {
  const result = await getMssql().deleteFrom("products").executeTakeFirst();
  return Number(result.numDeletedRows);
}
