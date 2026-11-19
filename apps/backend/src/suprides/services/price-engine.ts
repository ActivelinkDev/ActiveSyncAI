/**
 * Motor de preço: preço base de um produto (fora de campanha), a partir do custo do fornecedor.
 *
 *   margem = regra da coleção mais profunda do produto (collection_margins)
 *   base   = custo com margem × (1 + IVA), arredondado (,49/,99; ,90 a partir de 50 €)
 *            e nunca abaixo de custo + IVA (venda com prejuízo)
 *
 * Puro e partilhado: o sync usa-o para o preço que envia, e as campanhas partem do mesmo valor
 * (gravado em products.base_price em cada sync real). As coleções do produto são resolvidas
 * pelo sync (dependem do mapeamento e do estado da loja) e chegam aqui já prontas.
 */
import { applyMargin, applyRoundingNotBelow } from './price-calc';
import { collectionLevel, type CollectionHierarchy } from '../routes/sync-helpers';
import type { CollectionMarginRule, CollectionMargins, Rounding } from '../types';

export interface PriceContext {
  margins: CollectionMargins;
  hierarchyById: Map<string, CollectionHierarchy>;
  /** Taxa de IVA em % (ex.: 23). */
  ivaRate: number;
  rounding?: Rounding;
}

export interface BasePrice {
  /** Custo do fornecedor (sem IVA). */
  cost: number;
  /** Regra de margem aplicada (null = sem regra: vende a custo + IVA, arredondado para cima). */
  rule: CollectionMarginRule | null;
  /** Preço de venda com IVA, arredondado. */
  price: number;
  /** Custo + IVA (abaixo disto é venda com prejuízo). */
  minPrice: number;
}

export const ivaMultiplierOf = (ivaRate: number | undefined) => 1 + ((ivaRate ?? 23) / 100);

/** Regra de margem da coleção mais profunda que tenha margem > 0. */
export function findCollectionMargin(
  collIds: string[],
  margins: CollectionMargins,
  hierarchyById: Map<string, CollectionHierarchy>,
): CollectionMarginRule | null {
  const sorted = [...collIds].sort((a, b) => collectionLevel(b, hierarchyById) - collectionLevel(a, hierarchyById));
  for (const id of sorted) {
    const r = margins.rules[id];
    if (r && r.marginValue > 0) return r;
  }
  return null;
}

/** Texto curto da regra (planos do dry-run, products.base_margin_rule). */
export const marginRuleLabel = (rule: CollectionMarginRule | null): string | null =>
  rule ? `${rule.mode}:${rule.marginValue}` : null;

/** Preço base de um produto com custo > 0 e as coleções já resolvidas. */
export function computeBasePrice(cost: number, collectionIds: string[], ctx: PriceContext): BasePrice {
  const iva = ivaMultiplierOf(ctx.ivaRate);
  const rule = findCollectionMargin(collectionIds, ctx.margins, ctx.hierarchyById);
  const net = rule ? applyMargin(cost, rule.mode, rule.marginValue) : cost;
  const minPrice = cost * iva;
  return { cost, rule, price: applyRoundingNotBelow(net * iva, minPrice, ctx.rounding), minPrice };
}
