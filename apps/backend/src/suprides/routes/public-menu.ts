import { Router } from 'express';
import { loadMenuItems, loadPublicMenu, loadShopifyCollectionMapping, loadAdminSettings } from '../repositories/store';
import { buildPublicMenuTree, publishPublicMenu } from '../services/public-menu';
import { getAllProducts } from '../services/products-cache';
import { parseStock } from '../api/suprides-api';
import { normTaxonomyValue } from '../services/taxonomy';
import {
  buildActiveCollectionIndexes,
  buildDerivedCollectionIds,
  collectionHierarchyLookup,
} from './sync-helpers';

const router = Router();

/**
 * GET /api/suprides/public-menu/audit
 * Devolve o conteúdo atual de menu público guardado com stats.
 */
router.get('/audit', async (_req, res) => {
  try {
    const file = await loadPublicMenu();
    res.json({ stats: file.stats, nodes: file.nodes });
  } catch (e: any) {
    res.status(500).json({ error: 'Erro ao carregar menu público', detail: e.message });
  }
});

/**
 * POST /api/suprides/public-menu/publish
 * Recalcula o menu público a partir da catálogo e publica no Shopify.
 * Query param:
 *   ?rebuild=true  (default) → recalcula activeCollectionIds da catálogo
 *   ?rebuild=false           → usa menu público guardado já existente, só republica
 */
router.post('/publish', async (req, res) => {
  const rebuild = req.query.rebuild !== 'false';

  try {
    let publicMenuFile = await loadPublicMenu();

    if (rebuild) {
      const all = await getAllProducts(false);
      const collMap = await loadShopifyCollectionMapping();
      const indexes = buildActiveCollectionIndexes(collMap);
      const hierarchyById = collectionHierarchyLookup(await loadMenuItems());

      const activeIds = new Set<string>();
      for (const p of all) {
        const stock = parseStock(p.stock);
        if (stock <= 0) continue;
        const line = normTaxonomyValue((p.product_line || '').trim());
        const fam  = normTaxonomyValue((p.family       || '').trim());
        const sub  = normTaxonomyValue((p.sub_family   || '').trim());
        const ids  = buildDerivedCollectionIds(line, fam, sub, collMap, indexes, hierarchyById);
        for (const id of ids) activeIds.add(id);
      }

      publicMenuFile = await buildPublicMenuTree([...activeIds]);
    }

    const settings = await loadAdminSettings();
    const handle = settings.publicMenuHandle || 'menu-publico';
    const title  = settings.publicMenuTitle  || 'Menu Público';

    const pubResult = await publishPublicMenu(handle, title);

    res.json({
      rebuilt: rebuild,
      stats: publicMenuFile.stats,
      published: pubResult.ok,
      errors: pubResult.errors,
      warnings: pubResult.warnings,
    });
  } catch (e: any) {
    res.status(500).json({ error: 'Erro ao publicar menu público', detail: e.message });
  }
});

export default router;
