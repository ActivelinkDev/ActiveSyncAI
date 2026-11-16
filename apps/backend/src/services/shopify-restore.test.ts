import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshot, SNAPSHOT_COLLECTIONS_LIMIT } from './shopify-restore';
import type { SnapshotProduct } from '../suprides/api/shopify-read';

const p = (over: Partial<SnapshotProduct> = {}): SnapshotProduct => ({
  productId: 1, title: 'T', handle: 't', status: 'ACTIVE', vendor: 'V', productType: '', updatedAt: '',
  descriptionHtml: '<p>d</p>', stockStatus: 'Disponível', variantsCount: 1, variantId: 10, sku: 'A',
  price: '10.00', compareAtPrice: null, barcode: '123', inventoryItemId: 100, cost: '5.00',
  weight: { unit: 'KILOGRAMS', value: 1 }, collectionIds: ['1'], collectionTitles: ['C1'],
  ...over,
});

test('sem alterações → sem diferenças', () => {
  const d = diffSnapshot([p()], [p()]);
  assert.equal(d.products.length, 0);
});

test('preço, estado e coleção acrescentada', () => {
  const d = diffSnapshot([p()], [p({ price: '12.49', status: 'DRAFT', collectionIds: ['1', '2'] })]);
  assert.equal(d.products.length, 1);
  assert.deepEqual(d.products[0].changes.map(c => c.field).sort(), ['price', 'status']);
  assert.deepEqual(d.products[0].removeCollections, ['2']);
});

test('preços comparados como números ("10" = "10.00")', () => {
  assert.equal(diffSnapshot([p()], [p({ price: '10' })]).products.length, 0);
});

test('cópia antiga sem descrição/peso → esses campos não são repostos', () => {
  const old = p();
  delete (old as any).descriptionHtml;
  delete (old as any).weight;
  const d = diffSnapshot([old], [p({ descriptionHtml: '<p>nova</p>', weight: { unit: 'KILOGRAMS', value: 2 } })]);
  assert.equal(d.products.length, 0);
});

test('coleções possivelmente cortadas na cópia → não se retiram', () => {
  const many = Array.from({ length: SNAPSHOT_COLLECTIONS_LIMIT }, (_, i) => String(i + 1));
  const d = diffSnapshot([p({ collectionIds: many })], [p({ collectionIds: [...many, '99'] })]);
  assert.deepEqual(d.products, []);
});

test('produtos novos e desaparecidos só são reportados', () => {
  const d = diffSnapshot([p({ productId: 1, sku: 'A' })], [p({ productId: 2, sku: 'B' })]);
  assert.equal(d.goneFromShop.length, 1);
  assert.equal(d.newInShop.length, 1);
  assert.equal(d.products.length, 0);
});

test('filtro por SKU', () => {
  const d = diffSnapshot(
    [p({ productId: 1, sku: 'A' }), p({ productId: 2, sku: 'B' })],
    [p({ productId: 1, sku: 'A', price: '1' }), p({ productId: 2, sku: 'B', price: '1' })],
    { skus: new Set(['B']) },
  );
  assert.deepEqual(d.products.map(x => x.sku), ['B']);
});
