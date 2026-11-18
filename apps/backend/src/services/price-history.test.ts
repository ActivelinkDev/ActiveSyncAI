import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPrices, lowestInWindow, type CurrentPrice } from './price-history';

const prod = (sku: string | null, price: string | null, compareAtPrice: string | null = null) =>
  ({ productId: 1, sku, price, compareAtPrice, status: 'ACTIVE' } as any);

test('histórico: só regista o que mudou (preço ou riscado)', () => {
  const cur = new Map<string, CurrentPrice>([['SUP1', { price: 10, compareAt: null }], ['SUP2', { price: 20, compareAt: 25 }]]);
  const d = diffPrices(cur, [prod('SUP1', '10.00'), prod('SUP2', '20.00', '24.99'), prod('SUP3', '5.5')]);
  assert.deepEqual(d.map(c => [c.sku, c.oldPrice, c.newPrice, c.oldCompareAt, c.newCompareAt]),
    [['SUP2', 20, 20, 25, 24.99], ['SUP3', null, 5.5, null, null]]);
});

test('histórico: SKU repetido conta o primeiro; sem SKU ou sem preço fica de fora', () => {
  const d = diffPrices(new Map(), [prod('SUP1', '10'), prod('SUP1', '99'), prod(null, '5'), prod('SUP9', null)]);
  assert.deepEqual(d.map(c => [c.sku, c.newPrice]), [['SUP1', 10]]);
});

test('30 dias: inclui o preço em vigor no início da janela e o atual', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 86_400_000);
  const rows = [
    { newPrice: 50, changedAt: day(0) },   // em vigor quando a janela começa
    { newPrice: 45, changedAt: day(20) },
    { newPrice: 48, changedAt: day(35) },
  ];
  assert.equal(lowestInWindow(rows, day(40)), 45);   // janela 10..40: em vigor 50, depois 45, 48
  assert.equal(lowestInWindow(rows, day(60)), 45);   // janela 30..60: em vigor no início = 45 (desde o dia 20), depois 48
  assert.equal(lowestInWindow(rows, day(80)), 48);   // janela 50..80: só 48 em vigor
});
