import { Router } from 'express';
import { loadMargins, saveMargins, loadCollectionMargins, saveCollectionMargins } from '../repositories/store';

const router = Router();

router.get('/', (_req, res) => res.json(loadMargins()));
router.put('/', (req, res) => { saveMargins(req.body); res.json(req.body); });
router.get('/collection', (_req, res) => res.json(loadCollectionMargins()));
router.put('/collection', (req, res) => { saveCollectionMargins(req.body); res.json(req.body); });

export default router;
