import type { PriceMode, Rounding } from '../types';

export function normalizeMoney(input: unknown): string {
  if (input == null) return '0.00';
  let s = String(input).trim().replace(/[^\d.,]/g, '');
  // Com os dois separadores, o último é o decimal: "1,234.56" (EN) ou "1.234,56" (PT).
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  }
  else if (s.includes(',') && !s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  return s;
}

export function applyMargin(price: number, mode: PriceMode, marginValue: number): number {
  if (!marginValue) return price;
  if (mode === 'percentage') return price / (1 - marginValue / 100);
  if (mode === 'fixed')      return price + marginValue;
  return price;
}

export function applyRounding(price: number, _rounding?: Rounding): number {
  const floor = Math.floor(price);
  // Em cêntimos inteiros: 12.49 - 12 dá 0.49000000000000021 em vírgula flutuante.
  const cents = Math.round((price - floor) * 100);
  if (price < 50) return cents <= 49 ? floor + 0.49 : floor + 0.99;
  return floor + 0.90;
}

/** Euros → cêntimos inteiros (sem erros de vírgula flutuante: 33.9972 → 3400 com ceil). */
const toCents = (v: number) => Math.round(v * 100);

/** Patamar de arredondamento seguinte acima de um preço já arredondado (,49 → ,99 → ,49…; ≥ 50 € → ,90 seguinte). */
function nextRoundingStep(rounded: number): number {
  const floor = Math.floor(rounded);
  if (rounded < 50 && toCents(rounded - floor) === 49) return floor + 0.99;
  return applyRounding(floor + 1);
}

/**
 * Arredonda como applyRounding, mas nunca abaixo de `minPrice` (custo + IVA): vender abaixo do
 * custo é proibido. Se o arredondamento descer abaixo do mínimo, sobe para o patamar seguinte.
 * O mínimo conta ao cêntimo, por excesso (27,64 × 1,23 = 33,9972 → 34,00).
 */
export function applyRoundingNotBelow(price: number, minPrice: number, rounding?: Rounding): number {
  const minCents = Math.ceil(Math.round(minPrice * 1e6) / 1e4);
  let r = applyRounding(Math.max(price, 0), rounding);
  for (let i = 0; i < 1000 && toCents(r) < minCents; i++) r = nextRoundingStep(r);
  return r;
}

export function slug(str: string): string {
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 255);
}
