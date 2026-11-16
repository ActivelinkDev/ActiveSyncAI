import { Router } from 'express';
import { loadAdminSettings, saveAdminSettings, loadStats, resetStats, loadCustomPrompt, saveCustomPrompt, loadConnectionSettings, saveConnectionSettings } from '../repositories/store';

const router = Router();

router.get('/settings', (_req, res) => res.json(loadAdminSettings()));

router.put('/settings', (req, res) => {
  const updated = Object.assign({}, loadAdminSettings(), req.body);
  saveAdminSettings(updated);
  res.json(updated);
});

router.get('/sync-stats', (_req, res) => res.json(loadStats()));
router.post('/sync-stats/reset', (_req, res) => res.json(resetStats()));

router.get('/connection', (_req, res) => {
  const s = loadConnectionSettings();
  res.json({
    shopifyStore:      s.shopifyStore      ?? process.env.SHOPIFY_STORE        ?? '',
    shopifyToken:      s.shopifyToken      ?? process.env.SHOPIFY_PASSWORD     ?? '',
    shopifyLocationId: s.shopifyLocationId ?? process.env.SHOPIFY_LOCATION_ID  ?? '',
    openaiApiKey:      s.openaiApiKey      ?? process.env.OPENAI_API_KEY       ?? '',
  });
});

router.put('/connection', (req, res) => {
  const allowed = ['shopifyStore','shopifyToken','shopifyLocationId','openaiApiKey'];
  const updated: any = { ...loadConnectionSettings() };
  for (const key of allowed) {
    if (typeof req.body?.[key] === 'string') updated[key] = req.body[key];
  }
  saveConnectionSettings(updated);
  res.json({ ok: true });
});

router.get('/custom-prompt', (_req, res) => res.json({ instructions: loadCustomPrompt() }));
router.post('/custom-prompt', (req, res) => {
  saveCustomPrompt(typeof req.body?.instructions === 'string' ? req.body.instructions : '');
  res.json({ ok: true });
});

export default router;
