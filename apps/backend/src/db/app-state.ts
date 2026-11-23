import { sql, type Kysely } from 'kysely';
import { getMssql } from './mssql';

export async function loadAppState<T>(name: string, fallback: T, db: Kysely<any> = getMssql()): Promise<T> {
  const row = await db.selectFrom('app_state').select('value').where('name', '=', name).executeTakeFirst();
  return row?.value == null ? fallback : JSON.parse(row.value);
}

export async function saveAppState(name: string, value: unknown, db: Kysely<any> = getMssql()): Promise<void> {
  await sql`MERGE app_state WITH (HOLDLOCK) AS dest
    USING (SELECT ${name} AS name, ${JSON.stringify(value)} AS value) AS src
    ON dest.name = src.name
    WHEN MATCHED THEN UPDATE SET value = src.value, updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (name, value) VALUES (src.name, src.value);`.execute(db);
}

export function updateAppState<T>(name: string, fallback: T, change: (current: T) => T): Promise<T> {
  return getMssql().transaction().execute(async db => {
    const { rows } = await sql<{ value: string | null }>`SELECT value FROM app_state WITH (UPDLOCK, HOLDLOCK)
      WHERE name = ${name}`.execute(db);
    const next = change(rows[0]?.value == null ? fallback : JSON.parse(rows[0].value));
    await saveAppState(name, next, db);
    return next;
  });
}
