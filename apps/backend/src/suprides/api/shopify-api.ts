import axios from 'axios';
import { loadConnectionSettings } from '../repositories/store';

// Shared AbortController — aborted when sync is cancelled.
let _abortController = new AbortController();

export function resetSyncAbort(): void {
  _abortController = new AbortController();
}

export function abortSync(): void {
  _abortController.abort();
}

// Versão da Admin API usada pelo sync. A Etapa 2 (GraphQL) passa-a para a versão atual.
export const SHOPIFY_API_VERSION = '2025-01';

export function getShopifyStore(): string {
  return loadConnectionSettings().shopifyStore || process.env.SHOPIFY_STORE || '';
}

function makeClients() {
  const conn  = loadConnectionSettings();
  const store = conn.shopifyStore  || process.env.SHOPIFY_STORE    || '';
  const token = conn.shopifyToken  || process.env.SHOPIFY_PASSWORD || '';
  const base   = `https://${store}/admin/api/${SHOPIFY_API_VERSION}/`;
  const signal = _abortController.signal;

  const rest = axios.create({
    baseURL: base,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    timeout: 20_000,
    signal,
    validateStatus: (s: number) => (s >= 200 && s < 300) || s === 429 || s === 422 || s === 404,
  });

  const gqlClient = axios.create({
    baseURL: `${base}graphql.json`,
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    timeout: 120_000,
    signal,
    validateStatus: () => true,
  });

  return { rest, gqlClient };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function _requestWithRetry(
  fn: () => Promise<any>,
  desc: string,
  tries = 5
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fn();
      if (res.status === 429) {
        const ra = Number(res.headers?.['retry-after'] || 4);
        await sleep((isNaN(ra) ? 4 : ra) * 1000);
        continue;
      }
      if (res.status >= 200 && res.status < 300) return res;
      const body = JSON.stringify(res.data ?? '').slice(0, 400);
      const err = new Error(`${desc} falhou (${res.status}): ${body}`);
      (err as any).response = res;
      throw err;
    } catch (e) {
      if ((e as any)?.code === 'ERR_CANCELED' || (e as any)?.name === 'AbortError') throw e;
      lastErr = e;
      if (i < tries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr ?? new Error(`${desc} falhou após ${tries} tentativas`);
}

async function graphql(query: string, variables: Record<string, unknown> = {}, tries = 3): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    const { gqlClient } = makeClients();
    const res = await gqlClient.post('', { query, variables });
    if (res.status === 429) {
      const ra = Number(res.headers?.['retry-after'] || 2);
      await sleep((isNaN(ra) ? 2 : ra) * 1000);
      continue;
    }
    if (res.status === 500) {
      lastErr = new Error(`Shopify GraphQL HTTP 500: ${JSON.stringify(res.data).slice(0, 300)}`);
      await sleep(2000 * (i + 1));
      continue;
    }
    if (res.status >= 400) {
      throw new Error(`Shopify GraphQL HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    if (res.data?.errors) {
      if (!res.data?.data) throw new Error(res.data.errors[0].message);
      console.warn('[Shopify GraphQL] warnings:', JSON.stringify(res.data.errors));
    }
    return res.data?.data;
  }
  throw lastErr;
}

export async function findVariantBySku(sku: string): Promise<any> {
  const data = await graphql(
    `query findBySku($q: String!) {
      productVariants(first: 1, query: $q) {
        edges {
          node {
            id
            sku
            product { id }
            inventoryItem { id }
          }
        }
      }
    }`,
    { q: `sku:${sku}` }
  );
  const node = data?.productVariants?.edges?.[0]?.node;
  if (!node || node.sku !== sku) return null;
  // normalizar para o mesmo formato que o código REST esperava
  const variantNumId  = parseInt(node.id.split('/').pop(), 10);
  const productNumId  = parseInt(node.product.id.split('/').pop(), 10);
  const invItemNumId  = parseInt(node.inventoryItem.id.split('/').pop(), 10);
  return { id: variantNumId, sku: node.sku, product_id: productNumId, inventory_item_id: invItemNumId };
}

export async function createProduct(product: Record<string, unknown>): Promise<any> {
  const { rest } = makeClients();
  const res = await _requestWithRetry(() => rest.post('products.json', { product }), 'createProduct');
  return (res as any).data.product;
}

export async function updateProduct(productId: number, payload: Record<string, unknown>): Promise<any> {
  const { rest } = makeClients();
  const res = await _requestWithRetry(
    () => rest.put(`products/${productId}.json`, { product: { id: productId, ...payload } }),
    `updateProduct(${productId})`
  );
  return (res as any).data.product;
}

export async function updateVariant(variantId: number, payload: Record<string, unknown>): Promise<any> {
  const { rest } = makeClients();
  const res = await _requestWithRetry(
    () => rest.put(`variants/${variantId}.json`, { variant: { id: variantId, ...payload } }),
    `updateVariant(${variantId})`
  );
  return (res as any).data.variant;
}


// ── Metafields ────────────────────────────────────────────────────────────────

/** Converte o nome de um grupo de tags num metafield key válido (a-z, 0-9, _). */
export function toMetafieldKey(groupName: string): string {
  return groupName
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 64);
}

export interface MetafieldInput {
  namespace: string;
  key: string;
  value: string;
}

/**
 * Upsert de metafields num produto via GraphQL productUpdate.
 * Cria ou actualiza (por namespace+key) sem necessitar do ID do metafield.
 */
export async function updateProductMetafields(
  productId: number,
  metafields: MetafieldInput[]
): Promise<void> {
  if (!metafields.length) return;
  const gid = `gid://shopify/Product/${productId}`;
  const data = await graphql(
    `mutation productMetafieldUpsert($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        id: gid,
        metafields: metafields.map(m => ({
          namespace: m.namespace,
          key: m.key,
          value: m.value,
          type: 'single_line_text_field',
        })),
      },
    }
  );
  const errors = data?.productUpdate?.userErrors;
  if (errors?.length) throw new Error(`updateProductMetafields(${productId}): ${errors.map((e: any) => e.message).join('; ')}`);
}

export async function setInventoryCost(inventoryItemId: number, cost: string): Promise<void> {
  const gid = `gid://shopify/InventoryItem/${inventoryItemId}`;
  const data = await graphql(
    `mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id }
        userErrors { field message }
      }
    }`,
    { id: gid, input: { cost } }
  );
  const errors = data?.inventoryItemUpdate?.userErrors;
  if (errors?.length) throw new Error(`inventoryItemUpdate: ${errors[0].message}`);
}

const _collectionCache = new Map<string, number>();

export const toHandle = (str: string) => String(str)
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '')
  .slice(0, 255);

export async function findOrCreateCollection(title: string, handle: string): Promise<number> {
  if (_collectionCache.has(handle)) return _collectionCache.get(handle)!;

  const { rest } = makeClients();
  const searchRes = await _requestWithRetry(
    () => rest.get('custom_collections.json', { params: { handle, limit: 1 } }),
    `findCollection(${handle})`
  );
  const existing = (searchRes as any).data?.custom_collections?.[0];
  if (existing) { _collectionCache.set(handle, existing.id); return existing.id; }

  const createRes = await _requestWithRetry(
    () => rest.post('custom_collections.json', { custom_collection: { title, handle } }),
    `createCollection(${handle})`
  );
  const id: number = (createRes as any).data.custom_collection.id;
  _collectionCache.set(handle, id);
  return id;
}

export interface ShopifyImage { id: number; src: string; position?: number }

/** Lê as imagens atualmente publicadas num produto Shopify. */
export async function getProductImages(productId: number): Promise<ShopifyImage[]> {
  const { rest } = makeClients();
  const res = await _requestWithRetry(
    () => rest.get(`products/${productId}/images.json`),
    `getProductImages(${productId})`
  );
  return ((res as any).data?.images || []) as ShopifyImage[];
}

/** Cria uma imagem num produto (REST). Devolve a imagem criada ou null em 422. */
export async function addProductImage(productId: number, src: string, position?: number): Promise<ShopifyImage | null> {
  const { rest } = makeClients();
  const payload: Record<string, unknown> = { src };
  if (position != null) payload.position = position;
  const res = await _requestWithRetry(
    () => rest.post(`products/${productId}/images.json`, { image: payload }),
    `addProductImage(${productId})`
  );
  const data = (res as any).data;
  if (!data?.image) return null;
  return data.image as ShopifyImage;
}

/** Apaga uma imagem específica de um produto. */
export async function deleteProductImage(productId: number, imageId: number): Promise<void> {
  const { rest } = makeClients();
  await _requestWithRetry(
    () => rest.delete(`products/${productId}/images/${imageId}.json`),
    `deleteProductImage(${productId},${imageId})`
  );
}

/**
 * Chave de comparação de imagens pelo nome de ficheiro.
 * O Shopify reescreve o host para o CDN dele mas preserva o filename original,
 * por isso comparar por URL completo nunca bate certo após o upload. O filename é estável.
 */
export function imageKeyFromUrl(url: string): string {
  try {
    const clean = String(url).split('?')[0].split('#')[0];
    const base = clean.substring(clean.lastIndexOf('/') + 1);
    return decodeURIComponent(base).toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

/** URLs únicos por filename, mantendo a ordem de entrada. */
export function dedupeImageUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const k = imageKeyFromUrl(u);
    if (!seen.has(k)) { seen.add(k); out.push(u); }
  }
  return out;
}

/**
 * Reconcilia as imagens de um produto de forma idempotente: lê as imagens reais
 * do Shopify e adiciona apenas as que faltam (comparando por filename). Não envia
 * imagens já presentes, evitando duplicação independentemente do estado dos flags.
 */
export async function reconcileProductImages(
  productId: number,
  desiredUrls: string[],
): Promise<{ added: number; missing: number; total: number; complete: boolean }> {
  const desired = dedupeImageUrls(desiredUrls.filter(u => /^https?:\/\//i.test(u)));
  const current = await getProductImages(productId);
  const currentKeys = new Set(current.map(i => imageKeyFromUrl(i.src || '')));
  const missing = desired.filter(u => !currentKeys.has(imageKeyFromUrl(u)));

  let added = 0;
  for (let i = 0; i < missing.length; i++) {
    const img = await addProductImage(productId, missing[i], current.length + i + 1);
    if (img) added++;
  }
  return {
    added,
    missing: missing.length,
    total: current.length + added,
    complete: added === missing.length,
  };
}

/**
 * Remove imagens duplicadas (mesmo filename) de um produto, mantendo a primeira
 * ocorrência por ordem de posição. Devolve quantas manteve e quantas apagou.
 */
export async function dedupeProductImages(
  productId: number,
): Promise<{ kept: number; removed: number; removedIds: number[] }> {
  const current = await getProductImages(productId);
  const seen = new Set<string>();
  const removedIds: number[] = [];
  for (const img of current) {
    const key = imageKeyFromUrl(img.src || '');
    if (seen.has(key)) {
      await deleteProductImage(productId, img.id);
      removedIds.push(img.id);
    } else {
      seen.add(key);
    }
  }
  return { kept: seen.size, removed: removedIds.length, removedIds };
}

export async function findProductByHandle(handle: string): Promise<any> {
  const { rest } = makeClients();
  const res = await _requestWithRetry(
    () => rest.get('products.json', { params: { handle, limit: 1, fields: 'id,handle,variants' } }),
    `findProductByHandle(${handle})`
  );
  return (res as any).data?.products?.[0] || null;
}

export async function findCollectionId(title: string): Promise<number | null> {
  const handle = toHandle(title);
  const { rest } = makeClients();
  const res = await _requestWithRetry(
    () => rest.get('custom_collections.json', { params: { handle, limit: 1 } }),
    `findCollection(${handle})`
  );
  return (res as any).data?.custom_collections?.[0]?.id || null;
}

export async function fetchProductsInCollection(collectionId: number): Promise<{ id: number; sku: string }[]> {
  const gid = `gid://shopify/Collection/${collectionId}`;
  const results: { id: number; sku: string }[] = [];
  let cursor: string | null = null;
  do {
    const data = await graphql(`
      query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id variants(first: 1) { nodes { sku } } }
          }
        }
      }
    `, { id: gid, cursor });
    for (const p of (data?.collection?.products?.nodes || [])) {
      results.push({ id: Number(p.id.split('/').pop()), sku: p.variants?.nodes?.[0]?.sku || '' });
    }
    cursor = data?.collection?.products?.pageInfo?.hasNextPage
      ? data.collection.products.pageInfo.endCursor : null;
  } while (cursor);
  return results;
}

export async function getCollectId(productId: number, collectionId: number): Promise<number | null> {
  const { rest } = makeClients();
  const res = await _requestWithRetry(
    () => rest.get('collects.json', { params: { product_id: productId, collection_id: collectionId, limit: 1 } }),
    `getCollect(${productId},${collectionId})`
  );
  return (res as any).data?.collects?.[0]?.id ?? null;
}

export async function deleteCollect(collectId: number): Promise<void> {
  const { rest } = makeClients();
  await _requestWithRetry(
    () => rest.delete(`collects/${collectId}.json`),
    `deleteCollect(${collectId})`
  );
}

export async function addProductToCollection(productId: number, collectionId: number): Promise<void> {
  const { rest } = makeClients();
  for (let i = 0; i < 3; i++) {
    const res = await rest.post('collects.json', { collect: { product_id: productId, collection_id: collectionId } });
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 422) return; // já está na coleção
    if (res.status === 429) {
      const ra = Number(res.headers?.['retry-after'] || 2);
      await sleep((isNaN(ra) ? 2 : ra) * 1000);
      continue;
    }
    throw new Error(`addToCollection(${productId}) falhou (${res.status})`);
  }
}

export async function fetchAllCollections(): Promise<Map<string, string>> {
  return _fetchAllCollections();
}

async function _fetchAllCollections(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | null = null;
  do {
    const data = await graphql(`
      query($cursor: String) {
        collections(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id handle } }
        }
      }
    `, { cursor });
    for (const e of (data?.collections?.edges || [])) map.set(e.node.handle, e.node.id);
    cursor = data?.collections?.pageInfo?.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);
  return map;
}

async function _fetchMenuByHandle(handle: string): Promise<any> {
  let cursor: string | null = null;
  do {
    const data = await graphql(`
      query($cursor: String) {
        menus(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id handle title
              items {
                id title type resourceId url
                items {
                  id title type resourceId url
                  items { id title type resourceId url }
                }
              }
            }
          }
        }
      }
    `, { cursor });

    const menus: any[] = data?.menus?.edges?.map((e: any) => e.node) || [];
    const found = menus.find(m => m.handle === handle);
    if (found) return found;
    cursor = data?.menus?.pageInfo?.hasNextPage ? data.menus.pageInfo.endCursor : null;
  } while (cursor);

  return null;
}

export async function updateMenuLinks(
  productTree: Record<string, Record<string, string[]>>,
  lineToMenu: Record<string, string> = {}
): Promise<void> {
  if (!productTree || Object.keys(productTree).length === 0) return;

  const menuToLines: Record<string, string[]> = {};
  for (const [line, menuItem] of Object.entries(lineToMenu)) {
    if (!menuToLines[menuItem]) menuToLines[menuItem] = [];
    menuToLines[menuItem].push(line);
  }

  const collMap = await _fetchAllCollections();
  const menu = await _fetchMenuByHandle('menu-principal');
  if (!menu) { console.log("Menu 'menu-principal' não encontrado"); return; }

  const allItems = menu.items.map((item: any) => {
    const lines = menuToLines[item.title.trim()] || [];
    if (lines.length === 0) {
      const preserved: any = { id: item.id, title: item.title, type: item.type, items: item.items || [] };
      if (item.resourceId) preserved.resourceId = item.resourceId;
      if (item.url)        preserved.url        = item.url;
      return preserved;
    }

    const lineSubItems = lines.map(lineName => {
      const lineGid   = collMap.get(toHandle(lineName));
      const families  = productTree[lineName] || {};
      const familyItems = Object.entries(families).map(([famTitle]) => {
        const famGid = collMap.get(toHandle(famTitle));
        return famGid
          ? { title: famTitle, type: 'COLLECTION', resourceId: famGid, items: [] }
          : { title: famTitle, type: 'HTTP', url: `/collections/${toHandle(famTitle)}`, items: [] };
      });
      return lineGid
        ? { title: lineName, type: 'COLLECTION', resourceId: lineGid, items: familyItems }
        : { title: lineName, type: 'HTTP', url: `/collections/${toHandle(lineName)}`, items: familyItems };
    });

    const updated: any = { id: item.id, title: item.title, type: item.type, items: lineSubItems };
    if (item.resourceId) updated.resourceId = item.resourceId;
    if (item.url)        updated.url        = item.url;
    return updated;
  });

  const result = await graphql(`
    mutation($id: ID!, $handle: String!, $title: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, handle: $handle, title: $title, items: $items) {
        menu { id }
        userErrors { field message }
      }
    }
  `, { id: menu.id, handle: 'menu-principal', title: menu.title, items: allItems });

  const errs: any[] = result?.menuUpdate?.userErrors || [];
  if (errs.length) console.warn('[Suprides] Erros no menu:', JSON.stringify(errs));
}

export async function getMenuTopItems(handle = 'menu-principal'): Promise<string[]> {
  const menu = await _fetchMenuByHandle(handle);
  return (menu?.items || []).map((i: any) => i.title);
}

export interface PublicMenuNode {
  title: string;
  shopifyId?: string;
  children: PublicMenuNode[];
}

export async function publishMenuNodes(
  handle: string,
  title: string,
  nodes: PublicMenuNode[]
): Promise<{ ok: boolean; errors: string[] }> {
  const menu = await _fetchMenuByHandle(handle);
  if (!menu) return { ok: false, errors: [`Menu '${handle}' não encontrado no Shopify`] };

  const toItem = (n: PublicMenuNode): any => {
    const item: any = { title: n.title, type: 'COLLECTION', items: (n.children || []).map(toItem) };
    if (n.shopifyId) item.resourceId = `gid://shopify/Collection/${n.shopifyId}`;
    return item;
  };

  const items = nodes.map(toItem);
  const result = await graphql(`
    mutation($id: ID!, $handle: String!, $title: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, handle: $handle, title: $title, items: $items) {
        menu { id }
        userErrors { field message }
      }
    }
  `, { id: menu.id, handle, title, items });

  const userErrors: { field: string; message: string }[] = result?.menuUpdate?.userErrors || [];
  return { ok: userErrors.length === 0, errors: userErrors.map((e: any) => e.message) };
}

export async function getShopifyMenuFull(handle = 'menu-principal'): Promise<any> {
  return _fetchMenuByHandle(handle);
}

export interface MenuSyncNode {
  title: string;
  shopifyId?: string;
  children: MenuSyncNode[];
}

export async function syncMenuStructure(
  nodes: MenuSyncNode[],
  onProgress?: (phase: string, done: number, total: number) => void
): Promise<{ created: number; renamed: number; deleted: number; errors: string[] }> {
  const menu = await _fetchMenuByHandle('menu-principal');
  if (!menu) throw new Error("Menu 'menu-principal' não encontrado no Shopify");

  const { rest } = makeClients();
  let created = 0;
  let renamed = 0;
  const deleted = 0;
  const errors: string[] = [];

  // Recolher todos os shopifyIds existentes nos nós
  const allShopifyIds = new Set<string>();
  const extractIds = (ns: MenuSyncNode[]) => {
    for (const n of ns) {
      if (n.shopifyId) allShopifyIds.add(n.shopifyId);
      if (n.children?.length) extractIds(n.children);
    }
  };
  extractIds(nodes);

  // Sempre buscar todas as coleções — necessário para resolver IDs em falta
  // e para validar IDs já guardados (podem estar desatualizados)
  const allCollections = await _fetchAllCollections();

  // Validar todos os shopifyIds guardados contra o Shopify
  const collectionTitles = new Map<string, string>();
  if (allShopifyIds.size > 0) {
    try {
      const idChunks: string[][] = [];
      const idArr = Array.from(allShopifyIds);
      for (let i = 0; i < idArr.length; i += 200) idChunks.push(idArr.slice(i, i + 200));
      for (const chunk of idChunks) {
        const collRes = await _requestWithRetry(
          () => rest.get('custom_collections.json', {
            params: { ids: chunk.join(','), limit: 250, fields: 'id,title' }
          }),
          'fetchCollectionTitles'
        );
        for (const c of ((collRes as any).data?.custom_collections || [])) {
          collectionTitles.set(String(c.id), c.title);
        }
      }
    } catch { /* non-fatal */ }
  }

  // Limpar shopifyIds duplicados (o mesmo ID em múltiplos nós = sync anterior errado)
  const _idCount = new Map<string, number>();
  const _countIds = (ns: MenuSyncNode[]) => {
    for (const n of ns) {
      if (n.shopifyId) _idCount.set(n.shopifyId, (_idCount.get(n.shopifyId) || 0) + 1);
      if (n.children?.length) _countIds(n.children);
    }
  };
  _countIds(nodes);
  const _clearDupes = (ns: MenuSyncNode[]) => {
    for (const n of ns) {
      if (n.shopifyId && (_idCount.get(n.shopifyId) || 0) > 1) delete n.shopifyId;
      if (n.children?.length) _clearDupes(n.children);
    }
  };
  _clearDupes(nodes);

  // Handle hierárquico: "informatica--acessorios" em vez de "acessorios" para evitar colisões
  const getCollectionGid = async (node: MenuSyncNode, parentHandle = ''): Promise<string> => {
    if (node.shopifyId) {
      const currentTitle = collectionTitles.get(node.shopifyId);
      if (currentTitle === undefined) {
        // ID guardado já não existe no Shopify — limpar e resolver pelo handle
        delete node.shopifyId;
      } else {
        if (currentTitle.trim() !== node.title.trim()) {
          try {
            const newHandle = parentHandle ? `${parentHandle}--${toHandle(node.title)}` : toHandle(node.title);
            await _requestWithRetry(
              () => rest.put(`custom_collections/${node.shopifyId}.json`, {
                custom_collection: { id: Number(node.shopifyId), title: node.title, handle: newHandle }
              }),
              `renameCollection(${node.shopifyId})`
            );
            renamed++;
            _collectionCache.delete(toHandle(currentTitle));
            allCollections.set(newHandle, `gid://shopify/Collection/${node.shopifyId}`);
          } catch (e: any) {
            errors.push(`Erro ao renomear '${currentTitle}' → '${node.title}': ${e.message}`);
          }
        }
        return `gid://shopify/Collection/${node.shopifyId}`;
      }
    }

    const nodeHandle = toHandle(node.title);
    const handle = parentHandle ? `${parentHandle}--${nodeHandle}` : nodeHandle;

    const existingGid = allCollections.get(handle);
    if (existingGid) {
      node.shopifyId = existingGid.split('/').pop();
      return existingGid;
    }

    // Truly new collection — create via REST
    try {
      const createRes = await _requestWithRetry(
        () => rest.post('custom_collections.json', { custom_collection: { title: node.title, handle } }),
        `createCollection(${handle})`
      );
      created++;
      const newId = String((createRes as any).data.custom_collection.id);
      const newGid = `gid://shopify/Collection/${newId}`;
      node.shopifyId = newId;
      allCollections.set(handle, newGid);
      _collectionCache.set(handle, Number(newId));
      return newGid;
    } catch (e: any) {
      errors.push(`Coleção '${node.title}': ${e.message}`);
      return '';
    }
  };

  const total = nodes.reduce((s, l) => s + 1 + (l.children || []).reduce((s2, f) => s2 + 1 + (f.children || []).length, 0), 0);
  let done = 0;

  // Processamento sequencial para evitar rate-limit da API Shopify
  const menuItems: any[] = [];
  for (const linha of nodes) {
    const linhaHandle = toHandle(linha.title);
    const linhaGid = await getCollectionGid(linha, '');
    onProgress?.('collections', ++done, total);
    if (!linhaGid) continue;

    const familyItems: any[] = [];
    for (const familia of (linha.children || [])) {
      const famGid = await getCollectionGid(familia, linhaHandle);
      onProgress?.('collections', ++done, total);
      if (!famGid) continue;
      const famHandle = `${linhaHandle}--${toHandle(familia.title)}`;

      const subItems: any[] = [];
      for (const sub of (familia.children || [])) {
        const subGid = await getCollectionGid(sub, famHandle);
        onProgress?.('collections', ++done, total);
        if (!subGid) continue;
        subItems.push({ title: sub.title, type: 'COLLECTION', resourceId: subGid, items: [] });
      }

      familyItems.push({ title: familia.title, type: 'COLLECTION', resourceId: famGid, items: subItems });
    }

    menuItems.push({ title: linha.title, type: 'COLLECTION', resourceId: linhaGid, items: familyItems });
  }

  if (created > 0) await sleep(2000);

  onProgress?.('menu-update', total, total);

  const menuMutation = `
    mutation($id: ID!, $handle: String!, $title: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, handle: $handle, title: $title, items: $items) {
        menu { id }
        userErrors { field message }
      }
    }
  `;
  const menuVars = { id: menu.id, handle: 'menu-principal', title: menu.title, items: menuItems };

  let result: any;
  try {
    result = await graphql(menuMutation, menuVars);
  } catch (e: any) {
    if (!String(e.message).includes('500')) throw e;

    // HTTP 500 = provavelmente GID inválido/apagado — buscar coleções frescas e filtrar
    const freshCols = allCollections.size > 0 ? allCollections : await _fetchAllCollections();
    const validGids = new Set([...freshCols.values()]);
    const filterItems = (items: any[]): any[] =>
      items
        .filter(i => !i.resourceId || validGids.has(i.resourceId))
        .map(i => ({ ...i, items: filterItems(i.items || []) }));

    result = await graphql(menuMutation, { ...menuVars, items: filterItems(menuItems) });
  }

  const userErrors: any[] = result?.menuUpdate?.userErrors || [];
  for (const e of userErrors) errors.push(e.message);

  return { created, renamed, deleted, errors };
}
