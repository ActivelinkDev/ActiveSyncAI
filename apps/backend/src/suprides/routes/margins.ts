import { Router } from 'express';
import { loadCollectionMargins, saveCollectionMargins } from '../repositories/store';

const router = Router();

router.get('/collection', async (_req, res) => {
  res.json(await loadCollectionMargins());
});

router.put('/collection', async (req, res) => {
  await saveCollectionMargins(req.body);
  res.json(req.body);
});

export default router;
