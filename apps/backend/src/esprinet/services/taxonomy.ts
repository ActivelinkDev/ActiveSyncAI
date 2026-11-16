import { getAllProducts } from './products-cache';
import type { SupridesProduct } from '../../suprides/types';

export interface EsprinetTaxonomy {
  products: SupridesProduct[];
  productLines: Set<string>;
  families: Set<string>;
  subFamilies: Set<string>;
  warnings: string[];
}

export function normTaxonomyValue(value: unknown): string {
  return String(value || '').trim();
}

export async function loadEsprinetTaxonomy(): Promise<EsprinetTaxonomy> {
  const products = await getAllProducts(false);
  const productLines = new Set<string>();
  const families = new Set<string>();

  for (const p of products) {
    const line = normTaxonomyValue(p.product_line);
    const fam = normTaxonomyValue(p.family);
    if (line) productLines.add(line);
    if (fam) families.add(fam);
  }

  return {
    products,
    productLines,
    families,
    subFamilies: new Set<string>(),
    warnings: ['Taxonomia Esprinet derivada da tabela esprinet_products.'],
  };
}
