import { Router } from 'express';
import { loadAdminSettings, saveAdminSettings, loadStats, resetStats, loadCustomPrompt, saveCustomPrompt, loadConnectionSettings, saveConnectionSettings } from '../repositories/store';
import { connectionView, applyConnectionUpdate, type FieldSpec } from '../../security/connection-view';
import { audit } from '../../security/audit';
import { clientIp } from '../../security/ip-filter';

const router = Router();

router.get('/settings', async (_req, res) => {
  res.json(await loadAdminSettings());
});

/** Só os campos conhecidos (nada de chaves arbitrárias vindas do pedido). */
export function pickAdminSettings(body: any): Partial<import('../types').AdminSettings> {
  const out: any = {};
  if (typeof body?.ivaRate === 'number' && body.ivaRate >= 0 && body.ivaRate <= 100) out.ivaRate = body.ivaRate;
  if (body?.rounding && typeof body.rounding === 'object') {
    out.rounding = { aboveUnitTo999: body.rounding.aboveUnitTo999 === true, belowUnitTo499: body.rounding.belowUnitTo499 === true };
  }
  for (const k of ['autoPublishPublicMenu', 'createNewProducts']) if (typeof body?.[k] === 'boolean') out[k] = body[k];
  for (const k of ['publicMenuHandle', 'publicMenuTitle']) if (typeof body?.[k] === 'string' && body[k].length <= 100) out[k] = body[k];
  return out;
}

router.put('/settings', async (req, res) => {
  const updated = { ...await loadAdminSettings(), ...pickAdminSettings(req.body) };
  await saveAdminSettings(updated);
  res.json(updated);
});

router.get('/sync-stats', async (_req, res) => {
  res.json(await loadStats());
});

router.post('/sync-stats/reset', async (_req, res) => {
  res.json(await resetStats());
});

const CONNECTION_FIELDS: FieldSpec[] = [
  { key: 'shopifyStore', env: 'SHOPIFY_STORE' },
  { key: 'shopifyToken', env: 'SHOPIFY_PASSWORD' },
  { key: 'shopifyLocationId', env: 'SHOPIFY_LOCATION_ID' },
  { key: 'supridesUrl', env: 'SUPRIDES_URL' },
  { key: 'supridesUser', env: 'SUPRIDES_USER' },
  { key: 'supridesPass', env: 'SUPRIDES_PASS' },
  { key: 'supridesToken', env: 'SUPRIDES_TOKEN' },
  { key: 'openaiApiKey', env: 'OPENAI_API_KEY' },
];

router.get('/connection', async (_req, res) => {
  res.json(connectionView(CONNECTION_FIELDS, await loadConnectionSettings()));
});

router.put('/connection', async (req, res) => {
  const { updated, changed } = applyConnectionUpdate(CONNECTION_FIELDS, await loadConnectionSettings(), req.body);
  if (changed.length) await saveConnectionSettings(updated);
  await audit('action', { ip: clientIp(req), user: req.session?.username, detail: `Ligações Suprides alteradas: ${changed.join(', ') || 'nada'}` });
  res.json({ ok: true, changed });
});

router.get('/custom-prompt', async (_req, res) => {
  res.json({ instructions: await loadCustomPrompt() });
});

router.post('/custom-prompt', async (req, res) => {
  const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions : '';
  await saveCustomPrompt(instructions);
  res.json({ ok: true });
});

export default router;
