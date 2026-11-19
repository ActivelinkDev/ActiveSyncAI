import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTestEnvironmentSafe } from './mssql';

test('travão dos testes: NODE_ENV=test só liga a uma base *_Test e sem Shopify', () => {
  // Fora dos testes não faz nada (produção usa a base ActiveSyncAI)
  assert.doesNotThrow(() => assertTestEnvironmentSafe({ MSSQL_DATABASE: 'ActiveSyncAI' }));
  assert.doesNotThrow(() => assertTestEnvironmentSafe({ NODE_ENV: 'test', MSSQL_DATABASE: 'ActiveSyncAI_Test' }));
  assert.throws(() => assertTestEnvironmentSafe({ NODE_ENV: 'test', MSSQL_DATABASE: 'ActiveSyncAI' }), /base de teste/);
  assert.throws(() => assertTestEnvironmentSafe({ NODE_ENV: 'test' }), /base de teste/);
  assert.throws(() => assertTestEnvironmentSafe({ NODE_ENV: 'test', MSSQL_DATABASE: 'ActiveSyncAI_Test', SHOPIFY_STORE: 'x' }), /Shopify/);
});
