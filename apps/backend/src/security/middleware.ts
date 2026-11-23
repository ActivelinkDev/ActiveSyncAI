/**
 * Camadas de acesso aplicadas a todos os pedidos (ver index.ts):
 *   cabeçalhos de segurança → sessão obrigatória em /api → origem obrigatória em escritas →
 *   registo das ações que escrevem na loja ou mudam credenciais.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getSession, type Session } from './sessions';
import { audit } from './audit';
import { clientIp } from './ip-filter';

export interface SecurityOptions { secureCookies: boolean }
let opts: SecurityOptions = { secureCookies: true };
export function configureSecurity(o: SecurityOptions) { opts = o; }

/** Nome do cookie: "__Host-" obriga o browser a exigir HTTPS, Path=/ e sem Domain. */
export function sessionCookieName(): string {
  return opts.secureCookies ? '__Host-asai' : 'asai_dev';
}
export function sessionCookieOptions() {
  return { httpOnly: true, secure: opts.secureCookies, sameSite: 'strict' as const, path: '/' };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionToken(req: Request): string | undefined {
  return readCookie(req, sessionCookieName());
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { session?: Session } }
}

/** /api, /API, /Api/… — o Express não distingue maiúsculas nos caminhos por omissão, por isso as camadas também não. */
export const isApiPath = (p: string) => /^\/api(\/|$)/i.test(p);

// ----- Cabeçalhos -----
export function securityHeaders(): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      // Angular Material injeta estilos em linha.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://cdn.shopify.com https://www.suprides.pt",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (opts.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (isApiPath(req.path)) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

// ----- Sessão obrigatória -----
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/me']);

export function requireSession(): RequestHandler {
  return (req, res, next) => {
    if (!isApiPath(req.path) || PUBLIC_API.has(req.path)) return next();
    const s = getSession(sessionToken(req));
    if (!s) { res.status(401).json({ error: 'not_authenticated' }); return; }
    req.session = s;
    next();
  };
}

// ----- Origem (CSRF): escritas só a partir da própria app -----
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export function requireSameOrigin(): RequestHandler {
  return async (req, res, next) => {
    if (SAFE.has(req.method) || !isApiPath(req.path)) return next();
    const origin = req.headers.origin;
    let ok = false;
    try { ok = !!origin && new URL(origin).host === req.headers.host; } catch { ok = false; }
    if (!ok) {
      await audit('access.denied.origin', { ip: clientIp(req), detail: `${req.method} ${req.path} origin=${origin ?? '-'}` });
      res.status(403).json({ error: 'bad_origin' });
      return;
    }
    next();
  };
}

// ----- Ações sensíveis: ficam no registo de segurança (quem, quando, o quê) -----
export const DANGEROUS: { method: string; path: RegExp; label: string }[] = [
  { method: 'POST', path: /^\/api\/suprides\/sync-familias$/i, label: 'Sync completo para a Shopify' },
  { method: 'POST', path: /^\/api\/suprides\/sync-familias-cache$/i, label: 'Sync completo para a Shopify' },
  { method: 'POST', path: /^\/api\/suprides\/sync-stock$/i, label: 'Sync de stock para a Shopify' },
  { method: 'POST', path: /^\/api\/suprides\/reconcile-removes$/i, label: 'Retirar produtos de coleções na Shopify' },
  { method: 'POST', path: /^\/api\/suprides\/sync-images(\/dedupe)?\/?$/i, label: 'Imagens na Shopify' },
  { method: 'POST', path: /^\/api\/suprides\/menu\/sync$/i, label: 'Menu na Shopify' },
  { method: 'POST', path: /^\/api\/suprides\/public-menu\/publish$/i, label: 'Publicar menu na Shopify' },
  { method: 'POST', path: /^\/api\/scheduler\/run-now$/i, label: 'Executar agora (importação + sync)' },
  { method: 'POST', path: /^\/api\/campanhas\/\d+\/agendar$/i, label: 'Agendar campanha (preços na loja)' },
  { method: 'POST', path: /^\/api\/campanhas\/\d+\/desagendar$/i, label: 'Desagendar campanha' },
  { method: 'POST', path: /^\/api\/campanhas\/\d+\/cancelar$/i, label: 'Cancelar campanha (repõe preços na loja)' },
  { method: 'PUT', path: /^\/api\/suprides\/admin\/(connection|settings)$/i, label: 'Alterar ligações/definições' },
];

export function dangerousAction(req: Request) {
  return DANGEROUS.find(d => d.method === req.method && d.path.test(req.path));
}

export function auditDangerousActions(): RequestHandler {
  return async (req, _res, next) => {
    const d = dangerousAction(req);
    if (d) await audit('action', { ip: clientIp(req), user: req.session?.username, detail: `${d.label} (${req.method} ${req.path})` });
    next();
  };
}

/** Erros: mensagem genérica para o cliente, detalhe só no log do servidor. */
export function errorHandler() {
  return (err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    if (status >= 500) console.error(`[erro] ${req.method} ${req.path}:`, err?.stack || err);
    if (res.headersSent) return;
    res.status(status).json({ error: status === 413 ? 'Pedido demasiado grande' : status < 500 ? 'Pedido inválido' : 'Erro interno' });
  };
}
