/**
 * Compara o plano do dry-run (o que o sync devia fazer) com a loja real depois do sync.
 * Função pura — usada por scripts/sync-verify.ts e pelos testes.
 */
import type { SnapshotProduct } from '../suprides/api/shopify-read';
import type { SyncPlanItem } from '../suprides/routes/sync';

export type VerifyField = 'status' | 'price' | 'compareAtPrice' | 'cost' | 'collections' | 'exists' | 'created' | 'published';

export interface VerifyMismatch {
  sku: string;
  action: SyncPlanItem['action'];
  field: VerifyField;
  expected: unknown;
  actual: unknown;
}

export interface VerifyReport {
  checked: number;
  ok: number;
  byAction: Record<string, number>;
  mismatches: VerifyMismatch[];
  mismatchesByField: Record<string, number>;
  /** IDs de coleção do plano que não são numéricos (não verificáveis por ID). */
  unverifiableCollections: number;
}

const money = (v: string | null | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

export function verifyPlan(plan: SyncPlanItem[], after: SnapshotProduct[]): VerifyReport {
  const byId = new Map(after.map(p => [p.productId, p]));
  const bySku = new Map<string, SnapshotProduct>();
  for (const p of after) if (p.sku && !bySku.has(p.sku)) bySku.set(p.sku, p);

  const report: VerifyReport = {
    checked: 0, ok: 0, byAction: {}, mismatches: [], mismatchesByField: {}, unverifiableCollections: 0,
  };
  const miss = (it: SyncPlanItem, field: VerifyField, expected: unknown, actual: unknown) => {
    report.mismatches.push({ sku: it.sku, action: it.action, field, expected, actual });
    report.mismatchesByField[field] = (report.mismatchesByField[field] || 0) + 1;
  };

  for (const it of plan) {
    report.checked++;
    report.byAction[it.action] = (report.byAction[it.action] || 0) + 1;
    const before = report.mismatches.length;

    if (it.action === 'skip-new' || it.action === 'skip-no-cost') {
      // Não devia ter sido criado.
      const p = bySku.get(it.sku);
      if (p) miss(it, 'created', 'não criado', `produto ${p.productId}`);
    } else {
      const p = (it.shopifyProductId ? byId.get(it.shopifyProductId) : undefined) ?? bySku.get(it.sku);
      if (!p) {
        miss(it, 'exists', 'na loja', 'em falta');
      } else {
        const expStatus = (it.status || '').toUpperCase();
        if (expStatus && p.status !== expStatus) miss(it, 'status', expStatus, p.status);
        // Ativo mas fora da Loja online = invisível para os clientes. (Cópias antigas sem o campo não contam.)
        if (expStatus === 'ACTIVE' && p.status === 'ACTIVE' && p.publishedAt === null) miss(it, 'published', 'publicado', 'não publicado');

        if (it.action === 'update' || it.action === 'create') {
          if (money(it.price) !== money(p.price)) miss(it, 'price', it.price, p.price);
          if (money(it.compareAtPrice) !== money(p.compareAtPrice)) miss(it, 'compareAtPrice', it.compareAtPrice ?? null, p.compareAtPrice);
          if (it.cost != null && money(it.cost) !== money(p.cost)) miss(it, 'cost', it.cost, p.cost);
          const actual = new Set(p.collectionIds);
          const missing: string[] = [];
          for (const cid of it.collectionIds || []) {
            if (!/^\d+$/.test(cid)) { report.unverifiableCollections++; continue; }
            if (!actual.has(cid)) missing.push(cid);
          }
          if (missing.length) miss(it, 'collections', missing, p.collectionIds);
        }
      }
    }
    if (report.mismatches.length === before) report.ok++;
  }
  return report;
}
