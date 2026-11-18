/**
 * Ligações (Preferências): a API nunca devolve credenciais inteiras.
 * GET → credenciais como "••••abcd" + "<campo>Set: true/false".
 * PUT → só altera campos enviados não vazios; uma máscara devolvida é ignorada.
 */
import { SECRET_FIELDS, maskSecret } from './secret-box';

export interface FieldSpec { key: string; env?: string }

const isSecret = (k: string) => (SECRET_FIELDS as readonly string[]).includes(k);

export function connectionView(fields: FieldSpec[], stored: Record<string, any>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    const value = String(stored[f.key] ?? (f.env ? process.env[f.env] : '') ?? '');
    if (isSecret(f.key)) {
      out[f.key] = maskSecret(value);
      out[`${f.key}Set`] = value.length > 0;
    } else {
      out[f.key] = value;
    }
  }
  return out;
}

export function applyConnectionUpdate(fields: FieldSpec[], current: Record<string, any>, body: unknown): { updated: Record<string, any>; changed: string[] } {
  const updated = { ...current };
  const changed: string[] = [];
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  for (const f of fields) {
    const v = b[f.key];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t || t.startsWith('••••')) continue;
    if (t.length > 2000) continue;
    if (updated[f.key] !== t) { updated[f.key] = t; changed.push(f.key); }
  }
  return { updated, changed };
}
