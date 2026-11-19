import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBasePrice, findCollectionMargin, marginRuleLabel, ivaMultiplierOf, type PriceContext } from './price-engine';
import type { CollectionHierarchy } from '../routes/sync-helpers';

// Árvore: 1 (L1) → 10 (L2) → 100 (L3)
const hierarchy = new Map<string, CollectionHierarchy>([
  ['1', { childCount: 1 }],
  ['10', { l1Id: '1', childCount: 1 }],
  ['100', { l2Id: '10', l1Id: '1', childCount: 0 }],
]);
const ctx = (rules: PriceContext['margins']['rules']): PriceContext =>
  ({ margins: { rules }, hierarchyById: hierarchy, ivaRate: 23 });
const cents = (n: number) => Math.round(n * 100) / 100;

test('findCollectionMargin: coleção mais profunda com margem > 0', () => {
  const rules = { '1': { mode: 'percentage' as const, marginValue: 5 }, '10': { mode: 'percentage' as const, marginValue: 10 }, '100': { mode: 'percentage' as const, marginValue: 0 } };
  // 100 (L3) tem margem 0 → ignorada; ganha 10 (L2), não 1 (L1), seja qual for a ordem
  assert.equal(findCollectionMargin(['1', '100', '10'], { rules }, hierarchy)?.marginValue, 10);
  assert.equal(findCollectionMargin(['999'], { rules }, hierarchy), null);
});

test('computeBasePrice: margem percentual sobre o preço de venda + IVA + arredondamento', () => {
  const b = computeBasePrice(10, ['10'], ctx({ '10': { mode: 'percentage', marginValue: 20 } }));
  // 10 / 0,8 × 1,23 = 15,375 → 15,49 (igual ao teste do dry-run)
  assert.equal(cents(b.price), 15.49);
  assert.equal(b.cost, 10);
  assert.equal(cents(b.minPrice), 12.3);
  assert.equal(marginRuleLabel(b.rule), 'percentage:20');
});

test('computeBasePrice: margem fixa', () => {
  const b = computeBasePrice(10, ['10'], ctx({ '10': { mode: 'fixed', marginValue: 5 } }));
  assert.equal(cents(b.price), 18.49); // 15 × 1,23 = 18,45 → 18,49
});

test('computeBasePrice: sem regra → custo + IVA, nunca abaixo (venda com prejuízo)', () => {
  const b = computeBasePrice(27.64, ['999'], ctx({}));
  assert.equal(b.rule, null);
  assert.equal(marginRuleLabel(b.rule), null);
  assert.equal(cents(b.price), 34.49); // 33,9972 → 33,99 seria prejuízo
  assert.ok(b.price >= b.minPrice);
});

test('ivaMultiplierOf: 23 % por omissão', () => {
  assert.equal(ivaMultiplierOf(undefined), 1.23);
  assert.equal(ivaMultiplierOf(6), 1.06);
});
