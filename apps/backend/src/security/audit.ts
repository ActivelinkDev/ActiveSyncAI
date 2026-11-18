/**
 * Registo de segurança: uma linha JSON por evento em <DATA_DIR>/logs/security-audit.log.
 * Nunca escrever palavras-passe, tokens ou credenciais aqui.
 */
import fs from 'fs';
import path from 'path';
import { dataPath } from '../utils/data-dir';

export type AuditEvent =
  | 'login.ok' | 'login.fail' | 'login.locked' | 'logout'
  | 'password.fail' | 'password.changed'
  | 'access.denied.ip' | 'access.denied.origin'
  | 'action';

export function audit(event: AuditEvent, data: { ip?: string; user?: string; detail?: string } = {}): void {
  const clean = (v?: string) => (v == null ? undefined : String(v).replace(/[\r\n\t]/g, ' ').slice(0, 300));
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ip: clean(data.ip), user: clean(data.user), detail: clean(data.detail) });
  try {
    const dir = dataPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'security-audit.log'), line + '\n');
  } catch (e: any) {
    console.error('[audit] não foi possível escrever:', e?.message);
  }
}

/** Últimos N eventos (para o ecrã de segurança). */
export function readAudit(limit = 200): unknown[] {
  try {
    const lines = fs.readFileSync(path.join(dataPath('logs'), 'security-audit.log'), 'utf8').trim().split('\n');
    return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
