import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  promoPrice, minPriceCents, evaluateProduct, effectivePrice, promoShopPrices, isLossMaking, type ProductInput,
} from './campaign-calc';

const at = new Date('2026-12-20T00:00:00Z');
const old = new Date('2026-11-16T15:42:00Z');      // > 30 dias antes
const recent = new Date('2026-12-10T00:00:00Z');   // < 30 dias antes
const input = (o: Partial<ProductInput> = {}): ProductInput =>
  ({ base: 100, cost: 50, reference: 100, firstRecordedAt: old, inShop: true, ...o });

test('promoPrice: % e € arredondados para baixo ao cêntimo', () => {
  assert.equal(promoPrice(19.99, { type: 'PERCENT', value: 10 }), 17.99); // 17,991
  assert.equal(promoPrice(10.49, { type: 'PERCENT', value: 15 }), 8.91);  // 8,9165
  assert.equal(promoPrice(100, { type: 'PERCENT', value: 12.5 }), 87.5);
  assert.equal(promoPrice(34.49, { type: 'AMOUNT', value: 5 }), 29.49);
  assert.equal(promoPrice(3, { type: 'AMOUNT', value: 5 }), 0);
});

test('minPriceCents: custo + IVA por excesso', () => {
  assert.equal(minPriceCents(27.64, 23), 3400); // 33,9972
  assert.equal(minPriceCents(10, 23), 1230);
});

test('evaluateProduct: incluído, com intervalo válido', () => {
  const e = evaluateProduct(input(), { type: 'PERCENT', value: 10 }, 23, at);
  assert.equal(e.state, 'INCLUIDO');
  assert.equal(e.promo, 90);
  assert.equal(e.warning, null);
  // mínimo: 99,99 (1 cêntimo abaixo da referência) → 0,01 €; máximo: 61,50 (custo + IVA) → 38,50 €
  assert.deepEqual(e.range, { minAmount: 0.01, maxAmount: 38.5, minPercent: 0.01, maxPercent: 38.5 });
});

test('evaluateProduct: SEM_DESCONTO quando o promocional não fica abaixo do mínimo dos 30 dias', () => {
  // Esteve a 85 € há pouco tempo: 10 % sobre 100 € (90 €) não é desconto real
  const e = evaluateProduct(input({ reference: 85 }), { type: 'PERCENT', value: 10 }, 23, at);
  assert.equal(e.state, 'BLOQUEADO');
  assert.equal(e.blockReason, 'SEM_DESCONTO');
  assert.equal(e.range?.minAmount, 15.01);
});

test('evaluateProduct: PREJUIZO quando o promocional sem IVA fica abaixo do custo', () => {
  const e = evaluateProduct(input({ cost: 80 }), { type: 'PERCENT', value: 10 }, 23, at); // mínimo 98,40
  assert.equal(e.blockReason, 'PREJUIZO');
  assert.deepEqual(e.range, { minAmount: 0.01, maxAmount: 1.6, minPercent: 0.01, maxPercent: 1.6 });
});

test('evaluateProduct: sem promoção possível (custo + IVA ≥ referência)', () => {
  const e = evaluateProduct(input({ base: 34.49, reference: 34.49, cost: 27.64 }), { type: 'PERCENT', value: 5 }, 23, at);
  assert.equal(e.state, 'BLOQUEADO');
  assert.ok(e.range); // 34,00 ≤ 34,48 → ainda há margem de 0,01 a 0,49
  const none = evaluateProduct(input({ base: 34, reference: 34, cost: 27.64 }), { type: 'PERCENT', value: 5 }, 23, at);
  assert.equal(none.range, null);
});

test('evaluateProduct: SEM_PRECO sem preço base, fora da loja ou sem custo', () => {
  for (const o of [{ base: null }, { inShop: false }, { cost: null }, { cost: 0 }]) {
    assert.equal(evaluateProduct(input(o), { type: 'PERCENT', value: 10 }, 23, at).blockReason, 'SEM_PRECO');
  }
});

test('evaluateProduct: histórico curto só avisa; sem histórico a referência é o preço atual', () => {
  const short = evaluateProduct(input({ firstRecordedAt: recent }), { type: 'PERCENT', value: 10 }, 23, at);
  assert.equal(short.state, 'INCLUIDO');
  assert.equal(short.warning, 'HISTORICO_CURTO');
  const none = evaluateProduct(input({ reference: null, firstRecordedAt: null }), { type: 'PERCENT', value: 10 }, 23, at);
  assert.equal(none.state, 'INCLUIDO');
  assert.equal(none.reference, 100);
  assert.equal(none.warning, 'HISTORICO_CURTO');
});

test('preço em campanha: o menor entre promocional e base atual; sem riscado se não houver redução', () => {
  assert.equal(effectivePrice(90, 100), 90);
  assert.equal(effectivePrice(90, 80), 80);
  assert.deepEqual(promoShopPrices(90, 100, 100), { price: 90, compareAtPrice: 100 });
  assert.deepEqual(promoShopPrices(90, 100, 85), { price: 85, compareAtPrice: 100 });
  assert.deepEqual(promoShopPrices(90, 85, 85), { price: 85, compareAtPrice: null });
});

test('isLossMaking: o custo subiu depois do início', () => {
  assert.equal(isLossMaking(90, 70, 23), false); // mínimo 86,10
  assert.equal(isLossMaking(90, 75, 23), true);  // mínimo 92,25
});
