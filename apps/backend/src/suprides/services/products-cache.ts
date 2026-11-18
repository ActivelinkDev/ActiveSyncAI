import { getAllProducts as readProducts } from '../../repositories/suprides-cache';
import type { SupridesProduct, FamiliaTree } from '../types';

export async function getAllProducts(_force = false): Promise<SupridesProduct[]> {
  const rows = await readProducts(2147483647);
  return rows.map(r => ({
    sku:               r.sku,
    name:              r.name              ?? '',
    ean:               r.ean               ?? undefined,
    brand:             r.brand             ?? undefined,
    product_line:      r.product_line      ?? undefined,
    family:            r.family            ?? undefined,
    sub_family:        r.sub_family        ?? undefined,
    price:             r.price             != null ? String(r.price)  : undefined,
    pvpr:              r.pvpr              != null ? String(r.pvpr)   : undefined,
    stock:             r.stock             != null ? String(r.stock)  : undefined,
    stock_status:      r.stock_status      ?? undefined,
    images:            r.images            ? JSON.parse(r.images)     : undefined,
    description:       r.description       ?? undefined,
    short_description: r.short_description ?? undefined,
    cor:               r.cor               ?? undefined,
    weight:            r.weight            != null ? r.weight         : undefined,
    part_number:       r.part_number       ?? undefined,
    manufacturer:      r.manufacturer      ?? undefined,
  })) as SupridesProduct[];
}

export function buildFamiliasFromProducts(all: SupridesProduct[]): FamiliaTree[] {
  const lineMap = new Map<string, Map<string, Set<string>>>();
  for (const p of all) {
    const line   = (p.product_line || '').trim();
    const family = (p.family       || '').trim();
    const sub    = (p.sub_family   || '').trim();
    if (!line || !family) continue;
    if (!lineMap.has(line)) lineMap.set(line, new Map());
    if (!lineMap.get(line)!.has(family)) lineMap.get(line)!.set(family, new Set());
    if (sub) lineMap.get(line)!.get(family)!.add(sub);
  }

  const result: FamiliaTree[] = [];
  for (const [product_line, familyMap] of lineMap) {
    const familias = [];
    for (const [family, subSet] of familyMap) {
      familias.push({ family, subfamilias: Array.from(subSet) });
    }
    result.push({ product_line, familias });
  }
  return result;
}
