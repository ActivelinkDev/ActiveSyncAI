/**
 * Leitura (só leitura) de todos os produtos da loja via GraphQL, numa só passagem paginada.
 * Usado pelo sync (índice SKU → IDs), pela cópia de segurança e pela verificação pós-sync.
 */
import axios, { AxiosInstance } from 'axios';
import { loadConnectionSettings } from '../repositories/store';
import { purchaseInventoryFields, readPurchaseInventory, type PurchaseInventoryState } from '../services/purchase-inventory';

/** Versão única da Admin API (leituras e escritas). */
export const SHOPIFY_API_VERSION = '2026-10';
/** @deprecated usar SHOPIFY_API_VERSION */
export const SHOPIFY_READ_API_VERSION = SHOPIFY_API_VERSION;

const PAGE = 40; // mantém o custo da query bem abaixo do máximo por pedido

const PRODUCTS_QUERY = `
query($after: String, $q: String) {
  products(first: ${PAGE}, after: $after, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId title handle status vendor productType updatedAt publishedAt descriptionHtml
      metafield(namespace: "custom", key: "stock_status") { value }
      variantsCount { count }
      variants(first: 1) { nodes {
        legacyResourceId sku price compareAtPrice
        ${purchaseInventoryFields}
        barcodes(first: 1) { nodes { value } }
        inventoryItem {
          legacyResourceId tracked
          unitCost { amount }
          measurement { weight { unit value } }
        }
      } }
      collections(first: 25) { nodes { legacyResourceId title } }
    }
  }
}`;

export interface SnapshotProduct {
  productId: number; title: string; handle: string; status: string; vendor: string;
  productType: string; updatedAt: string; publishedAt?: string | null; descriptionHtml: string | null; stockStatus: string | null;
  variantsCount: number;
  purchaseInventory?: PurchaseInventoryState;
  variantId: number | null; sku: string | null; price: string | null; compareAtPrice: string | null;
  barcode: string | null; inventoryItemId: number | null; cost: string | null;
  weight: { unit: string; value: number } | null;
  collectionIds: string[]; collectionTitles: string[];
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function shopifyStoreAndToken(): Promise<{ store: string; token: string }> {
  const s = await loadConnectionSettings();
  const store = s.shopifyStore || process.env.SHOPIFY_STORE || '';
  const token = s.shopifyToken || process.env.SHOPIFY_PASSWORD || '';
  if (!store || !token) throw new Error('Credenciais Shopify em falta');
  return { store, token };
}

export async function makeGraphqlClient(version = SHOPIFY_READ_API_VERSION): Promise<AxiosInstance> {
  const { store, token } = await shopifyStoreAndToken();
  return axios.create({
    baseURL: `https://${store}/admin/api/${version}/graphql.json`,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    timeout: 60_000,
    validateStatus: () => true,
  });
}

/**
 * Executa uma query/mutation GraphQL com novas tentativas (429, 5xx, THROTTLED, falhas de rede)
 * e espera calculada pelo limite de pontos (extensions.cost.throttleStatus).
 */
export async function gql<T = any>(http: AxiosInstance, query: string, variables: Record<string, unknown> = {}, tries = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await http.post('', { query, variables });
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`GraphQL HTTP ${r.status}`);
        await sleep(2000 * (i + 1));
        continue;
      }
      if (r.status >= 400) throw Object.assign(new Error(`GraphQL HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`), { fatal: true });
      if (r.data?.errors) {
        if (JSON.stringify(r.data.errors).includes('THROTTLED')) { await sleep(2000 * (i + 1)); continue; }
        throw Object.assign(new Error(JSON.stringify(r.data.errors).slice(0, 500)), { fatal: true });
      }
      const t = r.data?.extensions?.cost?.throttleStatus;
      const cost = r.data?.extensions?.cost?.requestedQueryCost ?? 0;
      if (t && t.restoreRate > 0 && t.currentlyAvailable < cost) {
        await sleep(Math.ceil((cost - t.currentlyAvailable) / t.restoreRate) * 1000);
      }
      return r.data.data as T;
    } catch (e: any) {
      if (e?.fatal) throw e;
      lastErr = e;
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Lê todos os produtos da loja (ou só os que correspondem à pesquisa `search`, p.ex. "sku:A OR sku:B").
 */
export async function readAllProducts(onProgress?: (n: number) => void, search?: string): Promise<SnapshotProduct[]> {
  const http = await makeGraphqlClient();
  const products: SnapshotProduct[] = [];
  let after: string | null = null;
  for (;;) {
    const data: any = await gql(http, PRODUCTS_QUERY, { after, q: search ?? null });
    const conn = data.products;
    for (const n of conn.nodes) {
      const v = n.variants.nodes[0];
      const w = v?.inventoryItem?.measurement?.weight;
      products.push({
        productId: Number(n.legacyResourceId), title: n.title, handle: n.handle, status: n.status,
        vendor: n.vendor, productType: n.productType, updatedAt: n.updatedAt, publishedAt: n.publishedAt ?? null,
        descriptionHtml: n.descriptionHtml ?? null,
        stockStatus: n.metafield?.value ?? null,
        variantsCount: n.variantsCount?.count ?? n.variants.nodes.length,
        purchaseInventory: v ? readPurchaseInventory(v) : undefined,
        variantId: v ? Number(v.legacyResourceId) : null, sku: v?.sku ?? null,
        price: v?.price ?? null, compareAtPrice: v?.compareAtPrice ?? null, barcode: v?.barcodes?.nodes?.[0]?.value ?? null,
        inventoryItemId: v?.inventoryItem ? Number(v.inventoryItem.legacyResourceId) : null,
        cost: v?.inventoryItem?.unitCost?.amount ?? null,
        weight: w && w.value != null ? { unit: w.unit, value: Number(w.value) } : null,
        collectionIds: n.collections.nodes.map((c: any) => String(c.legacyResourceId)),
        collectionTitles: n.collections.nodes.map((c: any) => c.title),
      });
    }
    onProgress?.(products.length);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return products;
}

export interface ShopifySkuEntry { productId: number; variantId: number; inventoryItemId: number }

/**
 * Índice SKU → IDs. SKUs repetidos na loja ficam com o primeiro produto encontrado
 * e são devolvidos em `duplicates` para aviso.
 */
export function buildSkuIndex(products: SnapshotProduct[]): { index: Map<string, ShopifySkuEntry>; duplicates: string[] } {
  const index = new Map<string, ShopifySkuEntry>();
  const duplicates = new Set<string>();
  for (const p of products) {
    const sku = (p.sku || '').trim();
    if (!sku || !p.variantId || !p.inventoryItemId) continue;
    if (index.has(sku)) { duplicates.add(sku); continue; }
    index.set(sku, { productId: p.productId, variantId: p.variantId, inventoryItemId: p.inventoryItemId });
  }
  return { index, duplicates: [...duplicates] };
}
