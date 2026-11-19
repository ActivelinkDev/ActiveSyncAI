import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU, MAPPING } from '../../test-support/fixtures';
import type { SupridesProduct } from '../types';
import type { SnapshotProduct } from '../api/shopify-read';
import type { loadSyncData } from '../repositories/sync-data';
import { runFullShopifySync, type SyncPlanItem } from './sync';
import { verifyPlan } from '../../services/sync-verify';

const prod = (p: Partial<SupridesProduct> & { sku: string }): SupridesProduct => ({
  brand: 'Marca', product_line: 'ESCRITORIO', family: 'PAPEL',
  name: `Produto ${p.sku}`, price: '10', stock: '20', stock_status: 'disponivel',
  ...p,
});

const shop = (productId: number, sku: string, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE'): SnapshotProduct => ({
  productId, title: `Produto ${sku}`, handle: sku.toLowerCase(), status, vendor: 'Marca', productType: '',
  updatedAt: '2026-05-22T00:00:00Z', descriptionHtml: '', stockStatus: null, variantsCount: 1,
  variantId: productId * 10, sku, price: '1.00', compareAtPrice: null, barcode: null,
  inventoryItemId: productId * 100, cost: null, weight: null, collectionIds: [], collectionTitles: [],
});

const SHOP: SnapshotProduct[] = [
  shop(1, 'UPD'),
  shop(2, 'NOCOST'),
  shop(3, 'UNMAPPED-SEM-STOCK'),
  { ...shop(4, 'UNMAPPED-ATIVO'), collectionIds: ['101'], productType: 'Capas' },
  shop(5, 'BELOW'),
  shop(9, 'OUTRO-FORNECEDOR'),
];

const products = [
    prod({ sku: 'UPD', price: '10', pvpr: '30' }),                     // atualiza: 10 / 0,8 × 1,23 = 15,375 → 15,49
    // NEW/NOCOST-NEW numa linha com L2: só-L1 não chega para entrar um produto que ainda não está na loja
    prod({ sku: 'NEW', product_line: 'ACESSORIOS', price: '5' }),    // não existe na loja → skip-new
    prod({ sku: 'NOCOST', price: undefined }),                          // existe, sem custo → draft-no-cost
    prod({ sku: 'NOCOST-NEW', product_line: 'ACESSORIOS', price: undefined }), // não existe, sem custo → skip-no-cost
    prod({ sku: 'UNMAPPED-SEM-STOCK', product_line: 'LINHA X', stock: '0', stock_status: 'sem_stock' }), // → draft-unmapped
    prod({ sku: 'UNMAPPED-ATIVO', product_line: undefined, family: undefined }), // sem linha → preço com a margem das coleções da loja
    prod({ sku: 'BELOW', product_line: 'ACESSORIOS', price: '41.4' }), // sem margem: 41,4 × 1,23 = 50,92 → 50,90 < custo+IVA
];

type StoredStates = Awaited<ReturnType<typeof loadSyncData>>['states'];
const run = (createNewProducts = false, states: StoredStates = [], shop = SHOP) => runFullShopifySync({
  dryRun: true,
  readShop: async () => shop,
  readLocal: async () => ({
    settings: { ivaRate: 23, rounding: { aboveUnitTo999: true, belowUnitTo499: true }, createNewProducts },
    collMap: MAPPING, menu: MENU, collMargins: { rules: { '101': { mode: 'percentage', marginValue: 20 } } },
    products, states, tags: [],
  }),
}) as Promise<any>;
const bySku = (plan: SyncPlanItem[]) => new Map(plan.map(i => [i.sku, i]));

test('dry-run: decisão por produto', async () => {
  const r = await run();
  const plan = bySku(r.plan);

  const upd = plan.get('UPD')!;
  assert.equal(upd.action, 'update');
  assert.equal(upd.shopifyProductId, 1);
  assert.equal(upd.status, 'active');
  assert.equal(upd.price, '15.49');
  assert.equal(upd.compareAtPrice, null); // PVPR 30 nunca vai como preço riscado (Omnibus, 19/11)
  assert.equal(upd.cost, '10.00');
  assert.equal(upd.marginRule, 'percentage:20');
  assert.deepEqual(upd.collectionIds, ['101']);

  assert.equal(plan.get('NEW')?.action, 'skip-new');
  assert.equal(plan.get('NOCOST')?.action, 'draft-no-cost');
  assert.equal(plan.get('NOCOST')?.status, 'draft');
  assert.equal(plan.get('NOCOST-NEW')?.action, 'skip-no-cost');
  assert.equal(plan.get('UNMAPPED-SEM-STOCK')?.action, 'draft-unmapped');
  const ua = plan.get('UNMAPPED-ATIVO')!;
  assert.equal(ua.action, 'update');
  assert.deepEqual(ua.collectionIds, ['101']);
  assert.equal(ua.marginRule, 'percentage:20');
  assert.equal(ua.price, '15.49');

  assert.equal(r.summary.update, 3);
  assert.equal(r.summary.create, 0);
  assert.equal(r.summary.skipNew, 1);
  assert.equal(r.summary.draftNoCost, 1);
  assert.equal(r.summary.skipNoCost, 1);
  assert.equal(r.summary.draftUnmapped, 1);
});

test('dry-run: verificações do resumo', async () => {
  const r = await run();
  assert.equal(r.checks.noMarginRule, 1);           // BELOW
  assert.equal(r.checks.belowCostVat, 1);
  assert.equal(r.checks.belowCostVatSample[0].sku, 'BELOW');
  // Ativos na loja em que o sync não toca: só o produto de outro fornecedor.
  assert.equal(r.checks.untouchedActive, 1);
  assert.deepEqual(r.checks.untouchedActiveSample.map((x: any) => x.sku), ['OUTRO-FORNECEDOR']);
});

test('o dry-run concilia bigint do SQL com o snapshot sem alterar os IDs guardados', async () => {
  const id = 820000000001;
  const shop = SHOP.map(p => p.sku === 'UPD' ? { ...p, productId: id } : p);
  const states: StoredStates = [{
    sku: 'UPD', shopify_product_id: String(id - 1), shopify_variant_id: '10', shopify_inventory_item_id: '100',
    shopify_content_hash: null, shopify_node_id: null, images_synced: 0,
  }];
  const r = await run(false, states, shop);
  assert.equal(bySku(r.plan).get('UPD')?.shopifyProductId, id);
  assert.equal(states[0].shopify_product_id, String(id - 1));
});

test('createNewProducts ligado → o produto novo passa a create', async () => {
  const r = await run(true);
  assert.equal(bySku(r.plan).get('NEW')?.action, 'create');
  assert.equal(r.summary.skipNew, 0);
});

test('sync:verify: loja igual ao plano → sem diferenças; preço errado → diferença', async () => {
  const r = await run();
  const plan: SyncPlanItem[] = r.plan;
  const after = SHOP.map(p => {
    const it = plan.find(i => i.shopifyProductId === p.productId);
    if (!it) return p;
    return {
      ...p,
      status: (it.status || p.status).toUpperCase(),
      price: it.price ?? p.price,
      compareAtPrice: it.compareAtPrice ?? null,
      cost: it.cost ?? p.cost,
      collectionIds: it.collectionIds ?? p.collectionIds,
    };
  });
  const ok = verifyPlan(plan, after);
  assert.equal(ok.mismatches.length, 0, JSON.stringify(ok.mismatches));

  const wrong = after.map(p => (p.sku === 'UPD' ? { ...p, price: '14.99' } : p));
  const bad = verifyPlan(plan, wrong);
  assert.equal(bad.mismatches.length, 1);
  assert.equal(bad.mismatches[0].field, 'price');

  const created = [...after, shop(50, 'NEW')];
  assert.equal(verifyPlan(plan, created).mismatchesByField.created, 1);
});

test('sync:verify: produto ativo não publicado na loja → diferença', async () => {
  const r = await run();
  const plan: SyncPlanItem[] = r.plan;
  const it = plan.find(i => i.sku === 'UPD')!;
  const after = SHOP.map(p => (p.sku === 'UPD'
    ? { ...p, status: 'ACTIVE', publishedAt: null, price: it.price!, compareAtPrice: it.compareAtPrice ?? null, cost: it.cost!, collectionIds: it.collectionIds! }
    : p));
  const v = verifyPlan(plan.filter(i => i.sku === 'UPD'), after);
  assert.deepEqual(v.mismatches.map(m => m.field), ['published']);
});
