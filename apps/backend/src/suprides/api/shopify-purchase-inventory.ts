import { gql, makeGraphqlClient } from './shopify-read';
import { planPurchaseInventory, purchaseInventoryFields, readPurchaseInventory, type VariantRow } from '../services/purchase-inventory';

type Client = Awaited<ReturnType<typeof makeGraphqlClient>>;
type PageInfo = { hasNextPage: boolean; endCursor: string | null };

async function hasAvailableInventory(http: Client, id: string): Promise<boolean> {
  let after: string | null = null;
  do {
    const data: { inventoryItem: { inventoryLevels: {
      pageInfo: PageInfo; nodes: { quantities: { quantity: number }[] }[];
    } } | null } = await gql(http,
      'query($id: ID!, $after: String) { inventoryItem(id: $id) { inventoryLevels(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { quantities(names: ["available"]) { quantity } } } } }',
      { id, after });
    if (!data.inventoryItem) throw new Error('Artigo de inventário indisponível na Shopify.');
    const levels = data.inventoryItem.inventoryLevels;
    if (levels.nodes.some(level => level.quantities.some(stock => stock.quantity > 0))) return true;
    after = levels.pageInfo.hasNextPage ? levels.pageInfo.endCursor : null;
  } while (after);
  return false;
}

/** Ajusta as variantes sem escrever quantidades. O metafield guarda a configuração para a reposição. */
export async function syncPurchaseInventory(productId: number, blocked: boolean): Promise<boolean> {
  const http = await makeGraphqlClient();
  const id = 'gid://shopify/Product/' + productId;
  const updates: ({ id: string } & NonNullable<ReturnType<typeof planPurchaseInventory>>)[] = [];
  let after: string | null = null;
  do {
    const data: { product: { variants: { nodes: VariantRow[]; pageInfo: PageInfo } } | null } = await gql(http,
      'query($id: ID!, $after: String) { product(id: $id) { variants(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { id ' +
      purchaseInventoryFields + ' inventoryItem { id tracked } } } } }', { id, after });
    if (!data.product) throw new Error('Produto ' + productId + ' não encontrado na Shopify.');
    const variants = data.product.variants;
    for (const row of variants.nodes) {
      const plan = planPurchaseInventory(blocked, readPurchaseInventory(row));
      if (!plan) continue;
      if (blocked && await hasAvailableInventory(http, row.inventoryItem.id)) {
        throw new Error('A variante ' + row.id + ' tem stock disponível numa localização da Shopify.');
      }
      updates.push({ id: row.id, ...plan });
    }
    after = variants.pageInfo.hasNextPage ? variants.pageInfo.endCursor : null;
  } while (after);
  for (let start = 0; start < updates.length; start += 250) {
    const data = await gql<{ productVariantsBulkUpdate: { userErrors: { message: string }[] } }>(http,
      'mutation($id: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $variants) { userErrors { field message } } }',
      { id, variants: updates.slice(start, start + 250) });
    if (data.productVariantsBulkUpdate.userErrors.length) {
      throw new Error(data.productVariantsBulkUpdate.userErrors.map(error => error.message).join('; '));
    }
  }
  return updates.length > 0;
}
