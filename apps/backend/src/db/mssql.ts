/**
 * Ligação ao SQL Server (base de dados própria da app, ex.: ActiveSyncAI).
 *
 * .env:
 *   MSSQL_SERVER=nome-do-servidor      MSSQL_INSTANCE=instância (opcional; usa o SQL Browser)
 *   MSSQL_PORT=porta (opcional; em vez da instância)
 *   MSSQL_DATABASE=ActiveSyncAI        MSSQL_USER / MSSQL_PASSWORD (login SQL só desta BD)
 *   MSSQL_ENCRYPT=1 (por omissão)      MSSQL_TRUST_CERT=1 (certificado autoassinado da instância)
 *
 */
import { Kysely, MssqlDialect } from 'kysely';
import * as Tedious from 'tedious';
import * as Tarn from 'tarn';

export function mssqlConfigured(): boolean {
  return !!(process.env.MSSQL_SERVER && process.env.MSSQL_DATABASE && process.env.MSSQL_USER && process.env.MSSQL_PASSWORD);
}

function connectionConfig(): Tedious.ConnectionConfiguration {
  const port = process.env.MSSQL_PORT ? Number(process.env.MSSQL_PORT) : undefined;
  return {
    server: process.env.MSSQL_SERVER!,
    authentication: {
      type: 'default',
      options: { userName: process.env.MSSQL_USER!, password: process.env.MSSQL_PASSWORD! },
    },
    options: {
      database: process.env.MSSQL_DATABASE!,
      ...(port ? { port } : process.env.MSSQL_INSTANCE ? { instanceName: process.env.MSSQL_INSTANCE } : {}),
      encrypt: process.env.MSSQL_ENCRYPT !== '0',
      trustServerCertificate: process.env.MSSQL_TRUST_CERT !== '0',
      connectTimeout: 15_000,
      requestTimeout: 120_000,
      appName: 'ActiveSyncAI',
    },
  };
}

let db: Kysely<any> | null = null;

/**
 * Travão dos testes (NODE_ENV=test, ver .env.test): só uma base cujo nome termine em _Test,
 * e nunca com credenciais da Shopify no ambiente — um teste nunca toca na base nem na loja reais.
 */
export function assertTestEnvironmentSafe(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'test') return;
  if (!/_test$/i.test(env.MSSQL_DATABASE ?? '')) {
    throw new Error(`NODE_ENV=test só pode usar uma base de teste (*_Test), não "${env.MSSQL_DATABASE}".`);
  }
  if (env.SHOPIFY_STORE || env.SHOPIFY_PASSWORD) {
    throw new Error('NODE_ENV=test não pode ter credenciais da Shopify (SHOPIFY_STORE/SHOPIFY_PASSWORD).');
  }
}

/** Instância partilhada (pool de ligações). */
export function getMssql<DB = any>(): Kysely<DB> {
  if (!mssqlConfigured()) throw new Error('SQL Server não configurado (MSSQL_* no .env).');
  if (!db) {
    assertTestEnvironmentSafe();
    db = new Kysely<any>({
      dialect: new MssqlDialect({
        tarn: { ...Tarn, options: { min: 0, max: 10 } },
        tedious: { ...Tedious, connectionFactory: () => new Tedious.Connection(connectionConfig()) },
      }),
    });
  }
  return db as unknown as Kysely<DB>;
}

export async function closeMssql(): Promise<void> {
  if (db) { await db.destroy(); db = null; }
}
