/**
 * Árvore de menu e mapeamento de coleções de teste.
 *
 *   100 Informática (L1)
 *     200 Portáteis (L2)       ← familia: linha INFORMATICA
 *       300 Gaming (L3)        ← subfamilia: PORTATEIS GAMING
 *       301 Office (L3)        ← subfamilia: PORTATEIS OFFICE
 *     201 Acessórios (L2)      ← familia: linha ACESSORIOS (sem filhos → destino direto)
 *   101 Escritório (L1)        ← menu: linha ESCRITORIO
 */
import type { MenuNode, ShopifyCollectionMapping } from '../suprides/types';
import type { CollectionHierarchy } from '../suprides/routes/sync-helpers';

export const MENU: MenuNode[] = [
  {
    title: 'Informática', shopifyId: '100', children: [
      { title: 'Portáteis', shopifyId: '200', children: [
        { title: 'Gaming', shopifyId: '300', children: [] },
        { title: 'Office', shopifyId: '301', children: [] },
      ] },
      { title: 'Acessórios', shopifyId: '201', children: [] },
    ],
  },
  { title: 'Escritório', shopifyId: '101', children: [] },
];

export const MAPPING: ShopifyCollectionMapping = {
  menu: { '101': ['ESCRITORIO'] },
  familia: { '200': ['INFORMATICA'], '201': ['ACESSORIOS'] },
  subfamilia: { '300': ['PORTATEIS GAMING'], '301': ['PORTATEIS OFFICE'] },
};

/** Igual a collectionHierarchyLookup(), mas a partir de MENU (sem ler disco). */
export function hierarchyFrom(nodes: MenuNode[]): Map<string, CollectionHierarchy> {
  const out = new Map<string, CollectionHierarchy>();
  for (const l1 of nodes) {
    if (l1.shopifyId) out.set(l1.shopifyId, { childCount: l1.children.length });
    for (const l2 of l1.children) {
      if (l2.shopifyId) out.set(l2.shopifyId, { l1Id: l1.shopifyId, childCount: l2.children.length });
      for (const l3 of l2.children) {
        if (l3.shopifyId) out.set(l3.shopifyId, { l2Id: l2.shopifyId, l1Id: l1.shopifyId, childCount: 0 });
      }
    }
  }
  return out;
}
