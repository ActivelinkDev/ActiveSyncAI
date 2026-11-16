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

export function slug(str: string): string {
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 255);
}
