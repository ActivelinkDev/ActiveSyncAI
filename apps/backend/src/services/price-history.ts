/**
 * Histórico do preço praticado na loja (regra dos 30 dias — Omnibus).
 *
 * Regista o preço que o cliente VÊ, lido da Shopify depois de cada sync (não o calculado):
 * se o sync não correr, o preço da loja não mudou e não há registo. Nunca é apagado.
 *
 *   price_current  — último preço conhecido de cada SKU
 *   price_history  — uma linha por mudança (preço ou preço riscado)
 */
import { sql } from 'kysely';
import { getMssql, mssqlConfigured } from '../db/mssql';
import { migrateMssql } from '../db/mssql-migrations';
import { readAllProducts, type SnapshotProduct } from '../suprides/api/shopify-read';
import { logLine } from '../utils/logger';
import { sendAlert } from './alerts';

export type PriceSource = 'INITIAL' | 'SNAPSHOT' | 'SYNC' | 'RESTORE' | 'CAMPAIGN' | 'CAMPAIGN_END';

export interface CurrentPrice { price: number; compareAt: number | null }
/** Origem por SKU (campanhas): sobrepõe-se à fonte geral da gravação. */
export type PriceAttribution = Map<string, { source: PriceSource; campaignId: number | null }>;
export interface PriceChange {
  sku: string; productId: number | null; status: string | null;
  oldPrice: number | null; newPrice: number; oldCompareAt: number | null; newCompareAt: number | null;
}

const toMoney = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) ? n : null;
};

/**
 * Compara a loja com o último preço conhecido (puro, testável).
 * SKU repetido na loja: conta o primeiro (como o sync). Produtos sem SKU ou sem preço ficam de fora.
 */
export function diffPrices(current: Map<string, CurrentPrice>, products: SnapshotProduct[]): PriceChange[] {
  const seen = new Set<string>();
  const out: PriceChange[] = [];
  for (const p of products) {
    const sku = p.sku?.trim();
    const price = toMoney(p.price);
    if (!sku || price === null || seen.has(sku)) continue;
    seen.add(sku);
    const compareAt = toMoney(p.compareAtPrice);
    const cur = current.get(sku);
    if (cur && cur.price === price && cur.compareAt === compareAt) continue;
    out.push({
      sku, productId: p.productId ?? null, status: p.status ?? null,
      oldPrice: cur?.price ?? null, newPrice: price,
      oldCompareAt: cur?.compareAt ?? null, newCompareAt: compareAt,
    });
  }
  return out;
}

/**
 * Preço mais baixo praticado nos 30 dias anteriores a `at` (inclui o preço em vigor no início
 * da janela e o atual). `rows` = histórico desse SKU por ordem de data. Puro, testável.
 */
export function lowestInWindow(rows: { newPrice: number; changedAt: Date }[], at: Date, days = 30): number | null {
  const from = at.getTime() - days * 86_400_000;
  let inForceAtStart: number | null = null;
  let min: number | null = null;
  for (const r of rows) {
    const t = r.changedAt.getTime();
    if (t > at.getTime()) break;
    if (t <= from) { inForceAtStart = r.newPrice; continue; }
    min = min === null ? r.newPrice : Math.min(min, r.newPrice);
  }
  const candidates = [inForceAtStart, min].filter((v): v is number => v !== null);
  return candidates.length ? Math.min(...candidates) : null;
}

let migrated = false;
async function ready() {
  if (!migrated) { await migrateMssql(); migrated = true; }
  return getMssql();
}

/** Data do registo mais recente no histórico (ou null se vazio). */
export async function lastRecordedAt(): Promise<Date | null> {
  const db = await ready();
  const r: any = await db.selectFrom('price_history').select(sql`MAX(changed_at)`.as('m')).executeTakeFirst();
  return r?.m ? new Date(r.m) : null;
}

async function loadCurrent(): Promise<Map<string, CurrentPrice>> {
  const db = await ready();
  const rows = await db.selectFrom('price_current').select(['sku', 'price', 'compare_at_price']).execute();
  return new Map(rows.map((r: any) => [r.sku, { price: toMoney(r.price)!, compareAt: toMoney(r.compare_at_price) }]));
}

/**
 * Regista as mudanças de preço da loja. `first` = true na primeira vez (fonte INITIAL).
 * Devolve o número de mudanças gravadas. Sem SQL Server configurado, não faz nada.
 */
export async function recordShopPrices(
  products: SnapshotProduct[], at: Date, source: PriceSource, attribution?: PriceAttribution,
): Promise<{ changes: number; skipped?: string }> {
  if (!mssqlConfigured()) return { changes: 0, skipped: 'SQL Server não configurado' };
  // Nunca gravar "para trás": uma leitura mais antiga do que o último registo inventaria mudanças.
  const last = await lastRecordedAt();
  if (last && at.getTime() <= last.getTime()) return { changes: 0, skipped: `leitura de ${at.toISOString()} é anterior ao último registo (${last.toISOString()})` };
  const current = await loadCurrent();
  const changes = diffPrices(current, products);
  if (!changes.length) return { changes: 0 };
  const db = await ready();
  const when = at.toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);

  await db.transaction().execute(async trx => {
    // SQL Server aceita até 2100 parâmetros por pedido: 150 linhas × 11 colunas.
    for (let i = 0; i < changes.length; i += 150) {
      const chunk = changes.slice(i, i + 150);
      await trx.insertInto('price_history').values(chunk.map(c => ({
        sku: c.sku, shopify_product_id: c.productId,
        old_price: c.oldPrice, new_price: c.newPrice,
        old_compare_at_price: c.oldCompareAt, new_compare_at_price: c.newCompareAt,
        status: c.status,
        source: attribution?.get(c.sku)?.source ?? (current.size === 0 ? 'INITIAL' : source),
        campaign_id: attribution?.get(c.sku)?.campaignId ?? null,
        changed_at: when,
      }))).execute();
    }
    // Atualiza price_current (MERGE por SKU), em blocos.
    for (let i = 0; i < changes.length; i += 250) {
      const chunk = changes.slice(i, i + 250);
      const values = sql.join(chunk.map(c =>
        sql`(${c.sku}, ${c.productId}, ${c.newPrice}, ${c.newCompareAt}, ${c.status}, ${when})`));
      await sql`
        MERGE price_current AS t
        USING (VALUES ${values}) AS s (sku, shopify_product_id, price, compare_at_price, status, updated_at)
        ON t.sku = s.sku
        WHEN MATCHED THEN UPDATE SET shopify_product_id = s.shopify_product_id,
          price = s.price, compare_at_price = s.compare_at_price, status = s.status, updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT (sku, shopify_product_id, price, compare_at_price, status, updated_at)
          VALUES (s.sku, s.shopify_product_id, s.price, s.compare_at_price, s.status, s.updated_at);
      `.execute(trx);
    }
  });
  return { changes: changes.length };
}

/**
 * Lê a loja e regista as mudanças de preço. Chamar depois de QUALQUER escrita de preços na loja
 * (sync completo, mesmo cancelado ou com erros; reposição). Nunca lança: uma falha só gera alerta,
 * para não estragar o resultado de quem escreveu. `search` = filtro da Shopify (ex.: só alguns SKUs).
 */
export async function recordPricesFromShop(
  source: PriceSource, context: string, search?: string, attribution?: () => Promise<PriceAttribution>,
): Promise<void> {
  try {
    const products = await readAllProducts(undefined, search);
    const r = await recordShopPrices(products, new Date(), source, attribution ? await attribution() : undefined);
    logLine(r.skipped
      ? `[Preços] Histórico não gravado (${context}): ${r.skipped}`
      : `[Preços] Histórico (${context}): ${r.changes} mudança(s) registada(s)`);
  } catch (e: any) {
    logLine(`[Preços] FALHOU o registo do histórico (${context}): ${e?.message ?? e}`);
    await sendAlert('price-history', 'Histórico de preços não foi gravado',
      `Houve escritas de preços na loja (${context}), mas não foi possível registá-las no SQL Server.
Sem este registo, a regra dos 30 dias fica com falhas.

Erro: ${e?.message ?? e}`);
  }
}

/** Preço mais baixo dos últimos 30 dias de um SKU (para as campanhas). */
export async function lowestPrice30d(sku: string, at = new Date()): Promise<number | null> {
  const db = await ready();
  const rows = await db.selectFrom('price_history').select(['new_price', 'changed_at'])
    .where('sku', '=', sku).orderBy('changed_at').orderBy('id').execute();
  return lowestInWindow(rows.map((r: any) => ({ newPrice: Number(r.new_price), changedAt: new Date(r.changed_at) })), at);
}

export interface ReferenceInfo {
  /** Preço mais baixo nos 30 dias anteriores a `at` (inclui o em vigor). null = sem histórico. */
  reference: number | null;
  /** Primeiro registo do SKU (para o aviso de histórico curto). */
  firstRecordedAt: Date | null;
}

/** Referência dos 30 dias para vários SKUs de uma vez (campanhas). */
export async function referencesFor(skus: string[], at: Date, days = 30): Promise<Map<string, ReferenceInfo>> {
  const out = new Map<string, ReferenceInfo>();
  if (!skus.length) return out;
  const db = await ready();
  const bySku = new Map<string, { newPrice: number; changedAt: Date }[]>();
  for (let i = 0; i < skus.length; i += 1000) {
    const rows = await db.selectFrom('price_history').select(['sku', 'new_price', 'changed_at'])
      .where('sku', 'in', skus.slice(i, i + 1000)).where('changed_at', '<=', at)
      .orderBy('sku').orderBy('changed_at').orderBy('id').execute();
    for (const r of rows as any[]) {
      if (!bySku.has(r.sku)) bySku.set(r.sku, []);
      bySku.get(r.sku)!.push({ newPrice: Number(r.new_price), changedAt: new Date(r.changed_at) });
    }
  }
  for (const sku of skus) {
    const rows = bySku.get(sku) ?? [];
    out.set(sku, { reference: lowestInWindow(rows, at, days), firstRecordedAt: rows[0]?.changedAt ?? null });
  }
  return out;
}
