/**
 * Filtro por IP real (endereço do socket TCP). Cabeçalhos como X-Forwarded-For,
 * CF-Connecting-IP, Origin ou User-Agent NÃO contam: qualquer cliente os falsifica.
 *
 * ALLOWED_SUBNETS no .env, separados por vírgula: "192.0.2.0/24, 198.51.100.0/24, 203.0.113.5".
 * Sem nada configurado → só redes internas (gamas privadas RFC 1918 + IPv6 local) e o próprio
 * servidor. A internet nunca entra. Para restringir mais, definir ALLOWED_SUBNETS.
 */
import net from 'net';
import type { Request, Response, NextFunction } from 'express';

export interface Subnet { family: 4 | 6; base: bigint; bits: number }

function ipToBigInt(ip: string): { family: 4 | 6; value: bigint } | null {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return { family: 4, value: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) };
  }
  const noZone = ip.split('%')[0];
  if (net.isIPv6(noZone)) {
    let s = noZone;
    // IPv4 embutido no fim (ex.: ::ffff:1.2.3.4) → dois grupos hexadecimais
    const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (m) {
      const v4 = ipToBigInt(m[2])!.value;
      s = m[1] + ((v4 >> 16n) & 0xffffn).toString(16) + ':' + (v4 & 0xffffn).toString(16);
    }
    const parts = s.split('::');
    if (parts.length > 2) return null;
    const h = parts[0] ? parts[0].split(':') : [];
    const t = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    const groups = parts.length === 2 ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
    if (groups.length !== 8) return null;
    let v = 0n;
    for (const g of groups) v = (v << 16n) + BigInt(parseInt(g || '0', 16));
    return { family: 6, value: v };
  }
  return null;
}

/** Normaliza o endereço do socket: "::ffff:192.0.2.5" → "192.0.2.5". */
export function normalizeRemote(addr: string | undefined): string {
  const a = String(addr || '').trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1] : a;
}

/** Redes internas: 10/8, 172.16/12, 192.168/16, IPv6 ULA (fc00::/7) e link-local (fe80::/10). */
export const PRIVATE_NETWORKS = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7, fe80::/10'; // check-secrets: ignore (gamas RFC 1918, não são IPs da empresa)

/** Sub-redes efetivas: ALLOWED_SUBNETS se definido, senão as redes internas. */
export function effectiveSubnets(spec: string | undefined): { subnets: Subnet[]; source: 'config' | 'private' } {
  return String(spec || '').trim()
    ? { subnets: parseSubnets(spec), source: 'config' }
    : { subnets: parseSubnets(PRIVATE_NETWORKS), source: 'private' };
}

export function parseSubnets(spec: string | undefined): Subnet[] {
  const out: Subnet[] = [];
  for (const raw of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [ip, bitsStr] = raw.split('/');
    const parsed = ipToBigInt(ip);
    if (!parsed) throw new Error(`ALLOWED_SUBNETS: endereço inválido "${raw}"`);
    const max = parsed.family === 4 ? 32 : 128;
    const bits = bitsStr === undefined ? max : Number(bitsStr);
    if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`ALLOWED_SUBNETS: máscara inválida "${raw}"`);
    const mask = bits === 0 ? 0n : ((1n << BigInt(max)) - 1n) ^ ((1n << BigInt(max - bits)) - 1n);
    out.push({ family: parsed.family, base: parsed.value & mask, bits });
  }
  return out;
}

export function isLoopback(ip: string): boolean {
  return ip === '::1' || /^127\./.test(ip);
}

export function ipAllowed(remote: string | undefined, subnets: Subnet[]): boolean {
  const ip = normalizeRemote(remote);
  if (isLoopback(ip)) return true;
  const parsed = ipToBigInt(ip);
  if (!parsed) return false;
  return subnets.some(s => {
    if (s.family !== parsed.family) return false;
    const max = s.family === 4 ? 32 : 128;
    const mask = s.bits === 0 ? 0n : ((1n << BigInt(max)) - 1n) ^ ((1n << BigInt(max - s.bits)) - 1n);
    return (parsed.value & mask) === s.base;
  });
}

export function ipFilter(subnets: Subnet[], onDeny?: (ip: string, req: Request) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    const remote = req.socket?.remoteAddress;
    if (ipAllowed(remote, subnets)) return next();
    onDeny?.(normalizeRemote(remote), req);
    // Sem detalhes: não confirmar que há aqui uma aplicação.
    res.status(403).end();
  };
}

/** IP do cliente para registos e limites: sempre o do socket. */
export function clientIp(req: Request): string {
  return normalizeRemote(req.socket?.remoteAddress);
}
