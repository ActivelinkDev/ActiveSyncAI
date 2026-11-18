import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImages } from './images-sync';

const SRC = 'https://www.suprides.pt/media/catalog/product/a/b/';
const CDN = 'https://cdn.shopify.com/s/files/1/files/';
const uuid = '_a6df69d6-b0d4-4b30-ab7f-035a92e09bb8';

test('todas já na loja e prontas → completo, nada a enviar', () => {
  const p = planImages([SRC + 'x_0.jpg', SRC + 'x_1.jpg'], [
    { id: 1, src: CDN + 'x_0' + uuid + '.jpg', status: 'READY' },
    { id: 2, src: CDN + 'x_1' + uuid + '.jpg', status: 'READY' },
  ]);
  assert.deepEqual(p, { add: [], removeFailed: [], complete: true });
});

test('falta uma → envia só essa', () => {
  const p = planImages([SRC + 'x_0.jpg', SRC + 'x_1.jpg'], [{ id: 1, src: CDN + 'x_0' + uuid + '.jpg', status: 'READY' }]);
  assert.deepEqual(p.add, [SRC + 'x_1.jpg']);
  assert.equal(p.complete, false);
});

test('imagem falhada → retira e volta a enviar', () => {
  const p = planImages([SRC + 'x_0.jpg'], [{ id: 7, src: SRC + 'x_0.jpg', status: 'FAILED' }]);
  assert.deepEqual(p.removeFailed, [7]);
  assert.deepEqual(p.add, [SRC + 'x_0.jpg']);
});

test('ainda em processamento → não está completo, não reenvia', () => {
  const p = planImages([SRC + 'x_0.jpg'], [{ id: 1, src: SRC + 'x_0.jpg', status: 'PROCESSING' }]);
  assert.deepEqual(p.add, []);
  assert.equal(p.complete, false);
});

test('URLs repetidos na Suprides contam uma vez; imagens extra na loja ficam', () => {
  const p = planImages([SRC + 'x_0.jpg', SRC + 'x_0.jpg'], [
    { id: 1, src: CDN + 'x_0' + uuid + '.jpg', status: 'READY' },
    { id: 2, src: CDN + 'outra.jpg', status: 'READY' },
  ]);
  assert.deepEqual(p, { add: [], removeFailed: [], complete: true });
});

test('a mesma foto com outro prefixo da Suprides e outra extensão conta como presente', () => {
  const p = planImages([SRC + '6a48ff029c45c_product_image_0.jpeg'], [
    { id: 1, src: CDN + '69749f02dbb0b_product_image_0' + uuid + '.jpg', status: 'READY' },
  ]);
  assert.deepEqual(p, { add: [], removeFailed: [], complete: true });
});

test('duplicados: fica a primeira cópia de cada foto, pela ordem', async () => {
  const { findDuplicateImages } = await import('../suprides/api/shopify-api');
  const img = (id: number, pre: string, n: number) => ({ id, src: CDN + pre + '_product_image_' + n + uuid + '.jpg', status: 'READY' });
  const r = findDuplicateImages([img(1, 'aaaaaaaaaaaaa', 0), img(2, 'aaaaaaaaaaaaa', 1), img(3, 'bbbbbbbbbbbbb', 0), img(4, 'bbbbbbbbbbbbb', 1)]);
  assert.deepEqual(r.keep.map(i => i.id), [1, 2]);
  assert.deepEqual(r.duplicates.map(i => i.id), [3, 4]);
});
