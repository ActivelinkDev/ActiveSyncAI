import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import products = require('../../repositories/suprides-cache');
import store = require('../repositories/store');
import campaigns = require('../repositories/campaigns');
import { runSupridesImport, mapApiProduct, type ImportEvent } from './import-suprides';

const range = (n: number) => Array.from({ length: n }, (_, i) => `S${i + 1}`);
const pageFetcher = (skus: string[]) => async (page: number, limit: number) =>
  skus.slice((page - 1) * limit, page * limit).map(sku => ({ sku, name: `Produto ${sku}`, stock: '> 10' }));

function mockRepository(t: TestContext, active: number) {
  t.mock.method(products, 'withCatalogueLock', (run: () => Promise<unknown>) => run());
  const saved: string[] = [];
  const removalRequests: string[][] = [];
  t.mock.method(products, 'countActiveProducts', async () => active);
  t.mock.method(products, 'upsertProductsBatch', async (rows: products.SupridesProduct[]) => {
    saved.push(...rows.map(p => p.sku));
    return rows.length;
  });
  t.mock.method(products, 'markMissingAsRemoved', async (seen: Set<string>) => {
    removalRequests.push([...seen]);
    return Math.max(0, active - seen.size);
  });
  t.mock.method(products, 'countProducts', async () => Math.max(active, saved.length));
  t.mock.method(store, 'loadPublicMenu', async () => ({ nodes: [] }));
  t.mock.method(campaigns, 'withdrawLossMakers', async () => []);
  return { saved, removalRequests };
}

test('mapeia o produto do fornecedor, incluindo o retorno de stock', () => {
  const mapped = mapApiProduct({ sku: 'S1', name: 'Produto S1', stock: '> 10', price: '10,25', images: ['a', 'b'] });
  assert.equal(mapped.sku, 'S1');
  assert.equal(mapped.stock, 20);
  assert.equal(mapped.stock_status, 'disponivel');
  assert.equal(mapped.cost, 10.25);
  assert.equal(mapped.images, '["a","b"]');
});

test('importação inicial grava cada página e confirma os SKU vistos', async t => {
  const { saved, removalRequests } = mockRepository(t, 0);
  const skus = range(620);
  const result = await runSupridesImport(() => {}, { fetchPage: pageFetcher(skus) });
  assert.deepEqual(saved, skus);
  assert.deepEqual(removalRequests, [skus]);
  assert.deepEqual(result, { saved: 620, total: 620, removed: 0, removalSkipped: false });
});

test('acima do limiar, permite marcar os produtos ausentes como retirados', async t => {
  const { removalRequests } = mockRepository(t, 250);
  const skus = range(240);
  const result = await runSupridesImport(() => {}, { fetchPage: pageFetcher(skus) });
  assert.deepEqual(removalRequests, [skus]);
  assert.equal(result.removed, 10);
  assert.equal(result.removalSkipped, false);
});

test('catálogo abaixo de 85% aguarda confirmação para marcar retirados', async t => {
  const { removalRequests } = mockRepository(t, 240);
  const fetchPage = pageFetcher(range(100));
  const blocked = await runSupridesImport(() => {}, { fetchPage });
  assert.equal(blocked.removalSkipped, true);
  assert.equal(removalRequests.length, 0);
  const confirmed = await runSupridesImport(() => {}, { fetchPage, allowLargeRemoval: true });
  assert.equal(confirmed.removed, 140);
  assert.deepEqual(removalRequests, [range(100)]);
});

test('página que falha aborta a importação sem marcar retirados', { timeout: 60_000 }, async t => {
  const { removalRequests } = mockRepository(t, 250);
  const events: ImportEvent[] = [];
  await assert.rejects(runSupridesImport(e => events.push(e), {
    fetchPage: async page => {
      if (page === 2) throw new Error('timeout simulado');
      return [];
    },
  }), /Página 2 falhou/);
  assert.deepEqual(removalRequests, []);
  assert.equal(events[events.length - 1]?.type, 'error');
});

test('falha ao gravar uma onda não pode marcar retirados', async t => {
  const { removalRequests } = mockRepository(t, 1);
  t.mock.method(products, 'upsertProductsBatch', async () => { throw new Error('falha de escrita'); });
  await assert.rejects(runSupridesImport(() => {}, { fetchPage: pageFetcher(['S1']) }), /falha de escrita/);
  assert.equal(removalRequests.length, 0);
});
