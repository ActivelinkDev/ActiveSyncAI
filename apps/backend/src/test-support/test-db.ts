/**
 * Base de dados de teste (ActiveSyncAI_Test) para testes de integração.
 *
 * Lê apps/backend/.env.test (fora do git) por cima do ambiente. Sem esse ficheiro ou sem
 * palavra-passe, testDbAvailable() devolve false e os testes de integração ficam saltados
 * (npm test continua a correr em qualquer máquina). O travão de getMssql garante que, com
 * NODE_ENV=test, só se liga a uma base *_Test e sem credenciais da Shopify.
 *
 * Usar num ficheiro de teste ANTES de qualquer getMssql() (cada ficheiro corre no seu processo):
 *   const skip = !testDbAvailable();
 *   test('...', { skip }, async () => { const db = await getTestDb(); ... });
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import type { Kysely } from 'kysely';
import { getMssql, assertTestEnvironmentSafe } from '../db/mssql';
import { migrateMssql } from '../db/mssql-migrations';

const ENV_FILE = path.resolve(__dirname, '../../.env.test');
let loaded: boolean | null = null;

export function testDbAvailable(): boolean {
  if (loaded !== null) return loaded;
  if (!fs.existsSync(ENV_FILE)) return (loaded = false);
  dotenv.config({ path: ENV_FILE, override: true });
  // Mesmo que outra coisa tenha lido o .env antes: nos testes não há Shopify.
  for (const k of ['SHOPIFY_STORE', 'SHOPIFY_PASSWORD', 'SHOPIFY_LOCATION_ID']) delete process.env[k];
  process.env.NODE_ENV = 'test';
  assertTestEnvironmentSafe();
  return (loaded = !!process.env.MSSQL_PASSWORD);
}

/** Ligação à base de teste, com o esquema atualizado. */
export async function getTestDb(): Promise<Kysely<any>> {
  if (!testDbAvailable()) throw new Error('Base de teste indisponível (.env.test sem MSSQL_PASSWORD).');
  const db = getMssql();
  await migrateMssql(db);
  return db;
}
