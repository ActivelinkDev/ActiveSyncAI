import { getAllProducts as getSqliteProducts, countProducts } from '../../repositories/esprinet-cache';
import type { SupridesProduct, FamiliaTree } from '../../suprides/types';

export async function getAllProducts(_force = false): Promise<SupridesProduct[]> {
  if (countProducts() <= 0) return [];
  const rows = getSqliteProducts(100_000);
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
  const lineMap = new Map<string, Set<string>>();
  for (const p of all) {
    const line = (p.product_line || '').trim();
    const family = (p.family || '').trim();
    if (!line || !family) continue;
    if (!lineMap.has(line)) lineMap.set(line, new Set());
    lineMap.get(line)!.add(family);
  }

  return Array.from(lineMap.entries()).map(([product_line, families]) => ({
    product_line,
    familias: Array.from(families).sort().map(family => ({ family, subfamilias: [] })),
  })).sort((a, b) => a.product_line.localeCompare(b.product_line));
}
