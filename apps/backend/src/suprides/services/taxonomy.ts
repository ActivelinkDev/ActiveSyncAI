import { getAllProducts } from './products-cache';
import type { SupridesProduct } from '../types';

export interface SupridesTaxonomy {
  products: SupridesProduct[];
  productLines: Set<string>;
  families: Set<string>;
  subFamilies: Set<string>;
  warnings: string[];
}

export function normTaxonomyValue(value: unknown): string {
  return String(value || '').trim();
}

export async function loadSupridesTaxonomy(): Promise<SupridesTaxonomy> {
  const products = await getAllProducts(false);
  const productLines = new Set<string>();
  const families = new Set<string>();
  const subFamilies = new Set<string>();

  for (const p of products) {
    const line = normTaxonomyValue(p.product_line);
    const fam = normTaxonomyValue(p.family);
    const sub = normTaxonomyValue(p.sub_family);
    if (line) productLines.add(line);
    if (fam) families.add(fam);
    if (sub) subFamilies.add(sub);
  }

  return {
    products,
    productLines,
    families,
    subFamilies,
    warnings: [
      'Taxonomia derivada dos produtos disponíveis em cache/API; valores válidos sem produtos neste momento podem aparecer como unknown.',
    ],
  };
}
