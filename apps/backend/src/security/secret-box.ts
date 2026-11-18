/**
 * Credenciais cifradas no disco (AES-256-GCM). A chave vem de SECRETS_KEY no .env,
 * que fica fora da pasta de dados: uma cópia de <DATA_DIR> sozinha não revela nada.
 *
 *   npm run secrets:init   → gera a chave no .env e cifra o que estiver em claro.
 *
 * Sem chave, lê e grava em claro (como antes) e avisa no arranque.
 */
import crypto from 'crypto';

const PREFIX = 'enc:v1:';

/** Campos que são credenciais (nunca devolvidos inteiros pela API). */
export const SECRET_FIELDS = ['shopifyToken', 'supridesPass', 'supridesToken', 'openaiApiKey'] as const;

function key(): Buffer | null {
  const raw = process.env.SECRETS_KEY?.trim();
  if (!raw) return null;
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('SECRETS_KEY inválida (tem de ter 32 bytes em base64).');
  return k;
}

export function secretsKeyConfigured(): boolean { return !!key(); }

export function isEncrypted(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k || !plain) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join(':');
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value;
  const k = key();
  if (!k) throw new Error('Credenciais cifradas mas SECRETS_KEY não está definida no .env.');
  const [ivB, tagB, ctB] = value.slice(PREFIX.length).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

export function encryptFields<T extends Record<string, any>>(obj: T): T {
  const out: any = { ...obj };
  for (const f of SECRET_FIELDS) if (typeof out[f] === 'string' && out[f] && !isEncrypted(out[f])) out[f] = encryptSecret(out[f]);
  return out;
}

export function decryptFields<T extends Record<string, any>>(obj: T): T {
  const out: any = { ...obj };
  for (const f of SECRET_FIELDS) if (typeof out[f] === 'string') out[f] = decryptSecret(out[f]);
  return out;
}

/** "••••abcd" — só os últimos 4 caracteres, e só se o valor for comprido. */
export function maskSecret(v: string | undefined | null): string {
  const s = String(v ?? '');
  if (!s) return '';
  return s.length >= 16 ? '••••' + s.slice(-4) : '••••';
}
