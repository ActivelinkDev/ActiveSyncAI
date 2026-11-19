/**
 * Marcas da loja (secção "As nossas marcas" do tema), mantidas pelo integrador.
 *
 * Na Shopify: um metaobject do tipo `marca` por marca, legível pelo tema (shop.metaobjects.marca).
 *   nome      (integrador)  nome da marca, igual ao "vendor" dos produtos
 *   produtos  (integrador)  n.º de produtos à venda (ativos)
 *   visivel   (integrador)  true se tem produtos à venda; false quando deixa de ter
 *   logo      (à mão)       logótipo, carregado uma vez no admin — o integrador nunca lhe toca
 *   ordem     (à mão)       opcional, para ordenar à mão
 *   oculta    (à mão)       esconder sempre esta marca, mesmo com produtos
 * As entradas nunca são apagadas (para não perder o logótipo): passam a visivel=false.
 * Corre no fim de cada sync completo e com `npm run brands:sync [-- --apply]`.
 */
import { gql, makeGraphqlClient, type SnapshotProduct } from '../suprides/api/shopify-read';
import { slug } from '../suprides/services/price-calc';
import { logLine } from '../utils/logger';

export const BRAND_TYPE = 'marca';
/** Valores de "vendor" que não são marcas (o sync usa "Suprides" quando o produto vem sem marca). */
const NOT_BRANDS = new Set(['suprides', '']);

export interface ActiveBrand { handle: string; name: string; products: number }
export interface ShopBrand { handle: string; name: string | null; products: number | null; visible: boolean | null }
export interface BrandWrite { handle: string; name: string; products: number; visible: boolean; isNew: boolean }

/** Marcas com produtos à venda (estado ACTIVE), a partir da leitura da loja. Puro. */
export function activeBrands(products: SnapshotProduct[]): ActiveBrand[] {
  const byHandle = new Map<string, { names: Map<string, number>; products: number }>();
  for (const p of products) {
    if (p.status !== 'ACTIVE') continue;
    const name = (p.vendor ?? '').trim();
    if (NOT_BRANDS.has(name.toLowerCase())) continue;
    const handle = slug(name);
    if (!handle) continue;
    const b = byHandle.get(handle) ?? { names: new Map(), products: 0 };
    b.products++;
    b.names.set(name, (b.names.get(name) ?? 0) + 1);
    byHandle.set(handle, b);
  }
  return [...byHandle].map(([handle, b]) => ({
    handle,
    // Grafia mais usada (ex.: "Xiaomi" vs "XIAOMI")
    name: [...b.names].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0],
    products: b.products,
  })).sort((a, b) => b.products - a.products || a.name.localeCompare(b.name));
}

/** O que escrever: marcas ativas com valores diferentes, e marcas que deixaram de ter produtos. Puro. */
export function planBrandWrites(active: ActiveBrand[], shop: ShopBrand[]): BrandWrite[] {
  const existing = new Map(shop.map(b => [b.handle, b]));
  const out: BrandWrite[] = [];
  for (const a of active) {
    const e = existing.get(a.handle);
    if (e && e.name === a.name && e.products === a.products && e.visible === true) continue;
    out.push({ handle: a.handle, name: a.name, products: a.products, visible: true, isNew: !e });
  }
  const activeHandles = new Set(active.map(a => a.handle));
  for (const e of shop) {
    if (activeHandles.has(e.handle)) continue;
    if (e.visible === false && (e.products ?? 0) === 0) continue;
    out.push({ handle: e.handle, name: e.name ?? e.handle, products: 0, visible: false, isNew: false });
  }
  return out;
}

// ── Shopify ──────────────────────────────────────────────────────────────────

type Client = Awaited<ReturnType<typeof makeGraphqlClient>>;

function userErrors(what: string, payload: any): void {
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(`${what}: ${errs.map((e: any) => `${(e.field || []).join('.')} ${e.message}`.trim()).join('; ')}`);
}

/** Cria a definição `marca` (uma vez), legível pela loja online. */
async function ensureDefinition(http: Client): Promise<boolean> {
  const d = await gql(http, `query($t: String!) { metaobjectDefinitionByType(type: $t) { id } }`, { t: BRAND_TYPE });
  if (d?.metaobjectDefinitionByType?.id) return false;
  const r = await gql(http, `mutation($d: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $d) { metaobjectDefinition { id } userErrors { field message code } } }`, {
    d: {
      type: BRAND_TYPE, name: 'Marca', displayNameKey: 'nome',
      access: { storefront: 'PUBLIC_READ' },
      fieldDefinitions: [
        { key: 'nome', name: 'Nome', type: 'single_line_text_field', required: true },
        { key: 'logo', name: 'Logótipo', type: 'file_reference', description: 'Carregar à mão; o integrador não mexe.' },
        { key: 'produtos', name: 'Produtos à venda', type: 'number_integer', description: 'Atualizado pelo integrador.' },
        { key: 'visivel', name: 'Visível', type: 'boolean', description: 'Atualizado pelo integrador: tem produtos à venda.' },
        { key: 'ordem', name: 'Ordem', type: 'number_integer', description: 'Opcional: ordenar à mão (menor primeiro).' },
        { key: 'oculta', name: 'Esconder sempre', type: 'boolean', description: 'Esconder esta marca da homepage.' },
      ],
    },
  });
  userErrors('metaobjectDefinitionCreate', r?.metaobjectDefinitionCreate);
  return true;
}

async function readShopBrands(http: Client): Promise<ShopBrand[]> {
  const out: ShopBrand[] = [];
  let after: string | null = null;
  do {
    const d: any = await gql(http, `query($t: String!, $a: String) {
        metaobjects(type: $t, first: 250, after: $a) {
          nodes { handle fields { key value } }
          pageInfo { hasNextPage endCursor } } }`, { t: BRAND_TYPE, a: after });
    for (const n of d?.metaobjects?.nodes ?? []) {
      const f = new Map<string, string | null>((n.fields ?? []).map((x: any) => [x.key, x.value]));
      out.push({
        handle: n.handle, name: f.get('nome') ?? null,
        products: f.get('produtos') != null ? Number(f.get('produtos')) : null,
        visible: f.get('visivel') == null ? null : f.get('visivel') === 'true',
      });
    }
    after = d?.metaobjects?.pageInfo?.hasNextPage ? d.metaobjects.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function upsertBrand(http: Client, w: BrandWrite): Promise<void> {
  const r = await gql(http, `mutation($h: MetaobjectHandleInput!, $m: MetaobjectUpsertInput!) {
      metaobjectUpsert(handle: $h, metaobject: $m) { metaobject { id } userErrors { field message code } } }`, {
    h: { type: BRAND_TYPE, handle: w.handle },
    // Só os campos do integrador: logo, ordem e oculta ficam como estão.
    m: { fields: [
      { key: 'nome', value: w.name },
      { key: 'produtos', value: String(w.products) },
      { key: 'visivel', value: w.visible ? 'true' : 'false' },
    ] },
  });
  userErrors(`metaobjectUpsert(${w.handle})`, r?.metaobjectUpsert);
}

export interface BrandsSyncResult { active: ActiveBrand[]; writes: BrandWrite[]; definitionCreated: boolean; applied: boolean }

/** Atualiza as marcas na loja. `apply=false` só calcula (lê a loja, não escreve). */
export async function syncBrands(products: SnapshotProduct[], apply = true): Promise<BrandsSyncResult> {
  const http = await makeGraphqlClient();
  const active = activeBrands(products);
  const definitionCreated = apply ? await ensureDefinition(http) : false;
  const existing = definitionCreated ? [] : await readShopBrands(http).catch(e => {
    if (!apply && /metaobject|definition|access/i.test(String(e?.message))) return [];   // ainda sem definição
    throw e;
  });
  const writes = planBrandWrites(active, existing);
  if (apply) for (const w of writes) await upsertBrand(http, w);
  return { active, writes, definitionCreated, applied: apply };
}

/** Versão para o fim do sync: nunca lança (as marcas não podem estragar o resultado do sync). */
export async function syncBrandsAfterSync(products: SnapshotProduct[] | null): Promise<void> {
  if (!products) return;
  try {
    const r = await syncBrands(products, true);
    if (r.definitionCreated) logLine('[Marcas] Definição "marca" criada na Shopify');
    if (r.writes.length) {
      logLine(`[Marcas] ${r.active.length} marca(s) à venda; atualizadas ${r.writes.length}: ` +
        r.writes.slice(0, 10).map(w => `${w.name}${w.visible ? ` (${w.products})` : ' (escondida)'}`).join(', '));
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    logLine(/access denied|scope|ACCESS_DENIED/i.test(msg)
      ? '[Marcas] Não atualizadas: a app da Shopify não tem permissão para metaobjects (write_metaobjects, write_metaobject_definitions)'
      : `[Marcas] Não atualizadas: ${msg}`);
  }
}
