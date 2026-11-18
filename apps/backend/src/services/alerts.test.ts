import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, sendAlert, alertsConfigured } from './alerts';

test('alertas: credenciais nunca vão no email', () => {
  const t = scrub('erro com shpat_abc123DEF e sk-proj-abcdefghijklmnop; token=xyz password: segredo'); // check-secrets: ignore (valores falsos de teste)
  assert.equal(/abc123DEF|abcdefghijklmnop|xyz|segredo/.test(t), false);
  assert.match(t, /shpat_••••/);
});

test('alertas: sem configuração não envia nem rebenta', async () => {
  for (const k of ['SMTP_HOST', 'ALERT_TO', 'ALERT_FROM']) delete process.env[k];
  assert.equal(alertsConfigured(), false);
  const r = await sendAlert('sync-failed', 'Teste', 'detalhe');
  assert.deepEqual(r, { sent: false, reason: 'email não configurado' });
});

test('alertas: servidor de email inacessível não rebenta', async () => {
  process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = '1'; // porta fechada
  process.env.ALERT_FROM = 'a@example.com'; process.env.ALERT_TO = 'b@example.com';
  const r = await sendAlert('sync-errors', 'Teste', 'detalhe');
  assert.equal(r.sent, false);
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'ALERT_TO', 'ALERT_FROM']) delete process.env[k];
});
