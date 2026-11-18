import { getMssql } from '../db/mssql';

export type AuditEvent =
  | 'login.ok' | 'login.fail' | 'login.locked' | 'logout'
  | 'password.fail' | 'password.changed'
  | 'access.denied.ip' | 'access.denied.origin'
  | 'action';

export async function audit(event: AuditEvent, data: { ip?: string; user?: string; detail?: string } = {}): Promise<void> {
  const clean = (v: string | undefined, limit: number) => v == null ? null : String(v).replace(/[\r\n\t]/g, ' ').slice(0, limit);
  try {
    await getMssql().insertInto('security_audit').values({
      event, ip: clean(data.ip, 64), username: clean(data.user, 100), detail: clean(data.detail, 300),
    }).execute();
  } catch (e: any) {
    console.error('[audit] não foi possível escrever:', e?.message);
  }
}

export async function readAudit(limit = 200) {
  const rows = await getMssql().selectFrom('security_audit').selectAll()
    .top(Math.min(500, Math.max(1, Math.trunc(limit) || 200))).orderBy('id', 'desc').execute();
  return rows.map(row => ({
    ts: row.ts.toISOString(), event: row.event, ip: row.ip ?? undefined,
    user: row.username ?? undefined, detail: row.detail ?? undefined,
  }));
}
