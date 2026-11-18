/**
 * Palavra-passe da conta: guardada só como hash scrypt (sal aleatório, custo alto).
 * Formato: scrypt$N$r$p$<sal base64>$<hash base64>
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { dataPath } from '../utils/data-dir';

const N = 1 << 17, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) => err ? reject(err) : resolve(key)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** Regras mínimas (ASVS 5.0 V6.2): comprimento, sem regras de composição, sem as mais comuns. */
const COMMON = ['password', 'palavrapasse', 'activesync', 'shopify', 'suprides', 'qwerty', '123456', 'admin', 'activelink'];
export function passwordProblem(password: string, username?: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `A palavra-passe tem de ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password.length > 256) return 'A palavra-passe é demasiado longa.';
  const low = password.toLowerCase();
  if (username && low.includes(username.toLowerCase())) return 'A palavra-passe não pode conter o nome de utilizador.';
  if (COMMON.some(c => low.replace(/[^a-z0-9]/g, '').startsWith(c) && low.length < c.length + 6)) return 'A palavra-passe é demasiado comum.';
  if (/^(.)\1+$/.test(password)) return 'A palavra-passe é demasiado simples.';
  return null;
}

// ----- Conta (uma só) -----
export interface Account { username: string; passwordHash: string; changedAt: string }

const ACCOUNT_FILE = () => path.join(dataPath('security'), 'account.json');

export function loadAccount(): Account | null {
  try {
    const a = JSON.parse(fs.readFileSync(ACCOUNT_FILE(), 'utf8'));
    return a?.username && a?.passwordHash ? a : null;
  } catch { return null; }
}

export function saveAccount(a: Account): void {
  const dir = dataPath('security');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = ACCOUNT_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNT_FILE());
}

/** Hash de referência para comparar quando a conta não existe (mesmo tempo de resposta). */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  return (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));
}
