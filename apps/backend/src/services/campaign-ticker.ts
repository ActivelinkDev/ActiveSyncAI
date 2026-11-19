/**
 * Temporizador das campanhas (de minuto a minuto).
 *
 * Cada passagem é idempotente e reconcilia a loja com a base de dados:
 *   1. inicia as campanhas agendadas cujo início chegou (fixa os valores) e termina as que acabaram;
 *   2. repõe o preço base dos produtos que deixaram de estar em promoção (fim, cancelamento, retirada);
 *   3. envia o preço promocional (e o preço riscado = referência dos 30 dias) dos que entraram;
 *   4. lê esses produtos da loja e grava o histórico (CAMPAIGN / CAMPAIGN_END, com a campanha).
 * Um envio que falhe fica por marcar e é repetido na passagem seguinte.
 *
 * Desligado por omissão (CAMPAIGN_TICKER_ENABLED=1 só no servidor, como o AUTO_SYNC_ENABLED):
 * o PC de desenvolvimento nunca escreve na loja por causa de uma campanha.
 * Corre dentro do lock do catálogo: se houver uma importação ou sync a correr, espera pelo minuto seguinte
 * (o sync já envia os preços de campanha das promoções ativas).
 */
import { withCatalogueLock } from '../repositories/suprides-cache';
import { variantUpdate } from '../suprides/api/shopify-api';
import { readAllProducts, type SnapshotProduct } from '../suprides/api/shopify-read';
import {
  startDueCampaigns, endDueCampaigns, loadLivePromotions, pendingApply, pendingRevert, markApplied, markReverted,
} from '../suprides/repositories/campaigns';
import { promoShopPrices } from '../suprides/services/campaign-calc';
import { recordShopPrices, type PriceAttribution } from './price-history';
import { logLine } from '../utils/logger';
import { sendAlert } from './alerts';

/** Escrita e leitura de preços na loja (substituível nos testes). */
export interface ShopPriceWriter {
  setPrice(productId: number, variantId: number, price: string, compareAtPrice: string | null): Promise<void>;
  readBySkus(skus: string[]): Promise<SnapshotProduct[]>;
}

export const shopifyPriceWriter: ShopPriceWriter = {
  setPrice: (productId, variantId, price, compareAtPrice) => variantUpdate(productId, variantId, { price, compareAtPrice }),
  async readBySkus(skus) {
    const out: SnapshotProduct[] = [];
    for (let i = 0; i < skus.length; i += 50) {
      const search = skus.slice(i, i + 50).map(s => `sku:"${s.replace(/"/g, '\\"')}"`).join(' OR ');
      out.push(...await readAllProducts(undefined, search));
    }
    return out;
  },
};

export interface TickResult {
  started: { id: number; included: number; blocked: number }[];
  ended: number[];
  applied: number;
  reverted: number;
  errors: { sku: string; campaignId: number; error: string }[];
  historyChanges: number;
}

export async function runCampaignTick(now = new Date(), writer: ShopPriceWriter = shopifyPriceWriter): Promise<TickResult> {
  const started = await startDueCampaigns(now);
  const ended = await endDueCampaigns(now);
  const live = await loadLivePromotions();
  const attribution: PriceAttribution = new Map();
  const errors: TickResult['errors'] = [];
  let applied = 0, reverted = 0;
  const fail = (sku: string, campaignId: number, e: unknown) =>
    errors.push({ sku, campaignId, error: String((e as any)?.message ?? e).slice(0, 300) });

  // Repor primeiro: se o mesmo SKU sair de uma campanha e entrar noutra, fica o promocional novo.
  for (const r of await pendingRevert()) {
    try {
      // Já noutra promoção, ou o sync deixou de gerir o preço: nada a escrever.
      if (!live.has(r.sku) && r.basePrice != null && r.productId && r.variantId) {
        await writer.setPrice(r.productId, r.variantId, r.basePrice.toFixed(2), null);
        attribution.set(r.sku, { source: 'CAMPAIGN_END', campaignId: r.campaignId });
      }
      await markReverted(r.campaignId, r.sku, now);
      reverted++;
    } catch (e) { fail(r.sku, r.campaignId, e); }
  }

  for (const a of await pendingApply()) {
    if (!a.productId || !a.variantId) { fail(a.sku, a.campaignId, 'Produto sem ID na loja'); continue; }
    try {
      const p = promoShopPrices(a.promoPrice!, a.referencePrice!, a.basePrice);
      await writer.setPrice(a.productId, a.variantId, p.price.toFixed(2), p.compareAtPrice == null ? null : p.compareAtPrice.toFixed(2));
      await markApplied(a.campaignId, a.sku, now);
      attribution.set(a.sku, { source: 'CAMPAIGN', campaignId: a.campaignId });
      applied++;
    } catch (e) { fail(a.sku, a.campaignId, e); }
  }

  let historyChanges = 0;
  if (attribution.size) {
    const products = await writer.readBySkus([...attribution.keys()]);
    const r = await recordShopPrices(products, new Date(Math.max(Date.now(), now.getTime())), 'SYNC', attribution);
    historyChanges = r.changes;
  }
  return { started, ended, applied, reverted, errors, historyChanges };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await withCatalogueLock(() => runCampaignTick());
    for (const s of r.started) logLine(`[Campanhas] Campanha ${s.id} iniciada: ${s.included} produto(s) em promoção, ${s.blocked} bloqueado(s)`);
    for (const id of r.ended) logLine(`[Campanhas] Campanha ${id} terminada`);
    if (r.applied || r.reverted) {
      logLine(`[Campanhas] Loja: ${r.applied} preço(s) promocionais enviados, ${r.reverted} reposto(s); histórico +${r.historyChanges}`);
    }
    if (r.errors.length) {
      logLine(`[Campanhas] ${r.errors.length} envio(s) falharam (repetem no minuto seguinte): ${r.errors.slice(0, 5).map(e => e.sku).join(', ')}`);
      await sendAlert('campaign', `Campanhas: ${r.errors.length} preço(s) não enviados para a loja`,
        `O temporizador das campanhas não conseguiu atualizar estes produtos (tenta outra vez a cada minuto):

${r.errors.slice(0, 10).map(e => `- ${e.sku} (campanha ${e.campaignId}): ${e.error}`).join('\n')}`);
    }
  } catch (e: any) {
    if (e?.code === 'BUSY') return; // importação ou sync em curso: fica para o minuto seguinte
    logLine(`[Campanhas] FALHOU: ${e?.message ?? e}`);
    await sendAlert('campaign', 'Temporizador das campanhas falhou',
      `Uma passagem do temporizador das campanhas falhou (tenta outra vez dentro de um minuto).

Erro: ${e?.message ?? e}`);
  } finally {
    running = false;
  }
}

export function campaignTickerEnabled(): boolean {
  return /^(1|true|yes|sim)$/i.test(process.env.CAMPAIGN_TICKER_ENABLED ?? '');
}

export function startCampaignTicker(): void {
  if (!campaignTickerEnabled()) {
    console.log('[Campanhas] Temporizador desligado (CAMPAIGN_TICKER_ENABLED)');
    return;
  }
  if (timer) return;
  console.log('[Campanhas] Temporizador ligado (de minuto a minuto)');
  timer = setInterval(() => { void tick(); }, 60_000);
  void tick();
}

export function stopCampaignTicker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
