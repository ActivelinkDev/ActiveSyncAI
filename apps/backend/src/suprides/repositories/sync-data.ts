import { sql } from 'kysely';
import { getMssql } from '../../db/mssql';
import { loadAdminSettings, loadCollectionMargins, loadMenuItems, loadShopifyCollectionMapping } from './store';
import { getAllProducts } from '../services/products-cache';

interface ProductSyncState {
  sku: string;
  shopify_node_id: string | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_inventory_item_id: string | null;
  images_synced: number;
  shopify_content_hash: string | null;
}

interface ProductTag { sku: string; group_name: string; value: string }

async function loadSyncTags(): Promise<ProductTag[]> {
  const result = await sql<ProductTag>`
    IF EXISTS (SELECT 1 FROM product_tags_normalized n JOIN products p ON p.sku = n.sku)
      SELECT n.sku AS sku, g.name AS group_name, n.normalized_value AS value
      FROM product_tags_normalized n
      JOIN tag_groups g ON g.id = n.tag_group_id
      JOIN products p ON p.sku = n.sku
      WHERE n.normalized_value <> ''
    ELSE
      SELECT t.sku, g.name AS group_name, t.value
      FROM product_tags t
      JOIN tag_groups g ON g.id = t.tag_group_id
      JOIN products p ON p.sku = t.sku
      WHERE t.value <> ''
  `.execute(getMssql());
  return result.rows;
}

export async function loadSyncData() {
  const [settings, collMap, menu, collMargins, products, states, tags] = await Promise.all([
    loadAdminSettings(), loadShopifyCollectionMapping(), loadMenuItems(), loadCollectionMargins(), getAllProducts(),
    getMssql().selectFrom('products')
      .select(['sku', 'shopify_node_id', 'shopify_product_id', 'shopify_variant_id', 'shopify_inventory_item_id',
        'images_synced', 'shopify_content_hash']).$castTo<ProductSyncState>().execute(),
    loadSyncTags(),
  ]);
  return { settings, collMap, menu, collMargins, products, states, tags };
}

export interface ShopifyIdUpdate {
  sku: string;
  productId: number | null;
  variantId: number | null;
  inventoryItemId: number | null;
}

export async function updateShopifyIds(updates: ShopifyIdUpdate[]) {
  if (!updates.length) return;
  await sql`
    UPDATE p SET shopify_product_id = i.productId, shopify_variant_id = i.variantId,
                 shopify_inventory_item_id = i.inventoryItemId
    FROM products p
    JOIN OPENJSON(${JSON.stringify(updates)}) WITH (
      sku nvarchar(64), productId bigint, variantId bigint, inventoryItemId bigint
    ) i ON i.sku = p.sku
  `.execute(getMssql());
}
