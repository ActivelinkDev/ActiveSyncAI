import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubnets, ipAllowed, normalizeRemote } from './ip-filter';
import { createSession, getSession, isElevated, destroyAllSessions, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, ELEVATION_MS } from './sessions';
import { registerFailure, registerSuccess, loginBlockedFor, _resetThrottle, MAX_FAILS_PER_IP } from './login-throttle';
import { hashPassword, verifyPassword, passwordProblem } from './password';
import { connectionView, applyConnectionUpdate } from './connection-view';
import { maskSecret } from './secret-box';

test('filtro IP: sub-redes IPv4, IPv4 em IPv6, loopback e fora', () => {
  const s = parseSubnets('192.0.2.0/24, 203.0.113.5');
  assert.equal(ipAllowed('192.0.2.77', s), true);
  assert.equal(ipAllowed('::ffff:192.0.2.1', s), true);
  assert.equal(ipAllowed('203.0.113.5', s), true);
  assert.equal(ipAllowed('203.0.113.6', s), false);
  assert.equal(ipAllowed('198.51.100.1', s), false);
  assert.equal(ipAllowed('127.0.0.1', s), true);
  assert.equal(ipAllowed('::1', s), true);
  assert.equal(ipAllowed('', s), false);
  assert.equal(ipAllowed('lixo', s), false);
});

test('filtro IP: sem sub-redes → só o próprio PC', () => {
  const s = parseSubnets('');
  assert.equal(ipAllowed('198.51.100.2', s), false);
  assert.equal(ipAllowed('::ffff:127.0.0.1', s), true);
});

test('filtro IP: IPv6 e máscaras inválidas', () => {
  const s = parseSubnets('fd00:1234::/32');
  assert.equal(ipAllowed('fd00:1234:abcd::1', s), true);
  assert.equal(ipAllowed('fd00:1235::1', s), false);
  assert.throws(() => parseSubnets('192.0.2.0/33'));
  assert.throws(() => parseSubnets('abc/24'));
  assert.equal(normalizeRemote('::ffff:203.0.113.1'), '203.0.113.1');
});

test('sessões: expiram por inatividade e pelo limite absoluto', () => {
  destroyAllSessions();
  const t0 = 1_000_000;
  const tok = createSession('admin', '203.0.113.1', 'ua', t0);
  assert.ok(getSession(tok, t0 + 1000));
  assert.equal(getSession(tok, t0 + 1000 + SESSION_IDLE_MS + 1), null);

  const tok2 = createSession('admin', '203.0.113.1', 'ua', t0);
  let now = t0;
  while (now < t0 + SESSION_ABSOLUTE_MS - SESSION_IDLE_MS) { now += SESSION_IDLE_MS - 1000; assert.ok(getSession(tok2, now)); }
  assert.equal(getSession(tok2, t0 + SESSION_ABSOLUTE_MS + 1), null);
  assert.equal(getSession('nao-existe', t0), null);
  assert.equal(getSession(undefined, t0), null);
});

test('sessões: confirmação da palavra-passe vale 5 minutos', () => {
  const t0 = 2_000_000;
  const tok = createSession('admin', 'ip', 'ua', t0);
  const s = getSession(tok, t0)!;
  assert.equal(isElevated(s, t0 + ELEVATION_MS - 1), true);
  assert.equal(isElevated(s, t0 + ELEVATION_MS + 1), false);
});

test('tentativas: bloqueio após 5 falhas, a duplicar, e sucesso limpa', () => {
  _resetThrottle();
  const ip = '203.0.113.9';
  let now = 5_000_000;
  for (let i = 0; i < MAX_FAILS_PER_IP - 1; i++) assert.equal(registerFailure(ip, now).lockedMs, 0);
  assert.equal(registerFailure(ip, now).lockedMs, 60_000);
  assert.ok(loginBlockedFor(ip, now + 1000) > 0);
  now += 61_000;
  assert.equal(loginBlockedFor(ip, now), 0);
  for (let i = 0; i < MAX_FAILS_PER_IP - 1; i++) registerFailure(ip, now);
  assert.equal(registerFailure(ip, now).lockedMs, 120_000);
  registerSuccess(ip);
  assert.equal(loginBlockedFor(ip, now), 0);
  _resetThrottle();
});

test('palavra-passe: hash scrypt verifica e rejeita', async () => {
  const h = await hashPassword('uma frase bem comprida 42');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword('uma frase bem comprida 42', h), true);
  assert.equal(await verifyPassword('outra', h), false);
  assert.equal(await verifyPassword('x', 'lixo'), false);
});

test('palavra-passe: regras mínimas', () => {
  assert.ok(passwordProblem('curta'));
  assert.ok(passwordProblem('aaaaaaaaaaaaaaaa'));
  assert.ok(passwordProblem('admin-frase-longa', 'admin'));
  assert.equal(passwordProblem('cavalo bateria agrafo correto'), null);
});

test('ligações: credenciais mascaradas; vazio e máscara não alteram', () => {
  const fields = [{ key: 'shopifyStore' }, { key: 'shopifyToken' }];
  const view = connectionView(fields, { shopifyStore: 'loja', shopifyToken: 'tok_x_1234567890abcdef' });
  assert.deepEqual(view, { shopifyStore: 'loja', shopifyToken: '••••cdef', shopifyTokenSet: true });
  assert.equal(JSON.stringify(view).includes('shpat_'), false);

  const cur = { shopifyStore: 'loja', shopifyToken: 'segredo-antigo' };
  assert.deepEqual(applyConnectionUpdate(fields, cur, { shopifyToken: '' }).changed, []);
  assert.deepEqual(applyConnectionUpdate(fields, cur, { shopifyToken: '••••cdef' }).changed, []);
  assert.deepEqual(applyConnectionUpdate(fields, cur, { shopifyToken: 'novo', outro: 'x' }), { updated: { shopifyStore: 'loja', shopifyToken: 'novo' }, changed: ['shopifyToken'] });
  assert.equal(maskSecret('curto'), '••••');
});

test('credenciais cifradas: ida e volta e deteção de adulteração', async () => {
  const prev = process.env.SECRETS_KEY;
  process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
  const { encryptSecret, decryptSecret, encryptFields, decryptFields, isEncrypted } = await import('./secret-box');
  const enc = encryptSecret('shpat_abc');
  assert.ok(isEncrypted(enc));
  assert.equal(decryptSecret(enc), 'shpat_abc');
  const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptSecret(tampered));
  const obj = encryptFields({ shopifyStore: 'loja', shopifyToken: 'tok' });
  assert.equal(obj.shopifyStore, 'loja');
  assert.ok(isEncrypted(obj.shopifyToken));
  assert.deepEqual(decryptFields(obj), { shopifyStore: 'loja', shopifyToken: 'tok' });
  if (prev === undefined) delete process.env.SECRETS_KEY; else process.env.SECRETS_KEY = prev;
});
