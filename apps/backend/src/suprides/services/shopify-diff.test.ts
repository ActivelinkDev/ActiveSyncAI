import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planProductWrite, contentHash, toGrams, type DesiredProduct } from './shopify-diff';
import { imageKeyFromUrl } from '../api/shopify-api';
import type { SnapshotProduct } from '../api/shopify-read';

const desired = (over: Partial<DesiredProduct> = {}): DesiredProduct => ({
  title: 'T', descriptionHtml: '<p>d</p>', vendor: 'V', productType: 'L', status: 'ACTIVE',
  stockStatusLabel: 'Disponível', filtros: [{ namespace: 'filtros', key: 'cor', value: 'Preto' }],
  collectionIds: ['1'], price: '10.49', compareAtPrice: null, barcode: '123', cost: '7.00', weightGrams: 500,
  ...over,
});

const current = (over: Partial<SnapshotProduct> = {}): SnapshotProduct => ({
  productId: 1, title: 'T', handle: 't', status: 'ACTIVE', vendor: 'V', productType: 'L', updatedAt: '',
  publishedAt: '2026-01-01T00:00:00Z', descriptionHtml: '<p>d</p>', stockStatus: 'Disponível', variantsCount: 1,
  variantId: 10, sku: 'A', price: '10.49', compareAtPrice: null, barcode: '123', inventoryItemId: 100,
  cost: '7.0', weight: { unit: 'KILOGRAMS', value: 0.5 }, collectionIds: ['1', '2'], collectionTitles: [],
  ...over,
});

test('nada mudou → nada a enviar', () => {
  const d = desired();
  const w = planProductWrite(d, current(), contentHash(d));
  assert.deepEqual(w.changes, []);
  assert.equal(w.product, null);
  assert.equal(w.variant, null);
  assert.equal(w.publish, false);
});

test('sem hash anterior → envia o conteúdo (uma vez)', () => {
  const w = planProductWrite(desired(), current(), null);
  assert.deepEqual(w.changes, ['conteudo']);
  assert.equal((w.product as any).title, 'T');
  assert.equal((w.product as any).metafields.length, 2);
  assert.equal(w.variant, null);
});

test('só o preço mudou → só a variante, só o preço', () => {
  const d = desired({ price: '11.99' });
  const w = planProductWrite(d, current(), contentHash(d));
  assert.deepEqual(w.changes, ['preco']);
  assert.equal(w.product, null);
  assert.deepEqual(w.variant, { price: '11.99' });
});

test('preço riscado retirado → envia null', () => {
  const d = desired();
  const w = planProductWrite(d, current({ compareAtPrice: '20.00' }), contentHash(d));
  assert.deepEqual(w.variant, { compareAtPrice: null });
});

test('custo, peso e EAN numa só chamada da variante', () => {
  const d = desired({ cost: '8.00', weightGrams: 750, barcode: '999' });
  const w = planProductWrite(d, current(), contentHash(d));
  assert.deepEqual(w.variant, {
    barcodes: [{ value: '999' }],
    inventoryItem: { cost: '8.00', measurement: { weight: { value: 750, unit: 'GRAMS' } } },
  });
});

test('EAN vazio na Suprides não apaga o da loja', () => {
  const d = desired({ barcode: null });
  assert.equal(planProductWrite(d, current(), contentHash(d)).variant, null);
});

test('passa a rascunho e muda o stock → estado + só o metafield de stock', () => {
  const d = desired({ status: 'DRAFT', stockStatusLabel: 'Sem Stock' });
  const w = planProductWrite(d, current(), contentHash(d));
  assert.deepEqual(w.changes.sort(), ['status', 'stock_status']);
  assert.equal((w.product as any).status, 'DRAFT');
  assert.deepEqual((w.product as any).metafields.map((m: any) => m.key), ['stock_status']);
  assert.equal(w.publish, false);
});

test('reativar um produto despublicado → publicar', () => {
  const d = desired();
  const w = planProductWrite(d, current({ status: 'DRAFT', publishedAt: null }), contentHash(d));
  assert.equal((w.product as any).status, 'ACTIVE');
  assert.equal(w.publish, true);
});

test('coleções: só junta as que faltam, nunca retira', () => {
  const d = desired({ collectionIds: ['1', '3', 'nao-numerico'] });
  const w = planProductWrite(d, current(), contentHash(d));
  assert.deepEqual((w.product as any).collectionsToJoin, ['gid://shopify/Collection/3']);
  assert.equal((w.product as any).collectionsToLeave, undefined);
});

test('hash de conteúdo não depende da ordem dos filtros', () => {
  const a = desired({ filtros: [{ namespace: 'filtros', key: 'a', value: '1' }, { namespace: 'filtros', key: 'b', value: '2' }] });
  const b = desired({ filtros: [{ namespace: 'filtros', key: 'b', value: '2' }, { namespace: 'filtros', key: 'a', value: '1' }] });
  assert.equal(contentHash(a), contentHash(b));
  assert.notEqual(contentHash(a), contentHash(desired({ title: 'Outro' })));
});

test('conversão de pesos', () => {
  assert.equal(toGrams({ unit: 'KILOGRAMS', value: 1.25 }), 1250);
  assert.equal(toGrams({ unit: 'GRAMS', value: 80 }), 80);
  assert.equal(toGrams(null), null);
});

test('nome de imagem: ignora o sufixo _<uuid> que a Shopify acrescenta', () => {
  const original = 'https://www.suprides.pt/media/catalog/product/6/a/69bad03dda5aa_product_image_0.jpg';
  const cdn = 'https://cdn.shopify.com/s/files/1/0046/files/69bad03dda5aa_product_image_0_a6df69d6-b0d4-4b30-ab7f-035a92e09bb8.jpg?v=1784239259';
  assert.equal(imageKeyFromUrl(cdn), imageKeyFromUrl(original));
  assert.notEqual(imageKeyFromUrl(cdn), imageKeyFromUrl(original.replace('_0.', '_1.')));
});
