/**
 * Cálculo das campanhas (puro, testável). Tudo em cêntimos inteiros para evitar erros de vírgula flutuante.
 *
 *   base         = preço fora de campanha (products.base_price, o que a loja tem)
 *   referência   = preço mais baixo praticado nos 30 dias anteriores, incluindo o atual (Omnibus)
 *   promocional  = base − desconto (% ou €), ARREDONDADO PARA BAIXO ao cêntimo
 *
 * Bloqueios (o produto não entra na promoção):
 *   SEM_PRECO     o sync não gere o preço (sem custo, fora do mapeamento) ou não está na loja
 *   SEM_DESCONTO  promocional ≥ referência: não há redução real face aos 30 dias
 *   PREJUIZO      promocional sem IVA < custo (venda com prejuízo)
 * Aviso (não bloqueia, decisão 19/11):
 *   HISTORICO_CURTO  menos de 30 dias de histórico de preços para o SKU
 */
export type DiscountType = 'PERCENT' | 'AMOUNT';
export interface Discount { type: DiscountType; value: number }
export type BlockReason = 'SEM_PRECO' | 'SEM_DESCONTO' | 'PREJUIZO';
export type Warning = 'HISTORICO_CURTO';

export const DAYS_REFERENCE = 30;
const DAY_MS = 86_400_000;

export const toCents = (v: number) => Math.round(v * 100);
const fromCents = (c: number) => c / 100;

/** Custo + IVA em cêntimos, por excesso (igual a applyRoundingNotBelow: 33,9972 → 3400). */
export function minPriceCents(cost: number, ivaRate: number): number {
  return Math.ceil(Math.round(cost * (1 + ivaRate / 100) * 1e6) / 1e4);
}

/** Preço promocional, arredondado para baixo ao cêntimo. Nunca negativo. */
export function promoPrice(base: number, d: Discount): number {
  const baseC = toCents(base);
  const c = d.type === 'PERCENT'
    // 1e-6: 19,99 × 0,9 = 17,991 não pode cair para 17,98 por vírgula flutuante
    ? Math.floor(baseC * (100 - d.value) / 100 + 1e-6)
    : baseC - toCents(d.value);
  return fromCents(Math.max(0, c));
}

export interface ValidRange {
  /** Desconto mínimo para o promocional ficar abaixo da referência. */
  minAmount: number; maxAmount: number;
  /** O mesmo em % do preço base (aproximado a 2 casas, para mostrar). */
  minPercent: number; maxPercent: number;
}

export interface ProductInput {
  /** products.base_price (null = o sync não gere o preço). */
  base: number | null;
  cost: number | null;
  /** Preço mais baixo dos 30 dias (null = sem histórico). */
  reference: number | null;
  /** Data do primeiro registo do SKU no histórico (null = sem histórico). */
  firstRecordedAt: Date | null;
  /** O produto existe na loja. */
  inShop: boolean;
}

export interface ProductEvaluation {
  state: 'INCLUIDO' | 'BLOQUEADO';
  blockReason: BlockReason | null;
  warning: Warning | null;
  base: number | null;
  reference: number | null;
  promo: number | null;
  /** Intervalo de desconto válido (null = sem promoção possível). */
  range: ValidRange | null;
}

/** Avalia um produto numa campanha com início em `at`. */
export function evaluateProduct(p: ProductInput, d: Discount, ivaRate: number, at: Date): ProductEvaluation {
  if (p.base == null || p.base <= 0 || !p.inShop || p.cost == null || p.cost <= 0) {
    return { state: 'BLOQUEADO', blockReason: 'SEM_PRECO', warning: null, base: p.base, reference: p.reference, promo: null, range: null };
  }
  const shortHistory = !p.firstRecordedAt || p.firstRecordedAt.getTime() > at.getTime() - DAYS_REFERENCE * DAY_MS;
  const warning: Warning | null = shortHistory ? 'HISTORICO_CURTO' : null;
  // Sem histórico, a referência é o preço atual (o mais baixo conhecido).
  const reference = p.reference ?? p.base;
  const refC = toCents(Math.min(reference, p.base));
  const baseC = toCents(p.base);
  const minC = minPriceCents(p.cost, ivaRate);
  const promo = promoPrice(p.base, d);
  const promoC = toCents(promo);

  const maxPromoC = refC - 1;                 // tem de ficar pelo menos 1 cêntimo abaixo da referência
  const range: ValidRange | null = minC <= maxPromoC
    ? {
        minAmount: fromCents(baseC - maxPromoC), maxAmount: fromCents(baseC - minC),
        minPercent: Math.ceil((baseC - maxPromoC) / baseC * 10000) / 100,
        maxPercent: Math.floor((baseC - minC) / baseC * 10000) / 100,
      }
    : null;

  let blockReason: BlockReason | null = null;
  if (promoC > maxPromoC) blockReason = 'SEM_DESCONTO';
  else if (promoC < minC) blockReason = 'PREJUIZO';
  return {
    state: blockReason ? 'BLOQUEADO' : 'INCLUIDO', blockReason, warning,
    base: p.base, reference: fromCents(refC), promo, range,
  };
}

/** Preço a cobrar durante a campanha: o menor entre o promocional fixado e o preço base atual. */
export function effectivePrice(promo: number, currentBase: number | null): number {
  return currentBase != null && currentBase > 0 ? Math.min(promo, currentBase) : promo;
}

/**
 * Preço e preço riscado a enviar para um produto em promoção. Se o preço a cobrar já não ficar
 * abaixo da referência (ex.: o base desceu muito), não se mostra preço riscado.
 */
export function promoShopPrices(promo: number, reference: number, currentBase: number | null): { price: number; compareAtPrice: number | null } {
  const price = effectivePrice(promo, currentBase);
  return { price, compareAtPrice: toCents(price) < toCents(reference) ? reference : null };
}

/** O promocional fixado passou a dar prejuízo (o custo subiu depois do início). */
export function isLossMaking(promo: number, cost: number, ivaRate: number): boolean {
  return toCents(promo) < minPriceCents(cost, ivaRate);
}
