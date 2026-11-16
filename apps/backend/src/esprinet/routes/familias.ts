import { Router } from 'express';
import { getAllProducts, buildFamiliasFromProducts } from '../services/products-cache';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const all = await getAllProducts(force);
    res.json(buildFamiliasFromProducts(all));
  } catch (err: any) {
    console.error('[Esprinet] Erro em /familias:', err.message);
    res.status(500).json({ error: 'Erro ao obter familias' });
  }
});

export default router;
