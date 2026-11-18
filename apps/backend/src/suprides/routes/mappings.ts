import { Router } from 'express';
import { loadMappings, saveMappings } from '../repositories/store';
import { getMenuTopItems } from '../api/shopify-api';

const router = Router();

router.get('/', async (_req, res) => {
  res.json(await loadMappings());
});

router.put('/', async (req, res) => {
  const current = await loadMappings();
  const merged  = { ...current, ...req.body };
  const currentCount = (current.suprides?.length || 0) + Object.keys(current.lineToMenu || {}).length + (current.familyMappings?.length || 0);
  const incomingCount = (merged.suprides?.length || 0) + Object.keys(merged.lineToMenu || {}).length + (merged.familyMappings?.length || 0);
  if (currentCount > 0 && incomingCount === 0 && req.query.force !== 'true') {
    return res.status(400).json({
      error: 'Recusado para proteger mapeamentos existentes',
      detail: 'O payload recebido limparia todos os mapeamentos. Usa ?force=true apenas se for intencional.',
    });
  }
  await saveMappings(merged);
  res.json(merged);
});

router.get('/menu-items', async (_req, res) => {
  try {
    const items = await getMenuTopItems('menu-principal');
    res.json(items);
  } catch (err: any) {
    const status = err.response?.status || err.status;
    const msg    = status === 401
      ? 'Token Shopify inválido — verifica SHOPIFY_PASSWORD no .env'
      : err.message;
    console.error('[Suprides] Erro em /menu-items:', msg);
    res.status(status === 401 ? 401 : 500).json({ error: msg });
  }
});

export default router;
