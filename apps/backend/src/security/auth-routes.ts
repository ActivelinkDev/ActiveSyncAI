/**
 * /api/auth — login, sessão e mudança de palavra-passe.
 */
import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { audit, readAudit } from './audit';
import { clientIp } from './ip-filter';
import { loginBlockedFor, registerFailure, registerSuccess } from './login-throttle';
import {
  loadAccount, saveAccount, verifyPassword, hashPassword, passwordProblem, dummyPasswordHash,
} from './password';
import {
  createSession, getSession, destroySession, destroyAllSessions, SESSION_IDLE_MS,
} from './sessions';
import { sessionCookieName, sessionCookieOptions, sessionToken } from './middleware';

const router = Router();

/** Atraso aleatório nas falhas: igualiza tempos e abranda tentativas. */
const failDelay = () => new Promise(r => setTimeout(r, 300 + crypto.randomInt(300)));

function tooMany(res: Response, ms: number) {
  res.setHeader('Retry-After', String(Math.ceil(ms / 1000)));
  res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: Math.ceil(ms / 1000) });
}

/** Verifica utilizador + palavra-passe sempre com o mesmo custo, exista ou não a conta. */
async function checkCredentials(username: unknown, password: unknown): Promise<string | null> {
  const account = loadAccount();
  const u = typeof username === 'string' ? username.trim() : '';
  const p = typeof password === 'string' ? password : '';
  const hash = account?.passwordHash ?? await dummyPasswordHash();
  const passOk = p.length > 0 && p.length <= 256 && await verifyPassword(p, hash);
  const digest = (s: string) => crypto.createHash('sha256').update(s.normalize('NFKC').toLowerCase()).digest();
  const userOk = !!account && u.length > 0 && crypto.timingSafeEqual(digest(u), digest(account.username));
  return account && passOk && userOk ? account.username : null;
}

router.post('/login', async (req: Request, res: Response) => {
  const ip = clientIp(req);
  if (!loadAccount()) {
    res.status(503).json({ error: 'no_account', message: 'Conta ainda não configurada no servidor.' });
    return;
  }
  const blocked = loginBlockedFor(ip);
  if (blocked > 0) { audit('login.locked', { ip }); tooMany(res, blocked); return; }

  const user = await checkCredentials(req.body?.username, req.body?.password);
  if (!user) {
    const { lockedMs } = registerFailure(ip);
    audit('login.fail', { ip, detail: `utilizador="${String(req.body?.username ?? '').slice(0, 40)}"` });
    await failDelay();
    if (lockedMs > 0) { audit('login.locked', { ip, detail: `${Math.round(lockedMs / 1000)} s` }); tooMany(res, lockedMs); return; }
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  registerSuccess(ip);
  destroySession(sessionToken(req)); // nunca reaproveitar uma sessão anterior
  const token = createSession(user, ip, String(req.headers['user-agent'] || ''));
  res.cookie(sessionCookieName(), token, sessionCookieOptions());
  audit('login.ok', { ip, user });
  res.json({ username: user, idleTimeoutMs: SESSION_IDLE_MS });
});

router.post('/logout', (req, res) => {
  const s = getSession(sessionToken(req));
  destroySession(sessionToken(req));
  res.clearCookie(sessionCookieName(), sessionCookieOptions());
  if (s) audit('logout', { ip: clientIp(req), user: s.username });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const s = getSession(sessionToken(req));
  if (!s) { res.status(401).json({ error: 'not_authenticated', accountConfigured: !!loadAccount() }); return; }
  res.json({ username: s.username, idleTimeoutMs: SESSION_IDLE_MS });
});

router.post('/password', async (req, res) => {
  const ip = clientIp(req);
  const s = req.session!;
  const blocked = loginBlockedFor(ip);
  if (blocked > 0) { tooMany(res, blocked); return; }
  const ok = await checkCredentials(s.username, req.body?.currentPassword);
  if (!ok) {
    registerFailure(ip);
    audit('password.fail', { ip, user: s.username });
    await failDelay();
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  const next = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  const problem = passwordProblem(next, s.username);
  if (problem) { res.status(400).json({ error: 'weak_password', message: problem }); return; }
  if (next === req.body?.currentPassword) { res.status(400).json({ error: 'weak_password', message: 'A nova palavra-passe tem de ser diferente.' }); return; }
  const account = loadAccount()!;
  saveAccount({ ...account, passwordHash: await hashPassword(next), changedAt: new Date().toISOString() });
  destroyAllSessions(sessionToken(req));
  audit('password.changed', { ip, user: s.username });
  res.json({ ok: true });
});

router.get('/audit', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  res.json(readAudit(limit));
});

export default router;
