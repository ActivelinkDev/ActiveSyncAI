import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeBrands, planBrandWrites, type ShopBrand } from './brands-sync';

const p = (vendor: string | null, status = 'ACTIVE') => ({ vendor, status } as any);

test('activeBrands: só produtos ativos, sem "Suprides" nem vazios, grafia mais usada, por n.º de produtos', () => {
  const r = activeBrands([
    p('Apple'), p('Apple'), p('Apple', 'DRAFT'),
    p('Xiaomi'), p('XIAOMI'), p('Xiaomi'),
    p('Suprides'), p(''), p(null), p('  '),
    p('Só Rascunho', 'DRAFT'),
    p('Baseus'),
  ]);
  assert.deepEqual(r, [
    { handle: 'xiaomi', name: 'Xiaomi', products: 3 },
    { handle: 'apple', name: 'Apple', products: 2 },
    { handle: 'baseus', name: 'Baseus', products: 1 },
  ]);
});

test('planBrandWrites: novas, alteradas, sem mudanças e as que deixaram de ter produtos', () => {
  const shop: ShopBrand[] = [
    { handle: 'apple', name: 'Apple', products: 2, visible: true },        // igual → nada
    { handle: 'xiaomi', name: 'Xiaomi', products: 5, visible: true },      // muda o n.º
    { handle: 'torras', name: 'Torras', products: 4, visible: true },      // sem produtos → esconder
    { handle: 'lovit', name: 'Lovit', products: 0, visible: false },       // já escondida → nada
  ];
  const w = planBrandWrites([
    { handle: 'apple', name: 'Apple', products: 2 },
    { handle: 'xiaomi', name: 'Xiaomi', products: 3 },
    { handle: 'baseus', name: 'Baseus', products: 1 },
  ], shop);
  assert.deepEqual(w, [
    { handle: 'xiaomi', name: 'Xiaomi', products: 3, visible: true, isNew: false },
    { handle: 'baseus', name: 'Baseus', products: 1, visible: true, isNew: true },
    { handle: 'torras', name: 'Torras', products: 0, visible: false, isNew: false },
  ]);
  // Volta a ter produtos → visível outra vez
  assert.deepEqual(planBrandWrites([{ handle: 'lovit', name: 'Lovit', products: 2 }], shop.slice(3)),
    [{ handle: 'lovit', name: 'Lovit', products: 2, visible: true, isNew: false }]);
});

test('planLogoLinks: nome do ficheiro = marca (qualquer grafia), não substitui sem --force', async () => {
  const { planLogoLinks } = await import('./brands-sync');
  const brands: ShopBrand[] = [
    { handle: 'apple', name: 'Apple', products: 209, visible: true, logo: null },
    { handle: 'daan-tech', name: 'Daan Tech', products: 3, visible: true, logo: null },
    { handle: 'xiaomi', name: 'Xiaomi', products: 54, visible: true, logo: 'gid://shopify/MediaImage/1' },
  ];
  const f = (file: string) => ({ file, name: file.replace(/\.[^.]+$/, ''), ext: file.slice(file.lastIndexOf('.')) });
  const files = [f('Apple.png'), f('apple.svg'), f('Daan Tech.PNG'), f('xiaomi.svg'), f('Samsung.png'), f('leia-me.txt')];
  assert.deepEqual(planLogoLinks(files, brands), [
    { kind: 'link', handle: 'apple', brand: 'Apple', file: 'Apple.png', replace: false },
    { kind: 'duplicate', handle: 'apple', file: 'apple.svg' },
    { kind: 'link', handle: 'daan-tech', brand: 'Daan Tech', file: 'Daan Tech.PNG', replace: false },
    { kind: 'no-brand', file: 'Samsung.png' },
    { kind: 'skip-has-logo', handle: 'xiaomi', brand: 'Xiaomi', file: 'xiaomi.svg' },
  ]);
  const forced = planLogoLinks([f('xiaomi.svg')], brands, true);
  assert.deepEqual(forced, [{ kind: 'link', handle: 'xiaomi', brand: 'Xiaomi', file: 'xiaomi.svg', replace: true }]);
});
