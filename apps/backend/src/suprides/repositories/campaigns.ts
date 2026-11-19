/**
 * Campanhas (promoções com a regra dos 30 dias) no SQL Server.
 *
 * Estados: RASCUNHO → AGENDADA → ATIVA → TERMINADA / CANCELADA.
 * - Só um rascunho se edita (dados, produtos). Exceções por produto: rascunho ou agendada.
 * - Agendar verifica que nenhum produto está noutra campanha agendada/ativa com datas sobrepostas.
 * - No início, os valores de cada produto ficam fixados (base, referência dos 30 dias, promocional,
 *   custo) e o estado de cada produto passa a INCLUIDO ou BLOQUEADO.
 * - Nunca altera products.base_price: a campanha é uma camada por cima.
 * - "Em promoção" = campanha ATIVA e produto INCLUIDO. O temporizador (services/campaign-ticker)
 *   envia e repõe preços na loja e marca applied_at / reverted_at.
 */
import { sql, type Kysely } from 'kysely';
import { getMssql } from '../../db/mssql';
import { loadAdminSettings } from './store';
import { referencesFor, type PriceAttribution } from '../../services/price-history';
import {
  evaluateProduct, effectivePrice, isLossMaking,
  type Discount, type DiscountType, type ProductEvaluation,
} from '../services/campaign-calc';

export type CampaignStatus = 'RASCUNHO' | 'AGENDADA' | 'ATIVA' | 'TERMINADA' | 'CANCELADA';

export interface CampaignInput {
  name: string;
  discountType: DiscountType;
  discountValue: number;
  startsAt: Date;
  endsAt: Date;
  notes?: string | null;
}

export interface Campaign extends Required<CampaignInput> {
  id: number;
  status: CampaignStatus;
  createdAt: Date;
  scheduledAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface CampaignProductRow {
  sku: string;
  state: 'INCLUIDO' | 'BLOQUEADO' | 'RETIRADO';
  blockReason: string | null;
  warning: string | null;
  override: Discount | null;
  basePrice: number | null;
  referencePrice: number | null;
  promoPrice: number | null;
  costAtStart: number | null;
  appliedAt: Date | null;
  revertedAt: Date | null;
  removedAt: Date | null;
  removedReason: string | null;
}

export class CampaignError extends Error {
  constructor(message: string, public code: 'NOT_FOUND' | 'INVALID' | 'CONFLICT', public details?: unknown) {
    super(message);
  }
}

type Db = Kysely<any>;
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const date = (v: unknown): Date | null => (v == null ? null : new Date(v as string));

function toCampaign(r: any): Campaign {
  return {
    id: r.id, name: r.name, status: r.status,
    discountType: r.discount_type, discountValue: Number(r.discount_value),
    startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at), notes: r.notes ?? null,
    createdAt: new Date(r.created_at), scheduledAt: date(r.scheduled_at),
    startedAt: date(r.started_at), endedAt: date(r.ended_at),
  };
}

function toProductRow(r: any): CampaignProductRow {
  return {
    sku: r.sku, state: r.state, blockReason: r.block_reason ?? null, warning: r.warning ?? null,
    override: r.override_type ? { type: r.override_type, value: Number(r.override_value) } : null,
    basePrice: num(r.base_price), referencePrice: num(r.reference_price), promoPrice: num(r.promo_price),
    costAtStart: num(r.cost_at_start), appliedAt: date(r.applied_at), revertedAt: date(r.reverted_at),
    removedAt: date(r.removed_at), removedReason: r.removed_reason ?? null,
  };
}

export function validateDiscount(d: Discount): void {
  if (d.type !== 'PERCENT' && d.type !== 'AMOUNT') throw new CampaignError('Tipo de desconto inválido (PERCENT ou AMOUNT).', 'INVALID');
  if (!Number.isFinite(d.value) || d.value <= 0) throw new CampaignError('O desconto tem de ser maior que zero.', 'INVALID');
  if (d.type === 'PERCENT' && d.value >= 100) throw new CampaignError('O desconto em % tem de ser menor que 100.', 'INVALID');
  if (Math.abs(d.value * 100 - Math.round(d.value * 100)) > 1e-6) {
    throw new CampaignError('O desconto tem no máximo 2 casas decimais.', 'INVALID');
  }
}

function validateInput(i: CampaignInput): void {
  const name = (i.name ?? '').trim();
  if (!name || name.length > 200) throw new CampaignError('O nome é obrigatório (máx. 200 caracteres).', 'INVALID');
  validateDiscount({ type: i.discountType, value: i.discountValue });
  if (!(i.startsAt instanceof Date) || isNaN(i.startsAt.getTime()) || !(i.endsAt instanceof Date) || isNaN(i.endsAt.getTime())) {
    throw new CampaignError('Datas inválidas.', 'INVALID');
  }
  if (i.endsAt.getTime() <= i.startsAt.getTime()) throw new CampaignError('O fim tem de ser depois do início.', 'INVALID');
  if ((i.notes ?? '').length > 1000) throw new CampaignError('Notas com mais de 1000 caracteres.', 'INVALID');
}

async function loadCampaignRow(db: Db, id: number): Promise<Campaign> {
  const r = await db.selectFrom('campaigns').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw new CampaignError(`Campanha ${id} não existe.`, 'NOT_FOUND');
  return toCampaign(r);
}

function requireStatus(c: Campaign, allowed: CampaignStatus[], action: string): void {
  if (!allowed.includes(c.status)) {
    throw new CampaignError(`Não é possível ${action} uma campanha ${c.status.toLowerCase()}.`, 'INVALID');
  }
}

// ── Leitura ──────────────────────────────────────────────────────────────────

export interface CampaignSummary extends Campaign { products: number; included: number; blocked: number; withdrawn: number }

export async function listCampaigns(db: Db = getMssql()): Promise<CampaignSummary[]> {
  const rows = await sql<any>`
    SELECT c.*, COUNT(cp.sku) AS products,
      SUM(CASE WHEN cp.state = 'INCLUIDO' THEN 1 ELSE 0 END) AS included,
      SUM(CASE WHEN cp.state = 'BLOQUEADO' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN cp.state = 'RETIRADO' THEN 1 ELSE 0 END) AS withdrawn
    FROM campaigns c LEFT JOIN campaign_products cp ON cp.campaign_id = c.id
    GROUP BY c.id, c.name, c.status, c.discount_type, c.discount_value, c.starts_at, c.ends_at, c.notes,
             c.created_at, c.scheduled_at, c.started_at, c.ended_at
    ORDER BY c.starts_at DESC, c.id DESC`.execute(db);
  return rows.rows.map(r => ({
    ...toCampaign(r), products: Number(r.products ?? 0), included: Number(r.included ?? 0),
    blocked: Number(r.blocked ?? 0), withdrawn: Number(r.withdrawn ?? 0),
  }));
}

export async function getCampaign(id: number, db: Db = getMssql()): Promise<Campaign & { products: CampaignProductRow[] }> {
  const c = await loadCampaignRow(db, id);
  const rows = await db.selectFrom('campaign_products').selectAll().where('campaign_id', '=', id).orderBy('sku').execute();
  return { ...c, products: rows.map(toProductRow) };
}

// ── Edição ───────────────────────────────────────────────────────────────────

export async function createCampaign(i: CampaignInput, db: Db = getMssql()): Promise<number> {
  validateInput(i);
  const r = await db.insertInto('campaigns').values({
    name: i.name.trim(), discount_type: i.discountType, discount_value: i.discountValue,
    starts_at: i.startsAt, ends_at: i.endsAt, notes: i.notes?.trim() || null,
  }).output('inserted.id').executeTakeFirstOrThrow();
  return Number((r as any).id);
}

export async function updateCampaign(id: number, i: CampaignInput, db: Db = getMssql()): Promise<void> {
  validateInput(i);
  const c = await loadCampaignRow(db, id);
  requireStatus(c, ['RASCUNHO'], 'editar');
  await db.updateTable('campaigns').set({
    name: i.name.trim(), discount_type: i.discountType, discount_value: i.discountValue,
    starts_at: i.startsAt, ends_at: i.endsAt, notes: i.notes?.trim() || null,
  }).where('id', '=', id).execute();
}

export async function deleteCampaign(id: number, db: Db = getMssql()): Promise<void> {
  const c = await loadCampaignRow(db, id);
  requireStatus(c, ['RASCUNHO'], 'apagar');
  await db.deleteFrom('campaigns').where('id', '=', id).execute();
}

/**
 * Define os produtos de um rascunho (substitui a lista; mantém as exceções dos que ficam).
 * Devolve os SKUs desconhecidos (não entram).
 */
export async function setCampaignProducts(id: number, skus: string[], db: Db = getMssql()): Promise<{ count: number; unknown: string[] }> {
  const wanted = [...new Set(skus.map(s => String(s).trim()).filter(Boolean))];
  return db.transaction().execute(async trx => {
    const c = await loadCampaignRow(trx, id);
    requireStatus(c, ['RASCUNHO'], 'mudar os produtos de');
    const known = new Set<string>();
    for (let i = 0; i < wanted.length; i += 1000) {
      const rows = await trx.selectFrom('products').select('sku').where('sku', 'in', wanted.slice(i, i + 1000)).execute();
      for (const r of rows) known.add(r.sku);
    }
    const keep = wanted.filter(s => known.has(s));
    const current = new Set((await trx.selectFrom('campaign_products').select('sku').where('campaign_id', '=', id).execute()).map(r => r.sku));
    const keepSet = new Set(keep);
    const remove = [...current].filter(s => !keepSet.has(s));
    for (let i = 0; i < remove.length; i += 1000) {
      await trx.deleteFrom('campaign_products').where('campaign_id', '=', id).where('sku', 'in', remove.slice(i, i + 1000)).execute();
    }
    const add = keep.filter(s => !current.has(s));
    for (let i = 0; i < add.length; i += 500) {
      await trx.insertInto('campaign_products').values(add.slice(i, i + 500).map(sku => ({ campaign_id: id, sku }))).execute();
    }
    return { count: keep.length, unknown: wanted.filter(s => !known.has(s)) };
  });
}

/** Exceção por produto (outro desconto) ou null para voltar ao desconto da campanha. */
export async function setProductOverride(id: number, sku: string, override: Discount | null, db: Db = getMssql()): Promise<void> {
  if (override) validateDiscount(override);
  const c = await loadCampaignRow(db, id);
  requireStatus(c, ['RASCUNHO', 'AGENDADA'], 'mudar exceções de');
  const r = await db.updateTable('campaign_products')
    .set({ override_type: override?.type ?? null, override_value: override?.value ?? null })
    .where('campaign_id', '=', id).where('sku', '=', sku).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw new CampaignError(`O produto ${sku} não está nesta campanha.`, 'NOT_FOUND');
}

// ── Avaliação (pré-visualização e início) ────────────────────────────────────

export interface EvaluatedProduct extends ProductEvaluation {
  sku: string;
  cost: number | null;
  discount: Discount;
  override: Discount | null;
}

async function evaluateItems(db: Db, c: Campaign, items: { sku: string; override: Discount | null }[], at: Date): Promise<EvaluatedProduct[]> {
  if (!items.length) return [];
  const { ivaRate } = await loadAdminSettings();
  const skus = items.map(i => i.sku);
  const products = new Map<string, any>();
  for (let i = 0; i < skus.length; i += 1000) {
    const rows = await db.selectFrom('products')
      .select(['sku', 'cost', 'base_price', 'shopify_product_id', 'shopify_variant_id'])
      .where('sku', 'in', skus.slice(i, i + 1000)).execute();
    for (const r of rows) products.set(r.sku, r);
  }
  const refs = await referencesFor(skus, at);
  return items.map(it => {
    const p = products.get(it.sku);
    const discount = it.override ?? { type: c.discountType, value: c.discountValue };
    const ref = refs.get(it.sku);
    const cost = num(p?.cost);
    const e = evaluateProduct({
      base: num(p?.base_price), cost, reference: ref?.reference ?? null,
      firstRecordedAt: ref?.firstRecordedAt ?? null,
      inShop: !!(p?.shopify_product_id && p?.shopify_variant_id),
    }, discount, ivaRate ?? 23, at);
    return { sku: it.sku, cost, discount, override: it.override, ...e };
  });
}

/** Pré-visualização com os preços de hoje, contando os 30 dias até ao início (ou até agora, se já passou). */
export async function previewCampaign(id: number, now = new Date(), db: Db = getMssql()): Promise<EvaluatedProduct[]> {
  const c = await getCampaign(id, db);
  const at = c.startsAt.getTime() > now.getTime() ? c.startsAt : now;
  return evaluateItems(db, c, c.products.map(p => ({ sku: p.sku, override: p.override })), at);
}

// ── Ciclo de vida ────────────────────────────────────────────────────────────

const OVERLAP_LOCK = sql`DECLARE @r int;
  EXEC @r = sys.sp_getapplock @Resource = N'ActiveSyncAI.campaigns', @LockMode = 'Exclusive',
    @LockOwner = 'Transaction', @LockTimeout = 30000, @DbPrincipal = 'public';
  IF @r < 0 THROW 51010, 'Não foi possível obter o bloqueio das campanhas.', 1;`;

/** Rascunho → agendada. Recusa se algum produto estiver noutra campanha agendada/ativa com datas sobrepostas. */
export async function scheduleCampaign(id: number, now = new Date(), db: Db = getMssql()): Promise<void> {
  await db.transaction().execute(async trx => {
    await OVERLAP_LOCK.execute(trx);
    const c = await loadCampaignRow(trx, id);
    requireStatus(c, ['RASCUNHO'], 'agendar');
    if (c.endsAt.getTime() <= now.getTime()) throw new CampaignError('A campanha já terminou (data de fim no passado).', 'INVALID');
    const n = await trx.selectFrom('campaign_products').select(sql<number>`COUNT(*)`.as('n')).where('campaign_id', '=', id).executeTakeFirst();
    if (!Number((n as any)?.n)) throw new CampaignError('A campanha não tem produtos.', 'INVALID');
    const conflicts = await sql<{ sku: string; campaign_id: number; name: string }>`
      SELECT TOP 50 cp.sku, c.id AS campaign_id, c.name
      FROM campaign_products cp JOIN campaigns c ON c.id = cp.campaign_id
      WHERE c.status IN ('AGENDADA', 'ATIVA') AND c.id <> ${id}
        AND cp.state = 'INCLUIDO'
        AND c.starts_at < ${c.endsAt} AND c.ends_at > ${c.startsAt}
        AND cp.sku IN (SELECT sku FROM campaign_products WHERE campaign_id = ${id})
      ORDER BY cp.sku`.execute(trx);
    if (conflicts.rows.length) {
      throw new CampaignError(
        `${conflicts.rows.length >= 50 ? '50 ou mais' : conflicts.rows.length} produto(s) já estão noutra campanha nas mesmas datas.`,
        'CONFLICT', conflicts.rows);
    }
    await trx.updateTable('campaigns').set({ status: 'AGENDADA', scheduled_at: now }).where('id', '=', id).execute();
  });
}

/** Agendada → rascunho (para voltar a editar). */
export async function unscheduleCampaign(id: number, db: Db = getMssql()): Promise<void> {
  const c = await loadCampaignRow(db, id);
  requireStatus(c, ['AGENDADA'], 'desagendar');
  await db.updateTable('campaigns').set({ status: 'RASCUNHO', scheduled_at: null }).where('id', '=', id).where('status', '=', 'AGENDADA').execute();
}

/** Cancela (rascunho, agendada ou ativa). Numa ativa, o temporizador repõe os preços base. */
export async function cancelCampaign(id: number, now = new Date(), db: Db = getMssql()): Promise<void> {
  const c = await loadCampaignRow(db, id);
  requireStatus(c, ['RASCUNHO', 'AGENDADA', 'ATIVA'], 'cancelar');
  await db.updateTable('campaigns').set({ status: 'CANCELADA', ended_at: now }).where('id', '=', id).execute();
}

/** Inicia as campanhas agendadas cujo início chegou: fixa os valores de cada produto e passa a ATIVA. */
export async function startDueCampaigns(now = new Date(), db: Db = getMssql()): Promise<{ id: number; included: number; blocked: number }[]> {
  const due = await db.selectFrom('campaigns').selectAll()
    .where('status', '=', 'AGENDADA').where('starts_at', '<=', now).where('ends_at', '>', now).orderBy('starts_at').execute();
  const out: { id: number; included: number; blocked: number }[] = [];
  for (const row of due) {
    const c = toCampaign(row);
    const items = (await db.selectFrom('campaign_products').select(['sku', 'override_type', 'override_value'])
      .where('campaign_id', '=', c.id).execute())
      .map(r => ({ sku: r.sku, override: r.override_type ? { type: r.override_type as DiscountType, value: Number(r.override_value) } : null }));
    const evaluated = await evaluateItems(db, c, items, now);
    await db.transaction().execute(async trx => {
      // Valores fixados no início, em blocos (MERGE por SKU).
      for (let i = 0; i < evaluated.length; i += 150) {
        const values = sql.join(evaluated.slice(i, i + 150).map(e => sql`(${e.sku}, ${e.state}, ${e.blockReason}, ${e.warning},
          ${e.base}, ${e.reference}, ${e.promo}, ${e.cost})`));
        await sql`
          MERGE campaign_products AS t
          USING (VALUES ${values}) AS s (sku, state, block_reason, warning, base_price, reference_price, promo_price, cost_at_start)
          ON t.campaign_id = ${c.id} AND t.sku = s.sku
          WHEN MATCHED THEN UPDATE SET state = s.state, block_reason = s.block_reason, warning = s.warning,
            base_price = s.base_price, reference_price = s.reference_price, promo_price = s.promo_price,
            cost_at_start = s.cost_at_start;`.execute(trx);
      }
      await trx.updateTable('campaigns').set({ status: 'ATIVA', started_at: now })
        .where('id', '=', c.id).where('status', '=', 'AGENDADA').execute();
    });
    const included = evaluated.filter(e => e.state === 'INCLUIDO').length;
    out.push({ id: c.id, included, blocked: evaluated.length - included });
  }
  return out;
}

/** Termina as campanhas cujo fim chegou (ativas; e agendadas que nunca chegaram a começar). */
export async function endDueCampaigns(now = new Date(), db: Db = getMssql()): Promise<number[]> {
  const due = await db.selectFrom('campaigns').select('id')
    .where('status', 'in', ['ATIVA', 'AGENDADA']).where('ends_at', '<=', now).execute();
  const ids = due.map(r => r.id as number);
  if (ids.length) {
    await db.updateTable('campaigns').set({ status: 'TERMINADA', ended_at: now })
      .where('id', 'in', ids).where('status', 'in', ['ATIVA', 'AGENDADA']).execute();
  }
  return ids;
}

// ── Promoções em vigor e reconciliação com a loja ────────────────────────────

export interface LivePromotion { campaignId: number; promoPrice: number; referencePrice: number }

/** SKUs em promoção agora (campanha ATIVA e produto INCLUIDO). Usado pelo sync e pelo temporizador. */
export async function loadLivePromotions(db: Db = getMssql()): Promise<Map<string, LivePromotion>> {
  const rows = await sql<any>`
    SELECT cp.sku, cp.campaign_id, cp.promo_price, cp.reference_price
    FROM campaign_products cp JOIN campaigns c ON c.id = cp.campaign_id
    WHERE c.status = 'ATIVA' AND cp.state = 'INCLUIDO'
      AND cp.promo_price IS NOT NULL AND cp.reference_price IS NOT NULL`.execute(db);
  return new Map(rows.rows.map(r => [r.sku, {
    campaignId: r.campaign_id, promoPrice: Number(r.promo_price), referencePrice: Number(r.reference_price),
  }]));
}

/** Origem das mudanças de preço dos SKUs em promoção (para o histórico). */
export async function campaignAttribution(db: Db = getMssql()): Promise<PriceAttribution> {
  const live = await loadLivePromotions(db);
  return new Map([...live].map(([sku, p]) => [sku, { source: 'CAMPAIGN' as const, campaignId: p.campaignId }]));
}

export interface PendingShopWrite {
  sku: string; campaignId: number;
  promoPrice: number | null; referencePrice: number | null;
  /** Preço base atual (products.base_price). */
  basePrice: number | null;
  productId: number | null; variantId: number | null;
}

const toPending = (r: any): PendingShopWrite => ({
  sku: r.sku, campaignId: r.campaign_id,
  promoPrice: num(r.promo_price), referencePrice: num(r.reference_price), basePrice: num(r.base_price),
  productId: num(r.shopify_product_id), variantId: num(r.shopify_variant_id),
});

/** Em promoção mas ainda não enviados para a loja. */
export async function pendingApply(db: Db = getMssql()): Promise<PendingShopWrite[]> {
  const rows = await sql<any>`
    SELECT cp.sku, cp.campaign_id, cp.promo_price, cp.reference_price,
           p.base_price, p.shopify_product_id, p.shopify_variant_id
    FROM campaign_products cp
    JOIN campaigns c ON c.id = cp.campaign_id
    LEFT JOIN products p ON p.sku = cp.sku
    WHERE c.status = 'ATIVA' AND cp.state = 'INCLUIDO' AND cp.applied_at IS NULL
      AND cp.promo_price IS NOT NULL AND cp.reference_price IS NOT NULL
    ORDER BY cp.campaign_id, cp.sku`.execute(db);
  return rows.rows.map(toPending);
}

/** Enviados para a loja que já não estão em promoção (campanha terminada/cancelada, ou produto retirado). */
export async function pendingRevert(db: Db = getMssql()): Promise<PendingShopWrite[]> {
  const rows = await sql<any>`
    SELECT cp.sku, cp.campaign_id, cp.promo_price, cp.reference_price,
           p.base_price, p.shopify_product_id, p.shopify_variant_id
    FROM campaign_products cp
    JOIN campaigns c ON c.id = cp.campaign_id
    LEFT JOIN products p ON p.sku = cp.sku
    WHERE cp.applied_at IS NOT NULL AND cp.reverted_at IS NULL
      AND NOT (c.status = 'ATIVA' AND cp.state = 'INCLUIDO')
    ORDER BY cp.campaign_id, cp.sku`.execute(db);
  return rows.rows.map(toPending);
}

export async function markApplied(campaignId: number, sku: string, at: Date, db: Db = getMssql()): Promise<void> {
  await db.updateTable('campaign_products').set({ applied_at: at, reverted_at: null })
    .where('campaign_id', '=', campaignId).where('sku', '=', sku).execute();
}

export async function markReverted(campaignId: number, sku: string, at: Date, db: Db = getMssql()): Promise<void> {
  await db.updateTable('campaign_products').set({ reverted_at: at })
    .where('campaign_id', '=', campaignId).where('sku', '=', sku).execute();
}

/**
 * Retira das campanhas ativas os produtos cujo preço em promoção passou a dar prejuízo
 * (o custo subiu depois do início). Corre no fim de cada importação. O sync ou o temporizador
 * repõem depois o preço base na loja.
 */
export async function withdrawLossMakers(now = new Date(), db: Db = getMssql()): Promise<{ campaignId: number; sku: string }[]> {
  const { ivaRate } = await loadAdminSettings();
  const rows = await sql<any>`
    SELECT cp.campaign_id, cp.sku, cp.promo_price, p.cost, p.base_price
    FROM campaign_products cp
    JOIN campaigns c ON c.id = cp.campaign_id
    JOIN products p ON p.sku = cp.sku
    WHERE c.status = 'ATIVA' AND cp.state = 'INCLUIDO' AND cp.promo_price IS NOT NULL`.execute(db);
  const out: { campaignId: number; sku: string }[] = [];
  for (const r of rows.rows) {
    const cost = num(r.cost);
    if (cost == null || cost <= 0) continue; // sem custo: o sync passa o produto a rascunho
    if (!isLossMaking(effectivePrice(Number(r.promo_price), num(r.base_price)), cost, ivaRate ?? 23)) continue;
    await db.updateTable('campaign_products')
      .set({ state: 'RETIRADO', removed_at: now, removed_reason: 'PREJUIZO' })
      .where('campaign_id', '=', r.campaign_id).where('sku', '=', r.sku).where('state', '=', 'INCLUIDO').execute();
    out.push({ campaignId: r.campaign_id, sku: r.sku });
  }
  return out;
}

// ── Seleção de produtos (interface) ──────────────────────────────────────────

export interface ProductFilters {
  brand?: string; productLine?: string; family?: string; stockStatus?: string;
  /** Texto no nome ou no SKU. */
  text?: string;
  /** SKUs colados (um por linha, vírgulas ou espaços). */
  skus?: string[];
  /** Só produtos com preço gerido pelo sync e presentes na loja (por omissão true). */
  onlyManaged?: boolean;
}

export interface ProductInfo {
  sku: string; name: string | null; brand: string | null; productLine: string | null; family: string | null;
  stockStatus: string | null; cost: number | null; basePrice: number | null; inShop: boolean;
}

export const SELECTION_LIMIT = 5000;

const toInfo = (r: any): ProductInfo => ({
  sku: r.sku, name: r.name ?? null, brand: r.brand ?? null, productLine: r.product_line ?? null, family: r.family ?? null,
  stockStatus: r.stock_status ?? null, cost: num(r.cost), basePrice: num(r.base_price),
  inShop: !!(r.shopify_product_id && r.shopify_variant_id),
});

const INFO_COLUMNS = ['sku', 'name', 'brand', 'product_line', 'family', 'stock_status', 'cost', 'base_price',
  'shopify_product_id', 'shopify_variant_id'] as const;

/** Produtos que cumprem os filtros (máx. SELECTION_LIMIT; `truncated` se houver mais). */
export async function searchProducts(f: ProductFilters, db: Db = getMssql()): Promise<{ products: ProductInfo[]; truncated: boolean }> {
  let q = db.selectFrom('products').select([...INFO_COLUMNS]).where('removed_at', 'is', null);
  if (f.onlyManaged !== false) {
    q = q.where('base_price', 'is not', null).where('shopify_product_id', 'is not', null).where('shopify_variant_id', 'is not', null);
  }
  if (f.brand) q = q.where('brand', '=', f.brand);
  if (f.productLine) q = q.where('product_line', '=', f.productLine);
  if (f.family) q = q.where('family', '=', f.family);
  if (f.stockStatus) q = q.where('stock_status', '=', f.stockStatus);
  if (f.text?.trim()) {
    const like = `%${f.text.trim().replace(/[\%_[]/g, ch => `[${ch}]`)}%`;
    q = q.where(eb => eb.or([eb('name', 'like', like), eb('sku', 'like', like)]));
  }
  const skus = [...new Set((f.skus ?? []).map(s => String(s).trim()).filter(Boolean))];
  if (skus.length) {
    if (skus.length > 2000) throw new CampaignError('No máximo 2000 SKUs colados de cada vez.', 'INVALID');
    q = q.where('sku', 'in', skus);
  }
  const rows = await q.orderBy('brand').orderBy('name').top(SELECTION_LIMIT + 1).execute();
  return { products: rows.slice(0, SELECTION_LIMIT).map(toInfo), truncated: rows.length > SELECTION_LIMIT };
}

/** Valores para os filtros da seleção (marcas, linhas, famílias, estados de stock). */
export async function productFilterOptions(db: Db = getMssql()) {
  const distinct = async (col: 'brand' | 'product_line' | 'family' | 'stock_status') =>
    (await db.selectFrom('products').select(col).distinct().where(col, 'is not', null).where('removed_at', 'is', null)
      .orderBy(col).execute()).map((r: any) => r[col] as string).filter(Boolean);
  const [brands, productLines, families, stockStatuses] = await Promise.all([
    distinct('brand'), distinct('product_line'), distinct('family'), distinct('stock_status'),
  ]);
  return { brands, productLines, families, stockStatuses };
}

/** Nome, marca e preço atual dos produtos de uma campanha (para o detalhe). */
export async function productInfo(skus: string[], db: Db = getMssql()): Promise<Map<string, ProductInfo>> {
  const out = new Map<string, ProductInfo>();
  for (let i = 0; i < skus.length; i += 1000) {
    const rows = await db.selectFrom('products').select([...INFO_COLUMNS]).where('sku', 'in', skus.slice(i, i + 1000)).execute();
    for (const r of rows) out.set(r.sku, toInfo(r));
  }
  return out;
}

/** Desde quando há histórico de preços (regra dos 30 dias: campanhas válidas 30 dias depois). */
export async function historyStartedAt(db: Db = getMssql()): Promise<Date | null> {
  const r: any = await db.selectFrom('price_history').select(sql`MIN(changed_at)`.as('m')).executeTakeFirst();
  return r?.m ? new Date(r.m) : null;
}
