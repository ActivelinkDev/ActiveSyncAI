/**
 * Reposição da loja a partir de uma cópia de segurança (services/shopify-snapshot.ts).
 * diffSnapshot() é puro (testável); applyRestore() escreve na loja via GraphQL.
 *
 * Repõe: estado, título, descrição, preço, preço riscado, EAN, custo, peso, metafield
 * custom.stock_status, e retira coleções acrescentadas depois da cópia.
 * Nunca apaga produtos nem acrescenta coleções.
 */
import type { SnapshotProduct } from '../suprides/api/shopify-read';
import { gql, makeGraphqlClient } from '../suprides/api/shopify-read';

/** Se a cópia tem este n.º de coleções (ou mais) num produto, a lista pode estar cortada. */
export const SNAPSHOT_COLLECTIONS_LIMIT = 15;

export type RestoreField =
  | 'status' | 'title' | 'descriptionHtml' | 'price' | 'compareAtPrice' | 'barcode' | 'cost' | 'weight' | 'stockStatus';

export interface ProductRestoreDiff {
  productId: number;
  sku: string | null;
  title: string;
  changes: { field: RestoreField; from: unknown; to: unknown }[];
  /** Coleções que existem agora e não existiam na cópia → a retirar. */
  removeCollections: string[];
  /** Coleções da cópia que já não estão → só aviso (a reposição não volta a acrescentar). */
  missingCollections: string[];
  collectionsUncertain: boolean;
  variantId: number | null;
}

export interface RestoreDiff {
  products: ProductRestoreDiff[];
  /** Na cópia mas já não na loja (não se recriam). */
  goneFromShop: { productId: number; sku: string | null; title: string }[];
  /** Na loja mas não na cópia (criados depois; não se apagam). */
  newInShop: { productId: number; sku: string | null; title: string }[];
}

const money = (v: string | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const weightEq = (a: SnapshotProduct['weight'], b: SnapshotProduct['weight']): boolean => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.unit === b.unit && Math.abs(a.value - b.value) < 1e-6;
};

export function diffSnapshot(
  before: SnapshotProduct[],
  current: SnapshotProduct[],
  opts: { skus?: Set<string> } = {},
): RestoreDiff {
  const inScope = (p: SnapshotProduct) => !opts.skus || (p.sku != null && opts.skus.has(p.sku));
  const curById = new Map(current.map(p => [p.productId, p]));
  const beforeIds = new Set(before.map(p => p.productId));
  const out: RestoreDiff = { products: [], goneFromShop: [], newInShop: [] };

  for (const b of before) {
    if (!inScope(b)) continue;
    const c = curById.get(b.productId);
    if (!c) { out.goneFromShop.push({ productId: b.productId, sku: b.sku, title: b.title }); continue; }

    const changes: ProductRestoreDiff['changes'] = [];
    // Cópias antigas não têm todos os campos: um campo ausente (undefined) nunca é reposto.
    const has = (k: keyof SnapshotProduct) => (b as any)[k] !== undefined;
    const cmp = (field: RestoreField, from: unknown, to: unknown, equal: boolean) => {
      if (has(field) && !equal) changes.push({ field, from, to });
    };
    cmp('status', c.status, b.status, c.status === b.status);
    cmp('title', c.title, b.title, c.title === b.title);
    cmp('descriptionHtml', '(atual)', '(cópia)', (c.descriptionHtml ?? '') === (b.descriptionHtml ?? ''));
    cmp('price', c.price, b.price, money(c.price) === money(b.price));
    cmp('compareAtPrice', c.compareAtPrice, b.compareAtPrice, money(c.compareAtPrice) === money(b.compareAtPrice));
    cmp('barcode', c.barcode, b.barcode, (c.barcode ?? '') === (b.barcode ?? ''));
    cmp('cost', c.cost, b.cost, money(c.cost) === money(b.cost));
    cmp('weight', c.weight, b.weight, weightEq(c.weight, b.weight));
    cmp('stockStatus', c.stockStatus, b.stockStatus, (c.stockStatus ?? '') === (b.stockStatus ?? ''));

    const collectionsUncertain = b.collectionIds.length >= SNAPSHOT_COLLECTIONS_LIMIT;
    const beforeColl = new Set(b.collectionIds);
    const curColl = new Set(c.collectionIds);
    const removeCollections = collectionsUncertain ? [] : c.collectionIds.filter(id => !beforeColl.has(id));
    const missingCollections = b.collectionIds.filter(id => !curColl.has(id));

    if (changes.length || removeCollections.length || missingCollections.length) {
      out.products.push({
        productId: b.productId, sku: b.sku, title: b.title, changes,
        removeCollections, missingCollections, collectionsUncertain, variantId: c.variantId,
      });
    }
  }

  for (const c of current) {
    if (!inScope(c)) continue;
    if (!beforeIds.has(c.productId)) out.newInShop.push({ productId: c.productId, sku: c.sku, title: c.title });
  }
  return out;
}

const gid = (type: string, id: number | string) => `gid://shopify/${type}/${id}`;

const PRODUCT_UPDATE = `
mutation($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id } userErrors { field message } }
}`;

const VARIANTS_UPDATE = `
mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
}`;

const METAFIELDS_SET = `
mutation($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { userErrors { field message } }
}`;

const METAFIELDS_DELETE = `
mutation($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) { userErrors { field message } }
}`;

function checkUserErrors(what: string, r: any): void {
  const errs = r?.userErrors ?? [];
  if (errs.length) throw new Error(`${what}: ${errs.map((e: any) => e.message).join('; ')}`);
}

export interface ApplyResult { productsUpdated: number; collectionRemovals: number; errors: { productId: number; error: string }[] }

/** Escreve na loja o estado da cópia para os produtos de `diff`. */
export async function applyRestore(
  diff: RestoreDiff,
  before: SnapshotProduct[],
  onProgress?: (done: number, total: number) => void,
): Promise<ApplyResult> {
  const http = makeGraphqlClient();
  const beforeById = new Map(before.map(p => [p.productId, p]));
  const result: ApplyResult = { productsUpdated: 0, collectionRemovals: 0, errors: [] };
  let done = 0;

  for (const d of diff.products) {
    const b = beforeById.get(d.productId)!;
    const fields = new Set(d.changes.map(c => c.field));
    try {
      if (fields.has('status') || fields.has('title') || fields.has('descriptionHtml') || d.removeCollections.length) {
        const product: Record<string, unknown> = { id: gid('Product', d.productId) };
        if (fields.has('status')) product.status = b.status;
        if (fields.has('title')) product.title = b.title;
        if (fields.has('descriptionHtml')) product.descriptionHtml = b.descriptionHtml ?? '';
        if (d.removeCollections.length) product.collectionsToLeave = d.removeCollections.map(cid => gid('Collection', cid));
        const r: any = await gql(http, PRODUCT_UPDATE, { product });
        checkUserErrors('productUpdate', r.productUpdate);
      }

      const variantFields = ['price', 'compareAtPrice', 'barcode', 'cost', 'weight'] as const;
      if (d.variantId && variantFields.some(f => fields.has(f))) {
        const v: Record<string, unknown> = { id: gid('ProductVariant', d.variantId) };
        if (fields.has('price')) v.price = b.price;
        if (fields.has('compareAtPrice')) v.compareAtPrice = b.compareAtPrice;
        if (fields.has('barcode')) v.barcodes = b.barcode ? [{ value: b.barcode }] : [];
        const inv: Record<string, unknown> = {};
        if (fields.has('cost')) inv.cost = b.cost;
        if (fields.has('weight') && b.weight) inv.measurement = { weight: { unit: b.weight.unit, value: b.weight.value } };
        if (Object.keys(inv).length) v.inventoryItem = inv;
        const r: any = await gql(http, VARIANTS_UPDATE, { productId: gid('Product', d.productId), variants: [v] });
        checkUserErrors('productVariantsBulkUpdate', r.productVariantsBulkUpdate);
      }

      if (fields.has('stockStatus')) {
        if (b.stockStatus) {
          const r: any = await gql(http, METAFIELDS_SET, { metafields: [{
            ownerId: gid('Product', d.productId), namespace: 'custom', key: 'stock_status',
            type: 'single_line_text_field', value: b.stockStatus,
          }] });
          checkUserErrors('metafieldsSet', r.metafieldsSet);
        } else {
          const r: any = await gql(http, METAFIELDS_DELETE, { metafields: [{
            ownerId: gid('Product', d.productId), namespace: 'custom', key: 'stock_status',
          }] });
          checkUserErrors('metafieldsDelete', r.metafieldsDelete);
        }
      }

      result.collectionRemovals += d.removeCollections.length;
      if (d.changes.length) result.productsUpdated++;
    } catch (e: any) {
      result.errors.push({ productId: d.productId, error: e?.message ?? String(e) });
    }
    onProgress?.(++done, diff.products.length);
  }

  return result;
}
