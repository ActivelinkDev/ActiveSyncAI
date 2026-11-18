/**
 * Limite de tentativas de login (por IP e global).
 *  - Por IP: 5 falhas em 15 min → bloqueio de 1 min, que duplica a cada novo bloqueio (máx. 1 h).
 *  - Global: 20 falhas em 15 min (de qualquer IP) → todos os logins bloqueados 5 min.
 * Um login certo limpa o contador desse IP.
 */
export const MAX_FAILS_PER_IP = 5;
export const MAX_FAILS_GLOBAL = 20;
const WINDOW_MS = 15 * 60_000;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 60 * 60_000;
const GLOBAL_LOCK_MS = 5 * 60_000;

interface IpState { fails: number[]; lockedUntil: number; lockCount: number }
const perIp = new Map<string, IpState>();
let globalFails: number[] = [];
let globalLockedUntil = 0;

const prune = (arr: number[], now: number) => arr.filter(t => now - t < WINDOW_MS);

/** Milissegundos até poder tentar outra vez (0 = pode). */
export function loginBlockedFor(ip: string, now = Date.now()): number {
  const s = perIp.get(ip);
  return Math.max(0, (s?.lockedUntil ?? 0) - now, globalLockedUntil - now);
}

export function registerFailure(ip: string, now = Date.now()): { lockedMs: number } {
  const s = perIp.get(ip) ?? { fails: [], lockedUntil: 0, lockCount: 0 };
  s.fails = prune(s.fails, now);
  s.fails.push(now);
  let lockedMs = 0;
  if (s.fails.length >= MAX_FAILS_PER_IP) {
    lockedMs = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** s.lockCount);
    s.lockedUntil = now + lockedMs;
    s.lockCount++;
    s.fails = [];
  }
  perIp.set(ip, s);

  globalFails = prune(globalFails, now);
  globalFails.push(now);
  if (globalFails.length >= MAX_FAILS_GLOBAL) {
    globalLockedUntil = now + GLOBAL_LOCK_MS;
    globalFails = [];
    lockedMs = Math.max(lockedMs, GLOBAL_LOCK_MS);
  }
  return { lockedMs };
}

export function registerSuccess(ip: string): void {
  perIp.delete(ip);
}

/** Só para testes. */
export function _resetThrottle(): void {
  perIp.clear(); globalFails = []; globalLockedUntil = 0;
}
