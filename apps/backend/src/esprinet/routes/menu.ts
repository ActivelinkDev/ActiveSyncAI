import { Router } from 'express';
import { loadMenuItems, saveMenuItems, loadShopifyCollectionMapping, saveShopifyCollectionMapping, loadCollectionMargins, saveCollectionMargins } from '../repositories/store';
import type { MenuNode } from '../../suprides/types';

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

router.get('/', (_req, res) => {
  res.json(nodesToMenuResponse(loadMenuItems()));
});

router.get('/nodes', (_req, res) => {
  res.json(loadMenuItems());
});

router.put('/', (req, res) => {
  const { nodes } = req.body as { nodes: MenuNode[] };
  if (!Array.isArray(nodes)) return res.status(400).json({ error: 'nodes deve ser um array' });
  res.json({ nodes: saveMenuItems(nodes) });
});

router.post('/resolve-ids', (_req, res) => {
  const nodes = loadMenuItems();
  const ids = new Set<string>();
  let resolved = 0;

  const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const walk = (list: MenuNode[], parent = '') => {
    for (const node of list) {
      if (!node.shopifyId) {
        let candidate = parent ? `${parent}-${slug(node.title)}` : slug(node.title);
        let suffix = 2;
        while (ids.has(candidate)) candidate = `${candidate}-${suffix++}`;
        node.shopifyId = candidate;
        resolved++;
      }
      ids.add(node.shopifyId);
      walk(node.children || [], node.shopifyId);
    }
  };
  walk(nodes);
  saveMenuItems(nodes);

  const titleById = new Map<string, string>();
  const titleToId = new Map<string, string>();
  const currentIds = new Set<string>();
  const index = (list: MenuNode[]) => {
    for (const node of list) {
      if (node.shopifyId) {
        titleById.set(node.shopifyId, node.title);
        titleToId.set(node.title, node.shopifyId);
        currentIds.add(node.shopifyId);
      }
      index(node.children || []);
    }
  };
  index(nodes);

  const mapping = loadShopifyCollectionMapping();
  const migrateSection = (section: Record<string, string[]>): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [key, val] of Object.entries(section || {})) {
      if (currentIds.has(key)) out[key] = val;
      else out[titleToId.get(key) ?? key] = val;
    }
    return out;
  };
  mapping.menu = migrateSection(mapping.menu || {});
  mapping.familia = migrateSection(mapping.familia || {});
  mapping.subfamilia = migrateSection(mapping.subfamilia || {});
  if (mapping.hidden) {
    const hidden: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(mapping.hidden)) hidden[titleToId.get(key) ?? key] = val;
    mapping.hidden = hidden;
  }
  saveShopifyCollectionMapping(mapping);

  const collMargins = loadCollectionMargins();
  const newRules: typeof collMargins.rules = {};
  for (const [oldId, rule] of Object.entries(collMargins.rules)) {
    if (currentIds.has(oldId)) newRules[oldId] = rule;
    else {
      const newId = rule._title ? titleToId.get(rule._title) : undefined;
      newRules[newId ?? oldId] = rule;
    }
  }
  collMargins.rules = newRules;
  saveCollectionMargins(collMargins);

  res.json({ resolved, total: nodes.length });
});

router.post('/sync', (_req, res) => {
  res.status(501).json({ error: 'Sync Esprinet -> Shopify fora de ambito nesta fase.' });
});

export default router;
