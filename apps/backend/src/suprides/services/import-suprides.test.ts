import '../../test-support/temp-data-dir';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { removeTestDataDir } from '../../test-support/temp-data-dir';
import { ensureSupridesTable, ensureSupridesTagTables } from '../../db/migrate-suprides';
import { getSqlite, closeSqlite } from '../../db/sqlite';
import { markMissingAsRemoved, countActiveProducts } from '../../repositories/suprides-cache';
import { runSupridesImport } from './import-suprides';

const apiProduct = (sku: string) => ({ sku, name: `Produto ${sku}`, price: '10,00', stock: '> 10', product_line: 'ESCRITORIO' });

/** Simula a API: devolve `skus` em páginas de 100. */
const fakeApi = (skus: string[]) => async (page: number, limit: number) =>
  skus.slice((page - 1) * limit, page * limit).map(apiProduct);

const range = (n: number, prefix = 'S') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const row = (sku: string) => getSqlite()
  .prepare('SELECT sku, stock, stock_status, removed_at FROM suprides_products WHERE sku = ?')
  .get(sku) as { sku: string; stock: number; stock_status: string; removed_at: string | null } | undefined;

before(() => { ensureSupridesTable(); ensureSupridesTagTables(); });
after(() => { closeSqlite(); removeTestDataDir(); });

test('importação inicial grava todos os produtos', async () => {
  const r = await runSupridesImport(() => {}, { fetchPage: fakeApi(range(250)) });
  assert.equal(r.saved, 250);
  assert.equal(r.removed, 0);
  assert.equal(countActiveProducts(), 250);
  assert.equal(row('S1')?.stock_status, 'disponivel');
});

test('SKUs que deixam de vir são marcados como retirados (sem stock), não apagados', async () => {
  // 240 de 250 = 96 % → acima do travão
  const r = await runSupridesImport(() => {}, { fetchPage: fakeApi(range(240)) });
  assert.equal(r.removed, 10);
  assert.equal(r.removalSkipped, false);
  const gone = row('S250');
  assert.ok(gone, 'o produto continua na BD');
  assert.equal(gone!.stock, 0);
  assert.equal(gone!.stock_status, 'sem_stock');
  assert.ok(gone!.removed_at);
  assert.equal(countActiveProducts(), 240);
});

test('travão: se vierem menos de 85 % dos ativos, ninguém é marcado', async () => {
  // 100 de 240 ativos
  const r = await runSupridesImport(() => {}, { fetchPage: fakeApi(range(100)) });
  assert.equal(r.removalSkipped, true);
  assert.equal(r.removed, 0);
  assert.equal(countActiveProducts(), 240);
  assert.equal(row('S200')?.removed_at, null);
});

test('allowLargeRemoval passa o travão', async () => {
  const r = await runSupridesImport(() => {}, { fetchPage: fakeApi(range(100)), allowLargeRemoval: true });
  assert.equal(r.removalSkipped, false);
  assert.equal(r.removed, 140);
  assert.equal(countActiveProducts(), 100);
});

test('um produto retirado que volta deixa de estar retirado', async () => {
  await runSupridesImport(() => {}, { fetchPage: fakeApi(range(250)) });
  assert.equal(row('S250')?.removed_at, null);
  assert.equal(row('S250')?.stock_status, 'disponivel');
  assert.equal(countActiveProducts(), 250);
});

test('página que falha aborta sem marcar nada como retirado', { timeout: 60_000 }, async () => {
  const failing = async (page: number, limit: number) => {
    if (page === 2) throw new Error('timeout simulado');
    return fakeApi(range(250))(page, limit);
  };
  await assert.rejects(runSupridesImport(() => {}, { fetchPage: failing }), /Página 2 falhou/);
  assert.equal(countActiveProducts(), 250);
});

test('markMissingAsRemoved só conta os que estavam ativos', () => {
  const seen = new Set(range(249));
  assert.equal(markMissingAsRemoved(seen), 1);
  assert.equal(markMissingAsRemoved(seen), 0);
});
