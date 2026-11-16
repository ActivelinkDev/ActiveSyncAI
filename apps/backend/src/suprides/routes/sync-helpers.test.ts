import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActiveCollectionIndexes, buildDerivedCollectionIds } from './sync-helpers';
import { MENU, MAPPING, hierarchyFrom } from '../../test-support/fixtures';
import type { ShopifyCollectionMapping } from '../types';

const derive = (line: string, fam: string, sub: string, map: ShopifyCollectionMapping = MAPPING) =>
  buildDerivedCollectionIds(line, fam, sub, map, buildActiveCollectionIndexes(map), hierarchyFrom(MENU)).sort();

test('linha mapeada num L1 sem descendentes mapeados → só esse L1', () => {
  assert.deepEqual(derive('ESCRITORIO', 'PAPEL', ''), ['101']);
});

test('linha mapeada num L2 sem filhos → L2 + o L1 pai', () => {
  assert.deepEqual(derive('ACESSORIOS', 'RATOS', ''), ['100', '201']);
});

test('família mapeada num L3 cujo L2 aceita a linha → L3 + L2 + L1', () => {
  assert.deepEqual(derive('INFORMATICA', 'PORTATEIS GAMING', ''), ['100', '200', '300']);
});

test('subfamília também procura nos L3', () => {
  assert.deepEqual(derive('INFORMATICA', 'OUTRA', 'PORTATEIS OFFICE'), ['100', '200', '301']);
});

test('L3 compatível mas o ramo não aceita a linha → nada', () => {
  assert.deepEqual(derive('OUTRA LINHA', 'PORTATEIS GAMING', ''), []);
});

test('espaços à volta não contam', () => {
  assert.deepEqual(derive('  ESCRITORIO ', 'PAPEL', ''), ['101']);
});

test('coleção escondida não entra', () => {
  const map: ShopifyCollectionMapping = { ...MAPPING, hidden: { '300': true } };
  assert.deepEqual(derive('INFORMATICA', 'PORTATEIS GAMING', '', map), []);
  const map2: ShopifyCollectionMapping = { ...MAPPING, hidden: { '101': true } };
  assert.deepEqual(derive('ESCRITORIO', 'PAPEL', '', map2), []);
});

test('linha desconhecida → nada', () => {
  assert.deepEqual(derive('NAO EXISTE', '', ''), []);
});
