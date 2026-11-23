import type { MenuNode, ShopifyCollectionMapping } from '../types';
import { normTaxonomyValue } from '../services/taxonomy';

export interface CollectionHierarchy {
  l2Id?: string;
  l1Id?: string;
  childCount?: number;
}

export function collectionHierarchyLookup(nodes: MenuNode[]): Map<string, CollectionHierarchy> {
  const out = new Map<string, CollectionHierarchy>();
  for (const l1 of nodes) {
    if (l1.shopifyId) out.set(l1.shopifyId, { childCount: (l1.children || []).length });
    for (const l2 of l1.children || []) {
      if (l2.shopifyId) out.set(l2.shopifyId, { l1Id: l1.shopifyId, childCount: (l2.children || []).length });
      for (const l3 of l2.children || []) {
        if (l3.shopifyId) out.set(l3.shopifyId, { l2Id: l2.shopifyId, l1Id: l1.shopifyId, childCount: 0 });
      }
    }
  }
  return out;
}

export function buildActiveCollectionIndexes(collMap: ShopifyCollectionMapping) {
  const hidden = collMap.hidden || {};
  const build = (section: Record<string, string[]> = {}) => {
    const out = new Map<string, string[]>();
    for (const [collId, values] of Object.entries(section)) {
      if (hidden[collId]) continue;
      for (const raw of values || []) {
        const value = normTaxonomyValue(raw);
        if (!value) continue;
        if (!out.has(value)) out.set(value, []);
        out.get(value)!.push(collId);
      }
    }
    return out;
  };
  return {
    lineToCollIds:   build(collMap.menu       || {}),
    familyToCollIds: build(collMap.familia    || {}),
    subToCollIds:    build(collMap.subfamilia || {}),
  };
}

export function collectionLevel(id: string, hierarchyById: Map<string, CollectionHierarchy>): number {
  const h = hierarchyById.get(id);
  if (!h) return 1;
  if (h.l2Id && h.l1Id) return 3;
  if (h.l1Id) return 2;
  return 1;
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function parentAcceptsLine(
  collId: string,
  line: string,
  collMap: ShopifyCollectionMapping,
  hierarchyById: Map<string, CollectionHierarchy>
): boolean {
  const hidden = collMap.hidden || {};
  const parent = hierarchyById.get(collId);
  const l2Id = parent?.l2Id;
  const l1Id = parent?.l1Id;
  const l2Accepts = !!l2Id && !hidden[l2Id] && (collMap.familia?.[l2Id] || []).map(normTaxonomyValue).includes(line);
  const l1Accepts = !!l1Id && !hidden[l1Id] && (collMap.menu?.[l1Id]    || []).map(normTaxonomyValue).includes(line);
  return l2Accepts || l1Accepts;
}

export function buildDerivedCollectionIds(
  line: string,
  family: string,
  subFamily: string,
  collMap: ShopifyCollectionMapping,
  indexes: ReturnType<typeof buildActiveCollectionIndexes>,
  hierarchyById: Map<string, CollectionHierarchy>
): string[] {
  line      = normTaxonomyValue(line);
  family    = normTaxonomyValue(family);
  subFamily = normTaxonomyValue(subFamily);

  const hidden = collMap.hidden || {};

  const hasMappedL3Under = (l2Id: string): boolean =>
    Object.keys(collMap.subfamilia || {}).some(id => {
      const h = hierarchyById.get(id);
      return !hidden[id] && h?.l2Id === l2Id && (collMap.subfamilia[id] || []).length > 0;
    });

  const hasMappedDescendantUnderL1 = (l1Id: string): boolean =>
    Object.keys(collMap.familia || {}).some(id => {
      const h = hierarchyById.get(id);
      return !hidden[id] && h?.l1Id === l1Id && !h?.l2Id && (collMap.familia[id] || []).length > 0;
    }) ||
    Object.keys(collMap.subfamilia || {}).some(id => {
      const h = hierarchyById.get(id);
      return !hidden[id] && h?.l1Id === l1Id && (collMap.subfamilia[id] || []).length > 0;
    });

  const compatibleL3 = uniqueIds([
    ...(indexes.subToCollIds.get(family)    || []),
    ...(subFamily ? indexes.subToCollIds.get(subFamily) || [] : []),
  ]).filter(id => {
    const h = hierarchyById.get(id);
    return !!h?.l2Id && !!h.l1Id && !hidden[id] &&
      (!hasMappedL3Under(h.l2Id) || parentAcceptsLine(id, line, collMap, hierarchyById));
  });

  const l1IdsFromMap = uniqueIds(indexes.lineToCollIds.get(line) || [])
    .filter(id => hierarchyById.has(id) && collectionLevel(id, hierarchyById) === 1 && !hasMappedDescendantUnderL1(id));

  const l2Ids = uniqueIds(
    compatibleL3
      .map(id => hierarchyById.get(id)?.l2Id)
      .filter((id): id is string => !!id && !hidden[id])
  );
  const l1IdsFromL3 = uniqueIds(
    compatibleL3
      .map(id => hierarchyById.get(id)?.l1Id)
      .filter((id): id is string => !!id && !hidden[id])
  );

  const directL2Ids = uniqueIds(
    (indexes.familyToCollIds.get(line) || [])
      .filter(id => {
        const h = hierarchyById.get(id);
        return !!h?.l1Id && !h.l2Id && !hidden[id] && !hasMappedL3Under(id);
      })
  );
  const l1IdsFromDirectL2 = uniqueIds(
    directL2Ids
      .map(id => hierarchyById.get(id)?.l1Id)
      .filter((id): id is string => !!id && !hidden[id])
  );

  return uniqueIds([...l1IdsFromMap, ...l1IdsFromL3, ...l1IdsFromDirectL2, ...directL2Ids, ...l2Ids, ...compatibleL3]);
}
