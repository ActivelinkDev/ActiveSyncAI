import { Router } from 'express';
import { getShopifyMenuFull, syncMenuStructure, fetchAllCollections, toHandle, MenuSyncNode } from '../api/shopify-api';
import { loadMenuItems, saveMenuItems, loadShopifyCollectionMapping, saveShopifyCollectionMapping, loadCollectionMargins, saveCollectionMargins } from '../repositories/store';
import type { MenuNode } from '../types';

const router = Router();

function nodesToMenuResponse(nodes: MenuNode[]) {
  const toItem = (node: MenuNode): any => ({
    id: node.shopifyId || node.title,
    title: node.title,
    type: 'COLLECTION',
    resourceId: node.shopifyId,
    items: (node.children || []).map(toItem)
  });
  return { id: null, handle: 'menu-principal', title: 'Menu Principal', items: nodes.map(toItem) };
}

router.get('/', async (_req, res) => {
  const savedNodes = await loadMenuItems();
  if (savedNodes.length > 0) return res.json(nodesToMenuResponse(savedNodes));

  try {
    const menu = await getShopifyMenuFull('menu-principal');
    res.json(menu || { id: null, handle: 'menu-principal', title: 'Menu Principal', items: [] });
  } catch (e: any) {
    res.json({ id: null, handle: 'menu-principal', title: 'Menu Principal', items: [] });
  }
});

router.get('/nodes', async (_req, res) => {
  res.json(await loadMenuItems());
});

router.put('/', async (req, res) => {
  const { nodes } = req.body as { nodes: MenuNode[] };
  if (!Array.isArray(nodes)) return res.status(400).json({ error: 'nodes deve ser um array' });
  res.json({ nodes: await saveMenuItems(nodes) });
});

router.post('/resolve-ids', async (_req, res) => {
  try {
    const nodes = await loadMenuItems();
    if (nodes.length === 0) return res.json({ resolved: 0 });

    // Fetch all current Shopify collections (handle → gid)
    const allCollections = await fetchAllCollections();
    let resolved = 0;

    // Walk tree using HIERARCHICAL handles (parent--child) — same format as syncMenuStructure
    const walk = (list: MenuNode[], parentHandle = '') => {
      for (const node of list) {
        const nodeHandle = toHandle(node.title);
        const handle = parentHandle ? `${parentHandle}--${nodeHandle}` : nodeHandle;
        if (!node.shopifyId) {
          const gid = allCollections.get(handle);
          if (gid) {
            node.shopifyId = gid.split('/').pop();
            resolved++;
          }
        }
        if (node.children?.length) walk(node.children, handle);
      }
    };
    walk(nodes);
    await saveMenuItems(nodes);

    // Build lookup maps from resolved tree
    const titleToId  = new Map<string, string>(); // title → shopifyId
    const currentIds = new Set<string>();          // all currently valid shopifyIds
    const indexTree  = (list: MenuNode[]) => {
      for (const node of list) {
        if (node.shopifyId) {
          titleToId.set(node.title, node.shopifyId);
          currentIds.add(node.shopifyId);
        }
        if (node.children?.length) indexTree(node.children);
      }
    };
    indexTree(nodes);

    // Construir mapa id → título (usado em migrateSection e migrateMargins)
    const titleById = new Map<string, string>();
    const indexTitles = (list: MenuNode[]) => {
      for (const node of list) {
        if (node.shopifyId && node.title) titleById.set(node.shopifyId, node.title);
        if (node.children?.length) indexTitles(node.children);
      }
    };
    indexTitles(nodes);

    // Migrate collection mappings:
    //  - Numeric keys that exist in current menu → keep as-is
    //  - Numeric keys that are stale (not in menu) → try to find new ID via titleToId
    //  - Text keys (collection titles) → convert to numeric ID via titleToId
    const mapping = await loadShopifyCollectionMapping();
    let migratedKeys = 0;

    const migrateSection = (section: Record<string, string[]>): Record<string, string[]> => {
      const out: Record<string, string[]> = {};
      for (const [key, val] of Object.entries(section)) {
        const isNumeric = !isNaN(Number(key)) && key.trim() !== '';
        if (isNumeric) {
          if (currentIds.has(key)) {
            out[key] = val; // ID still valid in current menu
          } else {
            // Stale numeric ID — try to find via titleToId using the known title from menu
            const title = titleById.get(key);
            const newId = title ? titleToId.get(title) : undefined;
            if (newId) {
              out[newId] = val; migratedKeys++;
            } else {
              out[key] = val; // keep stale — can't resolve without a title match
            }
          }
          continue;
        }
        // Text key → resolve via titleToId
        const id = titleToId.get(key);
        if (id) { out[id] = val; migratedKeys++; }
        else out[key] = val;
      }
      return out;
    };

    const migrateHidden = (hidden: Record<string, boolean>): Record<string, boolean> => {
      const out: Record<string, boolean> = {};
      for (const [key, val] of Object.entries(hidden)) {
        const isNumeric = !isNaN(Number(key)) && key.trim() !== '';
        if (isNumeric) {
          if (currentIds.has(key)) { out[key] = val; continue; }
          const title = titleById.get(key);
          const newId = title ? titleToId.get(title) : undefined;
          out[newId ?? key] = val;
          continue;
        }
        const id = titleToId.get(key);
        out[id ?? key] = val;
      }
      return out;
    };

    mapping.menu       = migrateSection(mapping.menu       || {});
    mapping.familia    = migrateSection(mapping.familia    || {});
    mapping.subfamilia = migrateSection(mapping.subfamilia || {});
    if (mapping.hidden) mapping.hidden = migrateHidden(mapping.hidden);
    await saveShopifyCollectionMapping(mapping);

    // Migrar margens por coleção:
    //  1. Chaves cujo ID já existe no menu actual → manter (actualizar _title)
    //  2. Chaves cujo ID não existe mas têm _title que resolve para um novo ID → remapear
    //  3. Chaves sem _title e ID desconhecido → manter (orphaned, não eliminamos)
    const collMargins = await loadCollectionMargins();
    let migratedMargins = 0;
    const newRules: typeof collMargins.rules = {};

    for (const [oldId, rule] of Object.entries(collMargins.rules)) {
      if (currentIds.has(oldId)) {
        const freshTitle = titleById.get(oldId);
        newRules[oldId] = freshTitle ? { ...rule, _title: freshTitle } : rule;
      } else {
        const savedTitle = rule._title;
        const newId = savedTitle ? titleToId.get(savedTitle) : undefined;
        if (newId) {
          newRules[newId] = { ...rule, _title: savedTitle };
          migratedMargins++;
        } else {
          newRules[oldId] = rule;
        }
      }
    }

    collMargins.rules = newRules;
    await saveCollectionMargins(collMargins);

    res.json({ resolved, migratedKeys, migratedMargins, total: nodes.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sync', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type: string, data: object = {}) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const { nodes } = req.body as { nodes: MenuSyncNode[] };
    if (!Array.isArray(nodes)) { send('error', { message: 'nodes deve ser um array' }); return res.end(); }

    const total = nodes.reduce((s: number, l: any) =>
      s + 1 + (l.children || []).reduce((s2: number, f: any) => s2 + 1 + (f.children || []).length, 0), 0);
    send('start', { total });

    await saveMenuItems(nodes);
    const result = await syncMenuStructure(nodes, (phase, done, total) => {
      send('progress', { phase, done, total });
    });
    await saveMenuItems(nodes as any);
    send('done', result);
  } catch (e: any) {
    console.error('[MENU SYNC] Erro:', e.message);
    send('error', { message: e.message });
  }
  res.end();
});

export default router;
