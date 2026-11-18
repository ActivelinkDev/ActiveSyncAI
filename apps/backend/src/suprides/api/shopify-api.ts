import { loadConnectionSettings } from '../repositories/store';
import { gql, makeGraphqlClient, SHOPIFY_API_VERSION } from './shopify-read';

export { SHOPIFY_API_VERSION };

// Cancelamento: o sync verifica entre produtos (throwIfCancelled); estas funções mantêm-se
// para compatibilidade com as rotas.
let _abortController = new AbortController();
export function resetSyncAbort(): void { _abortController = new AbortController(); }
export function abortSync(): void { _abortController.abort(); }

export function getShopifyStore(): string {
  return loadConnectionSettings().shopifyStore || process.env.SHOPIFY_STORE || '';
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** GraphQL com novas tentativas e gestão do limite de pontos (ver shopify-read.gql). */
async function graphql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  return gql(makeGraphqlClient(), query, variables);
}

const gid = (type: string, id: number | string) => `gid://shopify/${type}/${id}`;
const numId = (g: string): number => Number(String(g).split('/').pop());

function throwUserErrors(what: string, payload: any): void {
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(`${what}: ${errs.map((e: any) => `${(e.field || []).join('.')} ${e.message}`.trim()).join('; ')}`);
}

// ── Produtos ──────────────────────────────────────────────────────────────────

export async function findVariantBySku(sku: string): Promise<{ id: number; sku: string; product_id: number; inventory_item_id: number } | null> {
  const data = await graphql(
    `query($q: String!) { productVariants(first: 5, query: $q) { nodes { id sku product { id } inventoryItem { id } } } }`,
    { q: `sku:"${sku.replace(/"/g, '\\"')}"` },
  );
  const node = (data?.productVariants?.nodes || []).find((n: any) => n.sku === sku);
  if (!node) return null;
  return { id: numId(node.id), sku: node.sku, product_id: numId(node.product.id), inventory_item_id: numId(node.inventoryItem.id) };
}

const PRODUCT_UPDATE = `
mutation($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) { product { id } userErrors { field message } }
}`;

/** productUpdate: campos do produto, metafields, coleções (collectionsToJoin/Leave) e media. */
export async function productUpdate(productId: number, input: Record<string, unknown>, media?: { originalSource: string }[]): Promise<void> {
  const data = await graphql(PRODUCT_UPDATE, {
    product: { id: gid('Product', productId), ...input },
    media: media?.length ? media.map(m => ({ originalSource: m.originalSource, mediaContentType: 'IMAGE' })) : null,
  });
  throwUserErrors(`productUpdate(${productId})`, data?.productUpdate);
}

/** productVariantsBulkUpdate de uma variante: preço, preço riscado, barcodes, inventoryItem (custo/peso). */
export async function variantUpdate(productId: number, variantId: number, input: Record<string, unknown>): Promise<void> {
  const data = await graphql(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId: gid('Product', productId), variants: [{ id: gid('ProductVariant', variantId), ...input }] },
  );
  throwUserErrors(`productVariantsBulkUpdate(${productId})`, data?.productVariantsBulkUpdate);
}

let _onlineStorePublicationId: Promise<string> | null = null;

/** ID da publicação "Online Store" (lido uma vez por processo). */
function onlineStorePublicationId(): Promise<string> {
  if (!_onlineStorePublicationId) {
    const p = graphql('{ publications(first: 50) { nodes { id name } } }').then((d: any) => {
      const nodes: { id: string; name: string }[] = d?.publications?.nodes || [];
      const found = nodes.find(n => /online store|loja online/i.test(n.name));
      if (!found) throw new Error('Publicação "Online Store" não encontrada');
      return found.id;
    });
    p.catch(() => { _onlineStorePublicationId = null; });
    _onlineStorePublicationId = p;
  }
  return _onlineStorePublicationId;
}

async function setPublished(productId: number, publish: boolean): Promise<void> {
  const publicationId = await onlineStorePublicationId();
  const name = publish ? 'publishablePublish' : 'publishableUnpublish';
  const data = await graphql(
    `mutation($id: ID!, $input: [PublicationInput!]!) {
      ${name}(id: $id, input: $input) { userErrors { field message } }
    }`,
    { id: gid('Product', productId), input: [{ publicationId }] },
  );
  throwUserErrors(`${name}(${productId})`, data?.[name]);
}

/** Publica o produto na Loja online. */
export async function publishProduct(productId: number): Promise<void> {
  await setPublished(productId, true);
}

/** Retira o produto da Loja online. */
export async function unpublishProduct(productId: number): Promise<void> {
  await setPublished(productId, false);
}

export interface CreateProductInput {
  title: string; descriptionHtml: string; vendor: string; productType: string; handle: string;
  status: 'ACTIVE' | 'DRAFT'; sku: string; price: string; compareAtPrice?: string | null; barcode?: string | null;
  cost?: string; weightGrams?: number; metafields?: { namespace: string; key: string; value: string }[];
  collectionIds?: string[];
}

/** Cria um produto de uma variante com productSet. Devolve os IDs numéricos. */
export async function createProduct(p: CreateProductInput): Promise<{ productId: number; variantId: number; inventoryItemId: number }> {
  const inventoryItem: Record<string, unknown> = { sku: p.sku, tracked: false };
  if (p.cost) inventoryItem.cost = p.cost;
  if (p.weightGrams !== undefined) inventoryItem.measurement = { weight: { value: p.weightGrams, unit: 'GRAMS' } };
  const data = await graphql(
    `mutation($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
        userErrors { field message }
      }
    }`,
    { input: {
      title: p.title, descriptionHtml: p.descriptionHtml, vendor: p.vendor, productType: p.productType,
      handle: p.handle, status: p.status,
      metafields: (p.metafields || []).map(m => ({ ...m, type: 'single_line_text_field' })),
      collections: (p.collectionIds || []).filter(id => /^\d+$/.test(id)).map(id => gid('Collection', id)),
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants: [{
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
        price: p.price, compareAtPrice: p.compareAtPrice ?? null,
        barcodes: p.barcode ? [{ value: p.barcode }] : [],
        inventoryItem,
      }],
    } },
  );
  throwUserErrors('productSet', data?.productSet);
  const prod = data.productSet.product;
  const v = prod.variants.nodes[0];
  return { productId: numId(prod.id), variantId: numId(v.id), inventoryItemId: numId(v.inventoryItem.id) };
}

export async function findProductByHandle(handle: string): Promise<{ id: number; variants: { id: number; inventory_item_id: number }[] } | null> {
  const data = await graphql(
    `query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id variants(first: 1) { nodes { id inventoryItem { id } } } } }`,
    { h: handle },
  );
  const p = data?.productByIdentifier;
  if (!p) return null;
  return { id: numId(p.id), variants: p.variants.nodes.map((v: any) => ({ id: numId(v.id), inventory_item_id: numId(v.inventoryItem.id) })) };
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

/** Upsert de metafields (por namespace+key) via productUpdate. */
export async function updateProductMetafields(productId: number, metafields: MetafieldInput[]): Promise<void> {
  if (!metafields.length) return;
  await productUpdate(productId, {
    metafields: metafields.map(m => ({ ...m, type: 'single_line_text_field' })),
  });
}

// ── Coleções ──────────────────────────────────────────────────────────────────

export const toHandle = (str: string) => String(str)
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '')
  .slice(0, 255);

export async function findCollectionId(title: string): Promise<number | null> {
  const data = await graphql(
    `query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id } }`,
    { h: toHandle(title) },
  );
  const id = data?.collectionByIdentifier?.id;
  return id ? numId(id) : null;
}

export async function addProductToCollection(productId: number, collectionId: number): Promise<void> {
  await productUpdate(productId, { collectionsToJoin: [gid('Collection', collectionId)] });
}

export async function removeProductFromCollection(productId: number, collectionId: number): Promise<void> {
  await productUpdate(productId, { collectionsToLeave: [gid('Collection', collectionId)] });
}

export async function fetchProductsInCollection(collectionId: number): Promise<{ id: number; sku: string }[]> {
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
    `, { id: gid('Collection', collectionId), cursor });
    for (const p of (data?.collection?.products?.nodes || [])) {
      results.push({ id: numId(p.id), sku: p.variants?.nodes?.[0]?.sku || '' });
    }
    cursor = data?.collection?.products?.pageInfo?.hasNextPage ? data.collection.products.pageInfo.endCursor : null;
  } while (cursor);
  return results;
}

// ── Imagens (media) ───────────────────────────────────────────────────────────

export interface ShopifyImage {
  id: number; src: string; position?: number;
  /** UPLOADED | PROCESSING | READY | FAILED */
  status?: string;
}

/** Imagens (MediaImage) de um produto, por ordem, com o estado do processamento. */
export async function getProductImages(productId: number): Promise<ShopifyImage[]> {
  const data = await graphql(
    `query($id: ID!) { product(id: $id) { media(first: 100) { nodes { id status mediaContentType ... on MediaImage { image { url } originalSource { url } } } } } }`,
    { id: gid('Product', productId) },
  );
  return (data?.product?.media?.nodes || [])
    .filter((m: any) => m.mediaContentType === 'IMAGE')
    .map((m: any, i: number) => ({ id: numId(m.id), src: m.originalSource?.url || m.image?.url || '', position: i + 1, status: m.status }));
}

/** Acrescenta imagens a um produto (a Shopify descarrega-as de forma assíncrona). */
export async function addProductImages(productId: number, urls: string[]): Promise<number> {
  if (!urls.length) return 0;
  await productUpdate(productId, {}, urls.map(u => ({ originalSource: u })));
  return urls.length;
}

/** Compatibilidade: acrescenta uma imagem. */
export async function addProductImage(productId: number, src: string, _position?: number): Promise<ShopifyImage | null> {
  await addProductImages(productId, [src]);
  return { id: 0, src };
}

/** Retira uma imagem (MediaImage) do produto. */
export async function deleteProductImage(productId: number, imageId: number): Promise<void> {
  const data = await graphql(
    `mutation($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { userErrors { field message } } }`,
    { files: [{ id: gid('MediaImage', imageId), referencesToRemove: [gid('Product', productId)] }] },
  );
  throwUserErrors(`fileUpdate(${imageId})`, data?.fileUpdate);
}

/**
 * Chave de comparação de imagens pelo nome de ficheiro.
 * - A Shopify acrescenta "_<uuid>" ao nome quando copia a imagem para o CDN dela.
 * - A Suprides muda o prefixo hexadecimal a cada exportação ("69749f02dbb0b_product_image_0.jpg"
 *   passa a "6a48ff029c45c_product_image_0.jpeg") e por vezes a extensão.
 * Fica a parte estável ("product_image_0"); a mesma posição conta como a mesma foto.
 */
export function imageKeyFromUrl(url: string): string {
  try {
    const clean = String(url).split('?')[0].split('#')[0];
    const base = decodeURIComponent(clean.substring(clean.lastIndexOf('/') + 1)).toLowerCase();
    return base
      .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.[a-z0-9]+$)/, '')
      .replace(/^[0-9a-f]{10,16}_/, '')
      .replace(/\.(jpe?g|png|webp|gif)$/, '');
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
 * Reconcilia as imagens de forma idempotente: lê as imagens do produto e acrescenta só as
 * que faltam (comparadas por nome de ficheiro), numa só chamada.
 */
export async function reconcileProductImages(
  productId: number,
  desiredUrls: string[],
): Promise<{ added: number; missing: number; total: number; complete: boolean }> {
  const desired = dedupeImageUrls(desiredUrls.filter(u => /^https?:\/\//i.test(u)));
  const current = await getProductImages(productId);
  const currentKeys = new Set(current.map(i => imageKeyFromUrl(i.src || '')));
  const missing = desired.filter(u => !currentKeys.has(imageKeyFromUrl(u)));
  const added = missing.length ? await addProductImages(productId, missing) : 0;
  return { added, missing: missing.length, total: current.length + added, complete: added === missing.length };
}

/** Imagens duplicadas de um produto (mesma foto), mantendo a primeira por ordem. Puro. */
export function findDuplicateImages(current: ShopifyImage[]): { keep: ShopifyImage[]; duplicates: ShopifyImage[] } {
  const seen = new Set<string>();
  const keep: ShopifyImage[] = [];
  const duplicates: ShopifyImage[] = [];
  for (const img of current) {
    const key = imageKeyFromUrl(img.src || '');
    if (seen.has(key)) duplicates.push(img);
    else { seen.add(key); keep.push(img); }
  }
  return { keep, duplicates };
}

/** Apaga ficheiros de imagem (do produto e da biblioteca de ficheiros da loja). */
export async function deleteImageFiles(imageIds: number[]): Promise<void> {
  for (let i = 0; i < imageIds.length; i += 50) {
    const data = await graphql(
      `mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { field message } } }`,
      { ids: imageIds.slice(i, i + 50).map(id => gid('MediaImage', id)) },
    );
    throwUserErrors('fileDelete', data?.fileDelete);
  }
}

/** Remove as imagens duplicadas de um produto, mantendo a primeira cópia de cada foto. */
export async function dedupeProductImages(productId: number): Promise<{ kept: number; removed: number; removedIds: number[] }> {
  const { keep, duplicates } = findDuplicateImages(await getProductImages(productId));
  if (duplicates.length) await deleteImageFiles(duplicates.map(d => d.id));
  return { kept: keep.length, removed: duplicates.length, removedIds: duplicates.map(d => d.id) };
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
        const data = await graphql(
          `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Collection { id title } } }`,
          { ids: chunk.map(id => gid('Collection', id)) },
        );
        for (const c of (data?.nodes || [])) {
          if (c?.id) collectionTitles.set(String(numId(c.id)), c.title);
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
            const r = await graphql(
              `mutation($c: CollectionUpdateInput!) { collectionUpdate(collection: $c) { collection { id } userErrors { field message } } }`,
              { c: { id: gid('Collection', node.shopifyId!), title: node.title, handle: newHandle } },
            );
            throwUserErrors('collectionUpdate', r?.collectionUpdate);
            renamed++;
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

    // Coleção nova
    try {
      const r = await graphql(
        `mutation($c: CollectionInput!) { collectionCreate(input: $c) { collection { id } userErrors { field message } } }`,
        { c: { title: node.title, handle } },
      );
      throwUserErrors('collectionCreate', r?.collectionCreate);
      created++;
      const newId = String(numId(r.collectionCreate.collection.id));
      const newGid = `gid://shopify/Collection/${newId}`;
      node.shopifyId = newId;
      allCollections.set(handle, newGid);
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
