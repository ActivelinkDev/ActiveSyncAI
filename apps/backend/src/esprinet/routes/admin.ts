import { Router } from 'express';
import { loadAdminSettings, saveAdminSettings, loadStats, resetStats, loadCustomPrompt, saveCustomPrompt, loadConnectionSettings, saveConnectionSettings } from '../repositories/store';
import { connectionView, applyConnectionUpdate, type FieldSpec } from '../../security/connection-view';
import { audit } from '../../security/audit';
import { clientIp } from '../../security/ip-filter';
import { pickAdminSettings } from '../../suprides/routes/admin';

const router = Router();

router.get('/settings', (_req, res) => res.json(loadAdminSettings()));

router.put('/settings', (req, res) => {
  const updated = { ...loadAdminSettings(), ...pickAdminSettings(req.body) };
  saveAdminSettings(updated);
  res.json(updated);
});

router.get('/sync-stats', (_req, res) => res.json(loadStats()));
router.post('/sync-stats/reset', (_req, res) => res.json(resetStats()));

const CONNECTION_FIELDS: FieldSpec[] = [
  { key: 'shopifyStore', env: 'SHOPIFY_STORE' },
  { key: 'shopifyToken', env: 'SHOPIFY_PASSWORD' },
  { key: 'shopifyLocationId', env: 'SHOPIFY_LOCATION_ID' },
  { key: 'openaiApiKey', env: 'OPENAI_API_KEY' },
];

router.get('/connection', (_req, res) => {
  res.json(connectionView(CONNECTION_FIELDS, loadConnectionSettings()));
});

router.put('/connection', (req, res) => {
  const { updated, changed } = applyConnectionUpdate(CONNECTION_FIELDS, loadConnectionSettings(), req.body);
  if (changed.length) saveConnectionSettings(updated);
  audit('action', { ip: clientIp(req), user: req.session?.username, detail: `Ligações Esprinet alteradas: ${changed.join(', ') || 'nada'}` });
  res.json({ ok: true, changed });
});

router.get('/custom-prompt', (_req, res) => res.json({ instructions: loadCustomPrompt() }));
router.post('/custom-prompt', (req, res) => {
  saveCustomPrompt(typeof req.body?.instructions === 'string' ? req.body.instructions : '');
  res.json({ ok: true });
});

export default router;
