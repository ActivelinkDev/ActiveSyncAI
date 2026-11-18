/**
 * Sessões em memória (um reinício do serviço termina todas — é intencional).
 * O cookie leva um token aleatório de 256 bits; em memória guarda-se só o seu SHA-256.
 */
import crypto from 'crypto';

export const SESSION_IDLE_MS = 30 * 60_000;          // 30 min sem uso
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000; // 12 h no máximo
export const ELEVATION_MS = 5 * 60_000;              // palavra-passe repetida vale 5 min

export interface Session {
  username: string; ip: string; userAgent: string;
  createdAt: number; lastSeen: number; elevatedUntil: number;
}

const sessions = new Map<string, Session>();
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(username: string, ip: string, userAgent: string, now = Date.now()): string {
  const token = crypto.randomBytes(32).toString('base64url');
  // Acabado de autenticar: conta como palavra-passe confirmada.
  sessions.set(hash(token), { username, ip, userAgent: userAgent.slice(0, 200), createdAt: now, lastSeen: now, elevatedUntil: now + ELEVATION_MS });
  return token;
}

/** Devolve a sessão válida (e renova o "último uso"), ou null. */
export function getSession(token: string | undefined, now = Date.now()): Session | null {
  if (!token || token.length > 100) return null;
  const key = hash(token);
  const s = sessions.get(key);
  if (!s) return null;
  if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_ABSOLUTE_MS) {
    sessions.delete(key);
    return null;
  }
  s.lastSeen = now;
  return s;
}

export function elevateSession(token: string, now = Date.now()): void {
  const s = sessions.get(hash(token));
  if (s) s.elevatedUntil = now + ELEVATION_MS;
}

export function isElevated(s: Session, now = Date.now()): boolean {
  return s.elevatedUntil > now;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(hash(token));
}

/** Ao mudar a palavra-passe: termina todas as sessões (opcionalmente menos a atual). */
export function destroyAllSessions(exceptToken?: string): void {
  const keep = exceptToken ? hash(exceptToken) : null;
  for (const k of [...sessions.keys()]) if (k !== keep) sessions.delete(k);
}

export function sessionCount(): number { return sessions.size; }

// Limpeza periódica das expiradas.
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_ABSOLUTE_MS) sessions.delete(k);
  }
}, 5 * 60_000).unref();
