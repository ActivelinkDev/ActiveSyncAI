import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMoney, applyMargin, applyRounding } from './price-calc';
import { parseStock, parseStockStatus } from '../api/suprides-api';

test('normalizeMoney: formatos de preço', () => {
  assert.equal(normalizeMoney(null), '0.00');
  assert.equal(normalizeMoney(undefined), '0.00');
  assert.equal(normalizeMoney(12.5), '12.5');
  assert.equal(normalizeMoney('12.50'), '12.50');
  assert.equal(normalizeMoney('12,50'), '12.50');
  assert.equal(normalizeMoney('12,50 €'), '12.50');
  assert.equal(normalizeMoney('1,234.56'), '1234.56');
  assert.equal(normalizeMoney('1.234,56'), '1234.56');
  assert.equal(normalizeMoney('1.234.567,8'), '1234567.8');
});

test('applyMargin: percentagem sobre o preço de venda, fixa, sem margem', () => {
  assert.equal(applyMargin(80, 'percentage', 20), 100);
  assert.equal(applyMargin(10, 'fixed', 2.5), 12.5);
  assert.equal(applyMargin(10, 'percentage', 0), 10);
  assert.equal(applyMargin(10, 'fixed', 0), 10);
});

test('applyRounding: abaixo de 50 € → ,49 ou ,99; a partir de 50 € → ,90', () => {
  const r = (n: number) => Math.round(applyRounding(n) * 100) / 100;
  assert.equal(r(12.10), 12.49);
  assert.equal(r(12.49), 12.49);
  assert.equal(r(12.50), 12.99);
  assert.equal(r(12.99), 12.99);
  assert.equal(r(49.995), 49.99);
  assert.equal(r(50.00), 50.90);
  assert.equal(r(123.95), 123.90); // nota: acima de 50 € pode arredondar para baixo
});

test('parseStock: texto da Suprides → quantidade', () => {
  assert.equal(parseStock(undefined), 0);
  assert.equal(parseStock('Esgotado'), 0);
  assert.equal(parseStock('Brevemente'), 0);
  assert.equal(parseStock('Sob Encomenda'), 0);
  assert.equal(parseStock('> 10'), 20);
  assert.equal(parseStock('< 10'), 5);
  assert.equal(parseStock('< 2'), 1);
  assert.equal(parseStock('Disponível'), 10);
  assert.equal(parseStock('Stock reduzido'), 1);
  assert.equal(parseStock('7'), 7);
});

test('parseStockStatus: texto da Suprides → estado', () => {
  assert.equal(parseStockStatus(undefined), 'sem_stock');
  assert.equal(parseStockStatus('Esgotado'), 'sem_stock');
  assert.equal(parseStockStatus('Sob Encomenda'), 'sob_encomenda');
  assert.equal(parseStockStatus('Brevemente'), 'brevemente');
  assert.equal(parseStockStatus('Disponível'), 'disponivel');
  assert.equal(parseStockStatus('Stock reduzido'), 'disponivel');
  assert.equal(parseStockStatus('> 10'), 'disponivel');
  assert.equal(parseStockStatus('0'), 'sem_stock');
  assert.equal(parseStockStatus('texto qualquer'), 'sem_stock');
});
